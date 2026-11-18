-- «ДУРАК»: открытые карты — по одной за ход, выход во время игры = поражение, чужую закрытую карту не видно.
--
-- Что меняется (простыми словами):
-- * Открытые карты на столе (как и закрытые) кладутся только по одной, даже если их несколько одного достоинства.
--   С руки — как раньше, можно сразу несколько одинаковых.
-- * «Выйти» во время выбора или игры: игрок занимает последнее свободное место (как при двух пропусках по времени),
--   его карты уходят в биту, игра идёт дальше. Остался один — итог.
-- * Закрытая карта, которая не подошла и ушла в руку, видна только её хозяину (в журнале для остальных — без карты).
-- * Вышедший из игры больше не видит эту игру в списке как «Идёт игра».

-- 0. Новый вид выбывания: 'left' — вышел сам
alter table public.durak_players drop constraint if exists durak_players_out_kind_check;
alter table public.durak_players add constraint durak_players_out_kind_check check (out_kind in ('done', 'afk', 'last', 'left'));

-- 1. Место выбывшего: по времени и вышедший сам — последнее свободное
create or replace function public.durak_place(p_room bigint, p_user uuid, p_kind text)
returns integer
language plpgsql security definer set search_path to ''
as $function$
declare v_n integer; v_place integer;
begin
  select count(*) into v_n from public.durak_players x where x.room_id = p_room;
  if p_kind in ('afk', 'left') then   -- выбыл по времени или вышел сам — последнее свободное место
    v_place := v_n - (select count(*) from public.durak_players x where x.room_id = p_room and x.out_kind in ('afk', 'left'));
  else
    v_place := 1 + (select count(*) from public.durak_players x where x.room_id = p_room and x.out_kind = 'done');
  end if;
  update public.durak_players x set place = v_place, out_kind = p_kind where x.room_id = p_room and x.user_id = p_user;
  return v_place;
end $function$;
revoke all on function public.durak_place(bigint, uuid, text) from public, anon, authenticated;

-- 2. Первый ход — только среди тех, кто ещё в игре
create or replace function public.durak_begin(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_seat integer;
begin
  select x.seat into v_seat from public.durak_players x where x.room_id = p_room and x.place is null order by random() limit 1;
  update public.durak_rooms g set status = 'play', turn_seat = v_seat, deadline = now() + interval '30 seconds'
   where g.id = p_room;
  perform public.durak_log(p_room, jsonb_build_object('kind', 'begin', 'seat', v_seat));
end $function$;
revoke all on function public.durak_begin(bigint) from public, anon, authenticated;

-- 3. Ход: открытые карты со стола — по одной
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
      if cardinality(p_cards) > 1 or not (v_open @> p_cards) then raise exception 'durak_bad_move'; end if;   -- со стола — по одной
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

-- 4. Бот: со стола тоже по одной
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
      array(select x from unnest(v_from) x where x is not null and x / 4 + 2 = v_rank
            limit case when v_src = 'open' then 1 else 4 end), null, false);   -- со стола — по одной
  end if;
end $function$;
revoke all on function public.durak_bot_move(bigint, uuid) from public, anon, authenticated;

-- 5. Выйти: в комнате ожидания — ставка возвращается; во время игры — поражение
create or replace function public.durak_leave(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.durak_rooms%rowtype;
  p public.durak_players%rowtype;
  v_next uuid; v_place integer;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.durak_tick(p_room);
  select * into g from public.durak_rooms x where x.id = p_room for update;
  if not found then raise exception 'durak_gone'; end if;
  select * into p from public.durak_players x where x.room_id = p_room and x.user_id = uid;
  if not found then raise exception 'durak_gone'; end if;

  -- во время игры выход = поражение: последнее свободное место, карты уходят в биту, игра идёт дальше
  if g.status in ('choose', 'play') then
    if p.place is not null then raise exception 'durak_gone'; end if;
    update public.durak_rooms x
       set bita = x.bita + cardinality(p.hand) + cardinality(array_remove(p.open, null))
                  + cardinality(array_remove(p.closed, null)) + cardinality(p.pick)
     where x.id = p_room;
    update public.durak_players x set hand = '{}', open = '{}', closed = '{}', pick = '{}', chosen = true
     where x.room_id = p_room and x.user_id = uid;
    v_place := public.durak_place(p_room, uid, 'left');
    perform public.durak_log(p_room, jsonb_build_object('kind', 'left', 'seat', p.seat, 'out', v_place));
    if (select count(*) from public.durak_players x where x.room_id = p_room and x.place is null) <= 1
       or (g.test and not exists (select 1 from public.durak_players x where x.room_id = p_room and x.place is null and x.bot_name is null)) then
      perform public.durak_after(p_room, coalesce(g.turn_seat, p.seat), false);   -- остался один (или одни боты) — итог
    elsif g.status = 'play' and g.turn_seat = p.seat then
      perform public.durak_after(p_room, p.seat, false);                         -- был его ход — ход следующему
    elsif g.status = 'choose' and not exists (select 1 from public.durak_players x where x.room_id = p_room and not x.chosen) then
      perform public.durak_begin(p_room);                                        -- остальные уже выбрали — игра начинается
    end if;
    return;
  end if;

  if g.status not in ('open', 'ready') then raise exception 'durak_gone'; end if;
  delete from public.durak_players x where x.room_id = p_room and x.user_id = uid;
  select x.user_id into v_next from public.durak_players x where x.room_id = p_room and x.bot_name is null order by x.joined_at limit 1;
  if v_next is null then
    perform public.durak_cancel_room(p_room);
    return;
  end if;
  update public.durak_players x set ready = x.bot_name is not null where x.room_id = p_room;
  update public.durak_rooms x
     set creator = case when x.creator = uid then v_next else x.creator end,
         status = 'open', deadline = null, version = x.version + 1
   where x.id = p_room;
end $function$;
revoke all on function public.durak_leave(bigint) from public, anon;
grant execute on function public.durak_leave(bigint) to authenticated;

-- 6. Вид комнаты: чужую закрытую карту, ушедшую в руку, не видно
create or replace function public.durak_view(p_room bigint)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.durak_rooms%rowtype;
  me public.durak_players%rowtype;
  v_need integer; v_src text; v_top integer[] := '{}'; i integer;
  v_play jsonb := '[]'; v_take boolean := false; v_turn boolean;
  v_players jsonb; v_rematch jsonb;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select * into g from public.durak_rooms x where x.id = p_room;
  if found and ((g.status in ('ready', 'choose', 'play') and g.deadline < now() - interval '2 seconds')
                or (g.status = 'open' and g.created_at < now() - interval '24 hours')
                or (g.status = 'play' and g.deadline - interval '28.5 seconds' <= now()
                    and exists (select 1 from public.durak_players x where x.room_id = g.id and x.seat = g.turn_seat and x.bot_name is not null))) then
    perform public.durak_tick(p_room);
    select * into g from public.durak_rooms x where x.id = p_room;
  end if;
  if not found then raise exception 'durak_gone'; end if;
  select * into me from public.durak_players x where x.room_id = p_room and x.user_id = uid;
  if not found then
    -- не игрок: открытую комнату можно посмотреть (кто в ней), чужую игру и тестовую комнату — нет
    if g.test or g.status not in ('open', 'ready', 'cancelled') then raise exception 'durak_gone'; end if;
  end if;

  v_need := public.durak_need(g.pile);
  -- видно: верхнюю карту, а если сверху восьмёрки — и карту под ними
  if cardinality(g.pile) > 0 then
    for i in reverse cardinality(g.pile)..1 loop
      v_top := array_prepend(g.pile[i], v_top);
      exit when g.pile[i] / 4 + 2 <> 8;
    end loop;
  end if;

  v_turn := g.status = 'play' and me.user_id is not null and me.place is null and me.seat = g.turn_seat;
  if me.user_id is not null then
    v_src := case when cardinality(me.hand) > 0 then 'hand'
                  when cardinality(array_remove(me.open, null)) > 0 then 'open'
                  else 'closed' end;
    if v_turn and v_src <> 'closed' then
      v_play := coalesce((select jsonb_agg(x order by x) from unnest(case when v_src = 'hand' then me.hand else me.open end) x
                          where x is not null and public.durak_fits(x / 4 + 2, v_need)), '[]');
      v_take := v_play = '[]' and cardinality(g.pile) > 0;
    end if;
  end if;

  select jsonb_agg(jsonb_build_object(
           'seat', x.seat, 'id', x.user_id, 'name', coalesce(x.bot_name, pr.display_name, 'Без имени'),
           'color', case when x.bot_name is not null then '#5F6B7A' else pr.color end,
           'avatar', case when x.bot_name is not null then '🤖' else pr.avatar end, 'bot', x.bot_name is not null,
           'me', x.user_id = uid, 'creator', x.user_id = g.creator, 'ready', x.ready, 'chosen', x.chosen,
           'hand', cardinality(x.hand),
           'open', case when g.status in ('play', 'finished') then to_jsonb(x.open) end,
           'closed', to_jsonb(array(select t.y is not null from unnest(x.closed) with ordinality t(y, n) order by t.n)),
           'misses', x.misses, 'place', x.place, 'out', x.out_kind, 'payout', x.payout
         ) order by x.seat)
    into v_players
    from public.durak_players x left join public.profiles pr on pr.id = x.user_id
   where x.room_id = p_room;

  if g.rematch_id is not null then
    select jsonb_build_object('id', r.id, 'status', r.status,
             'in', exists (select 1 from public.durak_players y where y.room_id = r.id and y.user_id = uid),
             'n', (select count(*) from public.durak_players y where y.room_id = r.id))
      into v_rematch from public.durak_rooms r where r.id = g.rematch_id and r.status in ('open', 'ready');
  end if;

  return jsonb_build_object(
    'id', g.id, 'status', g.status, 'stake', g.stake, 'version', g.version, 'test', g.test,
    'creator', g.creator = uid,
    'server_ms', (extract(epoch from clock_timestamp()) * 1000)::bigint,
    'deadline_ms', (extract(epoch from g.deadline) * 1000)::bigint,
    'turn', g.turn_seat, 'need', v_need, 'pile_top', to_jsonb(v_top), 'pile_n', cardinality(g.pile),
    'deck_n', cardinality(g.deck), 'bita', g.bita,
    -- закрытая карта, которая не подошла, уходит в руку: её видит только тот, кто её открыл
    'log', coalesce((select jsonb_agg(case when t.e->>'kind' = 'flip_take' and (t.e->>'seat')::int is distinct from me.seat
                                           then t.e - 'cards' else t.e end order by t.n)
                       from jsonb_array_elements(g.log) with ordinality t(e, n)), '[]'),
    'players', coalesce(v_players, '[]'),
    'rematch', v_rematch,
    'my', case when me.user_id is null then null else jsonb_build_object(
      'seat', me.seat, 'ready', me.ready, 'chosen', me.chosen, 'place', me.place, 'payout', me.payout, 'stake', me.stake,
      'hand', coalesce((select jsonb_agg(x order by x) from unnest(me.hand) x), '[]'),
      'pick', coalesce((select jsonb_agg(x order by x) from unnest(me.pick) x), '[]'),
      'open', to_jsonb(me.open),
      'src', v_src, 'turn', v_turn, 'playable', v_play, 'can_take', v_take) end
  );
end $function$;

revoke all on function public.durak_view(bigint) from public, anon;
grant execute on function public.durak_view(bigint) to authenticated;

-- 7. Список: вышедший не видит игру как «Идёт игра»
create or replace function public.durak_list()
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  r record;
  v jsonb;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  for r in select g.id from public.durak_rooms g
           where (g.status = 'open' and (g.created_at < now() - interval '24 hours'
                    or not exists (select 1 from public.durak_players x where x.room_id = g.id and x.bot_name is null)))
              or (g.status in ('ready', 'choose', 'play') and g.deadline < now() - interval '2 seconds') loop
    perform public.durak_tick(r.id);
  end loop;
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.active desc, t.created_at desc), '[]') into v from (
    select g.id, g.status, g.stake, g.test, g.created_at, g.finished_at,
           g.status in ('open', 'ready', 'choose', 'play') as active,
           exists (select 1 from public.durak_players x where x.room_id = g.id and x.user_id = uid) as mine,
           g.creator = uid as is_creator,
           (select pr.display_name from public.profiles pr where pr.id = g.creator) as creator_name,
           (select jsonb_agg(jsonb_build_object('id', x.user_id, 'name', coalesce(x.bot_name, pr.display_name, 'Без имени'),
                                                'color', case when x.bot_name is not null then '#5F6B7A' else pr.color end,
                                                'avatar', case when x.bot_name is not null then '🤖' else pr.avatar end,
                                                'place', x.place, 'payout', x.payout) order by x.seat)
              from public.durak_players x left join public.profiles pr on pr.id = x.user_id where x.room_id = g.id) as players,
           (select x.place from public.durak_players x where x.room_id = g.id and x.user_id = uid) as my_place,
           (select x.payout from public.durak_players x where x.room_id = g.id and x.user_id = uid) as my_payout
      from public.durak_rooms g
     where (g.status in ('open', 'ready') and (not g.test or exists (select 1 from public.durak_players x where x.room_id = g.id and x.user_id = uid)))
        or (g.status in ('choose', 'play') and exists (select 1 from public.durak_players x where x.room_id = g.id and x.user_id = uid
                                                          and coalesce(x.out_kind, '') not in ('afk', 'left')))   -- вышел — игра больше не «твоя»
        or (g.status = 'finished' and g.finished_at > now() - interval '3 days'
            and exists (select 1 from public.durak_players x where x.room_id = g.id and x.user_id = uid))
     order by g.created_at desc
     limit 20
  ) t;
  return v;
end $function$;
revoke all on function public.durak_list() from public, anon;
grant execute on function public.durak_list() to authenticated;
