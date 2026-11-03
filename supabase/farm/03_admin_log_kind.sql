-- ФЕРМА, часть 3: ручные начисления серебра (например, для теста).
-- В журнал фермы добавлен вид записи 'admin', чтобы каждое ручное начисление было видно
-- и сумма журнала всегда совпадала с балансом.

alter table public.farm_log drop constraint farm_log_kind_check;
alter table public.farm_log add constraint farm_log_kind_check
  check (kind in ('start', 'buy_plot', 'plant', 'harvest', 'admin'));

-- Как начислить серебро вручную (запускать в SQL-редакторе Supabase, подставив id игрока и сумму):
--
-- do $$
-- declare uid uuid := '<id игрока>';
-- begin
--   perform pg_advisory_xact_lock(hashtext('farm:' || uid::text));  -- та же очередь, что у функций фермы
--   update public.farm_wallets set silver = silver + 1000 where user_id = uid;
--   if not found then raise exception 'нет кошелька фермы: игрок ещё не открывал ферму'; end if;
--   insert into public.farm_log (user_id, kind, amount, ref) values (uid, 'admin', 1000, 'причина');
-- end $$;
