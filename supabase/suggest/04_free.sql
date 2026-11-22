-- «Свой вопрос» бесплатный: Вопрос, Слово и Выбор предлагаются без монет. Чтобы не было спама,
-- проверки одновременно могут ждать не больше 5 предложений одного человека (sug_limit).
-- Монеты не списываются, поэтому при отказе возвращать нечего; предложения, оплаченные раньше,
-- при отказе вернут списанное (admin_review_suggestion берёт сумму из журнала — не меняется).
create or replace function public.suggest_question(p_kind text, p_text text, p_options jsonb default null)
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
  insert into public.suggestions (user_id, kind, text, options)
    values (uid, p_kind, c.o_text, c.o_options) returning id into sid;
  return query select sid, public.coins_of(uid);
end $function$;
revoke all on function public.suggest_question(text, text, jsonb) from public, anon;
grant execute on function public.suggest_question(text, text, jsonb) to authenticated;
