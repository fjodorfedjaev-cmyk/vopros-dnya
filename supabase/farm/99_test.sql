-- ФЕРМА: самоотменяющийся тест.
-- Запускается как один блок. В конце он НАМЕРЕННО падает с ошибкой, из-за этого вся работа теста
-- откатывается, и в базе не остаётся никаких следов. Результат приходит в тексте этой «ошибки».
-- Для теста берутся два существующих участника из profiles; их данные не меняются.

do $test$
declare
  u1 uuid; u2 uuid;
  res text := '';
  j jsonb; j2 jsonb;
  pid uuid;
  e text;
begin
  select id into u1 from public.profiles order by created_at, id limit 1;
  select id into u2 from public.profiles order by created_at, id offset 1 limit 1;
  if u1 is null or u2 is null then raise exception 'нужно минимум два профиля для теста'; end if;

  -- ===== вход как игрок 1 =====
  perform set_config('request.jwt.claims', json_build_object('sub', u1)::text, true);

  -- 1. Первое открытие: 2 клетки, 100 серебра. Повторное: ничего не дублируется.
  j := public.farm_state();
  res := res || case when (j->>'silver')::int = 100 and (j->>'plots_open')::int = 2
                then E'ok   1a старт: 100 серебра, 2 клетки\n' else E'FAIL 1a старт\n' end;
  j := public.farm_state();
  res := res || case when (select count(*) from public.farm_wallets where user_id = u1) = 1
                      and (select count(*) from public.farm_log where user_id = u1 and kind = 'start') = 1
                      and (j->>'silver')::int = 100
                then E'ok   1b повторное открытие не дублирует\n' else E'FAIL 1b дубли\n' end;

  -- 2. Покупка клеток
  begin perform public.farm_buy_plot(5); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'not_next' then E'ok   2a нельзя купить клетку не по порядку\n' else E'FAIL 2a ' || e || E'\n' end;
  begin perform public.farm_buy_plot(3); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'not_enough' and (public.farm_state()->>'silver')::int = 100
                then E'ok   2b не хватает серебра: ошибка, ничего не списалось\n' else E'FAIL 2b ' || e || E'\n' end;

  -- дадим 700 серебра напрямую (только для теста)
  update public.farm_wallets set silver = 800 where user_id = u1;
  j := public.farm_buy_plot(3);
  res := res || case when (j->>'silver')::int = 200 and (j->>'plots_open')::int = 3
                then E'ok   2c клетка 3 за 600: серебро 800 -> 200\n' else E'FAIL 2c ' || j::text || E'\n' end;
  begin perform public.farm_buy_plot(3); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'not_next' and (public.farm_state()->>'silver')::int = 200
                then E'ok   2d повторная покупка той же клетки не списывает\n' else E'FAIL 2d ' || e || E'\n' end;

  -- 3. Посадка
  begin perform public.farm_plant('cress', array[4]); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'plot_closed' then E'ok   3a нельзя садить в закрытую клетку\n' else E'FAIL 3a ' || e || E'\n' end;
  begin perform public.farm_plant('nope', array[1]); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'bad_seed' then E'ok   3b несуществующее семя отклонено\n' else E'FAIL 3b ' || e || E'\n' end;
  j := public.farm_plant('cress', array[1]);
  res := res || case when (j->>'silver')::int = 200 and (j->>'spent')::int = 0
                then E'ok   3c бесплатный кресс не списывает серебро\n' else E'FAIL 3c ' || j::text || E'\n' end;
  begin perform public.farm_plant('cress', array[1]); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'plot_busy' then E'ok   3d нельзя садить в занятую клетку\n' else E'FAIL 3d ' || e || E'\n' end;
  begin perform public.farm_plant('radish', array[1, 2]); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'plot_busy'
                      and (public.farm_state()->>'silver')::int = 200
                      and not exists (select 1 from public.farm_plantings where user_id = u1 and plot = 2 and harvested_at is null)
                then E'ok   3e массовая посадка «всё или ничего»\n' else E'FAIL 3e ' || e || E'\n' end;
  begin perform public.farm_plant('melon', array[2]); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'not_enough' then E'ok   3f арбуз за 1200 при 200 серебра отклонён\n' else E'FAIL 3f ' || e || E'\n' end;
  j := public.farm_plant('radish', array[2, 3]);
  res := res || case when (j->>'silver')::int = 160 and (j->>'spent')::int = 40
                then E'ok   3g массовая посадка: 2 клетки по 20 = 40\n' else E'FAIL 3g ' || j::text || E'\n' end;

  -- 4. Сбор: до готовности нельзя
  j := public.farm_harvest(null);
  res := res || case when (j->>'harvested')::int = 0 and (j->>'gained')::int = 0
                then E'ok   4a до готовности сбор ничего не даёт\n' else E'FAIL 4a ' || j::text || E'\n' end;

  -- граница: готово ровно «сейчас» (ready_at в прошлом на миллисекунду) — собирается; в будущем на 5 сек — нет
  select id into pid from public.farm_plantings where user_id = u1 and plot = 1 and harvested_at is null;
  update public.farm_plantings set ready_at = clock_timestamp() + interval '5 seconds' where id = pid;
  j := public.farm_harvest(array[pid]);
  res := res || case when (j->>'harvested')::int = 0 then E'ok   4b за 5 секунд до готовности — нельзя\n' else E'FAIL 4b\n' end;
  update public.farm_plantings set ready_at = clock_timestamp() - interval '1 millisecond' where id = pid;
  j := public.farm_harvest(array[pid]);
  res := res || case when (j->>'harvested')::int = 1 and (j->>'gained')::int = 1 and (j->>'profit')::int = 1
                then E'ok   4c сразу после готовности: +1 серебро, прибыль 1\n' else E'FAIL 4c ' || j::text || E'\n' end;
  j := public.farm_harvest(array[pid]);
  res := res || case when (j->>'harvested')::int = 0 and (j->>'gained')::int = 0
                then E'ok   4d повторный сбор той же посадки ничего не даёт\n' else E'FAIL 4d ' || j::text || E'\n' end;

  -- 5. Игрок отсутствовал несколько суток: готовое остаётся одним сбором
  update public.farm_plantings set ready_at = clock_timestamp() - interval '3 days'
   where user_id = u1 and harvested_at is null;
  j := public.farm_harvest(null);
  res := res || case when (j->>'harvested')::int = 2 and (j->>'gained')::int = 46 and (j->>'profit')::int = 6
                       and (j->>'silver')::int = 207
                then E'ok   5a пропуск 3 суток: один сбор на посадку (2 редиса: +46, прибыль 6)\n' else E'FAIL 5a ' || j::text || E'\n' end;
  j := public.farm_harvest(null);
  res := res || case when (j->>'harvested')::int = 0 then E'ok   5b массовый повтор ничего не начисляет\n' else E'FAIL 5b\n' end;

  -- 6. Изменение настроек не трогает уже посаженное
  update public.farm_wallets set silver = 5000 where user_id = u1;
  j := public.farm_plant('melon', array[1]);
  update public.farm_seeds set payout = 9999 where id = 'melon';   -- откатится вместе с тестом
  update public.farm_plantings set ready_at = clock_timestamp() - interval '1 second' where user_id = u1 and harvested_at is null;
  j2 := public.farm_harvest(null);
  res := res || case when (j2->>'gained')::int = 2400 and (j2->>'profit')::int = 1200
                then E'ok   6 после смены настроек старая посадка платит по старым условиям (2400, прибыль 1200)\n'
                else E'FAIL 6 ' || j2::text || E'\n' end;
  update public.farm_seeds set payout = 2400 where id = 'melon';

  -- 7. Чужие данные: игрок 2 не может собрать посадку игрока 1
  j := public.farm_plant('cress', array[1]);
  select id into pid from public.farm_plantings where user_id = u1 and harvested_at is null limit 1;
  update public.farm_plantings set ready_at = clock_timestamp() - interval '1 second' where id = pid;
  perform set_config('request.jwt.claims', json_build_object('sub', u2)::text, true);
  j2 := public.farm_harvest(array[pid]);
  res := res || case when (j2->>'harvested')::int = 0 and exists (select 1 from public.farm_plantings where id = pid and harvested_at is null)
                then E'ok   7a игрок 2 не может собрать чужую посадку\n' else E'FAIL 7a\n' end;
  j2 := public.farm_state();
  res := res || case when (j2->>'silver')::int = 100 and (j2->>'plots_open')::int = 2 and jsonb_array_length(j2->'plantings') = 0
                then E'ok   7b у игрока 2 свой чистый старт, чужих посадок не видно\n' else E'FAIL 7b\n' end;

  -- 8. Не участник
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid())::text, true);
  begin perform public.farm_state(); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'not_member' then E'ok   8 посторонний не может открыть ферму\n' else E'FAIL 8 ' || e || E'\n' end;

  -- 9. Закрытость таблиц и функций для клиентов
  perform set_config('request.jwt.claims', json_build_object('sub', u1)::text, true);
  set local role authenticated;
  begin perform 1 from public.farm_wallets limit 1; e := 'нет ошибки'; exception when others then e := 'denied'; end;
  res := res || case when e = 'denied' then E'ok   9a прямое чтение farm_wallets клиенту закрыто\n' else E'FAIL 9a таблица читается напрямую\n' end;
  begin perform public.farm_enter(); e := 'нет ошибки'; exception when others then e := 'denied'; end;
  res := res || case when e = 'denied' then E'ok   9b внутренняя farm_enter клиенту закрыта\n' else E'FAIL 9b\n' end;
  begin perform public.farm_state(); e := 'доступно'; exception when others then e := 'denied'; end;
  res := res || case when e = 'доступно' then E'ok   9c farm_state клиенту доступна\n' else E'FAIL 9c\n' end;
  reset role;
  set local role anon;
  begin perform public.farm_state(); e := 'нет ошибки'; exception when others then e := 'denied'; end;
  reset role;
  res := res || case when e = 'denied' then E'ok   9d гость (anon) не может вызвать ферму\n' else E'FAIL 9d\n' end;

  -- 10. Контрольные цифры экономики
  res := res || case when (select sum(price) from public.farm_plot_prices where plot >= 3) = 76100
                       and (select count(*) from public.farm_plot_prices) = 16
                then E'ok   10a клетки 3-16 стоят вместе 76 100\n' else E'FAIL 10a\n' end;
  res := res || case when (select payout - cost from public.farm_seeds where id = 'cress') = 1
                       and (select payout - cost from public.farm_seeds where id = 'melon') = 1200
                       and (select grow_seconds from public.farm_seeds where id = 'melon') = 86400
                then E'ok   10b прибыль: кресс 1, арбуз 1200, арбуз растёт ровно 24 часа\n' else E'FAIL 10b\n' end;

  -- итог и откат
  raise exception E'\n===== РЕЗУЛЬТАТ ТЕСТА (всё откатано) =====\n%\nFAIL-строк: %\n',
    res, (length(res) - length(replace(res, 'FAIL', ''))) / 4;
end
$test$;
