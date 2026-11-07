-- Проверка 01_no_pause.sql: применяет изменение и проверяет числа, в конце нарочно падает — всё откатывается.
do $test$
declare v0 numeric; v1 numeric; v100 numeric; expect numeric;
begin
  create or replace function public.game_min_ms(p_hits integer)
   returns numeric language sql immutable set search_path to ''
  as $f$
    select coalesce(sum(45.0 / least(360, 110 + i * 6)) * 1000, 0)
    from generate_series(0, greatest(coalesce(p_hits, 0) - 1, -1)) as i
  $f$;
  v0 := public.game_min_ms(0); v1 := public.game_min_ms(1); v100 := public.game_min_ms(100);
  if v0 <> 0 then raise exception 'game_min_ms(0) = %, ожидали 0', v0; end if;
  if abs(v1 - 45.0 / 110 * 1000) > 0.001 then raise exception 'game_min_ms(1) = %', v1; end if;
  select sum(45.0 / least(360, 110 + i * 6)) * 1000 into expect from generate_series(0, 99) i;
  if abs(v100 - expect) > 0.001 then raise exception 'game_min_ms(100) = %, ожидали %', v100, expect; end if;
  if public.game_min_ms(null) <> 0 then raise exception 'game_min_ms(null) <> 0'; end if;
  raise exception 'ТЕСТ ПРОЙДЕН (откат): game_min_ms(1)=%, game_min_ms(100)=% мс', round(v1, 1), round(v100);
end
$test$;
