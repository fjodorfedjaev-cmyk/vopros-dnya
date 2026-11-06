-- «ВЫБОР ДНЯ» ОТ ДРУЗЕЙ: дополнительные «Выборы» под обычным.
--
-- Как устроено (простыми словами):
-- * Одобренный «Выбор» из «Свой вопрос» больше НЕ встаёт в общую очередь и не заменяет обычный.
--   Он ждёт в своей очереди и появляется со следующего дня после одобрения.
-- * В день: обычный «Выбор» + до 2 дополнительных (всего до 3). Если одобрено больше — остальные
--   выйдут в следующие дни, по порядку одобрения. Каждый дополнительный показывается один раз.
-- * Голоса видны после своего выбора, выбор можно менять до конца дня — как у обычного.
-- * +15 монет за первый выбор в каждом. Голоса хранятся отдельно от answers, поэтому на серию
--   и счётчики в профиле дополнительные «Выборы» не влияют.
-- * Вопрос и Слово не меняются: предложенное встаёт первым в общую очередь, как раньше.

-- 1. С какого дня вопрос можно показывать дополнительным (null — обычный вопрос из общей очереди)
alter table public.poll_questions add column extra_from date;

-- 2. Какие дополнительные «Выборы» в какой день: места 2 и 3 (место 1 — обычный «Выбор»)
create table public.daily_poll_extras (
  day date not null,
  slot smallint not null check (slot in (2, 3)),
  poll_id integer not null unique references public.poll_questions (id),   -- каждый — только один раз
  primary key (day, slot)
);

-- 3. Голоса в дополнительных
create table public.poll_extra_votes (
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  slot smallint not null check (slot in (2, 3)),
  choice smallint not null check (choice between 0 and 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, day, slot)
);
create index poll_extra_votes_day_idx on public.poll_extra_votes (day, slot);

alter table public.daily_poll_extras enable row level security;
alter table public.poll_extra_votes enable row level security;
revoke all on public.daily_poll_extras, public.poll_extra_votes from anon, authenticated;

-- 4. Обычный «Выбор дня» берётся только из обычных вопросов
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
      select pq.id into pid from public.poll_questions pq where pq.active and pq.extra_from is null
      order by (select max(dp.day) from public.daily_polls dp where dp.poll_id = pq.id) asc nulls first, pq.position asc, pq.id asc
      limit 1;
      if pid is null then raise exception 'no_polls'; end if;
      insert into public.daily_polls (day, poll_id) values (d, pid);
    end if;
  end if;
  return query select d, pq.id, null::text, pq.text, pq.options from public.poll_questions pq where pq.id = pid;
end $function$;

-- 5. Дополнительные «Выборы» на сегодня. Если свободное место есть и кто-то ждёт — ставим.
--    votes (кто что выбрал) отдаём, только если ты сам уже выбрал — как у обычного «Выбора».
create or replace function public.poll_extras_today()
returns table (q_day date, slot integer, poll_id integer, q_text text, q_options jsonb, my_choice integer, votes jsonb)
language plpgsql security definer set search_path to ''
as $function$
declare
  d date := public.today_tallinn();
  uid uuid := auth.uid();
  free_slot integer;
  pid integer;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  if (select count(*) from public.daily_poll_extras e where e.day = d) < 2
     and exists (select 1 from public.poll_questions pq
                 where pq.active and pq.extra_from <= d
                   and not exists (select 1 from public.daily_poll_extras e where e.poll_id = pq.id)) then
    perform pg_advisory_xact_lock(hashtext('poll_extras'));
    loop
      free_slot := null; pid := null;
      select s.n into free_slot from unnest(array[2, 3]) as s(n)
       where not exists (select 1 from public.daily_poll_extras e where e.day = d and e.slot = s.n)
       order by s.n limit 1;
      exit when free_slot is null;
      select pq.id into pid from public.poll_questions pq
       where pq.active and pq.extra_from <= d
         and not exists (select 1 from public.daily_poll_extras e where e.poll_id = pq.id)
       order by pq.extra_from, pq.id limit 1;
      exit when pid is null;
      insert into public.daily_poll_extras (day, slot, poll_id) values (d, free_slot, pid);
    end loop;
  end if;
  return query
    select d, e.slot::integer, pq.id, pq.text, pq.options, v.choice::integer,
           case when v.choice is null then null else
             (select coalesce(jsonb_agg(jsonb_build_object('user_id', x.user_id, 'choice', x.choice) order by x.created_at), '[]'::jsonb)
                from public.poll_extra_votes x where x.day = d and x.slot = e.slot) end
    from public.daily_poll_extras e
    join public.poll_questions pq on pq.id = e.poll_id
    left join public.poll_extra_votes v on v.day = d and v.slot = e.slot and v.user_id = uid
    where e.day = d
    order by e.slot;
end $function$;
revoke all on function public.poll_extras_today() from public, anon;
grant execute on function public.poll_extras_today() to authenticated;

-- 6. Выбрать вариант в дополнительном «Выборе» (или поменять до конца дня). +15 — только за первый выбор.
--    p_day — день, который видел человек: если уже наступил новый, голос не засчитываем.
create or replace function public.poll_extra_vote(p_day date, p_slot integer, p_choice integer)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  d date := public.today_tallinn();
  uid uuid := auth.uid();
  n integer;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  if p_day is distinct from d then raise exception 'poll_day_over'; end if;
  select jsonb_array_length(pq.options) into n
  from public.daily_poll_extras e join public.poll_questions pq on pq.id = e.poll_id
  where e.day = d and e.slot = p_slot;
  if n is null then raise exception 'poll_extra_gone'; end if;
  if p_choice is null or p_choice < 0 or p_choice >= n then raise exception 'bad_poll_choice'; end if;
  insert into public.poll_extra_votes (user_id, day, slot, choice) values (uid, d, p_slot, p_choice)
  on conflict (user_id, day, slot) do update set choice = excluded.choice, updated_at = now();
  insert into public.points_ledger (user_id, amount, reason, ref, day)
  values (uid, 15, 'poll', 'x' || p_slot || ':' || d, d)
  on conflict do nothing;
end $function$;
revoke all on function public.poll_extra_vote(date, integer, integer) from public, anon;
grant execute on function public.poll_extra_vote(date, integer, integer) to authenticated;

-- 7. Одобрение «Свой вопрос»: «Выбор» — в очередь дополнительных со следующего дня; Вопрос и Слово — как было
create or replace function public.admin_review_suggestion(p_id bigint, p_approve boolean, p_text text default null, p_options jsonb default null)
returns text
language plpgsql security definer set search_path to ''
as $function$
declare
  s public.suggestions%rowtype;
  c record;
  tid integer;
  charged integer;
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  select * into s from public.suggestions x where x.id = p_id for update;
  if not found then raise exception 'sug_not_found'; end if;
  if s.status <> 'pending' then raise exception 'sug_reviewed'; end if;

  if p_approve then
    select * into c from public.suggestion_clean(s.kind, coalesce(p_text, s.text), coalesce(p_options, s.options), s.id);
    if s.kind = 'question' then
      insert into public.questions (category, text, position, active)
        values ('funny', c.o_text, -1000000 + s.id::integer, true) returning id into tid;
    elsif s.kind = 'fill' then
      insert into public.fill_prompts (text, position, active)
        values (c.o_text, -1000000 + s.id::integer, true) returning id into tid;
    else
      insert into public.poll_questions (text, options, position, active, extra_from)
        values (c.o_text, c.o_options, 0, true, public.today_tallinn() + 1) returning id into tid;
    end if;
    update public.suggestions x set status = 'approved', reviewed_at = now(), target_id = tid where x.id = s.id;
    return 'approved';
  end if;

  perform pg_advisory_xact_lock(hashtext('points:' || s.user_id::text));
  charged := (select -l.amount from public.points_ledger l
              where l.user_id = s.user_id and l.reason = 'suggest' and l.ref = 'sug:' || s.id);
  if coalesce(charged, 0) > 0 then
    insert into public.points_ledger (user_id, amount, reason, ref)
      values (s.user_id, charged, 'suggest', 'sug:' || s.id || ':back');
  end if;
  update public.suggestions x set status = 'rejected', reviewed_at = now() where x.id = s.id;
  return 'rejected';
end $function$;
