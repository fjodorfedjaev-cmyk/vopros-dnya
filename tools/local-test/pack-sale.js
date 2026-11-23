// Сценарий «Покупка паков» (23.11): две недели после конца серии пак можно купить за 600.
// Первая неделя — на месте колоды («Пак «Начало»», «Купить за 600», «Осталось 13 д …», таймер идёт, «Что может выпасть»);
// подарок — сначала; покупка без ограничения; первый пак — страница едет к плитке. Неделя сменилась прямо на экране —
// покупка переезжает полосой над блоком коллекции («ещё …»), в блоке — «Скоро новая коллекция»; через 14 дней покупки нет.
// Мало монет — кнопка неактивна. Режим проверки: «1-я неделя / 2-я неделя / конец», покупка без монет и без базы.
// База: как для packs.js (pk) плюс 03_pack_sale.sql. Запуск: DB=pk node pack-sale.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const DB = process.env.DB || 'pk';
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-c', sql]).toString().trim();
const as = (uid, sql) => q(`select set_config('request.jwt.claims', json_build_object('sub', '${uid}', 'role', 'authenticated')::text, false); ${sql}`);
const results = [];
const ok = (name, cond) => results.push((cond ? 'ok   ' : 'FAIL ') + name);
const ids = q(`select string_agg(id::text, ',' order by created_at, id) from public.profiles`).split(',');
const admin = q('select user_id from public.admins limit 1');
const [u2, u3, poor] = ids.filter(x => x !== admin);
const dump = ids.filter(x => ![admin, u2, u3, poor].includes(x))[0];
const packId = q(`select id from public.cards where rarity = 'pack'`);
const coins = (u) => Number(q(`select public.coins_of('${u}')`));
const packs = (u) => Number(q(`select count(*) from public.card_copies where card_id = ${packId} and owner_id = '${u}' and state = 'owned'`));

async function toColl(p) {
  await p.locator('.bn-item', { hasText: 'Коллекция' }).click();
  await p.waitForSelector('.ko', { timeout: 8000 });
  await B.sleep(500);
}

(async () => {
  q(`insert into public.points_ledger (user_id, amount, reason, ref) select id, 5000, 'game', 'test:sale' from public.profiles where id <> '${poor}'`);
  q(`insert into public.points_ledger (user_id, amount, reason, ref) values ('${poor}', -500, 'game', 'test:poor')`);   // 1000 − 500 = 500 < 600
  for (let i = 0; i < 2; i++) as(admin, `select copy_id from public.cards_open(1, public.cards_price(1))`);
  q(`update public.card_copies set state = 'owned', owner_id = '${dump}', obtained_at = now()
      where state = 'deck' and id <> (select id from public.card_copies where state = 'deck' order by id limit 1)`);
  as(admin, `select copy_id from public.cards_open(1, public.cards_price(1))`);
  ok('колода пуста, серия закрыта', q(`select closed_at is not null from public.card_series where id = 1`) === 't');

  const browser = await B.launch(), errors = [];
  const p = await B.phone(browser, admin, errors, { tag: 'админ' });
  await toColl(p);
  ok('сначала подарок, покупки пока нет', await p.locator('.ko-gift').count() === 1 && !(await p.locator('.ko-buy').count()) && !(await p.locator('.kps').count()));
  await p.locator('.ko-gift .ko-open').click();
  await B.sleep(1800);
  await p.evaluate(() => window.scrollTo(0, 0));
  await B.sleep(300);
  await shot(p, 'ps_week1');
  const t1 = (await p.locator('.ko-buy .ko-left').textContent()).trim();
  ok('после «Забрать» — покупка на месте колоды: «Пак «Начало»», «Купить за 600», «Осталось 13 д …» — ' + t1,
    (await p.locator('.ko-buy .ko-title').textContent()).includes('Пак «Начало»') && /Купить за 600/.test(await p.locator('.ko-buy .ko-open').textContent())
    && /^13 д \d\d:\d\d:\d\d$/.test(t1));
  await B.sleep(1500);
  ok('таймер идёт', (await p.locator('.ko-buy .ko-left').textContent()).trim() !== t1);
  await p.locator('.ko-buy .ko-odds').click();
  await p.waitForSelector('.kb-sheet .kx-row');
  ok('«Что может выпасть»: 5 редкостей, 56% … 1,2%', (await p.locator('.kb-sheet .kx-pct').allTextContents()).join(' ') === '56% 24% 14% 4,7% 1,2%');
  await p.mouse.click(195, 30); await B.sleep(300);
  const c0 = coins(admin), n0 = packs(admin);
  await p.locator('.ko-buy .ko-open').click();
  await B.sleep(1500);
  ok('купил: −600, паков +1, на плитке «×' + (n0 + 1) + '»', coins(admin) === c0 - 600 && packs(admin) === n0 + 1
    && (await p.locator('.ka-tile.r-pack .ka-badge').textContent()).trim() === '×' + (n0 + 1));
  await p.evaluate(() => window.scrollTo(0, 0)); await B.sleep(200);
  await p.locator('.ko-buy .ko-open').click(); await B.sleep(1200);
  ok('без ограничения: ещё один', packs(admin) === n0 + 2 && coins(admin) === c0 - 1200);

  // друг без покупок колоды: сразу покупка; первый пак — страница едет к плитке
  const f = await B.phone(browser, u3, errors, { tag: 'друг' });
  await toColl(f);
  ok('друг без подарка: сразу покупка', await f.locator('.ko-buy').count() === 1 && !(await f.locator('.ko-gift').count()));
  await f.locator('.ko-buy .ko-open').click();
  await B.sleep(1300);
  const inView = await f.locator('.ka-tile.r-pack').evaluate(n => { const r = n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }).catch(() => false);
  ok('первый пак: страница доехала до плитки пака', inView && packs(u3) === 1);

  // мало монет — кнопка неактивна
  const pp = await B.phone(browser, poor, errors, { tag: 'без монет' });
  await toColl(pp);
  ok('500 монет: «Купить за 600» неактивна', await pp.locator('.ko-buy .ko-open').isDisabled());

  // неделя сменяется прямо на экране: до переезда 3 секунды
  q(`update public.card_series set closed_at = now() - interval '7 days' + interval '4 seconds' where id = 1`);
  await f.reload(); await f.waitForSelector('.bn-item'); await toColl(f);
  ok('за секунды до переезда — ещё на месте колоды', await f.locator('.ko-buy').count() === 1);
  await B.sleep(5500);
  await f.evaluate(() => window.scrollTo(0, 0)); await B.sleep(300);
  await shot(f, 'ps_week2');
  const t2 = (await f.locator('.kps .ko-left').textContent().catch(() => '')).trim();
  ok('неделя сменилась сама: полоса над блоком коллекции «ещё 6 д …», в блоке — «Скоро новая коллекция» — ' + t2,
    await f.locator('.kps').count() === 1 && !(await f.locator('.ko-buy').count()) && await f.locator('.ko-soon').count() === 1 && /^6 д \d\d:\d\d:\d\d$/.test(t2)
    && await f.evaluate(() => { const a = document.querySelector('.kps'), b = document.querySelector('.ko-soon'); return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); }));
  await f.locator('.kps-buy').click();
  await B.sleep(1300);
  ok('купил из полосы: паков 2', packs(u3) === 2);

  // через 14 дней покупки нет
  q(`update public.card_series set closed_at = now() - interval '15 days' where id = 1`);
  await f.reload(); await f.waitForSelector('.bn-item'); await toColl(f);
  ok('через 14 дней: ни полосы, ни покупки, «Скоро новая коллекция»', !(await f.locator('.kps').count()) && !(await f.locator('.ko-buy').count()) && await f.locator('.ko-soon').count() === 1);

  // режим проверки: недели переключаются, покупка без монет и без базы
  const before = q(`select (select count(*) from public.card_copies) || '/' || (select coalesce(sum(amount), 0) from public.points_ledger) || '/' || (select count(*) from public.card_events)`);
  await p.reload(); await p.waitForSelector('.bn-item'); await toColl(p);
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await B.sleep(200);
  await p.locator('.kpv-link').click(); await B.sleep(400);
  await p.locator('.kpv-chip', { hasText: '0' }).first().click(); await B.sleep(300);
  ok('проверка, подарок 0: покупка 1-й недели', await p.locator('.ko-buy').count() === 1);
  await p.locator('.ko-buy .ko-open').click(); await B.sleep(1300);
  ok('проверка: пак «куплен» — плитка есть, в базе ничего', await p.locator('.ka-tile.r-pack').count() === 1);
  await p.evaluate(() => window.scrollTo(0, 0)); await B.sleep(200);
  await p.locator('.kpv-chip', { hasText: '2-я неделя' }).click(); await B.sleep(300);
  await shot(p, 'ps_pv_week2');
  ok('проверка: «2-я неделя» — полоса сверху, «Скоро…»', await p.locator('.kps').count() === 1 && await p.locator('.ko-soon').count() === 1);
  await p.locator('.kpv-chip', { hasText: 'конец' }).click(); await B.sleep(300);
  ok('проверка: «конец» — покупки нет', !(await p.locator('.kps').count()) && !(await p.locator('.ko-buy').count()));
  await p.locator('.kpv-exit').click(); await B.sleep(500);
  ok('база не изменилась за проверку', q(`select (select count(*) from public.card_copies) || '/' || (select coalesce(sum(amount), 0) from public.points_ledger) || '/' || (select count(*) from public.card_events)`) === before);

  await browser.close();
  console.log(results.join('\n'));
  console.log(errors.length ? 'ОШИБКИ СТРАНИЦ:\n' + errors.join('\n') : 'ошибок на страницах нет');
  process.exit(results.some(r => r.startsWith('FAIL')) || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
