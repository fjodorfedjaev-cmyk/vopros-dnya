-- Для мини-профиля (и ленты ответов) локально: ответы, реакции, комментарии, member_stats (как в poll/01_poll.sql),
-- сессии Сектора и Зигзага. Порядок: ./db.sh ИМЯ cards-stub.sql profile-stub.sql … ../../supabase/duels/01_duels.sql …
create table if not exists public.answers (id bigint generated always as identity primary key, user_id uuid, day date default public.today_tallinn(),
  kind text default 'question', body text, created_at timestamptz default now());
create table if not exists public.reactions (id bigint generated always as identity primary key, answer_id bigint, user_id uuid, emoji text);
create table if not exists public.comments (id bigint generated always as identity primary key, answer_id bigint, user_id uuid, body text);
create table if not exists public.game_sessions (id uuid primary key default gen_random_uuid(), user_id uuid, game text, started_at timestamptz default now(),
  finished_at timestamptz, score integer, hits integer, perfects integer, duration_ms integer, valid boolean default true);
create table if not exists public.zigzag_sessions (id uuid primary key default gen_random_uuid(), user_id uuid, started_at timestamptz default now(),
  finished_at timestamptz, score integer, tiles integer, crystals integer, coins integer, duration_ms integer, valid boolean default true);
alter table public.points_ledger drop constraint if exists points_ledger_reason_check;
alter table public.points_ledger add constraint points_ledger_reason_check
  check (reason = any (array['question', 'fill', 'streak', 'game', 'poll', 'suggest', 'cards', 'duel']));
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
