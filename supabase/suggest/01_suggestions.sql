-- «ПРЕДЛОЖИТЬ СВОЙ ВОПРОС» — первая трата монет.
-- Любой участник предлагает вопрос, фразу для «Слова» или «Выбор» с 4 вариантами за 300 монет.
-- Предложение попадает на проверку админу. Одобрил — вопрос встаёт первым в очередь своего вида
-- (раньше обычных, ещё не показанных). Отклонил — монеты возвращаются.
-- Автора никому не показываем (и в проверке тоже).
--
-- Как устроена трата: это обычная запись в книге монет (points_ledger), только с минусом.
-- Баланс (coins_of) — сумма всех записей, поэтому он пересчитается сам.

-- 1. Новый вид записи в книге монет: 'suggest' (списание за предложение и возврат при отказе)
alter table public.points_ledger drop constraint points_ledger_reason_check;
alter table public.points_ledger add constraint points_ledger_reason_check
  check (reason = any (array['question', 'fill', 'streak', 'game', 'poll', 'suggest']));

-- 2. Админы — кто проверяет предложения. Читается только через функцию is_admin().
create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (select 1 from public.admins a where a.user_id = auth.uid())
$function$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- 3. Предложения. Напрямую таблица закрыта: всё только через функции ниже.
create table public.suggestions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('question', 'fill', 'poll')),
  text text not null check (char_length(text) between 1 and 300),
  options jsonb check (options is null or jsonb_typeof(options) = 'array'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  target_id integer            -- id нового вопроса после одобрения
);
create index suggestions_pending_idx on public.suggestions (created_at) where status = 'pending';
create index suggestions_user_idx on public.suggestions (user_id, created_at desc);
alter table public.suggestions enable row level security;
revoke all on public.suggestions from anon, authenticated;

-- 4. Проверка текста (общая для отправки и одобрения). Возвращает очищенный текст и варианты.
--    Вопрос: 5–200 символов. Слово: ровно один пропуск ___ (два и больше подчёркивания → ___).
--    Выбор: вопрос + ровно 4 разных варианта по 1–60 символов.
--    Повтор (такой же вопрос уже есть или уже предложен) не принимается.
create or replace function public.suggestion_clean(p_kind text, p_text text, p_options jsonb, p_exclude bigint default null,
  out o_text text, out o_options jsonb)
language plpgsql stable security definer set search_path to ''
as $function$
declare
  opt text;
  arr text[] := '{}';
begin
  if p_kind is null or p_kind not in ('question', 'fill', 'poll') then raise exception 'sug_bad_kind'; end if;
  o_text := regexp_replace(btrim(coalesce(p_text, '')), '\s+', ' ', 'g');
  if p_kind = 'fill' then
    o_text := regexp_replace(o_text, '_{2,}', '___', 'g');
    if (char_length(o_text) - char_length(replace(o_text, '___', ''))) / 3 <> 1 then raise exception 'sug_need_blank'; end if;
  end if;
  if char_length(o_text) < 5 or char_length(o_text) > 200 then raise exception 'sug_bad_text'; end if;

  if p_kind = 'poll' then
    if p_options is null or jsonb_typeof(p_options) <> 'array' or jsonb_array_length(p_options) <> 4 then raise exception 'sug_bad_options'; end if;
    for opt in select regexp_replace(btrim(x), '\s+', ' ', 'g') from jsonb_array_elements_text(p_options) x loop
      if coalesce(char_length(opt), 0) < 1 or char_length(opt) > 60 then raise exception 'sug_bad_options'; end if;
      if lower(opt) = any (select lower(y) from unnest(arr) y) then raise exception 'sug_same_options'; end if;
      arr := arr || opt;
    end loop;
    o_options := to_jsonb(arr);
  else
    o_options := null;
  end if;

  if exists (select 1 from public.suggestions s
             where s.kind = p_kind and s.status <> 'rejected' and lower(s.text) = lower(o_text)
               and s.id is distinct from p_exclude)
     or (p_kind = 'question' and exists (select 1 from public.questions q where lower(q.text) = lower(o_text)))
     or (p_kind = 'fill' and exists (select 1 from public.fill_prompts f where lower(f.text) = lower(o_text)))
     or (p_kind = 'poll' and exists (select 1 from public.poll_questions pq where lower(pq.text) = lower(o_text)))
  then raise exception 'sug_duplicate'; end if;
end $function$;
revoke all on function public.suggestion_clean(text, text, jsonb, bigint) from public, anon, authenticated;

-- 5. Отправить предложение: списывает 300 монет. Очередь 'points:<id>' — та же, что у казино,
--    поэтому два быстрых нажатия (или ставка в казино в ту же секунду) не уведут баланс в минус.
create or replace function public.suggest_question(p_kind text, p_text text, p_options jsonb default null)
returns table (s_id bigint, s_balance numeric)
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  c record;
  sid bigint;
  price constant integer := 300;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select * into c from public.suggestion_clean(p_kind, p_text, p_options);
  perform pg_advisory_xact_lock(hashtext('points:' || uid::text));
  if public.coins_of(uid) < price then raise exception 'sug_not_enough'; end if;
  insert into public.suggestions (user_id, kind, text, options)
    values (uid, p_kind, c.o_text, c.o_options) returning id into sid;
  insert into public.points_ledger (user_id, amount, reason, ref)
    values (uid, -price, 'suggest', 'sug:' || sid);
  return query select sid, public.coins_of(uid);
end $function$;
revoke all on function public.suggest_question(text, text, jsonb) from public, anon;
grant execute on function public.suggest_question(text, text, jsonb) to authenticated;

-- 6. Мои предложения (последние 30) — со статусом
create or replace function public.my_suggestions()
returns table (s_id bigint, s_kind text, s_text text, s_options jsonb, s_status text, s_created timestamptz)
language sql stable security definer set search_path to ''
as $function$
  select s.id, s.kind, s.text, s.options, s.status, s.created_at
  from public.suggestions s
  where s.user_id = auth.uid() and public.is_member()
  order by s.created_at desc
  limit 30
$function$;
revoke all on function public.my_suggestions() from public, anon;
grant execute on function public.my_suggestions() to authenticated;

-- 7. Для админа: всё, что ждёт проверки (без автора)
create or replace function public.admin_suggestions()
returns table (s_id bigint, s_kind text, s_text text, s_options jsonb, s_created timestamptz)
language plpgsql stable security definer set search_path to ''
as $function$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  return query
    select s.id, s.kind, s.text, s.options, s.created_at
    from public.suggestions s
    where s.status = 'pending'
    order by s.created_at asc;
end $function$;
revoke all on function public.admin_suggestions() from public, anon;
grant execute on function public.admin_suggestions() to authenticated;

-- 8. Для админа: одобрить (можно поправить текст и варианты) или отклонить (монеты возвращаются).
--    Одобренный встаёт первым в очередь: у него позиция меньше, чем у обычных вопросов,
--    а среди одобренных — кто раньше предложил, тот раньше и выйдет.
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
      insert into public.poll_questions (text, options, position, active)
        values (c.o_text, c.o_options, -1000000 + s.id::integer, true) returning id into tid;
    end if;
    update public.suggestions x set status = 'approved', reviewed_at = now(), target_id = tid where x.id = s.id;
    return 'approved';
  end if;

  -- отказ: вернуть ровно столько, сколько списали
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
revoke all on function public.admin_review_suggestion(bigint, boolean, text, jsonb) from public, anon;
grant execute on function public.admin_review_suggestion(bigint, boolean, text, jsonb) to authenticated;

-- 9. Кто админ. Свой id в репозиторий не пишем — он подставлен только при запуске в Supabase:
-- insert into public.admins (user_id) values ('<твой id из profiles>');
