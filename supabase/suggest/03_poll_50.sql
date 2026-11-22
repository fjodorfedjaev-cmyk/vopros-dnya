-- «Свой вопрос»: предложить «Выбор» стоит 50 монет, Вопрос и Слово — по-прежнему 100.
-- Меняется только цена; всё остальное как в 02_price_100.sql. Возврат при отказе берёт сумму из журнала,
-- поэтому «Выборы», предложенные раньше за 100, при отказе вернут 100, а новые — 50.
create or replace function public.suggest_question(p_kind text, p_text text, p_options jsonb default null)
returns table (s_id bigint, s_balance numeric)
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  c record;
  sid bigint;
  price integer := case when p_kind = 'poll' then 50 else 100 end;
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
