-- ПАКИ: самоотменяющийся тест. Запускать одним запросом ВМЕСТЕ с 02_packs.sql.
-- В конце тест намеренно падает — откатывается всё, следов нет. На рабочей базе тоже безопасно:
-- колода «опустошается» только внутри теста.
do $test$
declare
  u1 uuid; u2 uuid; u3 uuid; dump uuid; e text; res text := ''; n integer; m integer; r record; d record;
  pack_id integer; pk bigint; pk2 bigint; exp1 integer; exp2 integer; total integer; lid bigint;
  ser_before integer; cnt_common integer; cnt_leg integer; cnt_all integer;
begin
  select p.id into u1 from public.profiles p order by p.created_at, p.id limit 1;
  select p.id into u2 from public.profiles p where p.id <> u1 order by p.created_at, p.id limit 1;
  select p.id into u3 from public.profiles p where p.id not in (u1, u2) order by p.created_at, p.id limit 1;
  select p.id into dump from public.profiles p where p.id not in (u1, u2, u3) order by p.created_at, p.id limit 1;
  insert into public.points_ledger (user_id, amount, reason, ref)
    select x, 20000, 'game', 'test:packs' from unnest(array[u1, u2, u3]) x;
  select c.id into pack_id from public.cards c where c.rarity = 'pack' and c.series_id = 1;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);

  -- 1. пак в каталоге, альбом и колода как были
  select * into d from public.cards_deck(1);
  res := res || case when pack_id is not null
      and (select count(*) from public.cards where series_id = 1 and rarity <> 'pack') = 20
      and d.deck_total = 85 and d.deck_left = (select count(*) from public.card_copies where state = 'deck')
      and public.card_melt_value('pack') is null
    then E'ok   1 пак есть в каталоге, карточек по-прежнему 20, «из 85»\n' else E'FAIL 1\n' end;

  -- 2. пока колода не пуста — подарков нет, забрать нечего
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  res := res || case when not exists (select 1 from public.cards_pack_gift()) and public.cards_pack_claim(1) = 0
      and (select closed_at from public.card_series where id = 1) is null
    then E'ok   2 колода не пуста — подарка нет\n' else E'FAIL 2\n' end;

  -- 3. u1 открывает 2 карточки, u2 — 2, u3 — 1; остаток колоды, кроме одной, «раздаём» без покупки; последнюю открывает u1
  perform public.cards_open(1, public.cards_price(1));
  perform public.cards_open(1, public.cards_price(1));
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  perform public.cards_open(1, public.cards_price(1));
  perform public.cards_open(1, public.cards_price(1));
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  perform public.cards_open(1, public.cards_price(1));
  update public.card_copies k set state = 'owned', owner_id = dump, obtained_at = now()
   where k.state = 'deck' and k.id <> (select x.id from public.card_copies x where x.state = 'deck' order by x.id limit 1);
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'role', 'authenticated')::text, true);
  select * into r from public.cards_open(1, public.cards_price(1));
  exp1 := least(3, (select count(*) from public.card_events where kind = 'open' and to_user = u1));
  exp2 := least(3, (select count(*) from public.card_events where kind = 'open' and to_user = u2));
  select coalesce(sum(packs), 0) into total from public.card_pack_gifts where series_id = 1;
  res := res || case when r.deck_left = 0 and r.next_price is null
      and (select closed_at from public.card_series where id = 1) is not null
      and (select packs from public.card_pack_gifts where user_id = u1) = exp1
      and (select packs from public.card_pack_gifts where user_id = u2) = exp2
      and (select packs from public.card_pack_gifts where user_id = u3) = least(3, (select count(*) from public.card_events where kind = 'open' and to_user = u3))
      and not exists (select 1 from public.card_pack_gifts where user_id = dump and packs > least(3, (select count(*) from public.card_events where kind = 'open' and to_user = dump)))
      and (select copies from public.cards where id = pack_id) = greatest(1, total)
    then E'ok   3 последняя карточка — серия закрыта, подарки: 1 открытая = 1 пак, не больше 3 (u1 ' || exp1 || ', u2 ' || exp2 || E')\n'
    else E'FAIL 3\n' end;

  -- 4. всё, кто открывал, получили подарок; всего паков = сумма; повторное закрытие ничего не меняет
  perform public.cards_close_series(1);
  res := res || case when (select count(*) from public.card_pack_gifts where series_id = 1)
        = (select count(distinct to_user) from public.card_events e join public.card_copies k on k.id = e.copy_id
            join public.cards c on c.id = k.card_id where e.kind = 'open' and c.series_id = 1 and e.to_user is not null)
      and (select coalesce(sum(packs), 0) from public.card_pack_gifts where series_id = 1) = total
    then E'ok   4 подарок у каждого, кто открывал; второе закрытие — без изменений\n' else E'FAIL 4\n' end;

  -- 5. колода пуста: открыть нельзя, «0 из 85»
  begin perform public.cards_open(1, 100); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  select * into d from public.cards_deck(1);
  res := res || case when e = 'cards_deck_empty' and d.deck_left = 0 and d.deck_total = 85 and d.price is null
    then E'ok   5 колода пуста: открыть нельзя, «0 из 85»\n' else E'FAIL 5 ' || e || E'\n' end;

  -- 6. забрать: паки в коллекции, второй раз — 0
  select packs into n from public.cards_pack_gift() where series_id = 1;
  m := public.cards_pack_claim(1);
  res := res || case when n = exp1 and m = exp1 and public.cards_pack_claim(1) = 0
      and not exists (select 1 from public.cards_pack_gift())
      and (select count(*) from public.cards_my() where card_id = pack_id) = exp1
      and (select count(*) from public.card_events e join public.card_copies k on k.id = e.copy_id
            where k.card_id = pack_id and e.kind = 'grant' and e.to_user = u1) = exp1
      and not exists (select 1 from public.cards_my() where card_id = pack_id and can_melt)
    then E'ok   6 «Забрать»: ' || m || E' пака в коллекции, второй раз — 0, переплавить нельзя\n' else E'FAIL 6\n' end;

  -- 7. пак — не на витрину и не в переплавку; в «Собрано» не считается
  select copy_id into pk from public.cards_my() where card_id = pack_id order by serial limit 1;
  begin perform public.cards_set_showcase(1, pk); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  begin perform public.cards_melt(pk); n := 1; exception when others then n := 0; end;
  res := res || case when e = 'cards_pack_shelf' and n = 0 and not exists (select 1 from public.card_showcase where copy_id = pk)
      and (select distinct_cards from public.cards_members() where user_id = u1)
        = (select count(distinct k.card_id) from public.card_copies k join public.cards c on c.id = k.card_id
            where k.owner_id = u1 and k.state = 'owned' and c.rarity <> 'pack')
      and (public.member_profile(u1)->>'cards_total')::integer = 20
    then E'ok   7 пак нельзя на витрину и переплавить; «Собрано X из 20» без паков\n' else E'FAIL 7 ' || e || E'\n' end;

  -- 8. открыть пак: карточка серии, номер сверх тиража, пак открыт, история записана
  select * into r from public.cards_pack_open(pk);
  res := res || case when r.rarity <> 'pack' and r.serial > r.copies
      and r.serial = (select max(serial) from public.card_copies where card_id = r.card_id)
      and (select state from public.card_copies where id = pk) = 'opened'
      and (select owner_id from public.card_copies where id = r.copy_id) = u1
      and (select state from public.card_copies where id = r.copy_id) = 'owned'
      and exists (select 1 from public.card_events where copy_id = pk and kind = 'unpack' and from_user = u1)
      and exists (select 1 from public.card_events where copy_id = r.copy_id and kind = 'pack' and to_user = u1)
      and r.packs_left = exp1 - 1
    then E'ok   8 пак открыт: «' || r.name || '» №' || r.serial || '/' || r.copies || E', пак исчез, история есть\n' else E'FAIL 8\n' end;

  -- 9. второй раз тот же пак — нельзя; чужой пак — нельзя; обычную карточку как пак — нельзя
  begin perform public.cards_pack_open(pk); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'cards_not_yours' then E'ok   9a пак открывается только один раз\n' else E'FAIL 9a ' || e || E'\n' end;
  begin perform public.cards_pack_open(r.copy_id); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
  res := res || case when e = 'cards_not_pack' then E'ok   9b обычную карточку как пак не открыть\n' else E'FAIL 9b ' || e || E'\n' end;

  -- 10. Лавка: u1 выставляет пак, u2 покупает и открывает; пока пак в Лавке — открыть нельзя
  select copy_id into pk2 from public.cards_my() where card_id = pack_id order by serial limit 1;
  if pk2 is not null then
    select listing_id into lid from public.market_sell(pk2, 120, false);
    begin perform public.cards_pack_open(pk2); e := 'нет ошибки'; exception when others then e := sqlerrm; end;
    perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
    perform public.market_buy(lid, 120);
    select * into r from public.cards_pack_open(pk2);
    res := res || case when e = 'cards_not_yours' and r.rarity <> 'pack' and r.serial > r.copies
        and (select owner_id from public.card_copies where id = r.copy_id) = u2
        and (select state from public.card_copies where id = pk2) = 'opened'
      then E'ok   10 пак продаётся в Лавке, в Лавке его не открыть, купивший открывает\n' else E'FAIL 10 ' || e || E'\n' end;
  else
    res := res || E'skip 10 у u1 был один пак\n';
  end if;

  -- 11. шансы как в полной колоде: 850 паков (как 10 полных колод) → обычных около 48 из 85 (56%)
  perform set_config('request.jwt.claims', json_build_object('sub', u3, 'role', 'authenticated')::text, true);
  select coalesce(max(serial), 0) into ser_before from public.card_copies where card_id = pack_id;
  insert into public.card_copies (card_id, serial, state, owner_id, obtained_at)
    select pack_id, ser_before + s, 'owned', u3, now() from generate_series(1, 850) s;
  create temp table t_pk on commit drop as
    select o.* from public.card_copies k, lateral public.cards_pack_open(k.id) o
    where k.card_id = pack_id and k.owner_id = u3 and k.state = 'owned';
  select count(*), count(*) filter (where rarity = 'common'), count(*) filter (where rarity = 'legendary')
    into cnt_all, cnt_common, cnt_leg from t_pk;
  res := res || case when cnt_all >= 850 and cnt_common between cnt_all * 0.50 and cnt_all * 0.63 and cnt_leg between 1 and 25
      and not exists (select 1 from t_pk where rarity = 'pack')
    then E'ok   11 шансы: из ' || cnt_all || ' паков обычных ' || cnt_common || ' (' || round(cnt_common * 100.0 / cnt_all) || '%, ждём ~56%), «Солнце дня» ' || cnt_leg || E' (ждём ~10)\n'
    else E'FAIL 11 обычных ' || cnt_common || ' из ' || cnt_all || ', легендарных ' || cnt_leg || E'\n' end;

  -- 12. номера сверх тиража — подряд, без повторов
  res := res || case when not exists (
      select 1 from (select card_id, serial, row_number() over (partition by card_id order by serial) rn
                     from public.card_copies where card_id <> pack_id) x where x.serial <> x.rn)
    then E'ok   12 номера у каждой карточки идут подряд: №1…№6, потом №7/6, №8/6…\n' else E'FAIL 12\n' end;

  -- 13. переплавка копии из пака — как у обычной; «Солнце дня» №2/1 в уведомлении — с номером
  select copy_id into pk from public.cards_my() m join public.cards c on c.id = m.card_id
   where c.rarity = 'common' and m.serial > c.copies and m.can_melt limit 1;
  if pk is not null then
    begin perform public.cards_melt(pk); e := 'ок'; exception when others then e := sqlerrm; end;
    res := res || case when e = 'ок' and (select state from public.card_copies where id = pk) = 'melted'
      then E'ok   13 копию из пака можно переплавить\n' else E'FAIL 13 ' || e || E'\n' end;
  else
    res := res || E'skip 13 нет обычной копии из пака\n';
  end if;

  -- 14. права: гость не забирает и не открывает, участник не закрывает серию сам, таблица подарков закрыта
  set local role anon;
  begin perform public.cards_pack_claim(1); e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  reset role;
  res := res || case when e = 'отказ' then E'ok   14a гость не забирает паки\n' else E'FAIL 14a\n' end;
  set local role authenticated;
  begin perform public.cards_close_series(1); e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  reset role;
  res := res || case when e = 'отказ' then E'ok   14b участник не может сам закрыть серию\n' else E'FAIL 14b\n' end;
  set local role authenticated;
  begin perform 1 from public.card_pack_gifts limit 1; e := 'нет ошибки'; exception when others then e := 'отказ'; end;
  reset role;
  res := res || case when e = 'отказ' then E'ok   14c подарки нельзя читать напрямую\n' else E'FAIL 14c\n' end;

  raise exception E'\n===== РЕЗУЛЬТАТ ТЕСТА «ПАКИ» (всё откатано) =====\n%\nFAIL-строк: %\n',
    res, (length(res) - length(replace(res, 'FAIL', ''))) / 4;
end
$test$;
