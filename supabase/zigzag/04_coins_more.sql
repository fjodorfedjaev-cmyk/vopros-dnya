-- «ЗИГЗАГ», часть 4: монеты ещё в 1,2 раза чаще — первая с плитки №6 (было №8),
-- промежуток не меньше 12 плиток (было 16). Должно совпадать с CONFIG.coinFrom / coinGap в zigzag.js.
-- Применять ДО выкладки сайта.

create or replace function public.zz_max_coins(p_tiles integer)
returns integer
language sql immutable set search_path = ''
as $$
  select case when coalesce(p_tiles, 0) < 6 then 0 else (p_tiles - 6) / 12 + 1 end
$$;

revoke all on function public.zz_max_coins(integer) from public, anon, authenticated;
