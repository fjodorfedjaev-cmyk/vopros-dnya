-- ПОКУПКА ПАКОВ: самоотменяющийся тест. Запускать одним запросом ВМЕСТЕ с 03_pack_sale.sql (02_packs.sql уже в базе).
-- В конце тест намеренно падает — откатывается всё. Колода «опустошается» только внутри теста.
do $test$
declare
  u1 uuid; u2 uuid; dump uuid; e text; res text := ''; r record; s record; b0 numeric; pack_id integer; n integer; m integer;
begin
  select p.id into u1 from public.profiles p order by p.created_at, p.id limit 1;
  select p.id into u2 from public.profiles p where p.id <> u1 order by p.created_at, p.id limit 1;
  select p.id into dump from public.profiles p where p.id not in (u1, u2) order by p.created_at, p.id limit 1;
  insert into public.points_ledger (user_id, amount, reason, ref) select x, 20000, 'game', 'test:packsale' from unnest(array[u1, u2]) x;
  select c.id into pack_id from public.cards c where c.rarity = 'pack' and c.series_id = 1;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);

  -- 1. пока серия не закончилась — продажи нет
  begin perform public.cards_pack_buy(1, 600); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when not exists (select 1 from public.cards_pack_sale(1)) and e = 'cards_pack_sale_over'
    then E'ok   1 до конца серии пак не купить\n' else E'FAIL 1 ' || e || E'\n' end;

  -- 2. колода опустела: u1 открывает последнюю карточку → серия закрыта, продажа идёт 14 дней, переезд через 7
  perform public.cards_open(1, public.cards_price(1));
  update public.card_copies k set state = 'owned', owner_id = dump, obtained_at = now()
   where k.state = 'deck' and k.id <> (select x.id from public.card_copies x where x.state = 'deck' order by x.id limit 1);
  perform public.cards_open(1, public.cards_price(1));
  select * into s from public.cards_pack_sale(1);
  res := res || case when s.price = 600 and s.ends_at = (select closed_at from public.card_series where id = 1) + interval '14 days'
      and s.moves_at = (select closed_at from public.card_series where id = 1) + interval '7 days' and s.now_at is not null
    then E'ok   2 серия закончилась: пак за 600, переезд через 7 дней, конец через 14\n' else E'FAIL 2\n' end;

  -- 3. старая цена — ничего не списано
  b0 := public.coins_of(u1);
  begin perform public.cards_pack_buy(1, 500); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'cards_price_changed' and public.coins_of(u1) = b0 then E'ok   3 другая цена — отказ, монеты на месте\n' else E'FAIL 3 ' || e || E'\n' end;

  -- 4. купить: −600, пак мой, номер следующий, запись в книге и истории
  select * into r from public.cards_pack_buy(1, 600);
  res := res || case when r.balance = b0 - 600 and public.coins_of(u1) = b0 - 600
      and (select owner_id from public.card_copies where id = r.copy_id) = u1 and (select state from public.card_copies where id = r.copy_id) = 'owned'
      and (select card_id from public.card_copies where id = r.copy_id) = pack_id
      and r.serial = (select max(serial) from public.card_copies where card_id = pack_id)
      and (select copies from public.cards where id = pack_id) >= r.serial
      and exists (select 1 from public.points_ledger where user_id = u1 and amount = -600 and reason = 'cards' and ref = 'pack:' || r.copy_id)
      and exists (select 1 from public.card_events where copy_id = r.copy_id and kind = 'buy' and to_user = u1 and price = 600)
      and r.packs = 1
    then E'ok   4 куплен пак №' || r.serial || E': −600, в книге монет и в истории\n' else E'FAIL 4\n' end;

  -- 5. ещё два — без ограничения, номера подряд
  perform public.cards_pack_buy(1, 600);
  select * into r from public.cards_pack_buy(1, 600);
  res := res || case when r.packs = 3 and public.coins_of(u1) = b0 - 1800
    then E'ok   5 без ограничения: 3 пака, −1800\n' else E'FAIL 5\n' end;

  -- 6. подарок после покупок: номера продолжаются, «всего паков» = самый большой номер
  n := (select max(serial) from public.card_copies where card_id = pack_id);
  m := public.cards_pack_claim(1);
  res := res || case when m > 0 and (select max(serial) from public.card_copies where card_id = pack_id) = n + m
      and (select copies from public.cards where id = pack_id) = (select sum(packs) from public.card_pack_gifts where series_id = 1) + 3
      and not exists (select serial from public.card_copies where card_id = pack_id group by serial having count(*) > 1)
    then E'ok   6 подарок после покупок: номера дальше, без повторов; всего паков = подарки + 3 купленных\n' else E'FAIL 6\n' end;

  -- 7. купленный пак открывается как обычный
  select * into r from public.cards_pack_open((select k.id from public.card_copies k join public.card_events e on e.copy_id = k.id
                                                where k.card_id = pack_id and k.owner_id = u1 and k.state = 'owned' and e.kind = 'buy' limit 1));
  res := res || case when r.rarity <> 'pack' and r.serial > r.copies then E'ok   7 купленный пак открылся: «' || r.name || E'»\n' else E'FAIL 7\n' end;

  -- 8. мало монет — отказ (другой участник без лишних монет, если такой есть)
  perform set_config('request.jwt.claims', json_build_object('sub', dump, 'role', 'authenticated')::text, true);
  if public.coins_of(dump) < 600 then
    begin perform public.cards_pack_buy(1, 600); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
    res := res || case when e = 'cards_not_enough' then E'ok   8 без 600 монет не купить\n' else E'FAIL 8 ' || e || E'\n' end;
  else
    res := res || E'skip 8 у участника больше 600 монет\n';
  end if;

  -- 9. через 14 дней продажа закрыта
  update public.card_series set closed_at = now() - interval '15 days' where id = 1;
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  begin perform public.cards_pack_buy(1, 600); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when not exists (select 1 from public.cards_pack_sale(1)) and e = 'cards_pack_sale_over'
    then E'ok   9 через 14 дней продажа закрыта\n' else E'FAIL 9 ' || e || E'\n' end;
  -- на седьмой день — ещё идёт (переезд — дело сайта)
  update public.card_series set closed_at = now() - interval '8 days' where id = 1;
  select * into s from public.cards_pack_sale(1);
  res := res || case when s.price = 600 and s.moves_at < now() and s.ends_at > now() then E'ok   10 на 8-й день продажа идёт, время переезда прошло\n' else E'FAIL 10\n' end;

  -- 11. гость не покупает и не видит продажу
  set local role anon;
  begin perform public.cards_pack_buy(1, 600); e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  reset role;
  res := res || case when e = 'отказ' then E'ok   11 гость не покупает\n' else E'FAIL 11\n' end;

  raise exception E'\n===== РЕЗУЛЬТАТ ТЕСТА «ПОКУПКА ПАКОВ» (всё откатано) =====\n%\nFAIL-строк: %\n',
    res, (length(res) - length(replace(res, 'FAIL', ''))) / 4;
end
$test$;
