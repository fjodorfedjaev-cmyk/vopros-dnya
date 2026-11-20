-- ЗАЯВКИ НА ПОКУПКУ: самоотменяющийся тест. Запускать одним запросом ВМЕСТЕ с 02_bids.sql.
-- В конце тест намеренно падает — откатывается всё (и миграция тоже), следов нет.
do $test$
declare
  u1 uuid; u2 uuid; u3 uuid; e text; res text := ''; n integer; m integer; x numeric;
  cid integer; c bigint[]; r record; bid1 bigint; bid2 bigint; bid3 bigint; bid4 bigint; lid bigint; lid2 bigint;
  t0 numeric; t1 numeric; fees0 numeric; p0 bigint; local boolean;
  b1 numeric; b2 numeric; b3 numeric;
begin
  select p.id into u1 from public.profiles p order by p.created_at, p.id limit 1;
  select p.id into u2 from public.profiles p where p.id <> u1 order by p.created_at, p.id limit 1;
  select p.id into u3 from public.profiles p where p.id not in (u1, u2) order by p.created_at, p.id limit 1;
  insert into public.points_ledger (user_id, amount, reason, ref)
    values (u1, 3000, 'game', 'test:bids:1'), (u2, 3000, 'game', 'test:bids:2'), (u3, 3000, 'game', 'test:bids:3');
  local := to_regclass('public.push_calls') is not null;

  -- обычная карточка (6 копий): все копии отдаём u1, убираем с витрин и из лавки (всё откатится)
  select cc.id into cid from public.cards cc where cc.copies = 6 order by cc.sort limit 1;
  delete from public.card_showcase sc where sc.copy_id in (select k.id from public.card_copies k where k.card_id = cid);
  update public.card_listings l set status = 'cancelled', closed_at = now()
   where l.status = 'active' and l.copy_id in (select k.id from public.card_copies k where k.card_id = cid);
  update public.card_copies k set state = 'owned', owner_id = u1, obtained_at = now() where k.card_id = cid;
  select array_agg(k.id order by k.serial) into c from public.card_copies k where k.card_id = cid;
  t0 := public.coins_of(u1) + public.coins_of(u2) + public.coins_of(u3);
  select coalesce(sum(l.fee), 0) into fees0 from public.card_listings l where l.status = 'sold';

  -- 1. заявка откладывает монеты; видна в списке заявок, «моя» — только своему
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  b2 := public.coins_of(u2);
  select * into r from public.market_bid(cid, 100);
  bid1 := r.bid_id;
  res := res || case when r.kind = 'bid' and r.balance = b2 - 100 and public.coins_of(u2) = b2 - 100
      and exists (select 1 from public.market_bids() q where q.bid_id = bid1 and q.mine and q.price = 100)
    then E'ok   1 заявка за 100: отложено 100, видна как своя\n' else E'FAIL 1\n' end;
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  res := res || case when exists (select 1 from public.market_bids() q where q.bid_id = bid1 and not q.mine)
    then E'ok   1b другому видна, но не как его\n' else E'FAIL 1b\n' end;

  -- 2. отложенное нельзя потратить: ни на вторую заявку, ни на карточку из колоды
  b3 := public.coins_of(u3);
  select * into r from public.market_bid(cid, b3 - 50);      -- у u3 остаётся доступно 50
  bid2 := r.bid_id;
  n := 0;
  begin perform public.market_bid(cid, 60); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e = 'market_not_enough' then n := n + 1; end if;
  if public.cards_price(1) > 0 then
    begin perform public.cards_open(1, public.cards_price(1)); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
    if e = 'cards_not_enough' then n := n + 1; end if;
  else n := n + 1; end if;
  res := res || case when n = 2 and public.coins_of(u3) = 50
    then E'ok   2 отложенное не тратится: вторая заявка и карточка из колоды — «не хватает»\n' else E'FAIL 2 (' || n || E')\n' end;
  perform public.market_bid_cancel(bid2);
  res := res || case when public.coins_of(u3) = b3 and (select status from public.card_bids where id = bid2) = 'cancelled'
    then E'ok   3 отмена заявки — монеты снова доступны\n' else E'FAIL 3\n' end;

  -- 4. выставил дешевле заявки — продано сразу, по цене заявки; комиссия 10% с продавца
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  b1 := public.coins_of(u1);
  if local then select count(*) into p0 from public.push_calls; end if;
  select * into r from public.market_sell(c[1], 80);
  res := res || case when r.sold and r.price = 100 and r.net = 90 and public.coins_of(u1) = b1 + 90 and public.coins_of(u2) = b2 - 100
      and (select owner_id from public.card_copies where id = c[1]) = u2 and (select state from public.card_copies where id = c[1]) = 'owned'
      and (select status from public.card_bids where id = bid1) = 'filled' and (select listing_id from public.card_bids where id = bid1) = r.listing_id
      and (select fee from public.card_listings where id = r.listing_id) = 10
      and exists (select 1 from public.card_events ev where ev.copy_id = c[1] and ev.kind = 'sale' and ev.from_user = u1 and ev.to_user = u2 and ev.price = 100)
    then E'ok   4 выставил за 80 при заявке 100 — продано за 100, продавцу 90, копия у покупателя\n' else E'FAIL 4\n' end;
  if local then
    res := res || case when (select count(*) from public.push_calls) = p0 + 1
        and exists (select 1 from public.push_calls pc where pc.payload ->> 'type' = 'bid' and (pc.payload ->> 'listing_id')::bigint = r.listing_id)
        and (select buyer from public.push_bid_info(r.listing_id)) = u2
      then E'ok   4b покупателю — уведомление «Заявка исполнена»\n' else E'FAIL 4b\n' end;
  end if;

  -- 5. очередь: дороже — раньше, при равной цене — кто раньше
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  select q.bid_id into bid1 from public.market_bid(cid, 50) q;           -- u2: 50 (раньше)
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  select q.bid_id into bid2 from public.market_bid(cid, 50) q;           -- u3: 50 (позже)
  select q.bid_id into bid3 from public.market_bid(cid, 60) q;           -- u3: 60
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  lid := public.market_list(c[2], 40);                                    -- старое имя тоже совпадает с заявкой
  lid2 := public.market_list(c[3], 50);
  res := res || case when (select status from public.card_bids where id = bid3) = 'filled' and (select price from public.card_listings where id = lid) = 60
      and (select status from public.card_bids where id = bid1) = 'filled' and (select status from public.card_bids where id = bid2) = 'active'
      and (select owner_id from public.card_copies where id = c[2]) = u3 and (select owner_id from public.card_copies where id = c[3]) = u2
    then E'ok   5 очередь: сначала заявка 60, потом из двух по 50 — более ранняя\n' else E'FAIL 5\n' end;

  -- 6. дороже лучшей заявки — просто лот; снизил цену до заявки — продано по цене заявки
  select * into r from public.market_sell(c[4], 70);
  lid := r.listing_id;
  res := res || case when not r.sold and (select status from public.card_listings where id = lid) = 'active'
      and (select state from public.card_copies where id = c[4]) = 'market'
    then E'ok   6 за 70 при заявке 50 — лот висит\n' else E'FAIL 6\n' end;
  perform public.market_reprice(lid, 45);
  res := res || case when (select status from public.card_listings where id = lid) = 'sold' and (select price from public.card_listings where id = lid) = 50
      and (select buyer_id from public.card_listings where id = lid) = u3 and (select status from public.card_bids where id = bid2) = 'filled'
      and (select owner_id from public.card_copies where id = c[4]) = u3
    then E'ok   7 снизил до 45 — продано по заявке за 50\n' else E'FAIL 7\n' end;

  -- 8. заявка не ниже цены лота — куплено сразу, по цене лота (свои лоты не трогает)
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  lid := public.market_list(c[1], 120);                                   -- u2 продаёт свои
  lid2 := public.market_list(c[3], 110);
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  b1 := public.coins_of(u1);
  select * into r from public.market_bid(cid, 130);
  res := res || case when r.kind = 'bought' and r.price = 110 and r.copy_id = c[3] and public.coins_of(u1) = b1 - 110
      and (select status from public.card_listings where id = lid2) = 'sold' and (select status from public.card_listings where id = lid) = 'active'
      and (select owner_id from public.card_copies where id = c[3]) = u1
      and not exists (select 1 from public.card_bids q where q.buyer_id = u1 and q.status = 'active')
    then E'ok   8 заявка 130 — сразу куплен самый дешёвый лот за 110, заявка не повисла\n' else E'FAIL 8\n' end;
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  b2 := public.coins_of(u2);
  select * into r from public.market_bid(cid, 200);
  bid4 := r.bid_id;
  res := res || case when r.kind = 'bid' and (select status from public.card_listings where id = lid) = 'active' and public.coins_of(u2) = b2 - 200
    then E'ok   9 свой лот за 120 своей заявкой 200 не покупается\n' else E'FAIL 9\n' end;
  perform public.market_bid_cancel(bid4);

  -- 10. подняли заявку до цены лота — куплено по цене лота; меняли цену без совпадения — меняется отложенное
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  b3 := public.coins_of(u3);
  select q.bid_id into bid1 from public.market_bid(cid, 100) q;
  select * into r from public.market_bid_reprice(bid1, 125);
  res := res || case when r.kind = 'bought' and r.price = 120 and r.copy_id = c[1] and public.coins_of(u3) = b3 - 120
      and (select status from public.card_bids where id = bid1) = 'filled' and (select listing_id from public.card_bids where id = bid1) = lid
    then E'ok   10 подняли заявку 100 → 125 — куплен лот за 120\n' else E'FAIL 10\n' end;
  b3 := public.coins_of(u3);
  select q.bid_id into bid2 from public.market_bid(cid, 30) q;
  perform public.market_bid_reprice(bid2, 40);
  x := public.coins_of(u3);
  perform public.market_bid_reprice(bid2, 20);
  res := res || case when x = b3 - 40 and public.coins_of(u3) = b3 - 20 and (select price from public.card_bids where id = bid2) = 20
    then E'ok   11 заявка 30 → 40 → 20: отложено 40, потом 20\n' else E'FAIL 11\n' end;
  n := 0;
  begin perform public.market_bid_reprice(bid2, public.coins_of(u3) + 21); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e = 'market_not_enough' then n := n + 1; end if;
  res := res || case when n = 1 and (select price from public.card_bids where id = bid2) = 20
    then E'ok   12 поднять дороже, чем есть, — «не хватает», заявка прежняя\n' else E'FAIL 12\n' end;

  -- 13. «Продать сразу»: если заявки не ниже нет — ошибка и лот не создаётся; есть — продано
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  begin perform public.market_sell(c[3], 25, true); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'market_bid_gone' and (select state from public.card_copies where id = c[3]) = 'owned'
      and not exists (select 1 from public.card_listings l where l.copy_id = c[3] and l.status = 'active')
    then E'ok   13 «продать сразу за 25» при заявке 20 — отказ, лот не создан\n' else E'FAIL 13 ' || e || E'\n' end;
  select * into r from public.market_sell(c[3], 20, true);
  res := res || case when r.sold and r.price = 20 and (select owner_id from public.card_copies where id = c[3]) = u3
      and (select status from public.card_bids where id = bid2) = 'filled'
    then E'ok   14 «продать сразу за 20» — продано в заявку\n' else E'FAIL 14\n' end;

  -- 15. чужую заявку не отменить и не поменять; исполненную — тоже; с витрины не продать
  n := 0;
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  select q.bid_id into bid3 from public.market_bid(cid, 5) q;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  begin perform public.market_bid_cancel(bid3); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e = 'market_bid_gone' then n := n + 1; end if;
  begin perform public.market_bid_reprice(bid3, 6); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e = 'market_bid_gone' then n := n + 1; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  begin perform public.market_bid_cancel(bid2); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e = 'market_bid_gone' then n := n + 1; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  perform public.cards_set_showcase(1, c[5]);
  begin perform public.market_sell(c[5], 5, true); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e = 'cards_in_showcase' then n := n + 1; end if;
  res := res || case when n = 4 and (select status from public.card_bids where id = bid3) = 'active'
    then E'ok   15 чужую и исполненную заявку не тронуть, с витрины не продать\n' else E'FAIL 15 (' || n || E' из 4)\n' end;

  -- 16. неправильная цена и несуществующая карточка
  n := 0;
  foreach x in array array[0.01, 0, 100000, 1.234]::numeric[] loop
    begin perform public.market_bid(cid, x); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
    if e = 'market_bad_price' then n := n + 1; end if;
  end loop;
  begin perform public.market_bid(-1, 10); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  if e = 'market_no_card' then n := n + 1; end if;
  res := res || case when n = 5 then E'ok   16 цены 0,01 / 0 / 100 000 / 1,234 и чужая карточка — отказ\n' else E'FAIL 16 (' || n || E' из 5)\n' end;

  -- 17. не больше 20 заявок у одного
  m := (select count(*) from public.card_bids q where q.buyer_id = u1 and q.status = 'active');
  for n in 1 .. 20 - m loop perform public.market_bid(cid, 0.02); end loop;
  begin perform public.market_bid(cid, 0.02); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'market_bids_limit' and (select count(*) from public.card_bids q where q.buyer_id = u1 and q.status = 'active') = 20
    then E'ok   17 21-я заявка — отказ\n' else E'FAIL 17 ' || e || E'\n' end;

  -- 18. монеты сходятся: баланс трёх + отложенное + сгоревшая комиссия = как было в начале
  t1 := public.coins_of(u1) + public.coins_of(u2) + public.coins_of(u3)
      + (select coalesce(sum(q.price), 0) from public.card_bids q where q.status = 'active' and q.buyer_id in (u1, u2, u3))
      + (select coalesce(sum(l.fee), 0) from public.card_listings l where l.status = 'sold') - fees0;
  res := res || case when t1 = t0 then E'ok   18 монеты сходятся до копейки\n' else E'FAIL 18 ' || t0 || ' → ' || t1 || E'\n' end;

  -- 19. мои сделки: продажи по заявке и обычная покупка
  res := res || case when (select count(*) from public.market_history() h where h.side = 'sold' and h.via_bid) = 5
      and exists (select 1 from public.market_history() h where h.side = 'bought' and not h.via_bid and h.price = 110 and h.serial is not null)
      and exists (select 1 from public.market_history() h where h.side = 'sold' and h.price = 100 and h.net = 90)
    then E'ok   19 «Мои сделки»: 5 продаж по заявкам и покупка за 110\n' else E'FAIL 19\n' end;

  -- 20. таблица заявок закрыта, данные уведомлений и гостю — нельзя
  set local role authenticated;
  begin perform 1 from public.card_bids limit 1; e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  begin perform public.push_bid_info(1); e := e || ',нет ошибки'; exception when others then e := e || ',отказ'; end;
  begin perform public.market_fill(1, 1, u1, null); e := e || ',нет ошибки'; exception when others then e := e || ',отказ'; end;
  reset role;
  set local role anon;
  begin perform public.market_bids(); e := e || ',нет ошибки'; exception when others then e := e || ',отказ'; end;
  begin perform public.market_bid(cid, 1); e := e || ',нет ошибки'; exception when others then e := e || ',отказ'; end;
  reset role;
  res := res || case when e = 'отказ,отказ,отказ,отказ,отказ' then E'ok   20 заявки напрямую закрыты, внутренние функции и гостю — нельзя\n' else E'FAIL 20 ' || e || E'\n' end;

  raise exception E'\n===== РЕЗУЛЬТАТ ТЕСТА «ЗАЯВКИ» (всё откатано) =====\n%\nFAIL-строк: %\n',
    res, (length(res) - length(replace(res, 'FAIL', ''))) / 4;
end
$test$;
