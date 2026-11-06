-- КАРТОЧКИ: самоотменяющийся тест. Запускать одним запросом ВМЕСТЕ с 01_cards.sql.
-- В конце тест намеренно падает — откатывается всё, следов нет.
do $test$
declare
  u1 uuid; u2 uuid; poor uuid; e text; res text := ''; n integer; b0 numeric; b1 numeric; r record; d record;
  coin_id integer; sun_copy bigint; c1 bigint; other_copy bigint;
begin
  select p.id into u1 from public.profiles p order by p.created_at, p.id limit 1;
  select p.id into u2 from public.profiles p where p.id <> u1 order by p.created_at, p.id limit 1;
  select p.id into poor from public.profiles p where p.id not in (u1, u2) and public.coins_of(p.id) < 300 limit 1;
  insert into public.points_ledger (user_id, amount, reason, ref) values (u1, 5000, 'game', 'test:cards');
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);

  -- 1. серия на месте
  select * into d from public.cards_deck(1);
  res := res || case when (select count(*) from public.cards_catalog(1)) = 20 and d.deck_total = 85 and d.deck_left = 85 and d.price = 300
      and d.left_common = 48 and d.left_uncommon = 20 and d.left_rare = 12 and d.left_epic = 4 and d.left_legendary = 1
    then E'ok   1 серия «Начало»: 20 карточек, 85 копий в колоде, цена 300\n' else E'FAIL 1\n' end;

  -- 2. цена поменялась — ничего не списано
  b0 := public.coins_of(u1);
  begin perform public.cards_open(1, 250); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'cards_price_changed' and public.coins_of(u1) = b0 then E'ok   2 старая цена — отказ, монеты на месте\n' else E'FAIL 2 ' || e || E'\n' end;

  -- 3. открыть: −300, копия моя, есть запись в истории
  select * into r from public.cards_open(1, 300);
  res := res || case when r.balance = b0 - 300 and r.deck_left = 84
      and (select state from public.card_copies where id = r.copy_id) = 'owned'
      and (select owner_id from public.card_copies where id = r.copy_id) = u1
      and exists (select 1 from public.card_events where copy_id = r.copy_id and kind = 'open' and to_user = u1 and price = 300)
    then E'ok   3 открыта «' || r.name || E'», −300, копия моя, в истории есть\n' else E'FAIL 3\n' end;
  c1 := r.copy_id;

  -- 4. мало монет — отказ
  if poor is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', poor, 'role', 'authenticated')::text, true);
    begin perform public.cards_open(1, 300); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
    res := res || case when e = 'cards_not_enough' then E'ok   4 без монет открыть нельзя\n' else E'FAIL 4 ' || e || E'\n' end;
    perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  else
    res := res || E'skip 4 нет участника с балансом меньше 300\n';
  end if;

  -- 5. переплавка: все 6 «Монет» отдаём u1, 5 переплавляются по 15, шестая — последняя в игре
  -- если первой выпала «Монета», для проверки переплавки берём «Стрелку»
  select id into coin_id from public.cards
   where code = case when (select c.code from public.cards c join public.card_copies k on k.card_id = c.id where k.id = c1) = 'coin' then 'arrow' else 'coin' end;
  update public.card_copies set state = 'owned', owner_id = u1, obtained_at = now() where card_id = coin_id and state = 'deck';
  b1 := public.coins_of(u1);
  n := 0;
  for r in select id from public.card_copies where card_id = coin_id and state = 'owned' order by serial limit 5 loop
    perform public.cards_melt(r.id); n := n + 1;
  end loop;
  res := res || case when n = 5 and public.coins_of(u1) = b1 + 75
      and (select count(*) from public.card_copies where card_id = coin_id and state = 'melted') = 5
      and (select count(*) from public.card_events e2 join public.card_copies k on k.id = e2.copy_id where k.card_id = coin_id and e2.kind = 'melt') = 5
    then E'ok   5a 5 «Монет» переплавлены, +75\n' else E'FAIL 5a\n' end;
  select id into r from public.card_copies where card_id = coin_id and state = 'owned';
  begin perform public.cards_melt(r.id); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'cards_last_copy' then E'ok   5b последнюю копию в игре переплавить нельзя\n' else E'FAIL 5b ' || e || E'\n' end;
  res := res || case when (select can_melt from public.cards_my() where copy_id = r.id) = false then E'ok   5c у последней копии кнопки переплавки нет\n' else E'FAIL 5c\n' end;

  -- 6. второй раз ту же копию не переплавить
  select id into other_copy from public.card_copies where card_id = coin_id and state = 'melted' limit 1;
  begin perform public.cards_melt(other_copy); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'cards_not_yours' then E'ok   6 переплавленную второй раз не переплавить\n' else E'FAIL 6 ' || e || E'\n' end;

  -- 7. чужую копию не переплавить и не поставить на витрину
  select k.id into other_copy from public.card_copies k join public.cards c on c.id = k.card_id where c.code = 'fire' and k.state = 'deck' limit 1;
  update public.card_copies set state = 'owned', owner_id = u2 where id = other_copy;
  begin perform public.cards_melt(other_copy); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'cards_not_yours' then E'ok   7a чужую не переплавить\n' else E'FAIL 7a ' || e || E'\n' end;
  begin perform public.cards_set_showcase(1, other_copy); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'cards_not_yours' then E'ok   7b чужую не поставить на витрину\n' else E'FAIL 7b ' || e || E'\n' end;

  -- 8. витрина: поставить, переставить, нельзя переплавить, убрать
  perform public.cards_set_showcase(1, c1);
  begin perform public.cards_melt(c1); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e in ('cards_in_showcase', 'cards_no_melt') then E'ok   8a с витрины не переплавить\n' else E'FAIL 8a ' || e || E'\n' end;
  perform public.cards_set_showcase(2, c1);
  res := res || case when (select count(*) from public.cards_showcases() where user_id = u1) = 1
      and (select slot from public.cards_showcases() where copy_id = c1) = 2
    then E'ok   8b копия переехала на другую полку\n' else E'FAIL 8b\n' end;
  begin perform public.cards_set_showcase(4, c1); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'cards_bad_slot' then E'ok   8c полки только 1–3\n' else E'FAIL 8c ' || e || E'\n' end;
  perform public.cards_set_showcase(2, null);
  res := res || case when not exists (select 1 from public.cards_showcases() where user_id = u1) then E'ok   8d полку можно очистить\n' else E'FAIL 8d\n' end;

  -- 9. цена по ступенькам: убираем из колоды редкости сверху вниз
  update public.card_copies k set state = 'owned', owner_id = u1 from public.cards c where c.id = k.card_id and k.state = 'deck' and c.rarity = 'legendary';
  n := (select price from public.cards_deck(1));
  update public.card_copies k set state = 'owned', owner_id = u1 from public.cards c where c.id = k.card_id and k.state = 'deck' and c.rarity = 'epic';
  e := n || ',' || (select price from public.cards_deck(1));
  update public.card_copies k set state = 'owned', owner_id = u1 from public.cards c where c.id = k.card_id and k.state = 'deck' and c.rarity = 'rare';
  e := e || ',' || (select price from public.cards_deck(1));
  update public.card_copies k set state = 'owned', owner_id = u1 from public.cards c where c.id = k.card_id and k.state = 'deck' and c.rarity = 'uncommon';
  e := e || ',' || (select price from public.cards_deck(1));
  res := res || case when e = '250,200,150,100' then E'ok   9 цена падает: 250 → 200 → 150 → 100\n' else E'FAIL 9 ' || e || E'\n' end;

  -- 10. золотую переплавить нельзя
  select k.id into sun_copy from public.card_copies k join public.cards c on c.id = k.card_id where c.code = 'sun';
  begin perform public.cards_melt(sun_copy); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'cards_no_melt' then E'ok   10 золотую переплавить нельзя\n' else E'FAIL 10 ' || e || E'\n' end;

  -- 11. открыть за 100, пока остались только серые; потом колода пустая
  select * into r from public.cards_open(1, 100);
  res := res || case when r.rarity = 'common' then E'ok   11a за 100 выпала серая\n' else E'FAIL 11a\n' end;
  update public.card_copies set state = 'owned', owner_id = u1 where state = 'deck';
  begin perform public.cards_open(1, 100); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'cards_deck_empty' and (select price from public.cards_deck(1)) is null then E'ok   11b колода пустая — открыть нельзя\n' else E'FAIL 11b ' || e || E'\n' end;

  -- 12. счётчик коллекции для «Участников»
  res := res || case when (select distinct_cards from public.cards_members() where user_id = u1) = 20 then E'ok   12 у u1 собраны все 20\n' else E'FAIL 12\n' end;

  -- 13. таблицы напрямую закрыты, гость ничего не может
  set local role authenticated;
  begin perform 1 from public.card_copies limit 1; e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  reset role;
  res := res || case when e = 'отказ' then E'ok   13a копии нельзя читать напрямую\n' else E'FAIL 13a\n' end;
  set local role anon;
  begin perform public.cards_open(1, 300); e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  reset role;
  res := res || case when e = 'отказ' then E'ok   13b гость не может открыть\n' else E'FAIL 13b\n' end;

  raise exception E'\n===== РЕЗУЛЬТАТ ТЕСТА «КАРТОЧКИ» (всё откатано) =====\n%\nFAIL-строк: %\n',
    res, (length(res) - length(replace(res, 'FAIL', ''))) / 4;
end
$test$;
