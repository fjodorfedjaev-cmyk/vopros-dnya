-- ВЕРЮ — НЕ ВЕРЮ: последние карты (22.11.2026).
-- Положил последние карты — ещё не вышел. Остаёшься в игре без карт, пока не кончится круг:
--   * стопка ушла в биту или её забрал кто-то другой — ты без карт и занимаешь место;
--   * стопку забрал ты (тебя проверили «Не верю», а там враньё; или сам ошибся, когда круг дошёл до тебя) — играешь дальше;
--   * после тебя докладывают — круг идёт дальше, ты в нём. Дошёл до тебя — выбираешь «Верю» или «Не верю»
--     (доложить нечего). Время вышло — база отвечает за тебя «Верю».
-- Раньше «Доложить» следующего сразу выводило положившего последние карты.
-- Если без карт в конце круга остались несколько — места по порядку: кто раньше остался без карт, тот выше.
--
-- Меняются: bluff_move (взята из 02_range.sql), bluff_outs, bluff_tick, bluff_leave (из 01_bluff.sql),
-- bluff_bot_move (из 02_range.sql). Заодно: после выхода по времени или «Выйти» ход не достаётся тому,
-- кто только что занял место.

-- Когда игрок остался без карт (для порядка мест, если без карт остались несколько)
alter table public.bluff_players add column emptied_at timestamptz;

-- Кто остался без карт (и не забирает стопку) — занимает место; кто раньше остался без карт — выше
create or replace function public.bluff_outs(p_room bigint, p_except integer)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare r record;
begin
  for r in select x.user_id, x.seat from public.bluff_players x
            where x.room_id = p_room and x.place is null and cardinality(x.hand) = 0 and x.seat is distinct from p_except
            order by x.emptied_at nulls last, x.seat loop
    perform public.bluff_log(p_room, jsonb_build_object('kind', 'out', 'seat', r.seat, 'place', public.bluff_place(p_room, r.user_id, 'done')));
  end loop;
end $function$;
revoke all on function public.bluff_outs(bigint, integer) from public, anon, authenticated;

-- Ход: «put» — положить карты (в начале круга — с номиналом), «trust» — верю, «doubt» — не верю
create or replace function public.bluff_move(p_room bigint, p_user uuid, p_kind text, p_cards integer[], p_rank integer, p_auto boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.bluff_rooms%rowtype;
  me public.bluff_players%rowtype;
  v_prev public.bluff_players%rowtype;
  v_last integer[];
  v_truth boolean;
  v_taker uuid;
  v_taker_seat integer;
  v_start integer;
begin
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  if not found or g.status <> 'play' then raise exception 'bluff_gone'; end if;
  select * into me from public.bluff_players x where x.room_id = p_room and x.user_id = p_user;
  if not found or me.place is not null or me.seat is distinct from g.turn_seat then raise exception 'bluff_not_turn'; end if;
  if g.last_seat is not null then
    select * into v_prev from public.bluff_players x where x.room_id = p_room and x.seat = g.last_seat;
  end if;

  if p_kind = 'put' then
    if p_cards is null or cardinality(p_cards) = 0
       or (select count(distinct c) from unnest(p_cards) c) <> cardinality(p_cards)
       or exists (select 1 from unnest(p_cards) c where not (c = any (me.hand))) then
      raise exception 'bluff_bad_move';
    end if;
    if g.claim_rank is null then
      if p_rank is null or p_rank < g.low_rank or p_rank > g.high_rank then raise exception 'bluff_bad_rank'; end if;
      g.claim_rank := p_rank;
    end if;
    update public.bluff_players x
       set hand = array(select c from unnest(me.hand) c where not (c = any (p_cards))),
           misses = case when coalesce(p_auto, false) then x.misses else 0 end,
           emptied_at = case when cardinality(me.hand) = cardinality(p_cards) then clock_timestamp() end
     where x.room_id = p_room and x.user_id = p_user;
    update public.bluff_rooms x set pile = x.pile || p_cards, claim_rank = g.claim_rank, last_seat = me.seat, last_n = cardinality(p_cards)
     where x.id = p_room;
    perform public.bluff_log(p_room, jsonb_build_object('kind', 'put', 'seat', me.seat, 'n', cardinality(p_cards), 'rank', g.claim_rank,
                                                        'new', g.last_seat is null, 'auto', coalesce(p_auto, false)));
    -- кто положил последние карты раньше, остаётся в игре до конца круга (раньше здесь сразу выходил)
    v_start := public.bluff_next(p_room, me.seat);
    update public.bluff_rooms x set turn_seat = v_start, deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
    return;
  end if;

  if p_kind not in ('trust', 'doubt') then raise exception 'bluff_bad_move'; end if;
  if g.claim_rank is null or g.last_seat is null or g.last_seat = me.seat then raise exception 'bluff_bad_move'; end if;
  update public.bluff_players x set misses = case when coalesce(p_auto, false) then x.misses else 0 end
   where x.room_id = p_room and x.user_id = p_user;
  v_last := g.pile[cardinality(g.pile) - g.last_n + 1 : cardinality(g.pile)];
  v_truth := not exists (select 1 from unnest(v_last) c where c < 52 and c / 4 + 2 <> g.claim_rank);   -- джокер — всегда правда
  if p_kind = 'doubt' then
    v_taker := case when v_truth then me.user_id else v_prev.user_id end;
  else
    v_taker := case when v_truth then null else me.user_id end;
  end if;
  -- забирать некому (положивший уже вышел из игры) — стопка в биту
  if v_taker is not null and exists (select 1 from public.bluff_players x where x.room_id = p_room and x.user_id = v_taker and x.place is not null) then
    v_taker := null;
  end if;
  select x.seat into v_taker_seat from public.bluff_players x where x.room_id = p_room and x.user_id = v_taker;
  perform public.bluff_log(p_room, jsonb_build_object('kind', 'reveal', 'seat', me.seat, 'call', p_kind, 'of', g.last_seat,
                                                      'cards', to_jsonb(v_last), 'truth', v_truth, 'rank', g.claim_rank,
                                                      'taker', v_taker_seat, 'n', cardinality(g.pile), 'auto', coalesce(p_auto, false)));
  if v_taker is not null then
    update public.bluff_players x set hand = x.hand || g.pile, emptied_at = null where x.room_id = p_room and x.user_id = v_taker;
  else
    update public.bluff_rooms x set bita = x.bita + cardinality(g.pile) where x.id = p_room;
  end if;
  update public.bluff_rooms x set pile = '{}', claim_rank = null, last_seat = null, last_n = 0 where x.id = p_room;
  if v_taker is not null then perform public.bluff_fours(p_room, v_taker); end if;
  perform public.bluff_outs(p_room, null);              -- круг кончился: все без карт (кроме забравшего) занимают места
  if public.bluff_end_check(p_room) then return; end if;
  if (p_kind = 'doubt' and not v_truth) or (p_kind = 'trust' and v_truth) then
    v_start := me.seat;                                 -- угадал — начинает новый круг
    if exists (select 1 from public.bluff_players x where x.room_id = p_room and x.seat = v_start and x.place is not null) then
      v_start := public.bluff_next(p_room, v_start);
    end if;
  else
    v_start := public.bluff_next(p_room, me.seat);      -- ошибся — забрал стопку и пропускает ход
  end if;
  update public.bluff_rooms x set turn_seat = v_start, deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
end $function$;
revoke all on function public.bluff_move(bigint, uuid, text, integer[], integer, boolean) from public, anon, authenticated;

-- Ход бота: без карт — только «Верю» или «Не верю»
create or replace function public.bluff_bot_move(p_room bigint, p_user uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.bluff_rooms%rowtype;
  me public.bluff_players%rowtype;
  v_prev public.bluff_players%rowtype;
  v_rank integer; v_cards integer[]; v_k integer; v_j integer; v_roll double precision := random();
begin
  select * into g from public.bluff_rooms x where x.id = p_room;
  select * into me from public.bluff_players x where x.room_id = p_room and x.user_id = p_user;
  if g.claim_rank is null then
    select c / 4 + 2 into v_rank from unnest(me.hand) c where c < 52 group by 1 order by count(*) desc, random() limit 1;
    if v_rank is null then                                   -- одни джокеры
      v_rank := g.low_rank + floor(random() * (g.high_rank - g.low_rank + 1))::integer;
      v_cards := me.hand[1:1];
    else
      v_cards := array(select c from unnest(me.hand) c where c < 52 and c / 4 + 2 = v_rank);
      if v_roll < 0.3 then
        v_cards := v_cards || array(select c from unnest(me.hand) c where not (c = any (v_cards)) order by random() limit 1);
      end if;
    end if;
    perform public.bluff_move(p_room, p_user, 'put', v_cards, v_rank, false);
    return;
  end if;
  select * into v_prev from public.bluff_players x where x.room_id = p_room and x.seat = g.last_seat;
  v_k := (select count(*) from unnest(me.hand) c where c < 52 and c / 4 + 2 = g.claim_rank);
  v_j := (select count(*) from unnest(me.hand) c where c >= 52);
  if cardinality(me.hand) = 0 then                           -- без карт: доложить нечего
    perform public.bluff_move(p_room, p_user,
      case when g.last_n > 4 + g.jokers or v_roll < 0.5 then 'doubt' else 'trust' end, null, null, false);
  elsif v_k + g.last_n > 4 + g.jokers or (cardinality(v_prev.hand) = 0 and v_roll < 0.6) then
    perform public.bluff_move(p_room, p_user, 'doubt', null, null, false);
  elsif v_k + v_j > 0 and v_roll < 0.7 then
    perform public.bluff_move(p_room, p_user, 'put',
      array(select c from unnest(me.hand) c where c >= 52 or c / 4 + 2 = g.claim_rank), null, false);
  elsif v_roll < 0.25 then
    perform public.bluff_move(p_room, p_user, 'doubt', null, null, false);
  elsif v_roll < 0.45 then
    perform public.bluff_move(p_room, p_user, 'trust', null, null, false);
  else
    perform public.bluff_move(p_room, p_user, 'put',
      array(select c from unnest(me.hand) c order by random() limit 1 + floor(random() * 2)::integer), null, false);
  end if;
end $function$;
revoke all on function public.bluff_bot_move(bigint, uuid) from public, anon, authenticated;

-- Часы комнаты: «Готов» вышел, время хода вышло, ход бота, один в комнате, сутки без игры
create or replace function public.bluff_tick(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.bluff_rooms%rowtype;
  p public.bluff_players%rowtype;
  v_card integer; v_next integer;
begin
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  if not found then return; end if;

  if g.status = 'open' then
    if g.created_at < now() - interval '24 hours'
       or not exists (select 1 from public.bluff_players x where x.room_id = g.id and x.bot_name is null) then
      perform public.bluff_cancel_room(g.id);
    elsif public.bluff_alone_at(g.id) <= now() then
      perform public.bluff_log(g.id, jsonb_build_object('kind', 'alone'));     -- телефону: почему закрыта
      perform public.bluff_cancel_room(g.id);
    end if;

  elsif g.status = 'ready' and g.deadline < now() - interval '2 seconds' then
    delete from public.bluff_players x where x.room_id = g.id and not x.ready;   -- не успели — ставка возвращается
    if (select count(*) from public.bluff_players x where x.room_id = g.id) >= 3 then
      perform public.bluff_deal(g.id);
    elsif exists (select 1 from public.bluff_players x where x.room_id = g.id and x.bot_name is null) then
      update public.bluff_players x set ready = x.bot_name is not null where x.room_id = g.id;
      update public.bluff_rooms x set status = 'open', deadline = null, version = x.version + 1 where x.id = g.id;
    else
      perform public.bluff_cancel_room(g.id);
    end if;

  elsif g.status = 'play' then
    select * into p from public.bluff_players x where x.room_id = g.id and x.seat = g.turn_seat and x.place is null;
    -- ход бота: через 1,5 секунды после начала хода (ход длится 30 секунд, срок = начало + 30)
    if found and p.bot_name is not null then
      if g.deadline - interval '28.5 seconds' <= now() then perform public.bluff_bot_move(g.id, p.user_id); end if;
      return;
    end if;
    if g.deadline >= now() - interval '2 seconds' then return; end if;
    if p.user_id is null then                               -- ход у того, кого уже нет, — следующему
      v_next := public.bluff_next(g.id, coalesce(g.turn_seat, 0));
      update public.bluff_rooms x set turn_seat = v_next, deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = g.id;
      return;
    end if;
    update public.bluff_players x set misses = x.misses + 1 where x.room_id = g.id and x.user_id = p.user_id;
    if p.misses + 1 >= 2 then
      -- второй пропуск подряд: выбывает на последнее свободное место, его карты уходят в биту
      update public.bluff_rooms x set bita = x.bita + cardinality(p.hand) where x.id = g.id;
      update public.bluff_players x set hand = '{}' where x.room_id = g.id and x.user_id = p.user_id;
      perform public.bluff_log(g.id, jsonb_build_object('kind', 'afk', 'seat', p.seat, 'out', public.bluff_place(g.id, p.user_id, 'afk')));
      if public.bluff_end_check(g.id) then return; end if;
      v_next := public.bluff_next(g.id, p.seat);
      if g.last_seat is not null and v_next = g.last_seat then  -- отвечать на свой же ход нельзя: стопка в биту, новый круг
        update public.bluff_rooms x set bita = x.bita + cardinality(x.pile), pile = '{}', claim_rank = null, last_seat = null, last_n = 0
         where x.id = g.id;
        perform public.bluff_outs(g.id, null);
        if public.bluff_end_check(g.id) then return; end if;
        if exists (select 1 from public.bluff_players x where x.room_id = g.id and x.seat = v_next and x.place is not null) then
          v_next := public.bluff_next(g.id, v_next);       -- он сам остался без карт и занял место — круг начинает следующий
        end if;
      end if;
      update public.bluff_rooms x set turn_seat = v_next, deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = g.id;
      return;
    end if;
    -- первый пропуск: база ходит за игрока
    if g.claim_rank is null then
      select c into v_card from unnest(p.hand) c order by (c >= 52), c limit 1;   -- новый круг: одна карта, честно
      perform public.bluff_move(g.id, p.user_id, 'put', array[v_card], case when v_card >= 52 then g.low_rank else v_card / 4 + 2 end, true);
    elsif cardinality(p.hand) = 0 then
      perform public.bluff_move(g.id, p.user_id, 'trust', null, null, true);       -- без карт: доложить нечего — «Верю»
    else
      select c into v_card from unnest(p.hand) c                                  -- доложить одну: подходящую, если есть
       order by (case when c >= 52 or c / 4 + 2 = g.claim_rank then 0 else 1 end), c limit 1;
      perform public.bluff_move(g.id, p.user_id, 'put', array[v_card], null, true);
    end if;
  end if;
end $function$;
revoke all on function public.bluff_tick(bigint) from public, anon, authenticated;

-- Выйти: до старта — ставка возвращается; во время игры — поражение
create or replace function public.bluff_leave(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.bluff_rooms%rowtype;
  p public.bluff_players%rowtype;
  v_next uuid; v_seat integer;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.bluff_tick(p_room);
  select * into g from public.bluff_rooms x where x.id = p_room for update;
  if not found then raise exception 'bluff_gone'; end if;
  select * into p from public.bluff_players x where x.room_id = p_room and x.user_id = uid;
  if not found then raise exception 'bluff_gone'; end if;

  if g.status = 'play' then
    if p.place is not null then raise exception 'bluff_gone'; end if;
    update public.bluff_rooms x set bita = x.bita + cardinality(p.hand) where x.id = p_room;
    update public.bluff_players x set hand = '{}' where x.room_id = p_room and x.user_id = uid;
    perform public.bluff_log(p_room, jsonb_build_object('kind', 'left', 'seat', p.seat, 'out', public.bluff_place(p_room, uid, 'left')));
    -- клал последним — проверять некого: стопка в биту, круг окончен (кто был в круге без карт — занимает место)
    if g.last_seat = p.seat then
      update public.bluff_rooms x set bita = x.bita + cardinality(x.pile), pile = '{}', claim_rank = null, last_seat = null, last_n = 0
       where x.id = p_room;
      perform public.bluff_outs(p_room, null);
    end if;
    if public.bluff_end_check(p_room) then return; end if;
    if exists (select 1 from public.bluff_players x where x.room_id = p_room and x.seat = g.turn_seat and x.place is not null) then
      v_seat := public.bluff_next(p_room, g.turn_seat);   -- ход был у вышедшего (или у того, кто сейчас занял место) — следующему
      update public.bluff_rooms x set turn_seat = v_seat, deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
    elsif g.last_seat = p.seat then
      update public.bluff_rooms x set deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
    end if;
    return;
  end if;

  if g.status not in ('open', 'ready') then raise exception 'bluff_gone'; end if;
  delete from public.bluff_players x where x.room_id = p_room and x.user_id = uid;
  select x.user_id into v_next from public.bluff_players x where x.room_id = p_room and x.bot_name is null order by x.joined_at limit 1;
  if v_next is null then
    perform public.bluff_cancel_room(p_room);
    return;
  end if;
  update public.bluff_players x set ready = x.bot_name is not null where x.room_id = p_room;
  update public.bluff_rooms x
     set creator = case when x.creator = uid then v_next else x.creator end,
         status = 'open', deadline = null, version = x.version + 1
   where x.id = p_room;
end $function$;
revoke all on function public.bluff_leave(bigint) from public, anon;
grant execute on function public.bluff_leave(bigint) to authenticated;
