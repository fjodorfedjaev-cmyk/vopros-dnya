-- «Свой вопрос»: переключатель «Показывать автора». Включил — когда Вопрос, Слово или Выбор выйдет,
-- у него будет видно имя и аватарку автора. Выключено (по умолчанию) — как раньше: автора никто не видит.
-- Админ при проверке видит только пометку «с автором», без имени (проверка остаётся без автора).
-- Старые предложения — без автора: их отправляли, когда автора не показывали никому.
-- Старые версии функций — *_old, закрыты (удалять только с подтверждения).

-- 1. Хочет ли автор, чтобы его показывали
alter table public.suggestions add column show_author boolean not null default false;

-- 2. Отправить предложение: новый параметр p_show_author (остальное — как в 04_free.sql)
alter function public.suggest_question(text, text, jsonb) rename to suggest_question_old;
revoke all on function public.suggest_question_old(text, text, jsonb) from public, anon, authenticated;
create function public.suggest_question(p_kind text, p_text text, p_options jsonb default null, p_show_author boolean default false)
returns table (s_id bigint, s_balance numeric)
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  c record;
  sid bigint;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select * into c from public.suggestion_clean(p_kind, p_text, p_options);
  -- очередь человека: два быстрых нажатия не обойдут лимит
  perform pg_advisory_xact_lock(hashtext('points:' || uid::text));
  if (select count(*) from public.suggestions x where x.user_id = uid and x.status = 'pending') >= 5 then
    raise exception 'sug_limit';
  end if;
  insert into public.suggestions (user_id, kind, text, options, show_author)
    values (uid, p_kind, c.o_text, c.o_options, coalesce(p_show_author, false)) returning id into sid;
  return query select sid, public.coins_of(uid);
end $function$;
revoke all on function public.suggest_question(text, text, jsonb, boolean) from public, anon;
grant execute on function public.suggest_question(text, text, jsonb, boolean) to authenticated;

-- 3. Мои предложения — ещё и «с автором» ли
alter function public.my_suggestions() rename to my_suggestions_old;
revoke all on function public.my_suggestions_old() from public, anon, authenticated;
create function public.my_suggestions()
returns table (s_id bigint, s_kind text, s_text text, s_options jsonb, s_status text, s_created timestamptz, s_show_author boolean)
language sql stable security definer set search_path to ''
as $function$
  select s.id, s.kind, s.text, s.options, s.status, s.created_at, s.show_author
  from public.suggestions s
  where s.user_id = auth.uid() and public.is_member()
  order by s.created_at desc
  limit 30
$function$;
revoke all on function public.my_suggestions() from public, anon;
grant execute on function public.my_suggestions() to authenticated;

-- 4. Для админа: ждут проверки — с пометкой «с автором», но по-прежнему без самого автора
alter function public.admin_suggestions() rename to admin_suggestions_old;
revoke all on function public.admin_suggestions_old() from public, anon, authenticated;
create function public.admin_suggestions()
returns table (s_id bigint, s_kind text, s_text text, s_options jsonb, s_created timestamptz, s_show_author boolean)
language plpgsql stable security definer set search_path to ''
as $function$
begin
  if not public.is_admin() then raise exception 'not_admin'; end if;
  return query
    select s.id, s.kind, s.text, s.options, s.created_at, s.show_author
    from public.suggestions s
    where s.status = 'pending'
    order by s.created_at asc;
end $function$;
revoke all on function public.admin_suggestions() from public, anon;
grant execute on function public.admin_suggestions() to authenticated;

-- 5. Авторы вышедших вопросов: по виду и номерам (questions / fill_prompts / poll_questions) — кто предложил.
--    Отдаёт только одобренные, где автор сам включил «Показывать автора». Остальных не выдаёт никому.
create function public.sug_authors(p_kind text, p_ids integer[])
returns table (target_id integer, user_id uuid)
language sql stable security definer set search_path to ''
as $function$
  select s.target_id, s.user_id
  from public.suggestions s
  where public.is_member() and s.kind = p_kind and s.status = 'approved' and s.show_author
    and s.target_id = any (p_ids)
$function$;
revoke all on function public.sug_authors(text, integer[]) from public, anon;
grant execute on function public.sug_authors(text, integer[]) to authenticated;
