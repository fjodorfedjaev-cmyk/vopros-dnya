// Сценарий «Режим проверки паков» (23.11): только админ видит внизу Коллекции «Проверить паки (видно только тебе)».
// В режиме проверки Коллекция показывается так, будто колода опустела: подарок, «Забрать», «Мои паки», открытие —
// и всё это только на телефоне: база не меняется (копии, история, монеты, подарки). «Заново» с подарком 0–3,
// Лавка выключена, у копий из проверки нет кнопок, «Выйти» — всё как было. Друг ссылки не видит.
// База — как для packs.js (pk), колода НЕ пустая. Запуск: DB=pk node pack-preview.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const DB = process.env.DB || 'pk';
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-c', sql]).toString().trim();
const as = (uid, sql) => q(`select set_config('request.jwt.claims', json_build_object('sub', '${uid}', 'role', 'authenticated')::text, false); ${sql}`);
const results = [];
const ok = (name, cond) => results.push((cond ? 'ok   ' : 'FAIL ') + name);
const admin = q('select user_id from public.admins limit 1');
const friend = q(`select id from public.profiles where id <> '${admin}' order by created_at limit 1`);
const snap = () => q(`select (select count(*) from public.card_copies) || '/' || (select count(*) from public.card_copies where state = 'deck') || '/' ||
  (select count(*) from public.card_events) || '/' || (select count(*) from public.card_pack_gifts) || '/' || (select coalesce(sum(amount), 0) from public.points_ledger) || '/' ||
  (select count(*) from public.card_showcase) || '/' || coalesce((select closed_at::text from public.card_series where id = 1), '-')`);

async function tapThrough(p) {
  await p.waitForSelector('.kr-stage:not(.kr-wait)', { timeout: 8000 });
  for (let i = 0; i < 10 && !(await p.locator('.kr-result.on').count()); i++) { await p.locator('.kr-stage').click(); await B.sleep(300); }
  await p.waitForSelector('.kr-result.on', { timeout: 5000 });
}

(async () => {
  q(`insert into public.points_ledger (user_id, amount, reason, ref) select id, 5000, 'game', 'test:pv' from public.profiles`);
  for (let i = 0; i < 3; i++) as(admin, `select copy_id from public.cards_open(1, public.cards_price(1))`);
  const before = snap();
  const browser = await B.launch(), errors = [];

  const f = await B.phone(browser, friend, errors, { tag: 'друг' });
  await f.locator('.bn-item', { hasText: 'Коллекция' }).click();
  await f.waitForSelector('.ko', { timeout: 8000 });
  await B.sleep(500);
  ok('друг ссылки «Проверить паки» не видит', !(await f.locator('.kpv-link').count()));

  const p = await B.phone(browser, admin, errors, { tag: 'админ' });
  await p.locator('.bn-item', { hasText: 'Коллекция' }).click();
  await p.waitForSelector('.ko', { timeout: 8000 });
  await B.sleep(600);
  ok('у админа внизу Коллекции — «Проверить паки (видно только тебе)»', (await p.locator('.kpv-link').textContent()).includes('Проверить паки'));
  ok('до проверки — обычный блок открытия', /Открыть за/.test(await p.locator('.ko-open').textContent()));
  const realCount = (await p.locator('.ka-count').textContent()).trim();
  await p.locator('.kpv-link').click();
  await B.sleep(500);
  await shot(p, 'pv_start');
  ok('проверка: плашка «Режим проверки паков», подарок «3 пака», «Забрать»', (await p.locator('.kpv-t b').textContent()).includes('Режим проверки')
    && (await p.locator('.ko-gift-n').textContent()).trim() === '3 пака' && await p.locator('.ko-fan .kpk').count() === 3);
  await p.locator('.ko-gift .ko-open').click();
  await B.sleep(1300);
  await shot(p, 'pv_claimed');
  ok('«Забрать»: плитка пака «×3» в альбоме, «Скоро новая коллекция»', (await p.locator('.ka-tile.r-pack .ka-badge').textContent()).trim() === '×3' && await p.locator('.ko-soon').count() === 1);
  ok('база не изменилась после «Забрать»', snap() === before);
  // окно пака: Лавка выключена
  await p.locator('.ka-tile.r-pack').click();
  await p.waitForSelector('.kb-sheet .kpk');
  await p.locator('.kb-sheet').getByRole('button', { name: 'Продать в Лавке' }).click();
  await B.sleep(300);
  ok('«Продать в Лавке» в проверке — подсказка, окно на месте', (await p.locator('.toast').last().textContent().catch(() => '')).includes('Лавка выключена') && await p.locator('.kb-sheet').count() === 1);
  await p.locator('.kb-sheet').getByRole('button', { name: 'Открыть пак' }).click();
  await p.waitForSelector('.kr-cover', { timeout: 5000 });
  await tapThrough(p);
  await B.sleep(800);
  await shot(p, 'pv_result');
  ok('открытие в проверке: номер сверх тиража, «Открыть ещё пак · осталось 2», без «На витрину»',
    /из пака · №\d+\/\d+, сверх тиража/.test(await p.locator('.kr-result .kr-sub').first().textContent())
    && (await p.locator('.kr-again').textContent()).includes('осталось 2') && !(await p.getByRole('button', { name: 'На витрину' }).count()));
  const got = await p.locator('.kr-front .kc-name').textContent();
  await p.getByRole('button', { name: 'В коллекцию' }).click();
  await B.sleep(1000);
  ok('база не изменилась после открытия', snap() === before);
  // карточка из проверки в альбоме — без кнопок
  await p.locator('.ka-tile:not(.miss)', { hasText: got }).first().click();
  await p.waitForSelector('.kb-sheet');
  const chips = p.locator('.kb-sheet .kc-chip');
  if (await chips.count()) await chips.last().click();   // копия из проверки — последняя по номеру
  await B.sleep(300);
  await shot(p, 'pv_detail');
  ok('копия из проверки: подпись «из режима проверки», без витрины, Лавки и переплавки',
    (await p.locator('.kb-sheet').textContent()).includes('из режима проверки') && !(await p.locator('.kb-sheet').getByRole('button', { name: 'На витрину' }).count())
    && !(await p.locator('.kb-sheet .kc-hold').count()));
  await p.mouse.click(195, 30); await B.sleep(300);
  // Лавка в проверке выключена
  await p.locator('.coll-switch button', { hasText: 'Лавка' }).click();
  await B.sleep(400);
  ok('Лавка в проверке выключена', (await p.locator('.coll').textContent()).includes('В режиме проверки Лавка выключена') && !(await p.locator('.mk-tl').count()));
  await p.locator('.coll-switch button', { hasText: 'Коллекция' }).click();
  await B.sleep(300);
  // заново: подарок 0 — сразу «Скоро…»; подарок 1 — «1 пак»
  await p.locator('.kpv-chip', { hasText: '0' }).click();
  await B.sleep(300);
  ok('«Заново: 0» — сразу «Скоро новая коллекция», паков нет', await p.locator('.ko-soon').count() === 1 && !(await p.locator('.ka-tile.r-pack').count()));
  await p.locator('.kpv-chip', { hasText: '1' }).click();
  await B.sleep(300);
  await shot(p, 'pv_one');
  ok('«Заново: 1» — «1 пак», один пак в веере', (await p.locator('.ko-gift-n').textContent()).trim() === '1 пак' && await p.locator('.ko-fan .kpk').count() === 1);
  await p.locator('.kpv-chip', { hasText: '2' }).click();
  await B.sleep(300);
  ok('«Заново: 2» — «2 пака»', (await p.locator('.ko-gift-n').textContent()).trim() === '2 пака');
  // выйти
  await p.locator('.kpv-exit').click();
  await B.sleep(600);
  await shot(p, 'pv_exit');
  ok('«Выйти»: снова «Открыть за», паков нет, альбом как был', /Открыть за/.test(await p.locator('.ko-open').textContent())
    && !(await p.locator('.ka-tile.r-pack').count()) && !(await p.locator('.kpv').count()) && (await p.locator('.ka-count').textContent()).trim() === realCount);
  ok('база не изменилась за всю проверку', snap() === before);

  await browser.close();
  console.log(results.join('\n'));
  console.log(errors.length ? 'ОШИБКИ СТРАНИЦ:\n' + errors.join('\n') : 'ошибок на страницах нет');
  process.exit(results.some(r => r.startsWith('FAIL')) || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
