-- «ЗИГЗАГ», часть 3: монеты в 1,3 раза чаще — промежуток между монетами не меньше 16 плиток (было 25).
-- Должно совпадать с CONFIG.coinFrom / coinGap в zigzag.js.
-- Применять ДО выкладки сайта: старая версия игры даёт меньше монет и проверку пройдёт,
-- а новая с прежней проверкой (25) иногда упиралась бы в потолок.

create or replace function public.zz_max_coins(p_tiles integer)
returns integer
language sql immutable set search_path = ''
as $$
  select case when coalesce(p_tiles, 0) < 8 then 0 else (p_tiles - 8) / 16 + 1 end
$$;

revoke all on function public.zz_max_coins(integer) from public, anon, authenticated;
