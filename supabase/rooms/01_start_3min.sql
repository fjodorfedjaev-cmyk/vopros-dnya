-- КОМНАТЫ: ИГРА НЕ НАЧАЛАСЬ ЗА 3 МИНУТЫ — КОМНАТА ЗАКРЫВАЕТСЯ (23.11.2026), во всех играх с комнатами.
--
-- Как устроено (простыми словами):
-- * Дурак и «Верю — не верю»: открытая комната (ещё не раздавали) живёт 3 минуты с момента создания
--   (и «Ещё раз» — тоже: это новая комната). Не началась — закрывается, ставки возвращаются.
--   Прежнее правило «один в комнате минуту — закрыть» остаётся: что наступит раньше.
--   Для этого «когда закрыть» (durak_alone_at / bluff_alone_at) теперь = раньшее из «один минуту» и «3 минуты с создания».
--   Эти функции уже зовут вид комнаты (поле alone_ms — отсчёт на телефоне), список комнат и часы комнаты,
--   поэтому их самих переписывать не нужно. Часы комнаты (durak_tick / bluff_tick) пишут в журнал причину:
--   'alone' — один минуту, 'expired' — 3 минуты без игры. Тестовые комнаты с ботами не трогаем.
-- * Покер: менять нечего — раздача начинается сама, как только сели двое, а один за столом минуту — стол закрывается.
-- * Дуэли: вызов и открытая комната ждут 3 минуты (было — сутки), после «Принять» на «Готов» — 3 минуты (было — 15).
--   Не успели — ставки возвращаются (как раньше после суток).
-- * Расписания нет, как и раньше: закрывает тот, кто смотрит комнату или список.

-- 1. Когда закрыть открытую комнату Дурака: один минуту или 3 минуты с создания — что раньше
create or replace function public.durak_alone_at(p_room bigint)
returns timestamptz
language sql stable security definer set search_path to ''
as $function$
  select least(g.created_at + interval '3 minutes', coalesce(g.alone_since + interval '1 minute', 'infinity'::timestamptz))
    from public.durak_rooms g
   where g.id = p_room and g.status = 'open' and not g.test
$function$;
revoke all on function public.durak_alone_at(bigint) from public, anon, authenticated;

-- 2. То же для «Верю — не верю»
create or replace function public.bluff_alone_at(p_room bigint)
returns timestamptz
language sql stable security definer set search_path to ''
as $function$
  select least(g.created_at + interval '3 minutes', coalesce(g.alone_since + interval '1 minute', 'infinity'::timestamptz))
    from public.bluff_rooms g
   where g.id = p_room and g.status = 'open' and not g.test
$function$;
revoke all on function public.bluff_alone_at(bigint) from public, anon, authenticated;

-- 3. Часы комнаты Дурака — как были (взяты с рабочей базы), меняется только причина закрытия в журнале
create or replace function public.durak_tick(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.durak_rooms%rowtype;
  p public.durak_players%rowtype;
  v_card integer; v_src text; v_pos integer;
begin
  select * into g from public.durak_rooms x where x.id = p_room for update;
  if not found then return; end if;

  if g.status = 'open' then
    if g.created_at < now() - interval '24 hours'
       or not exists (select 1 from public.durak_players x where x.room_id = g.id and x.bot_name is null) then
      perform public.durak_cancel_room(g.id);
    elsif public.durak_alone_at(g.id) <= now() then
      -- один в комнате минуту или игра не началась за 3 минуты — комната закрывается, ставки возвращаются
      -- (телефону в журнал: почему — 'alone' или 'expired')
      perform public.durak_log(g.id, jsonb_build_object('kind',
        case when g.alone_since is not null and g.alone_since + interval '1 minute' <= now() then 'alone' else 'expired' end));
      perform public.durak_cancel_room(g.id);
    end if;

  elsif g.status = 'ready' and g.deadline < now() - interval '2 seconds' then
    delete from public.durak_players x where x.room_id = g.id and not x.ready;   -- не успели — ставка возвращается
    if (select count(*) from public.durak_players x where x.room_id = g.id) >= 2 then
      perform public.durak_deal(g.id);
    elsif exists (select 1 from public.durak_players x where x.room_id = g.id) then
      update public.durak_players x set ready = false where x.room_id = g.id;
      update public.durak_rooms x set status = 'open', deadline = null, version = x.version + 1 where x.id = g.id;
    else
      perform public.durak_cancel_room(g.id);
    end if;

  elsif g.status = 'choose' and g.deadline < now() - interval '2 seconds' then
    -- не выбрали — открытыми кладутся три случайные из шести, остальные три — в руку
    update public.durak_players x
       set open = array(select y from unnest(x.pick) y order by random() limit 3)
     where x.room_id = g.id and not x.chosen;
    update public.durak_players x
       set hand = array(select y from unnest(x.pick) y where y <> all (x.open)), pick = '{}', chosen = true
     where x.room_id = g.id and not x.chosen;
    perform public.durak_begin(g.id);

  elsif g.status = 'play' then
    select * into p from public.durak_players x where x.room_id = g.id and x.seat = g.turn_seat and x.place is null;
    -- ход бота: через 1,5 секунды после начала хода (ход длится 30 секунд, срок = начало + 30)
    if found and p.bot_name is not null then
      if g.deadline - interval '28.5 seconds' <= now() then
        perform public.durak_bot_move(g.id, p.user_id);
      end if;
      return;
    end if;
    if g.deadline >= now() - interval '2 seconds' then return; end if;
    if p.user_id is null then
      perform public.durak_after(g.id, coalesce(g.turn_seat, 0), false);
      return;
    end if;
    update public.durak_players x set misses = x.misses + 1 where x.room_id = g.id and x.user_id = p.user_id;
    if p.misses + 1 >= 2 then
      -- второй пропуск подряд: выбывает на последнее свободное место, его карты уходят в биту
      update public.durak_rooms x
         set bita = x.bita + cardinality(p.hand) + cardinality(array_remove(p.open, null)) + cardinality(array_remove(p.closed, null))
       where x.id = g.id;
      update public.durak_players x set hand = '{}', open = '{}', closed = '{}' where x.room_id = g.id and x.user_id = p.user_id;
      perform public.durak_log(g.id, jsonb_build_object('kind', 'afk', 'seat', p.seat, 'out', public.durak_place(g.id, p.user_id, 'afk')));
      perform public.durak_after(g.id, p.seat, false);
    elsif cardinality(g.pile) > 0 then
      perform public.durak_move(g.id, p.user_id, 'take', null, null, true);
    else
      -- стол пустой: база кладёт самую младшую карту (закрытые — первую по порядку)
      v_src := case when cardinality(p.hand) > 0 then 'hand' when cardinality(array_remove(p.open, null)) > 0 then 'open' else 'closed' end;
      if v_src = 'closed' then
        select t.i into v_pos from unnest(p.closed) with ordinality t(x, i) where t.x is not null order by t.i limit 1;
        perform public.durak_move(g.id, p.user_id, 'flip', null, v_pos::integer, true);
      else
        select min(x) into v_card from unnest(case when v_src = 'hand' then p.hand else p.open end) x;
        perform public.durak_move(g.id, p.user_id, 'play', array[v_card], null, true);
      end if;
    end if;
  end if;
end $function$;
revoke all on function public.durak_tick(bigint) from public, anon, authenticated;

-- 4. Часы комнаты «Верю — не верю» — как были (с рабочей базы), меняется только причина закрытия в журнале
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
      -- один в комнате минуту или игра не началась за 3 минуты (телефону: почему — 'alone' или 'expired')
      perform public.bluff_log(g.id, jsonb_build_object('kind',
        case when g.alone_since is not null and g.alone_since + interval '1 minute' <= now() then 'alone' else 'expired' end));
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

-- 5. Дуэли: вызов и комната — 3 минуты (было — сутки), «Готов» после принятия — 3 минуты (было — 15)
create or replace function public.duel_timeouts(p_id bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare d public.sector_duels%rowtype;
begin
  select * into d from public.sector_duels x where x.id = p_id for update;
  if not found then return; end if;
  if d.status in ('invited', 'open') and d.created_at < now() - interval '3 minutes' then
    update public.sector_duels x set status = 'expired' where x.id = d.id;
    insert into public.points_ledger (user_id, amount, reason, ref) values (d.p1, d.stake, 'duel', 'duel:' || d.id || ':back1')
    on conflict do nothing;
  elsif d.status = 'accepted' and d.accepted_at < now() - interval '3 minutes' then
    update public.sector_duels x set status = 'cancelled' where x.id = d.id;
    insert into public.points_ledger (user_id, amount, reason, ref) values
      (d.p1, d.stake, 'duel', 'duel:' || d.id || ':back1'),
      (d.p2, d.stake, 'duel', 'duel:' || d.id || ':back2')
    on conflict do nothing;
  elsif d.status = 'playing' and now() > d.start_at + interval '20 seconds' then
    -- кто не закончил и не подавал знак больше 20 секунд (или игра идёт дольше 30 минут) — вышел из игры
    if d.p1_end is null and (coalesce(d.p1_seen, d.start_at) < now() - interval '20 seconds' or now() > d.start_at + interval '30 minutes') then
      update public.sector_duels x set p1_end = 'forfeit', p1_score = x.p1_progress where x.id = d.id;
    end if;
    if d.p2_end is null and (coalesce(d.p2_seen, d.start_at) < now() - interval '20 seconds' or now() > d.start_at + interval '30 minutes') then
      update public.sector_duels x set p2_end = 'forfeit', p2_score = x.p2_progress where x.id = d.id;
    end if;
    perform public.duel_settle(d.id);
  end if;
end $function$;
revoke all on function public.duel_timeouts(bigint) from public, anon, authenticated;

-- 6. Список дуэлей: чужие открытые комнаты старше 3 минут закрываются при просмотре списка (было — сутки)
create or replace function public.duel_list()
returns table (id bigint, status text, stake integer, i_am_p1 boolean, opp_id uuid, opp_name text, opp_color text, opp_avatar text,
               my_ready boolean, my_score integer, opp_score integer, outcome text, created_at timestamptz, room boolean, joinable boolean)
language plpgsql security definer set search_path to ''
as $function$
declare uid uuid := auth.uid(); r record;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  for r in select x.id from public.sector_duels x
           where (uid in (x.p1, x.p2) and x.status in ('invited', 'open', 'accepted', 'playing'))
              or (x.status = 'open' and x.created_at < now() - interval '3 minutes') loop
    perform public.duel_timeouts(r.id);
  end loop;
  return query
    select x.id, x.status, x.stake, x.p1 = uid, o.id, o.display_name, o.color, o.avatar,
           case when x.p1 = uid then x.p1_ready else x.p2_ready end,
           case when x.p1 = uid then x.p1_score else x.p2_score end,
           case when x.status = 'finished' then case when x.p1 = uid then x.p2_score else x.p1_score end end,
           case when x.status <> 'finished' then null
                when x.result = 'draw' then 'draw'
                when (x.result = 'p1') = (x.p1 = uid) then 'win' else 'lose' end,
           x.created_at, x.room, x.status = 'open' and x.p1 <> uid
    from public.sector_duels x
    left join public.profiles o on o.id = case when x.p1 = uid then x.p2 else x.p1 end
    where (uid in (x.p1, x.p2)
           and (x.status in ('invited', 'open', 'accepted', 'playing')
                or (x.status = 'finished' and x.finished_at > now() - interval '7 days')))
       or (x.status = 'open' and x.p1 <> uid)
    order by (x.status in ('invited', 'open', 'accepted', 'playing')) desc, x.created_at desc
    limit 30;
end $function$;
revoke all on function public.duel_list() from public, anon;
grant execute on function public.duel_list() to authenticated;
