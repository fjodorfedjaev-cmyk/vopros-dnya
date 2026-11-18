-- «ДУРАК»: тестовые комнаты с ботами — только для админа, чтобы проверять игру без живых людей.
--
-- Как устроено (простыми словами):
-- * Админ открывает «тестовую комнату». Её видит только он: в списке у других её нет, зайти в неё нельзя,
--   уведомлений о ней нет, ставка всегда 0 (экономику не трогаем).
-- * Кнопка «Добавить бота» сажает за стол бота (до 5 мест вместе с админом). Ботов можно убрать до начала.
-- * Боты — не участники сайта: у них нет профиля, их нет в «Участниках», рейтингах и статистике.
--   Бот существует только как место за столом (durak_players с заполненным bot_name).
-- * Бот всегда «Готов», открытыми кладёт три старшие карты, а ходит сам через 1,5 секунды после начала своего хода:
--   кладёт самую младшую подходящую обычную карту (все такие сразу), особые (8, 2, 10) — только если больше нечем;
--   нечем — забирает стопку; на закрытых — открывает случайную.
-- * «Ещё раз» в тестовой комнате — новая тестовая комната с теми же ботами.
-- * Если за столом тестовой комнаты не осталось живых игроков, партия сразу заканчивается (места ботам — по числу карт):
--   боты между собой могут перекидывать стопку бесконечно.
-- * Для всех комнат: кто уже вышел из партии с местом, может сразу открыть новую комнату или зайти в другую.

-- 1. Пометки: тестовая комната и имя бота у места за столом.
--    Связь игрока с профилем убираем (у ботов профиля нет); живых игроков в комнату по-прежнему
--    добавляют только функции durak_*, и только участников сайта.
alter table public.durak_rooms add column test boolean not null default false;
alter table public.durak_players add column bot_name text;
alter table public.durak_players drop constraint durak_players_user_id_fkey;

-- Четыре бота (постоянные номера, чтобы «Ещё раз» сажал тех же)
create or replace function public.durak_bot_list()
returns table (id uuid, name text)
language sql immutable set search_path to ''
as $function$
  values ('00000000-0000-4000-8000-0000000000b1'::uuid, 'Бот Альфа'),
         ('00000000-0000-4000-8000-0000000000b2'::uuid, 'Бот Бета'),
         ('00000000-0000-4000-8000-0000000000b3'::uuid, 'Бот Гамма'),
         ('00000000-0000-4000-8000-0000000000b4'::uuid, 'Бот Дельта')
$function$;
revoke all on function public.durak_bot_list() from public, anon, authenticated;

-- 2. Ход бота (зовёт durak_tick, когда наступил ход бота и прошло 1,5 секунды)
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
  -- обычно — самая младшая обычная карта; иногда (15%) — случайная подходящая, чтобы игра была разной
  select t.r into v_rank from (
    select distinct x / 4 + 2 as r from unnest(v_from) x where x is not null and public.durak_fits(x / 4 + 2, v_need)
  ) t
  order by case when random() < 0.15 then random() else 0 end, case t.r when 8 then 1 when 2 then 2 when 10 then 3 else 0 end, t.r
  limit 1;
  if v_rank is null then
    perform public.durak_move(p_room, p_user, 'take', null, null, false);
  else
    perform public.durak_move(p_room, p_user, 'play',
      array(select x from unnest(v_from) x where x is not null and x / 4 + 2 = v_rank), null, false);
  end if;
end $function$;
revoke all on function public.durak_bot_move(bigint, uuid) from public, anon, authenticated;

-- 2б. После действия: остался один — итог; в тестовой комнате не осталось живых — итог сразу;
--     иначе ход тому же (после биты) или следующему
create or replace function public.durak_after(p_room bigint, p_seat integer, p_again boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_next integer; v_user uuid;
begin
  if (select g.test from public.durak_rooms g where g.id = p_room)
     and not exists (select 1 from public.durak_players x where x.room_id = p_room and x.place is null and x.bot_name is null)
     and (select count(*) from public.durak_players x where x.room_id = p_room and x.place is null) > 1 then
    -- одни боты: места по числу оставшихся карт (меньше карт — выше место)
    update public.durak_players x set place = t.pl, out_kind = 'last'
      from (select y.user_id,
                   (select count(*) from public.durak_players z where z.room_id = p_room and z.out_kind = 'done')
                   + row_number() over (order by cardinality(y.hand) + cardinality(array_remove(y.open, null)) + cardinality(array_remove(y.closed, null)), y.seat) as pl
              from public.durak_players y where y.room_id = p_room and y.place is null) t
     where x.room_id = p_room and x.user_id = t.user_id;
    perform public.durak_finish(p_room);
    return;
  end if;
  if (select count(*) from public.durak_players x where x.room_id = p_room and x.place is null) <= 1 then
    select x.user_id into v_user from public.durak_players x where x.room_id = p_room and x.place is null;
    if v_user is not null then
      update public.durak_players x
         set place = 1 + (select count(*) from public.durak_players y where y.room_id = p_room and y.out_kind = 'done'), out_kind = 'last'
       where x.room_id = p_room and x.user_id = v_user;
    end if;
    perform public.durak_finish(p_room);
    return;
  end if;
  if p_again and exists (select 1 from public.durak_players x where x.room_id = p_room and x.seat = p_seat and x.place is null) then
    v_next := p_seat;
  else
    select x.seat into v_next from public.durak_players x
     where x.room_id = p_room and x.place is null
     order by (x.seat <= p_seat), x.seat limit 1;
  end if;
  update public.durak_rooms g set turn_seat = v_next, deadline = now() + interval '30 seconds', version = g.version + 1
   where g.id = p_room;
end $function$;
revoke all on function public.durak_after(bigint, integer, boolean) from public, anon, authenticated;

-- 3. Раздача: боты сразу кладут открытыми три старшие
create or replace function public.durak_deal(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_deck integer[];
  r record;
  i integer := 0;
begin
  v_deck := array(select x from generate_series(0, 51) x order by random());
  for r in select x.user_id from public.durak_players x where x.room_id = p_room order by x.seat, x.joined_at loop
    update public.durak_players x
       set seat = i, closed = v_deck[1:3], pick = v_deck[4:9], open = '{}', hand = '{}',
           chosen = false, misses = 0, place = null, out_kind = null, payout = null
     where x.room_id = p_room and x.user_id = r.user_id;
    v_deck := v_deck[10:cardinality(v_deck)];
    i := i + 1;
  end loop;
  update public.durak_rooms g
     set status = 'choose', deck = v_deck, pile = '{}', bita = 0, turn_seat = null,
         deadline = now() + interval '60 seconds', started_at = now(), log = '[]', version = g.version + 1
   where g.id = p_room;
  update public.durak_players x
     set open = array(select y from unnest(x.pick) y order by y desc limit 3),
         hand = array(select y from unnest(x.pick) y order by y desc offset 3),
         pick = '{}', chosen = true
   where x.room_id = p_room and x.bot_name is not null;
  if not exists (select 1 from public.durak_players x where x.room_id = p_room and not x.chosen) then
    perform public.durak_begin(p_room);
  end if;
end $function$;
revoke all on function public.durak_deal(bigint) from public, anon, authenticated;

-- 4. Сроки + ход бота
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
    -- не выбрали — открытыми кладутся три старшие
    update public.durak_players x
       set open = array(select y from unnest(x.pick) y order by y desc limit 3),
           hand = array(select y from unnest(x.pick) y order by y desc offset 3),
           pick = '{}', chosen = true
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

-- 5. Войти в комнату: в тестовую — никому
create or replace function public.durak_enter(p_room bigint, p_user uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  g public.durak_rooms%rowtype;
  v_seat integer;
begin
  select * into g from public.durak_rooms x where x.id = p_room for update;
  if not found or g.status <> 'open' then raise exception 'durak_gone'; end if;
  if exists (select 1 from public.durak_players x where x.room_id = p_room and x.user_id = p_user) then return; end if;
  if g.test then raise exception 'durak_gone'; end if;
  if exists (select 1 from public.durak_players x join public.durak_rooms r on r.id = x.room_id
             where x.user_id = p_user and x.place is null and r.status in ('open', 'ready', 'choose', 'play')) then
    raise exception 'durak_busy';
  end if;
  if (select count(*) from public.durak_players x where x.room_id = p_room) >= 5 then raise exception 'durak_full'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || p_user::text));
  if public.coins_of(p_user) < g.stake then raise exception 'durak_not_enough'; end if;
  select min(s) into v_seat from generate_series(0, 4) s
   where s not in (select x.seat from public.durak_players x where x.room_id = p_room);
  insert into public.durak_players (room_id, user_id, seat, stake) values (p_room, p_user, v_seat, g.stake);
  update public.durak_rooms x set version = x.version + 1 where x.id = p_room;
end $function$;
revoke all on function public.durak_enter(bigint, uuid) from public, anon, authenticated;

-- 6. Новая комната: p_test — тестовая (только админ, ставка 0, без уведомлений, не считается в лимите 3 комнат)
drop function public.durak_create(integer);
drop function public.durak_new(uuid, integer, bigint);
create or replace function public.durak_new(p_user uuid, p_stake integer, p_from bigint, p_test boolean)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
declare v_id bigint;
begin
  if p_test and not exists (select 1 from public.admins a where a.user_id = p_user) then raise exception 'not_admin'; end if;
  if p_test then p_stake := 0; end if;
  if p_stake is null or p_stake < 0 or p_stake > 100000 then raise exception 'durak_bad_stake'; end if;
  if exists (select 1 from public.durak_players x join public.durak_rooms r on r.id = x.room_id
             where x.user_id = p_user and x.place is null and r.status in ('open', 'ready', 'choose', 'play')) then
    raise exception 'durak_busy';
  end if;
  perform pg_advisory_xact_lock(hashtext('durak:rooms'));
  if not p_test and (select count(*) from public.durak_rooms r where r.status in ('open', 'ready') and not r.test) >= 3 then
    raise exception 'durak_too_many';
  end if;
  perform pg_advisory_xact_lock(hashtext('points:' || p_user::text));
  if public.coins_of(p_user) < p_stake then raise exception 'durak_not_enough'; end if;
  insert into public.durak_rooms (creator, stake, rematch_of, test) values (p_user, p_stake, p_from, p_test) returning id into v_id;
  insert into public.durak_players (room_id, user_id, seat, stake) values (v_id, p_user, 0, p_stake);
  if not p_test and exists (select 1 from public.push_subscriptions ps where ps.user_id <> p_user and ps.active) then
    perform public.push_call(jsonb_build_object('type', 'durak', 'room_id', v_id, 'event', 'room'));
  end if;
  return v_id;
end $function$;
revoke all on function public.durak_new(uuid, integer, bigint, boolean) from public, anon, authenticated;

create or replace function public.durak_create(p_stake integer, p_test boolean default false)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  return public.durak_new(auth.uid(), p_stake, null, coalesce(p_test, false));
end $function$;
revoke all on function public.durak_create(integer, boolean) from public, anon;
grant execute on function public.durak_create(integer, boolean) to authenticated;

-- 7. Посадить бота / убрать бота (только админ, только своя тестовая комната до начала)
create or replace function public.durak_add_bot(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.durak_rooms%rowtype;
  v_bot uuid; v_name text; v_seat integer;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  select * into g from public.durak_rooms x where x.id = p_room for update;
  if not found or not g.test or g.status <> 'open'
     or not exists (select 1 from public.durak_players x where x.room_id = p_room and x.user_id = uid) then
    raise exception 'durak_gone';
  end if;
  if (select count(*) from public.durak_players x where x.room_id = p_room) >= 5 then raise exception 'durak_full'; end if;
  select b.id, b.name into v_bot, v_name from public.durak_bot_list() b
   where b.id not in (select x.user_id from public.durak_players x where x.room_id = p_room)
   order by b.id limit 1;
  select min(s) into v_seat from generate_series(0, 4) s
   where s not in (select x.seat from public.durak_players x where x.room_id = p_room);
  insert into public.durak_players (room_id, user_id, seat, stake, bot_name, ready) values (p_room, v_bot, v_seat, 0, v_name, true);
  update public.durak_rooms x set version = x.version + 1 where x.id = p_room;
end $function$;
revoke all on function public.durak_add_bot(bigint) from public, anon;
grant execute on function public.durak_add_bot(bigint) to authenticated;

create or replace function public.durak_remove_bot(p_room bigint, p_bot uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare uid uuid := auth.uid();
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  perform 1 from public.durak_rooms x where x.id = p_room and x.test and x.status = 'open' for update;
  if not found or not exists (select 1 from public.durak_players x where x.room_id = p_room and x.user_id = uid) then
    raise exception 'durak_gone';
  end if;
  delete from public.durak_players x where x.room_id = p_room and x.user_id = p_bot and x.bot_name is not null;
  update public.durak_rooms x set version = x.version + 1 where x.id = p_room;
end $function$;
revoke all on function public.durak_remove_bot(bigint, uuid) from public, anon;
grant execute on function public.durak_remove_bot(bigint, uuid) to authenticated;

-- 8. Выйти до раздачи: комнату ведёт следующий живой игрок; остались одни боты — комната закрывается
create or replace function public.durak_leave(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.durak_rooms%rowtype;
  v_next uuid;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.durak_tick(p_room);
  select * into g from public.durak_rooms x where x.id = p_room for update;
  if not found or g.status not in ('open', 'ready')
     or not exists (select 1 from public.durak_players x where x.room_id = p_room and x.user_id = uid) then
    raise exception 'durak_gone';
  end if;
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

-- 9. «Начать»: боты готовы сразу; готовы все — раздача без ожидания
create or replace function public.durak_start(p_room bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.durak_rooms%rowtype;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.durak_tick(p_room);
  select * into g from public.durak_rooms x where x.id = p_room for update;
  if not found or g.status <> 'open' or g.creator <> uid then raise exception 'durak_gone'; end if;
  if (select count(*) from public.durak_players x where x.room_id = p_room) < 2 then raise exception 'durak_alone'; end if;
  update public.durak_players x set ready = (x.user_id = uid or x.bot_name is not null) where x.room_id = p_room;
  update public.durak_rooms x set status = 'ready', deadline = now() + interval '30 seconds', version = x.version + 1 where x.id = p_room;
  if not exists (select 1 from public.durak_players x where x.room_id = p_room and not x.ready) then
    perform public.durak_deal(p_room);
  elsif not g.test and exists (select 1 from public.push_subscriptions ps join public.durak_players x on x.user_id = ps.user_id
             where x.room_id = p_room and x.user_id <> uid and ps.active) then
    perform public.push_call(jsonb_build_object('type', 'durak', 'room_id', p_room, 'event', 'start'));
  end if;
end $function$;

-- 10. «Ещё раз»: в тестовой комнате — новая тестовая с теми же ботами
create or replace function public.durak_rematch(p_room bigint)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  g public.durak_rooms%rowtype;
  v_id bigint;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select * into g from public.durak_rooms x where x.id = p_room for update;
  if not found or g.status <> 'finished'
     or not exists (select 1 from public.durak_players x where x.room_id = p_room and x.user_id = uid) then
    raise exception 'durak_gone';
  end if;
  if g.rematch_id is not null then
    perform public.durak_tick(g.rematch_id);
    if exists (select 1 from public.durak_players x where x.room_id = g.rematch_id and x.user_id = uid) then
      return g.rematch_id;
    end if;
    if exists (select 1 from public.durak_rooms x where x.id = g.rematch_id and x.status = 'open') then
      perform public.durak_enter(g.rematch_id, uid);
      update public.durak_rooms x set version = x.version + 1 where x.id = p_room;   -- остальные увидят «уже N в комнате»
      return g.rematch_id;
    end if;
  end if;
  v_id := public.durak_new(uid, g.stake, g.id, g.test);
  if g.test then
    insert into public.durak_players (room_id, user_id, seat, stake, bot_name, ready)
    select v_id, x.user_id, row_number() over (order by x.seat)::integer, 0, x.bot_name, true
      from public.durak_players x where x.room_id = p_room and x.bot_name is not null;
  end if;
  update public.durak_rooms x set rematch_id = v_id, version = x.version + 1 where x.id = p_room;
  return v_id;
end $function$;

-- 11. Вид комнаты: имена ботов, пометка «тестовая»; в свой ход бот ходит при опросе телефона
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
    'deck_n', cardinality(g.deck), 'bita', g.bita, 'log', g.log,
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

-- 12. Список: чужие тестовые комнаты не видны; имена ботов
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
        or (g.status in ('choose', 'play') and exists (select 1 from public.durak_players x where x.room_id = g.id and x.user_id = uid))
        or (g.status = 'finished' and g.finished_at > now() - interval '3 days'
            and exists (select 1 from public.durak_players x where x.room_id = g.id and x.user_id = uid))
     order by g.created_at desc
     limit 20
  ) t;
  return v;
end $function$;
