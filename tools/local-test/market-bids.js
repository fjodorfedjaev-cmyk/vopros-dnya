// Сценарий «Лавка: рынок и заявки» — два участника через весь сайт:
// каталог и фильтры, страница карточки, заявка (монеты откладываются), «Продать сразу» в заявку,
// покупка выбранного номера, заявка дороже лота — «Купить сразу», выставление, «Мои сделки» (Продаю / Покупаю / История), отмена заявки.
// База: как для coll-redesign.js, плюс ../../supabase/market/02_bids.sql. Запуск: DB=coll node market-bids.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const DB = process.env.DB || 'coll';
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-c', sql]).toString().trim();
const coins = (u) => Number(q(`select public.coins_of('${u}')`));
const results = [];
const ok = (name, cond) => results.push((cond ? 'ok   ' : 'FAIL ') + name);
const A = q('select user_id from public.admins limit 1');
const F = q(`select id from public.profiles where id <> '${A}' order by created_at limit 1`);
// Ракета (необычная, 4 копии): три — продавцу A; Солнце дня — никому (в колоде)
const rocket = q(`select id from public.cards where name = 'Ракета'`);
const sun = q(`select id from public.cards where name = 'Солнце дня'`);
q(`update public.card_copies set state = 'owned', owner_id = '${A}', obtained_at = now() where card_id = ${rocket} and serial <= 3`);
const owner = (serial) => q(`select owner_id from public.card_copies where card_id = ${rocket} and serial = ${serial}`);

async function openMarket(p) {
  await p.locator('.bn-item', { hasText: 'Профиль' }).click();
  await p.locator('.bn-item', { hasText: 'Коллекция' }).click();      // заново зайти — свежие данные
  await p.waitForSelector('.coll-switch');
  if ((await p.locator('.coll-switch button', { hasText: 'Лавка' }).getAttribute('aria-pressed')) !== 'true') await p.locator('.coll-switch button', { hasText: 'Лавка' }).click();
  await p.waitForSelector('.mk-tabs');
}
async function tab(p, name) { await p.locator('.mk-tabs button', { hasText: name }).click(); await B.sleep(200); }
async function twice(p, loc) { const h = await loc.elementHandle(); await h.click(); await B.sleep(150); await h.click(); }

(async () => {
  const browser = await B.launch(), errors = [];
  const pa = await B.phone(browser, A, errors, { tag: 'продавец' });
  const pf = await B.phone(browser, F, errors, { tag: 'покупатель' });
  const a0 = coins(A), f0 = coins(F);

  // 1. каталог у покупателя
  await openMarket(pf); await tab(pf, 'Рынок');
  await shot(pf, 'mb_catalog');
  ok('каталог: 20 строк, «Предложений других игроков пока нет»', await pf.locator('.mk-crow').count() === 20
    && (await pf.locator('.mk-sum').textContent()).includes('Предложений других игроков пока нет'));
  await pf.locator('.mk-rar', { hasText: 'Легендарная' }).click();
  const legend = await pf.locator('.mk-crow').count();
  await pf.locator('.mk-rar', { hasText: 'Легендарная' }).click();
  await pf.locator('.ka-filter', { hasText: 'В продаже' }).click();
  const onSale = await pf.locator('.mk-crow').count();
  await pf.locator('.ka-filter', { hasText: 'Все' }).click();
  ok('фильтры: легендарная — 1 строка, «В продаже» — пусто', legend === 1 && onSale === 0);

  // 2. заявка покупателя на Ракету за 100
  await pf.locator('.mk-crow', { hasText: 'Ракета' }).click();
  await pf.waitForSelector('.mk-sheet .mk-tiles');
  await shot(pf, 'mb_card_empty');
  await pf.getByRole('button', { name: 'Создать заявку' }).click();
  await pf.waitForSelector('#mk-bid');
  await pf.locator('#mk-bid').fill('100');
  await B.sleep(200);
  await shot(pf, 'mb_bidform');
  ok('форма заявки: «Отложится 100», «Создать заявку на 100»', (await pf.locator('.mk-meta').textContent()).includes('100')
    && /Создать заявку на 100/.test(await pf.locator('.kc-actions .btn.primary').textContent()));
  await pf.locator('.kc-actions .btn.primary').click();
  await B.sleep(1200);
  ok('заявка создана, монеты отложены (−100)', q(`select count(*) from public.card_bids where buyer_id = '${F}' and status = 'active' and price = 100`) === '1' && coins(F) === f0 - 100);

  // 3. продавец: «Продать» → Ракета → «Продать сразу за 100»
  await openMarket(pa); await tab(pa, 'Продать');
  await shot(pa, 'mb_sell_grid');
  ok('«Продать»: на Ракете видна заявка 100', (await pa.locator('.mk-pick-grid .kt', { hasText: 'Ракета' }).textContent()).includes('100'));
  await pa.locator('.mk-pick-grid .kt', { hasText: 'Ракета' }).click();
  await pa.waitForSelector('.kb-sheet .mk-form');
  await shot(pa, 'mb_sell_sheet');
  const now = pa.locator('.kc-actions .btn', { hasText: 'Продать сразу за 100' });
  ok('панель продажи: «Лучшая заявка 100», кнопка «Продать сразу за 100 · получишь 90»', (await pa.locator('.mk-tiles').textContent()).includes('100') && /получишь 90/.test(await now.textContent()));
  await twice(pa, now);
  await B.sleep(1500);
  if (await pa.locator('.kb-sheet .msg').count()) console.log('сообщение:', await pa.locator('.kb-sheet .msg').textContent());
  ok('продано по заявке: №1 у покупателя, продавцу +90, у покупателя −100', owner(1) === F && coins(A) === a0 + 90 && coins(F) === f0 - 100
    && q(`select status from public.card_bids where buyer_id = '${F}' order by id desc limit 1`) === 'filled');

  // 4. продавец выставляет №2 за 150 и №3 за 120
  await tab(pa, 'Продать');
  await pa.locator('.mk-pick-grid .kt', { hasText: 'Ракета' }).click();
  await pa.waitForSelector('#mk-p');
  await pa.locator('#mk-p').fill('150');
  await pa.locator('.kc-actions .btn.primary').click();
  await B.sleep(1200);
  await pa.locator('.mk-pick-grid .kt', { hasText: 'Ракета' }).click();
  await pa.waitForSelector('#mk-p');
  await pa.locator('#mk-p').fill('120');
  await pa.locator('.kc-actions .btn.primary').click();
  await B.sleep(1200);
  ok('выставлены №2 за 150 и №3 за 120', q(`select string_agg(k.serial || ':' || l.price::int, ',' order by k.serial) from public.card_listings l join public.card_copies k on k.id = l.copy_id where l.status = 'active' and k.card_id = ${rocket}`) === '2:150,3:120');

  // 5. покупатель: страница Ракеты — предложения, выбор №2, покупка
  await openMarket(pf); await tab(pf, 'Рынок');
  await shot(pf, 'mb_catalog2');
  ok('строка каталога: «от 120», «В продаже: 2 шт.», «У тебя: 1»', /от\s*120/.test(await pf.locator('.mk-crow', { hasText: 'Ракета' }).textContent())
    && (await pf.locator('.mk-crow', { hasText: 'Ракета' }).textContent()).includes('В продаже: 2 шт.') && (await pf.locator('.mk-crow', { hasText: 'Ракета' }).textContent()).includes('У тебя: 1'));
  await pf.locator('.mk-crow', { hasText: 'Ракета' }).click();
  await pf.waitForSelector('.mk-offers');
  ok('на странице: «Купить от 120», выбран самый дешёвый №3', (await pf.locator('.mk-tiles').textContent()).includes('120')
    && (await pf.locator('.mk-offer[aria-checked="true"]').textContent()).includes('№3'));
  await pf.locator('.mk-offer', { hasText: '№2' }).click();
  await shot(pf, 'mb_card_offers');
  const buy = pf.locator('.kc-actions .btn.primary');
  ok('выбрал №2 — кнопка «Купить №2 за 150»', /Купить №2 за 150/.test(await buy.textContent()));
  const f1 = coins(F);
  await twice(pf, buy);
  await B.sleep(1500);
  ok('куплен №2 за 150 (у продавца +135)', owner(2) === F && coins(F) === f1 - 150);

  // 6. заявка дороже лота — «Купить сразу» по цене лота
  await pf.locator('.mk-crow', { hasText: 'Ракета' }).click();
  await pf.getByRole('button', { name: 'Создать заявку' }).click();
  await pf.locator('#mk-bid').fill('130');
  await B.sleep(200);
  await shot(pf, 'mb_bid_cross');
  const cross = pf.locator('.kc-actions .btn.primary');
  ok('заявка 130 при лоте 120: подсказка и кнопка «Купить сразу за 120»', /Купить сразу за 120/.test(await cross.textContent()) && await pf.locator('.mk-cross:not([hidden])').count() === 1);
  const f2 = coins(F);
  await twice(pf, cross);
  await B.sleep(1500);
  ok('куплен №3 за 120, заявка не повисла', owner(3) === F && coins(F) === f2 - 120 && q(`select count(*) from public.card_bids where buyer_id = '${F}' and status = 'active'`) === '0');

  // 7. заявка на Солнце дня (никто не продаёт) — видна в «Мои сделки → Покупаю», отмена
  await pf.locator('.mk-crow', { hasText: 'Солнце дня' }).click();
  await pf.waitForSelector('.mk-sheet');
  await pf.locator('.kc-actions .btn', { hasText: 'Создать заявку' }).click();
  await pf.locator('#mk-bid').fill('500');
  await pf.locator('.kc-actions .btn.primary').click();
  await B.sleep(1200);
  await tab(pf, 'Мои сделки');
  await pf.locator('.mk-dtabs button', { hasText: 'Покупаю' }).click();
  await shot(pf, 'mb_deals_buy');
  ok('«Мои сделки»: «В заявках: 500», заявка на Солнце дня', (await pf.locator('.mk-bal').textContent()).includes('В заявках: 500')
    && await pf.locator('.mk-lot', { hasText: 'Солнце дня' }).count() === 1);
  const f3 = coins(F);
  await pf.locator('.mk-lot', { hasText: 'Солнце дня' }).click();
  await pf.getByRole('button', { name: 'Отменить заявку' }).click();
  await B.sleep(1200);
  ok('заявка отменена — 500 снова доступны', coins(F) === f3 + 500 && q(`select count(*) from public.card_bids where card_id = ${sun} and status = 'active'`) === '0');
  await pf.locator('.mk-dtabs button', { hasText: 'История' }).click();
  await B.sleep(1200);
  await shot(pf, 'mb_deals_hist');
  const hist = await pf.locator('.mk-hist').allTextContents();
  ok('история покупателя: 3 покупки, одна «по заявке»', hist.length === 3 && hist.filter(t => t.includes('по заявке')).length === 1);

  // 8. продавец: история — 3 продажи, «Продаю» пусто
  await openMarket(pa); await tab(pa, 'Мои сделки');
  await pa.locator('.mk-dtabs button', { hasText: 'История' }).click();
  await B.sleep(1200);
  await shot(pa, 'mb_seller_hist');
  const sh = await pa.locator('.mk-hist').allTextContents();
  ok('история продавца: 3 продажи (+90, +135, +108)', sh.length === 3 && sh.join(' ').includes('+90') && sh.join(' ').includes('+135') && sh.join(' ').includes('+108'));
  ok('монеты сходятся: продавец +333, покупатель −370, сгорело 37', coins(A) === a0 + 333 && coins(F) === f0 - 370);

  console.log(results.join('\n'));
  console.log(errors.length ? errors.slice(0, 20).join('\n') : 'ошибок на страницах нет');
  await browser.close();
  process.exit(results.some(r => r.startsWith('FAIL')) || errors.length ? 1 : 0);
})().catch(e => { console.error('СБОЙ', e); console.log(results.join('\n')); process.exit(1); });
