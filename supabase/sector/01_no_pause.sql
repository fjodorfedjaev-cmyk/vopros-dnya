-- Сектор: новый сектор появляется сразу после попадания (паузы 300 мс больше нет), запас на реакцию
-- с уровнем уменьшается до 0,27 с, при раздвоении — вдвое меньше. Поэтому минимальное время игры,
-- по которому база отсеивает подделки, считается так: по 45° на сектор при скорости до 360°/с, без пауз.
-- Это не строже настоящей игры (в худшем случае честная игра в 2,3 раза дольше этого минимума),
-- а game_finish ещё и даёт запас 25% (dur >= game_min_ms * 0.75).
create or replace function public.game_min_ms(p_hits integer)
 returns numeric
 language sql
 immutable
 set search_path to ''
as $function$
  select coalesce(sum(45.0 / least(360, 110 + i * 6)) * 1000, 0)
  from generate_series(0, greatest(coalesce(p_hits, 0) - 1, -1)) as i
$function$;
