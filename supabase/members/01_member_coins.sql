-- Баланс монет каждого участника для таблицы «Участники» в профиле.
-- Считается так же, как свой баланс: журнал монет + итог казино (coins_of), до сотых.
-- Видят только участники (is_member), как и остальную статистику.

create or replace function public.member_coins()
returns table (user_id uuid, coins numeric)
language sql stable security definer set search_path to ''
as $$
  select p.id, public.coins_of(p.id)
  from public.profiles p
  where public.is_member()
$$;

revoke all on function public.member_coins() from public, anon;
grant execute on function public.member_coins() to authenticated;
