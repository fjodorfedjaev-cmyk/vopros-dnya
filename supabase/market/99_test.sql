-- ЛАВКА: самоотменяющийся тест. Запускать одним запросом ВМЕСТЕ с 01_market.sql.
-- В конце тест намеренно падает — откатывается всё (и миграция тоже), следов нет.
do $test$
declare
  u1 uuid; u2 uuid; poor uuid; nonadmin uuid; e text; res text := ''; r record; x numeric;
  cid integer; c1 bigint; c2 bigint; c3 bigint; c4 bigint; l1 bigint; l2 bigint; l3 bigint;
  b1 numeric; b2 numeric; q0 bigint; hook boolean; n integer; sid bigint;
begin
  select p.id into u1 from public.profiles p order by p.created_at, p.id limit 1;
  select p.id into u2 from public.profiles p where p.id <> u1 order by p.created_at, p.id limit 1;
  select p.id into poor from public.profiles p where p.id not in (u1, u2) order by public.coins_of(p.id), p.id limit 1;
  select p.id into nonadmin from public.profiles p where not exists (select 1 from public.admins a where a.user_id = p.id) order by p.created_at limit 1;
  insert into public.points_ledger (user_id, amount, reason, ref)
    values (u1, 5000, 'game', 'test:market:1'), (u2, 5000, 'game', 'test:market:2'), (nonadmin, 1000, 'game', 'test:market:3');
  hook := public.push_hook_secret() is not null;

  -- для проверок берём «необычную» карточку, все 4 копии которой ещё в колоде, и отдаём их u1
  select c.id into cid from public.cards c
   where c.copies = 4 and not exists (select 1 from public.card_copies k where k.card_id = c.id and k.state <> 'deck')
   order by c.sort limit 1;
  update public.card_copies set state = 'owned', owner_id = u1, obtained_at = now() where card_id = cid;
  select id into c1 from public.card_copies where card_id = cid order by serial limit 1;
  select id into c2 from public.card_copies where card_id = cid order by serial offset 1 limit 1;
  select id into c3 from public.card_copies where card_id = cid order by serial offset 2 limit 1;
  select id into c4 from public.card_copies where card_id = cid order by serial offset 3 limit 1;

  -- 1. комиссия: 10% до сотых, не меньше 0,01
  res := res || case when public.market_fee(0.02) = 0.01 and public.market_fee(0.09) = 0.01 and public.market_fee(0.10) = 0.01
      and public.market_fee(0.14) = 0.01 and public.market_fee(0.15) = 0.02 and public.market_fee(155) = 15.50
      and public.market_fee(200) = 20 and public.market_fee(99999.99) = 10000.00
    then E'ok   1 комиссия: 0,02→0,01 · 0,15→0,02 · 155→15,50 · 99 999,99→10 000\n' else E'FAIL 1\n' end;

  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);

  -- 2. неправильные цены не принимаются
  n := 0;
  foreach x in array array[0.01, 0, -1, 100000, 1.234]::numeric[] loop
    begin perform public.market_list(c1, x); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
    if e = 'market_bad_price' then n := n + 1; end if;
  end loop;
  begin perform public.market_list(c1, null); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e = 'market_bad_price' then n := n + 1; end if;
  res := res || case when n = 6 and (select state from public.card_copies where id = c1) = 'owned'
    then E'ok   2 цены 0,01 / 0 / −1 / 100 000 / 1,234 / пусто — отказ\n' else E'FAIL 2 (' || n || E' из 6)\n' end;

  -- 3. выставить за 155: копия ушла из коллекции, видна в лавке, есть в истории
  n := (select total_copies from public.cards_members() where user_id = u1);
  l1 := public.market_list(c1, 155);
  res := res || case when (select state from public.card_copies where id = c1) = 'market'
      and not exists (select 1 from public.cards_my() where copy_id = c1)
      and (select total_copies from public.cards_members() where user_id = u1) = n - 1
      and exists (select 1 from public.market_lots() where listing_id = l1 and mine and price = 155 and seller_id = u1)
      and exists (select 1 from public.card_events where copy_id = c1 and kind = 'list' and from_user = u1 and price = 155)
    then E'ok   3 выставлена за 155: пропала из коллекции, есть в лавке и в истории\n' else E'FAIL 3\n' end;

  -- 4. выставленную нельзя выставить ещё раз, переплавить и поставить на витрину
  n := 0;
  begin perform public.market_list(c1, 10); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e = 'cards_not_yours' then n := n + 1; end if;
  begin perform public.cards_melt(c1); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e = 'cards_not_yours' then n := n + 1; end if;
  begin perform public.cards_set_showcase(1, c1); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e = 'cards_not_yours' then n := n + 1; end if;
  res := res || case when n = 3 then E'ok   4 в лавке: второй раз не выставить, не переплавить, не на витрину\n' else E'FAIL 4 (' || n || E' из 3)\n' end;

  -- 5. с витрины — сначала убрать
  perform public.cards_set_showcase(1, c2);
  begin perform public.market_list(c2, 10); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  perform public.cards_set_showcase(1, null);
  res := res || case when e = 'cards_in_showcase' then E'ok   5 с витрины не выставить\n' else E'FAIL 5 ' || e || E'\n' end;

  -- 6. изменить цену может только продавец
  perform public.market_reprice(l1, 155.55);
  e := (select price::text from public.card_listings where id = l1);
  perform public.market_reprice(l1, 155);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  n := 0;
  begin perform public.market_reprice(l1, 1); exception when others then if sqlerrm = 'market_gone' then n := n + 1; end if; end;
  begin perform public.market_cancel(l1); exception when others then if sqlerrm = 'market_gone' then n := n + 1; end if; end;
  res := res || case when e = '155.55' and n = 2 and (select price from public.card_listings where id = l1) = 155
      and (select count(*) from public.card_events where copy_id = c1 and kind = 'reprice') = 2
    then E'ok   6 цену меняет только продавец\n' else E'FAIL 6 ' || e || ' ' || n || E'\n' end;

  -- 7. свою не купить
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  begin perform public.market_buy(l1, 155); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'market_own' then E'ok   7 свою карточку не купить\n' else E'FAIL 7 ' || e || E'\n' end;

  -- 8. цена изменилась, пока смотрел — ничего не списано
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  b2 := public.coins_of(u2);
  begin perform public.market_buy(l1, 150); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'market_price_changed' and public.coins_of(u2) = b2 and (select status from public.card_listings where id = l1) = 'active'
    then E'ok   8 старая цена — отказ, монеты на месте\n' else E'FAIL 8 ' || e || E'\n' end;

  -- 9. не хватает монет
  if poor is not null and public.coins_of(poor) < 155 then
    perform set_config('request.jwt.claims', json_build_object('sub', poor, 'role', 'authenticated')::text, true);
    begin perform public.market_buy(l1, 155); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
    res := res || case when e = 'market_not_enough' then E'ok   9 без монет не купить\n' else E'FAIL 9 ' || e || E'\n' end;
    perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  else
    res := res || E'skip 9 нет участника с балансом меньше 155\n';
  end if;

  -- 10. покупка: покупатель −155, продавец +139,50, 15,50 сгорело, копия у покупателя
  b1 := public.coins_of(u1);
  b2 := public.coins_of(u2);
  select count(*) into q0 from net.http_request_queue;
  select * into r from public.market_buy(l1, 155);
  res := res || case when r.balance = b2 - 155 and public.coins_of(u2) = b2 - 155 and public.coins_of(u1) = b1 + 139.50
      and (select owner_id from public.card_copies where id = c1) = u2 and (select state from public.card_copies where id = c1) = 'owned'
      and (select status from public.card_listings where id = l1) = 'sold' and (select fee from public.card_listings where id = l1) = 15.50
      and exists (select 1 from public.card_events where copy_id = c1 and kind = 'sale' and from_user = u1 and to_user = u2 and price = 155)
      and exists (select 1 from public.cards_my() where copy_id = c1)
      and not exists (select 1 from public.market_lots() where listing_id = l1)
    then E'ok   10 куплена: −155 у покупателя, +139,50 продавцу, копия перешла\n' else E'FAIL 10\n' end;
  if hook and exists (select 1 from public.push_subscriptions where user_id = u1 and active) then
    res := res || case when (select count(*) from net.http_request_queue) = q0 + 1 then E'ok   10b уведомление продавцу поставлено в очередь\n' else E'FAIL 10b\n' end;
  else
    res := res || E'skip 10b у продавца нет уведомлений\n';
  end if;
  res := res || case when (select r2.balance from public.my_points() r2) = public.coins_of(u2) then E'ok   10c баланс в профиле считает лавку\n' else E'FAIL 10c\n' end;

  -- 11. второй раз ту же не купить
  begin perform public.market_buy(l1, 155); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'market_gone' then E'ok   11 проданную второй раз не купить\n' else E'FAIL 11 ' || e || E'\n' end;

  -- 12. в лавке видна цена последней продажи
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  l2 := public.market_list(c2, 10);
  res := res || case when (select last_price from public.market_lots() where listing_id = l2) = 155
    then E'ok   12 у нового лота видна последняя продажа: 155\n' else E'FAIL 12\n' end;

  -- 13. снять с продажи: копия вернулась в коллекцию
  perform public.market_cancel(l2);
  begin perform public.market_cancel(l2); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when (select state from public.card_copies where id = c2) = 'owned'
      and exists (select 1 from public.cards_my() where copy_id = c2) and e = 'market_gone'
      and exists (select 1 from public.card_events where copy_id = c2 and kind = 'unlist')
    then E'ok   13 снята: снова в коллекции, второй раз не снять\n' else E'FAIL 13 ' || e || E'\n' end;

  -- 14. копия в лавке считается живой: «последнюю в игре» по-прежнему не переплавить
  l3 := public.market_list(c3, 5);
  perform public.cards_melt(c2);
  perform public.cards_melt(c4);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  begin perform public.cards_melt(c1); e := 'ok'; exception when others then e := sqlerrm; end;  -- живы c1 и c3 (в лавке)
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  perform public.market_cancel(l3);
  begin perform public.cards_melt(c3); exception when others then e := e || ',' || sqlerrm; end;
  res := res || case when e = 'ok,cards_last_copy' then E'ok   14 копия в лавке считается: последнюю не переплавить\n' else E'FAIL 14 ' || e || E'\n' end;

  -- 15. самая дешёвая продажа: 0,02 → продавцу 0,01
  l3 := public.market_list(c3, 0.02);
  b1 := public.coins_of(u1);
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  b2 := public.coins_of(u2);
  perform public.market_buy(l3, 0.02);
  res := res || case when public.coins_of(u1) = b1 + 0.01 and public.coins_of(u2) = b2 - 0.02 and (select fee from public.card_listings where id = l3) = 0.01
    then E'ok   15 за 0,02: продавцу 0,01, сгорело 0,01\n' else E'FAIL 15\n' end;

  -- 16. уведомление админу о новом «Свой вопрос» (автора не раскрываем, самому себе не шлём)
  perform set_config('request.jwt.claims', json_build_object('sub', nonadmin, 'role', 'authenticated')::text, true);
  select count(*) into q0 from net.http_request_queue;
  select s_id into sid from public.suggest_question('question', 'Тест лавки: норм ли есть суп вилкой ' || floor(random() * 1000000)::text);
  res := res || case when (select count(*) from public.push_suggest_info(sid)) = (select count(*) from public.admins a where a.user_id <> nonadmin)
    then E'ok   16a админам есть что показать\n' else E'FAIL 16a\n' end;
  if hook and exists (select 1 from public.admins a join public.push_subscriptions ps on ps.user_id = a.user_id and ps.active where a.user_id <> nonadmin) then
    res := res || case when (select count(*) from net.http_request_queue) = q0 + 1 then E'ok   16b уведомление админу поставлено в очередь\n' else E'FAIL 16b\n' end;
  else
    res := res || E'skip 16b у админа нет уведомлений\n';
  end if;

  -- 17. таблица лотов закрыта, гость ничего не может
  set local role authenticated;
  begin perform 1 from public.card_listings limit 1; e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  begin perform public.push_sale_info(l1); e := e || ',нет ошибки'; exception when others then e := e || ',отказ'; end;
  reset role;
  set local role anon;
  begin perform public.market_lots(); e := e || ',нет ошибки'; exception when others then e := e || ',отказ'; end;
  reset role;
  res := res || case when e = 'отказ,отказ,отказ' then E'ok   17 лоты напрямую закрыты, данные уведомлений и гостю — нельзя\n' else E'FAIL 17 ' || e || E'\n' end;

  raise exception E'\n===== РЕЗУЛЬТАТ ТЕСТА «ЛАВКА» (всё откатано) =====\n%\nFAIL-строк: %\n',
    res, (length(res) - length(replace(res, 'FAIL', ''))) / 4;
end
$test$;
