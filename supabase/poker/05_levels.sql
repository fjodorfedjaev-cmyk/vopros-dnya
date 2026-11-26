-- «Покер»: стол 0,01 / 0,02 больше не открывается, добавлен стол 100 / 200 (вход от 8 000 до 20 000).
-- Номера уровней не меняем: они записаны в столах и истории. Уровень 1 (0,01 / 0,02) просто больше не выдаётся
-- (poker_create отвечает poker_bad_level), новый уровень — 7. Уже открытые столы живут как раньше: блайнды записаны в самом столе.
alter table public.poker_tables drop constraint poker_tables_level_check;
alter table public.poker_tables add constraint poker_tables_level_check check (level between 1 and 7);

-- Уровни блайндов. Вход за стол — от 40 до 100 больших блайндов.
create or replace function public.poker_level(p_level integer)
returns table (sb numeric, bb numeric)
language sql immutable set search_path to ''
as $function$
  select x.sb, x.bb from (values (2, 0.05, 0.10), (3, 0.25, 0.50), (4, 1.00, 2.00), (5, 5.00, 10.00), (6, 25.00, 50.00), (7, 100.00, 200.00)) x(l, sb, bb)
  where x.l = p_level
$function$;
