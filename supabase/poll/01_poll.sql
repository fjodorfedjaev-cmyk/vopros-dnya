-- «Выбор дня» — третья вкладка: вопрос с вариантами ответа (обычно 4).
-- Ответ хранится в той же таблице answers: kind = 'poll', body = номер варианта ('0'…'3').
-- Награда +15 монет (только с этого момента, прошлое не пересчитываем).
-- На серию дней «Выбор» не влияет: серия и счётчики в профиле считают только вопрос и слово.

-- 1. Вопросы и расписание по дням (как у «Слова дня»: читаются только через функцию)
create table public.poll_questions (
  id serial primary key,
  text text not null check (char_length(text) between 3 and 300),
  options jsonb not null check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 2 and 4),
  position integer not null default 0,
  active boolean not null default true
);
create table public.daily_polls (
  day date primary key,
  poll_id integer not null references public.poll_questions (id)
);
alter table public.poll_questions enable row level security;
alter table public.daily_polls enable row level security;
revoke all on public.poll_questions, public.daily_polls from anon, authenticated;

-- 2. Вопрос на сегодня: если ещё не выбран — берём тот, что дольше всех не показывался
create or replace function public.ensure_today_poll()
returns table (q_day date, q_id integer, q_category text, q_text text, q_options jsonb)
language plpgsql security definer set search_path to ''
as $function$
declare
  d date := public.today_tallinn();
  pid integer;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select dp.poll_id into pid from public.daily_polls dp where dp.day = d;
  if pid is null then
    perform pg_advisory_xact_lock(7426);
    select dp.poll_id into pid from public.daily_polls dp where dp.day = d;
    if pid is null then
      select pq.id into pid from public.poll_questions pq where pq.active
      order by (select max(dp.day) from public.daily_polls dp where dp.poll_id = pq.id) asc nulls first, pq.position asc, pq.id asc
      limit 1;
      if pid is null then raise exception 'no_polls'; end if;
      insert into public.daily_polls (day, poll_id) values (d, pid);
    end if;
  end if;
  return query select d, pq.id, null::text, pq.text, pq.options from public.poll_questions pq where pq.id = pid;
end $function$;
revoke all on function public.ensure_today_poll() from public, anon;
grant execute on function public.ensure_today_poll() to authenticated;

-- 3. Ответы: новый вид 'poll', в теле — номер варианта, который есть у вопроса этого дня
alter table public.answers drop constraint answers_kind_check;
alter table public.answers add constraint answers_kind_check check (kind = any (array['question', 'fill', 'poll']));

create or replace function public.check_poll_answer()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare n integer;
begin
  if new.kind <> 'poll' then return new; end if;
  if new.body !~ '^[0-3]$' then raise exception 'bad_poll_choice'; end if;
  select jsonb_array_length(pq.options) into n
  from public.daily_polls dp join public.poll_questions pq on pq.id = dp.poll_id
  where dp.day = new.day;
  if n is null or new.body::integer >= n then raise exception 'bad_poll_choice'; end if;
  return new;
end $function$;
create trigger answers_check_poll before insert or update on public.answers
  for each row execute function public.check_poll_answer();

-- 4. Монеты: +15 за выбор (+30 за вопрос и слово — как было). Бонус за серию — только от вопроса и слова.
alter table public.points_ledger drop constraint points_ledger_reason_check;
alter table public.points_ledger add constraint points_ledger_reason_check
  check (reason = any (array['question', 'fill', 'streak', 'game', 'poll']));

create or replace function public.award_answer_points()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare s integer; bonus integer;
begin
  insert into public.points_ledger (user_id, amount, reason, ref, day)
  values (new.user_id, case when new.kind = 'poll' then 15 else 30 end, new.kind, new.day::text, new.day)
  on conflict do nothing;
  -- «Выбор» на серию не влияет
  if new.kind <> 'poll'
     and (select count(*) from public.answers a where a.user_id = new.user_id and a.day = new.day and a.kind <> 'poll') = 1 then
    s := public.streak_on(new.user_id, new.day);
    bonus := case s when 3 then 40 when 7 then 100 when 30 then 300 when 100 then 1000 else 0 end;
    if bonus > 0 then
      insert into public.points_ledger (user_id, amount, reason, ref, day)
      values (new.user_id, bonus, 'streak', s || ':' || new.day, new.day)
      on conflict do nothing;
    end if;
  end if;
  return new;
end $function$;

-- 5. Серия и счётчики в профиле — без «Выбора» (как было до него)
create or replace function public.streak_on(p_user uuid, d date)
returns integer
language plpgsql stable security definer set search_path to ''
as $function$
declare n integer := 0; x date := d;
begin
  while exists (select 1 from public.answers a where a.user_id = p_user and a.day = x and a.kind <> 'poll') loop
    n := n + 1; x := x - 1;
  end loop;
  return n;
end $function$;

create or replace function public.member_stats()
returns table (user_id uuid, display_name text, color text, avatar text, total_answers integer, current_streak integer,
               best_streak integer, answered_today boolean, reactions_received integer, comments_written integer)
language sql stable security definer set search_path to 'public'
as $function$
  with days as (
    select distinct a.user_id, a.day from public.answers a where a.kind <> 'poll'
  ),
  d as (
    select days.user_id, days.day,
           days.day - (row_number() over (partition by days.user_id order by days.day))::integer as grp
    from days
  ),
  islands as (
    select d.user_id, max(d.day) as e, count(*)::integer as len
    from d group by d.user_id, d.grp
  )
  select p.id, p.display_name, p.color, p.avatar,
    (select count(*)::integer from public.answers a where a.user_id = p.id and a.kind <> 'poll'),
    coalesce((select i.len from islands i where i.user_id = p.id and i.e >= public.today_tallinn() - 1 order by i.e desc limit 1), 0),
    coalesce((select max(i.len) from islands i where i.user_id = p.id), 0),
    exists (select 1 from public.answers a where a.user_id = p.id and a.day = public.today_tallinn() and a.kind <> 'poll'),
    (select count(*)::integer from public.reactions r join public.answers a on a.id = r.answer_id where a.user_id = p.id),
    (select count(*)::integer from public.comments c where c.user_id = p.id)
  from public.profiles p
  where public.is_member()
  order by 6 desc, 5 desc, p.created_at
$function$;
