-- «ДУРАК»: семёрку можно класть на любую карту (как двойку) + данные для анимаций на телефоне.
--
-- Что меняется (простыми словами):
-- * 7 — на любую карту. После неё, как и раньше, только 7 или младше (и 2). 8 и 10 на семёрку по-прежнему нельзя.
-- * Журнал действий: у каждой записи номер «i» (растёт), чтобы телефон знал, какие действия ещё не показал анимацией;
--   у закрытой карты — с какого места её открыли («pos»); после хода — сколько карт добрали из колоды («drew»).
-- * Бот теперь бережёт семёрку, как 8, 2 и 10: кладёт её, только если обычной подходящей карты нет.

-- 1. Можно ли положить карту достоинства p_rank, когда надо побить p_need
create or replace function public.durak_fits(p_rank integer, p_need integer)
returns boolean
language sql immutable set search_path to ''
as $function$
  select case
    when p_need = 0 then true                 -- пустой стол
    when p_rank in (2, 7) then true           -- двойка и семёрка — на любую
    when p_need = 7 then p_rank <= 7          -- после семёрки — только 2..7
    when p_rank in (8, 10) then true          -- восьмёрка и десятка — на любую, кроме 7
    else p_rank >= p_need
  end
$function$;
revoke all on function public.durak_fits(integer, integer) from public, anon, authenticated;

-- 2. Журнал: номер записи «i» = версия комнаты после записи (только растёт)
create or replace function public.durak_log(p_room bigint, p_entry jsonb)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v jsonb;
begin
  select g.log || jsonb_build_array(p_entry || jsonb_build_object('i', g.version + 1)) into v from public.durak_rooms g where g.id = p_room;
  while jsonb_array_length(v) > 8 loop v := v - 0; end loop;
  update public.durak_rooms g set log = v, version = g.version + 1 where g.id = p_room;
end $function$;
revoke all on function public.durak_log(bigint, jsonb) from public, anon, authenticated;

-- 3. Ход: то же, что раньше, плюс «pos» у закрытой карты и «drew» — сколько карт добрали из колоды
create or replace function public.durak_move(p_room bigint, p_user uuid, p_kind text, p_cards integer[], p_pos integer, p_auto boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.durak_rooms%rowtype;
  p public.durak_players%rowtype;
  v_hand integer[]; v_open integer[]; v_closed integer[]; v_pile integer[]; v_deck integer[]; v_bita integer;
  v_need integer; v_rank integer; v_card integer; v_src text; v_rr integer; v_drew integer := 0;
  v_burn boolean := false; v_took boolean := false; v_out boolean;
  v_entry jsonb;
begin
  select * into g from public.durak_rooms x where x.id = p_room for update;
  if not found or g.status <> 'play' then raise exception 'durak_gone'; end if;
  select * into p from public.durak_players x where x.room_id = p_room and x.user_id = p_user;
  if not found or p.place is not null or p.seat is distinct from g.turn_seat then raise exception 'durak_not_turn'; end if;

  v_hand := p.hand; v_open := p.open; v_closed := p.closed;
  v_pile := g.pile; v_deck := g.deck; v_bita := g.bita;
  v_need := public.durak_need(v_pile);
  v_src := case when cardinality(v_hand) > 0 then 'hand'
                when cardinality(array_remove(v_open, null)) > 0 then 'open'
                else 'closed' end;

  if p_kind = 'play' then
    if v_src = 'closed' or p_cards is null or cardinality(p_cards) not between 1 and 4
       or exists (select 1 from unnest(p_cards) x where x is null or x not between 0 and 51)
       or (select count(distinct x) from unnest(p_cards) x) <> cardinality(p_cards)
       or (select count(distinct x / 4) from unnest(p_cards) x) <> 1 then
      raise exception 'durak_bad_move';
    end if;
    v_rank := p_cards[1] / 4 + 2;
    if v_src = 'hand' then
      if not (v_hand @> p_cards) then raise exception 'durak_bad_move'; end if;
      v_hand := array(select x from unnest(v_hand) x where x <> all (p_cards));
    else
      if not (v_open @> p_cards) then raise exception 'durak_bad_move'; end if;
      v_open := array(select case when t.x = any (p_cards) then null else t.x end
                      from unnest(v_open) with ordinality t(x, i) order by t.i);
    end if;
    if not public.durak_fits(v_rank, v_need) then raise exception 'durak_bad_move'; end if;
    v_pile := v_pile || p_cards;
    v_burn := v_rank = 10 or (select count(*) from unnest(v_pile) x where x / 4 + 2 = v_rank) >= 4;
    v_entry := jsonb_build_object('kind', 'play', 'cards', to_jsonb(p_cards), 'from', v_src);

  elsif p_kind = 'flip' then
    if v_src <> 'closed' or p_pos is null or p_pos < 1 or p_pos > cardinality(v_closed) or v_closed[p_pos] is null then
      raise exception 'durak_bad_move';
    end if;
    v_card := v_closed[p_pos];
    v_closed[p_pos] := null;
    v_rank := v_card / 4 + 2;
    if public.durak_fits(v_rank, v_need) then
      v_pile := v_pile || v_card;
      v_burn := v_rank = 10 or (select count(*) from unnest(v_pile) x where x / 4 + 2 = v_rank) >= 4;
      v_entry := jsonb_build_object('kind', 'play', 'cards', jsonb_build_array(v_card), 'from', 'closed', 'pos', p_pos);
    else
      v_took := true;
      v_entry := jsonb_build_object('kind', 'flip_take', 'cards', jsonb_build_array(v_card), 'n', cardinality(v_pile) + 1, 'pos', p_pos);
      v_hand := v_hand || v_pile || v_card;
      v_pile := '{}';
    end if;

  elsif p_kind = 'take' then
    if cardinality(v_pile) = 0 then raise exception 'durak_bad_move'; end if;
    if not p_auto then
      if v_src = 'closed' then raise exception 'durak_bad_move'; end if;
      if exists (select 1 from unnest(case when v_src = 'hand' then v_hand else v_open end) x
                 where x is not null and public.durak_fits(x / 4 + 2, v_need)) then
        raise exception 'durak_can_play';
      end if;
    end if;
    v_took := true;
    v_entry := jsonb_build_object('kind', 'take', 'n', cardinality(v_pile));
    v_hand := v_hand || v_pile;
    v_pile := '{}';

  else
    raise exception 'durak_bad_move';
  end if;

  -- забрал стопку: 4 одинаковые в руке уходят в биту
  if v_took then
    for v_rr in select x / 4 from unnest(v_hand) x group by x / 4 having count(*) >= 4 loop
      v_hand := array(select x from unnest(v_hand) x where x / 4 <> v_rr);
      v_bita := v_bita + 4;
      v_entry := v_entry || jsonb_build_object('four', v_rr + 2);
    end loop;
  end if;
  -- бита: десятка или все 4 одного достоинства в стопке
  if v_burn then
    v_bita := v_bita + cardinality(v_pile);
    v_pile := '{}';
    v_entry := v_entry || jsonb_build_object('burn', true);
  end if;
  -- добор из колоды до 3
  while cardinality(v_hand) < 3 and cardinality(v_deck) > 0 loop
    v_hand := v_hand || v_deck[cardinality(v_deck)];
    v_deck := v_deck[1:cardinality(v_deck) - 1];
    v_drew := v_drew + 1;
  end loop;
  if v_drew > 0 then v_entry := v_entry || jsonb_build_object('drew', v_drew); end if;
  v_out := cardinality(v_hand) = 0 and cardinality(array_remove(v_open, null)) = 0 and cardinality(array_remove(v_closed, null)) = 0;

  update public.durak_players x
     set hand = v_hand, open = v_open, closed = v_closed, misses = case when p_auto then x.misses else 0 end
   where x.room_id = p_room and x.user_id = p_user;
  update public.durak_rooms x set pile = v_pile, deck = v_deck, bita = v_bita where x.id = p_room;
  if v_out then
    v_entry := v_entry || jsonb_build_object('out', public.durak_place(p_room, p_user, 'done'));
  end if;
  perform public.durak_log(p_room, v_entry || jsonb_build_object('seat', p.seat, 'auto', p_auto));
  perform public.durak_after(p_room, p.seat, v_burn and not v_out);
end $function$;
revoke all on function public.durak_move(bigint, uuid, text, integer[], integer, boolean) from public, anon, authenticated;

-- 4. Бот: семёрка теперь «особая» — бережёт её до последнего, как 8, 2 и 10
create or replace function public.durak_bot_move(p_room bigint, p_user uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.durak_rooms%rowtype;
  p public.durak_players%rowtype;
  v_need integer; v_src text; v_rank integer; v_pos integer; v_from integer[];
begin
  select * into g from public.durak_rooms x where x.id = p_room for update;
  select * into p from public.durak_players x where x.room_id = p_room and x.user_id = p_user;
  v_need := public.durak_need(g.pile);
  v_src := case when cardinality(p.hand) > 0 then 'hand' when cardinality(array_remove(p.open, null)) > 0 then 'open' else 'closed' end;
  if v_src = 'closed' then
    select t.i into v_pos from unnest(p.closed) with ordinality t(x, i) where t.x is not null order by random() limit 1;
    perform public.durak_move(p_room, p_user, 'flip', null, v_pos::integer, false);
    return;
  end if;
  v_from := case when v_src = 'hand' then p.hand else p.open end;
  -- обычно — самая младшая обычная карта (7, 8, 2, 10 бережёт); иногда (15%) — случайная подходящая, чтобы игра была разной
  select t.r into v_rank from (
    select distinct x / 4 + 2 as r from unnest(v_from) x where x is not null and public.durak_fits(x / 4 + 2, v_need)
  ) t
  order by case when random() < 0.15 then random() else 0 end, case t.r when 7 then 1 when 8 then 2 when 2 then 3 when 10 then 4 else 0 end, t.r
  limit 1;
  if v_rank is null then
    perform public.durak_move(p_room, p_user, 'take', null, null, false);
  else
    perform public.durak_move(p_room, p_user, 'play',
      array(select x from unnest(v_from) x where x is not null and x / 4 + 2 = v_rank), null, false);
  end if;
end $function$;
revoke all on function public.durak_bot_move(bigint, uuid) from public, anon, authenticated;
