-- НАГРАДЫ БОЛЬШЕ (22.11.2026). Только с этого момента: старое не пересчитывается.
-- * Вопрос дня и Слово дня — 50 монет (было 30); Выбор дня — 30 (было 15), и дополнительные «Выборы» от друзей тоже 30.
--   Бонусы за серию — как были (3 дня — 40, 7 — 100, 30 — 300, 100 — 1000).
-- * Сектор: 1 монета за каждые 5 очков (было за 10).
-- * Одобренное предложение (Вопрос, Слово или Выбор) — автору 20 монет (причина 'suggest', ref 'sug:<id>:ok').
-- Меняются: award_answer_points, poll_extra_vote, award_game_points, admin_review_suggestion (взяты с рабочей базы).

create or replace function public.award_answer_points()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare s integer; bonus integer;
begin
  insert into public.points_ledger (user_id, amount, reason, ref, day)
  values (new.user_id, case when new.kind = 'poll' then 30 else 50 end, new.kind, new.day::text, new.day)
  on conflict do nothing;
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
  values (uid, 30, 'poll', 'x' || p_slot || ':' || d, d)
  on conflict do nothing;
end $function$;

create or replace function public.award_game_points(p_user uuid, p_session uuid, p_score integer)
returns integer
language plpgsql security definer set search_path to ''
as $function$
declare got integer;
begin
  got := greatest(p_score, 0) / 5;
  if got > 0 then
    insert into public.points_ledger (user_id, amount, reason, ref)
    values (p_user, got, 'game', p_session::text) on conflict do nothing;
  end if;
  return got;
end $function$;

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
    -- автору — 20 монет за одобренное
    perform pg_advisory_xact_lock(hashtext('points:' || s.user_id::text));
    insert into public.points_ledger (user_id, amount, reason, ref, day)
      values (s.user_id, 20, 'suggest', 'sug:' || s.id || ':ok', public.today_tallinn())
      on conflict do nothing;
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
