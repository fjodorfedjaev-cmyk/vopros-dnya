-- ДУЭЛИ В «СЕКТОРЕ»: один на один на монеты.
--
-- Как устроено (простыми словами):
-- * Вызов: выбираешь друга и ставку (целые монеты). Ставка сразу уходит из баланса «в банк».
--   Друг принимает (его ставка тоже уходит в банк) или отказывается (твоя ставка возвращается).
-- * Комната: то же, но без соперника — зайти может любой (его ставка уходит в банк). Не больше 3 открытых комнат.
-- * Оба жмут «Готов» — база назначает старт через 4 секунды. Игра одинаковая: у дуэли одно «зерно».
-- * Во время игры телефоны сообщают счёт (его видит соперник) — это заодно знак «я ещё играю».
-- * Итог считает не телефон: функция duel-submit переигрывает партию по зерну и записи нажатий
--   (тем же ядром sector-core.js) и записывает результат сюда (duel_store_result, только с ключом сервера).
-- * Победа: соперник уже закончил, а ты его обогнал — игра останавливается, победа твоя.
--   Свернул приложение или пропал больше чем на 20 секунд — проигрыш.
--   Счёт равный — решает число PERFECT, а если и оно равное — ставки возвращаются.
-- * Победитель забирает весь банк (комиссии пока нет). Обычные монеты за очки в дуэли не даются,
--   рекорд из дуэли в рейтинг не попадает (результаты дуэлей живут только здесь).
-- * Очки в дуэли — по трём зонам сектора: края 1, ближе к центру 2, центр 3 (это считает ядро игры).
-- * Сроки: вызов и комната ждут сутки; после принятия на «Готов» — 15 минут; иначе всё возвращается.

-- 1. Монеты: новая причина записи в книге — 'duel'
alter table public.points_ledger drop constraint points_ledger_reason_check;
alter table public.points_ledger add constraint points_ledger_reason_check
  check (reason = any (array['question', 'fill', 'streak', 'game', 'poll', 'suggest', 'cards', 'duel']));

-- 2. Дуэли. p1 — кто вызвал (или открыл комнату), p2 — кого вызвали (в комнате — кто зашёл; до этого пусто).
create table public.sector_duels (
  id bigint generated always as identity primary key,
  p1 uuid not null references public.profiles (id) on delete cascade,
  p2 uuid references public.profiles (id) on delete cascade,
  room boolean not null default false,
  stake integer not null check (stake between 1 and 100000),
  seed integer not null default (1 + floor(random() * 2147483646))::integer,
  status text not null default 'invited'
    check (status in ('open', 'invited', 'accepted', 'playing', 'finished', 'declined', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  p1_ready boolean not null default false,
  p2_ready boolean not null default false,
  start_at timestamptz,
  p1_progress integer not null default 0,
  p2_progress integer not null default 0,
  p1_seen timestamptz,
  p2_seen timestamptz,
  p1_score integer, p2_score integer,
  p1_hits integer, p2_hits integer,
  p1_perfects integer, p2_perfects integer,
  p1_end text check (p1_end in ('miss', 'skip', 'win', 'quit', 'forfeit')),
  p2_end text check (p2_end in ('miss', 'skip', 'win', 'quit', 'forfeit')),
  p1_presses jsonb, p2_presses jsonb,
  result text check (result in ('p1', 'p2', 'draw')),
  finished_at timestamptz,
  check (p1 <> p2),
  check (p2 is not null or status in ('open', 'cancelled', 'expired'))
);
create index sector_duels_p1_idx on public.sector_duels (p1, created_at desc);
create index sector_duels_p2_idx on public.sector_duels (p2, created_at desc);
alter table public.sector_duels enable row level security;
revoke all on public.sector_duels from anon, authenticated;

-- 3. Итог: кто выиграл и выплата из банка. Вызывается, когда у обоих есть конец игры.
create or replace function public.duel_settle(p_id bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  d public.sector_duels%rowtype;
  r text;
  l1 boolean; l2 boolean;
begin
  select * into d from public.sector_duels x where x.id = p_id for update;
  if d.status <> 'playing' or d.p1_end is null or d.p2_end is null then return; end if;
  l1 := d.p1_end in ('quit', 'forfeit');
  l2 := d.p2_end in ('quit', 'forfeit');
  if l1 and l2 then r := 'draw';
  elsif l1 then r := 'p2';
  elsif l2 then r := 'p1';
  elsif d.p1_score > d.p2_score then r := 'p1';
  elsif d.p1_score < d.p2_score then r := 'p2';
  elsif coalesce(d.p1_perfects, 0) > coalesce(d.p2_perfects, 0) then r := 'p1';
  elsif coalesce(d.p1_perfects, 0) < coalesce(d.p2_perfects, 0) then r := 'p2';
  else r := 'draw';
  end if;
  if r = 'draw' then
    insert into public.points_ledger (user_id, amount, reason, ref) values
      (d.p1, d.stake, 'duel', 'duel:' || d.id || ':back1'),
      (d.p2, d.stake, 'duel', 'duel:' || d.id || ':back2')
    on conflict do nothing;
  else
    insert into public.points_ledger (user_id, amount, reason, ref)
      values (case when r = 'p1' then d.p1 else d.p2 end, d.stake * 2, 'duel', 'duel:' || d.id || ':win')
    on conflict do nothing;
  end if;
  update public.sector_duels x set status = 'finished', result = r, finished_at = now() where x.id = d.id;
end $function$;
revoke all on function public.duel_settle(bigint) from public, anon, authenticated;

-- 4. Сроки: просроченные вызовы, долгое ожидание «Готов», пропавшие игроки
create or replace function public.duel_timeouts(p_id bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare d public.sector_duels%rowtype;
begin
  select * into d from public.sector_duels x where x.id = p_id for update;
  if not found then return; end if;
  if d.status in ('invited', 'open') and d.created_at < now() - interval '24 hours' then
    update public.sector_duels x set status = 'expired' where x.id = d.id;
    insert into public.points_ledger (user_id, amount, reason, ref) values (d.p1, d.stake, 'duel', 'duel:' || d.id || ':back1')
    on conflict do nothing;
  elsif d.status = 'accepted' and d.accepted_at < now() - interval '15 minutes' then
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

-- 5. Вызвать друга (p_opponent) или открыть комнату для любого (p_opponent пустой)
create or replace function public.duel_create(p_opponent uuid, p_stake integer)
returns bigint
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  did bigint;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  if p_opponent is not null and (p_opponent = uid or not exists (select 1 from public.profiles p where p.id = p_opponent)) then
    raise exception 'duel_bad_opponent';
  end if;
  if p_stake is null or p_stake < 1 or p_stake > 100000 then raise exception 'duel_bad_stake'; end if;
  if p_opponent is not null and exists (select 1 from public.sector_duels x
             where x.status in ('invited', 'accepted', 'playing')
               and ((x.p1 = uid and x.p2 = p_opponent) or (x.p1 = p_opponent and x.p2 = uid))) then
    raise exception 'duel_exists';
  end if;
  if p_opponent is null and (select count(*) from public.sector_duels x where x.p1 = uid and x.status = 'open') >= 3 then
    raise exception 'duel_too_many';
  end if;
  perform pg_advisory_xact_lock(hashtext('points:' || uid::text));
  if public.coins_of(uid) < p_stake then raise exception 'duel_not_enough'; end if;
  insert into public.sector_duels (p1, p2, stake, room, status)
    values (uid, p_opponent, p_stake, p_opponent is null, case when p_opponent is null then 'open' else 'invited' end)
    returning id into did;
  insert into public.points_ledger (user_id, amount, reason, ref) values (uid, -p_stake, 'duel', 'duel:' || did || ':p1');
  if p_opponent is not null then
    if exists (select 1 from public.push_subscriptions ps where ps.user_id = p_opponent and ps.active) then
      perform public.push_call(jsonb_build_object('type', 'duel', 'duel_id', did, 'event', 'invite'));
    end if;
  elsif exists (select 1 from public.push_subscriptions ps where ps.user_id <> uid and ps.active) then
    perform public.push_call(jsonb_build_object('type', 'duel', 'duel_id', did, 'event', 'room'));
  end if;
  return did;
end $function$;
revoke all on function public.duel_create(uuid, integer) from public, anon;
grant execute on function public.duel_create(uuid, integer) to authenticated;

-- 6. Принять или отказаться (тот, кого вызвали)
create or replace function public.duel_respond(p_id bigint, p_accept boolean)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  d public.sector_duels%rowtype;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.duel_timeouts(p_id);
  select * into d from public.sector_duels x where x.id = p_id for update;
  if not found or d.p2 <> uid or d.status <> 'invited' then raise exception 'duel_gone'; end if;
  if p_accept then
    perform pg_advisory_xact_lock(hashtext('points:' || uid::text));
    if public.coins_of(uid) < d.stake then raise exception 'duel_not_enough'; end if;
    insert into public.points_ledger (user_id, amount, reason, ref) values (uid, -d.stake, 'duel', 'duel:' || d.id || ':p2');
    update public.sector_duels x set status = 'accepted', accepted_at = now() where x.id = d.id;
    if exists (select 1 from public.push_subscriptions ps where ps.user_id = d.p1 and ps.active) then
      perform public.push_call(jsonb_build_object('type', 'duel', 'duel_id', d.id, 'event', 'accept'));
    end if;
  else
    update public.sector_duels x set status = 'declined' where x.id = d.id;
    insert into public.points_ledger (user_id, amount, reason, ref) values (d.p1, d.stake, 'duel', 'duel:' || d.id || ':back1')
    on conflict do nothing;
  end if;
end $function$;
revoke all on function public.duel_respond(bigint, boolean) from public, anon;
grant execute on function public.duel_respond(bigint, boolean) to authenticated;

-- 6б. Зайти в открытую комнату (кто угодно, кроме того, кто её открыл)
create or replace function public.duel_join(p_id bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  d public.sector_duels%rowtype;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.duel_timeouts(p_id);
  select * into d from public.sector_duels x where x.id = p_id for update;
  if not found or d.status <> 'open' or d.p1 = uid then raise exception 'duel_gone'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || uid::text));
  if public.coins_of(uid) < d.stake then raise exception 'duel_not_enough'; end if;
  insert into public.points_ledger (user_id, amount, reason, ref) values (uid, -d.stake, 'duel', 'duel:' || d.id || ':p2');
  update public.sector_duels x set p2 = uid, status = 'accepted', accepted_at = now() where x.id = d.id;
  if exists (select 1 from public.push_subscriptions ps where ps.user_id = d.p1 and ps.active) then
    perform public.push_call(jsonb_build_object('type', 'duel', 'duel_id', d.id, 'event', 'join'));
  end if;
end $function$;
revoke all on function public.duel_join(bigint) from public, anon;
grant execute on function public.duel_join(bigint) to authenticated;

-- 7. Отменить до старта: свой вызов или комнату (пока никто не ответил) или принятую дуэль (пока не нажали оба «Готов»)
create or replace function public.duel_cancel(p_id bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  d public.sector_duels%rowtype;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.duel_timeouts(p_id);
  select * into d from public.sector_duels x where x.id = p_id for update;
  if not found or not ((d.status in ('invited', 'open') and d.p1 = uid) or (d.status = 'accepted' and uid in (d.p1, d.p2))) then
    raise exception 'duel_gone';
  end if;
  update public.sector_duels x set status = 'cancelled' where x.id = d.id;
  insert into public.points_ledger (user_id, amount, reason, ref) values (d.p1, d.stake, 'duel', 'duel:' || d.id || ':back1')
  on conflict do nothing;
  if d.status = 'accepted' then
    insert into public.points_ledger (user_id, amount, reason, ref) values (d.p2, d.stake, 'duel', 'duel:' || d.id || ':back2')
    on conflict do nothing;
  end if;
end $function$;
revoke all on function public.duel_cancel(bigint) from public, anon;
grant execute on function public.duel_cancel(bigint) to authenticated;

-- 8. «Готов». Когда готовы оба — старт через 4 секунды.
create or replace function public.duel_ready(p_id bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  d public.sector_duels%rowtype;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.duel_timeouts(p_id);
  select * into d from public.sector_duels x where x.id = p_id for update;
  if not found or uid not in (d.p1, d.p2) or d.status <> 'accepted' then raise exception 'duel_gone'; end if;
  if uid = d.p1 then d.p1_ready := true; else d.p2_ready := true; end if;
  if d.p1_ready and d.p2_ready then
    update public.sector_duels x set p1_ready = true, p2_ready = true, status = 'playing',
           start_at = now() + interval '4 seconds', p1_seen = now() + interval '4 seconds', p2_seen = now() + interval '4 seconds'
     where x.id = d.id;
  else
    update public.sector_duels x set p1_ready = d.p1_ready, p2_ready = d.p2_ready where x.id = d.id;
  end if;
end $function$;
revoke all on function public.duel_ready(bigint) from public, anon;
grant execute on function public.duel_ready(bigint) to authenticated;

-- 9. Счёт во время игры (заодно знак «я ещё играю»)
create or replace function public.duel_progress(p_id bigint, p_score integer)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare uid uuid := auth.uid();
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  update public.sector_duels x
     set p1_progress = case when x.p1 = uid then greatest(x.p1_progress, least(coalesce(p_score, 0), 100000)) else x.p1_progress end,
         p1_seen = case when x.p1 = uid then now() else x.p1_seen end,
         p2_progress = case when x.p2 = uid then greatest(x.p2_progress, least(coalesce(p_score, 0), 100000)) else x.p2_progress end,
         p2_seen = case when x.p2 = uid then now() else x.p2_seen end
   where x.id = p_id and x.status = 'playing' and uid in (x.p1, x.p2)
     and ((x.p1 = uid and x.p1_end is null) or (x.p2 = uid and x.p2_end is null));
end $function$;
revoke all on function public.duel_progress(bigint, integer) from public, anon;
grant execute on function public.duel_progress(bigint, integer) to authenticated;

-- 10. Состояние дуэли для экрана (зерно — только когда игра уже назначена; счёт соперника — когда он закончил)
create or replace function public.duel_state(p_id bigint)
returns table (id bigint, status text, stake integer, i_am_p1 boolean,
               opp_id uuid, opp_name text, opp_color text, opp_avatar text,
               my_ready boolean, opp_ready boolean, server_ms double precision, start_ms double precision, seed integer,
               my_progress integer, opp_progress integer, my_end text, opp_end text,
               my_score integer, opp_score integer, my_perfects integer, opp_perfects integer, outcome text)
language plpgsql security definer set search_path to ''
as $function$
declare uid uuid := auth.uid();
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform public.duel_timeouts(p_id);
  return query
    select x.id, x.status, x.stake, x.p1 = uid,
           o.id, o.display_name, o.color, o.avatar,
           case when x.p1 = uid then x.p1_ready else x.p2_ready end,
           case when x.p1 = uid then x.p2_ready else x.p1_ready end,
           (extract(epoch from clock_timestamp()) * 1000)::double precision,
           (extract(epoch from x.start_at) * 1000)::double precision,
           case when x.status in ('playing', 'finished') then x.seed end,
           case when x.p1 = uid then x.p1_progress else x.p2_progress end,
           case when x.p1 = uid then x.p2_progress else x.p1_progress end,
           case when x.p1 = uid then x.p1_end else x.p2_end end,
           case when x.p1 = uid then x.p2_end else x.p1_end end,
           case when x.p1 = uid then x.p1_score else x.p2_score end,
           case when (case when x.p1 = uid then x.p2_end else x.p1_end end) is not null
                then case when x.p1 = uid then x.p2_score else x.p1_score end end,
           case when x.p1 = uid then x.p1_perfects else x.p2_perfects end,
           case when x.status = 'finished' then case when x.p1 = uid then x.p2_perfects else x.p1_perfects end end,
           case when x.status <> 'finished' then null
                when x.result = 'draw' then 'draw'
                when (x.result = 'p1') = (x.p1 = uid) then 'win' else 'lose' end
    from public.sector_duels x
    left join public.profiles o on o.id = case when x.p1 = uid then x.p2 else x.p1 end
    where x.id = p_id and uid in (x.p1, x.p2);
end $function$;
revoke all on function public.duel_state(bigint) from public, anon;
grant execute on function public.duel_state(bigint) to authenticated;

-- 11. Мои дуэли: открытые и последние законченные
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
              or (x.status = 'open' and x.created_at < now() - interval '24 hours') loop
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

-- 12. Для проверки на сервере (только с ключом сервера): зерно и что известно о сопернике
create or replace function public.duel_secret(p_id bigint, p_user uuid)
returns table (seed integer, status text, start_ms double precision, server_ms double precision, my_end text, opp_end text, opp_score integer)
language plpgsql security definer set search_path to ''
as $function$
begin
  perform public.duel_timeouts(p_id);
  return query
    select x.seed, x.status, (extract(epoch from x.start_at) * 1000)::double precision, (extract(epoch from clock_timestamp()) * 1000)::double precision,
           case when x.p1 = p_user then x.p1_end else x.p2_end end,
           case when x.p1 = p_user then x.p2_end else x.p1_end end,
           case when x.p1 = p_user then x.p2_score else x.p1_score end
    from public.sector_duels x where x.id = p_id and p_user in (x.p1, x.p2);
end $function$;
revoke all on function public.duel_secret(bigint, uuid) from public, anon, authenticated;
grant execute on function public.duel_secret(bigint, uuid) to service_role;

-- 13. Записать проверенный результат (только с ключом сервера — его зовёт duel-submit после переигрывания)
create or replace function public.duel_store_result(p_id bigint, p_user uuid, p_score integer, p_hits integer, p_perfects integer,
                                                    p_end text, p_presses jsonb, p_end_ms double precision)
returns table (status text, outcome text)
language plpgsql security definer set search_path to ''
as $function$
declare
  d public.sector_duels%rowtype;
  me1 boolean;
  oend text; oscore integer;
begin
  perform public.duel_timeouts(p_id);
  select * into d from public.sector_duels x where x.id = p_id for update;
  if not found or p_user not in (d.p1, d.p2) then raise exception 'duel_gone'; end if;
  me1 := d.p1 = p_user;
  if d.status = 'playing' and (case when me1 then d.p1_end else d.p2_end end) is null then
    if p_end not in ('miss', 'skip', 'win', 'quit') then raise exception 'duel_bad_result'; end if;
    -- партия не может закончиться позже, чем прошло времени с настоящего старта
    if now() < d.start_at + make_interval(secs => greatest(coalesce(p_end_ms, 0), 0) / 1000.0) - interval '3 seconds' then
      raise exception 'duel_too_early';
    end if;
    oend := case when me1 then d.p2_end else d.p1_end end;
    oscore := case when me1 then d.p2_score else d.p1_score end;
    if p_end = 'win' and not (oend is not null and (oend in ('quit', 'forfeit') or p_score > coalesce(oscore, 0))) then
      raise exception 'duel_not_won';
    end if;
    if me1 then
      update public.sector_duels x set p1_end = p_end, p1_score = p_score, p1_hits = p_hits, p1_perfects = p_perfects,
             p1_presses = p_presses, p1_progress = greatest(x.p1_progress, p_score), p1_seen = now() where x.id = d.id;
    else
      update public.sector_duels x set p2_end = p_end, p2_score = p_score, p2_hits = p_hits, p2_perfects = p_perfects,
             p2_presses = p_presses, p2_progress = greatest(x.p2_progress, p_score), p2_seen = now() where x.id = d.id;
    end if;
    perform public.duel_settle(d.id);
  end if;
  return query
    select x.status, case when x.status <> 'finished' then null
                          when x.result = 'draw' then 'draw'
                          when (x.result = 'p1') = me1 then 'win' else 'lose' end
    from public.sector_duels x where x.id = d.id;
end $function$;
revoke all on function public.duel_store_result(bigint, uuid, integer, integer, integer, text, jsonb, double precision) from public, anon, authenticated;
grant execute on function public.duel_store_result(bigint, uuid, integer, integer, integer, text, jsonb, double precision) to service_role;

-- 14. Данные для уведомлений о дуэли (только с ключом сервера)
create or replace function public.push_duel_info(p_id bigint)
returns table (p1 uuid, p2 uuid, p1_name text, p2_name text, stake integer)
language sql stable security definer set search_path to ''
as $function$
  select x.p1, x.p2, coalesce(a.display_name, 'Кто-то'), coalesce(b.display_name, 'Кто-то'), x.stake
  from public.sector_duels x
  left join public.profiles a on a.id = x.p1
  left join public.profiles b on b.id = x.p2
  where x.id = p_id
$function$;
revoke all on function public.push_duel_info(bigint) from public, anon, authenticated;
grant execute on function public.push_duel_info(bigint) to service_role;

create or replace function public.push_room_targets(p_id bigint)
returns table (user_id uuid)
language sql stable security definer set search_path to ''
as $function$
  select distinct ps.user_id from public.push_subscriptions ps
  join public.sector_duels x on x.id = p_id
  where ps.active and ps.user_id <> x.p1 and x.status = 'open'
$function$;
revoke all on function public.push_room_targets(bigint) from public, anon, authenticated;
grant execute on function public.push_room_targets(bigint) to service_role;
