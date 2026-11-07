-- «Свой вопрос» дешевле: 300 → 100 монет. Меняется только цена; всё остальное как в 01_suggestions.sql.
-- Возврат при отказе (admin_review_suggestion) берёт сумму из журнала, поэтому старые
-- предложения за 300 при отказе вернут 300, а новые — 100.
create or replace function public.suggest_question(p_kind text, p_text text, p_options jsonb default null)
returns table (s_id bigint, s_balance numeric)
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  c record;
  sid bigint;
  price constant integer := 100;
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
