// Сценарий: админ (первый участник локальной базы) открывает тестовую комнату и играет против ботов.
//   node durak-bots.js 3       — трое ботов (1–4)
// Нужно: ./db.sh e2e ../../supabase/durak/*.sql (без тестов) и DB=e2e node server.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const BOTS = Math.max(1, Math.min(4, parseInt(process.argv[2], 10) || 3));
const shot = B.shooter(__dirname + '/shots');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
const admin = q('select user_id from public.admins limit 1');
const other = q('select id from public.profiles where id not in (select user_id from public.admins) order by created_at limit 1');
(async () => {
  const browser = await B.launch(), errors = [];
  const A = await B.phone(browser, admin, errors, { tag: 'админ' });
  const O = await B.phone(browser, other, errors, { tag: 'друг' });
  await B.openDurak(A); await B.openDurak(O);
  await A.getByRole('button', { name: 'Новая комната' }).click();
  await A.waitForSelector('.dk-test-chip', { timeout: 5000 });
  await A.locator('.dk-test-chip').click();
  await shot(A, 'bots_form');
  await A.getByRole('button', { name: 'Открыть тестовую комнату' }).click();
  await A.waitForSelector('.dk-top');
  const extra = BOTS < 4 ? 1 : 0;   // если есть место — сажаем лишнего бота и убираем его (проверка «×»)
  for (let i = 0; i < BOTS + extra; i++) { await A.getByRole('button', { name: 'Добавить бота' }).click(); await B.sleep(500); }
  if (extra) await A.locator('.dk-seat-x').last().click();
  await B.sleep(1200);
  await shot(A, 'bots_room');
  await B.sleep(5500);
  const seenByOther = await O.locator('.duel-row', { hasText: 'Тестовая' }).count() + await O.locator('.duel-row button:has-text("Войти")').count();
  await A.getByRole('button', { name: 'Начать' }).click();
  await B.chooseOpen(A);
  await B.sleep(2500);
  await shot(A, 'bots_table');
  let moves = 0, done = false, t0 = Date.now();
  let flyShots = 0;
  while (!done && Date.now() - t0 < 600000) {
    if (await A.locator('.dk-result').count()) { done = true; break; }
    if (await B.moveIfMyTurn(A)) {
      moves++;
      if (moves === 10) await shot(A, 'bots_play');
      if (flyShots < 3 && moves % 4 === 2) { await B.sleep(1150); flyShots++; await A.screenshot({ path: __dirname + '/shots/bots_fly' + flyShots + '.png' }); }
    }
    await B.sleep(400);
  }
  await B.sleep(1200);
  await shot(A, 'bots_result');
  await A.getByRole('button', { name: /Ещё раз/ }).click();
  await B.sleep(1800);
  const again = await A.locator('.dk-seat', { hasText: 'Бот' }).count();
  await shot(A, 'bots_again');
  console.log((done ? 'партия против ' + BOTS + ' ботов закончена' : 'НЕ закончена') + ', ходов админа: ' + moves
    + '; другу тестовая комната ' + (seenByOther ? 'ВИДНА (плохо)' : 'не видна') + '; «Ещё раз» — ботов за столом: ' + again);
  console.log(errors.length ? errors.slice(0, 20).join('\n') : 'ошибок на страницах нет');
  await browser.close();
  process.exit(done && !seenByOther && again === BOTS && !errors.length ? 0 : 1);
})().catch(e => { console.error('СБОЙ', e); process.exit(1); });
