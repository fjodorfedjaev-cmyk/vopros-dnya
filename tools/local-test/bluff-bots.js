// «Верю — не верю»: админ (первый участник локальной базы) открывает тестовую комнату и играет против ботов.
//   node bluff-bots.js 3        — трое ботов (2–5); колода и джокеры — из LOW / JOKERS (по умолчанию от 6, 2 джокера)
// Нужно: ./db.sh … ../../supabase/bluff/01_bluff.sql (без тестов) и DB=… node server.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const BOTS = Math.max(2, Math.min(5, parseInt(process.argv[2], 10) || 3));
const LOW = process.env.LOW || '6', JOKERS = process.env.JOKERS || '2';
const shot = B.shooter(__dirname + '/shots');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
const admin = q('select user_id from public.admins limit 1');
const other = q('select id from public.profiles where id not in (select user_id from public.admins) order by created_at limit 1');
(async () => {
  const browser = await B.launch(), errors = [];
  const coins0 = q(`select public.coins_of('${admin}')`);
  const A = await B.phone(browser, admin, errors, { tag: 'админ' });
  const O = await B.phone(browser, other, errors, { tag: 'друг' });
  await B.openBluff(A); await B.openBluff(O);
  await shot(A, 'bf_lobby');
  await A.getByRole('button', { name: 'Новая комната' }).click();
  await A.waitForSelector('.dk-test-chip', { timeout: 5000 });
  await A.locator('.bf-chips button[aria-label="от ' + ({ 11: 'В', 12: 'Д', 13: 'К', 14: 'Т' }[LOW] || LOW) + '"]').click();
  await A.locator('.bf-chips').nth(1).locator('button[data-v="' + JOKERS + '"]').click();
  await shot(A, 'bf_form');
  await A.locator('.dk-test-chip').click();
  await shot(A, 'bf_form_test');
  await A.getByRole('button', { name: 'Открыть тестовую комнату' }).click();
  await A.waitForSelector('.duel-lobby');
  const max = +q("select least(6, (15 - low_rank) * 4 + jokers) from public.bluff_rooms order by id desc limit 1");
  const extra = BOTS + 1 < max ? 1 : 0;
  for (let i = 0; i < BOTS + extra; i++) { await A.getByRole('button', { name: 'Добавить бота' }).click(); await B.sleep(500); }
  if (extra) await A.locator('.dk-seat-x').last().click();
  await B.sleep(1200);
  await shot(A, 'bf_room');
  await B.sleep(5500);
  const seenByOther = await O.locator('.duel-row', { hasText: 'Тестовая' }).count() + await O.locator('.duel-row button:has-text("Войти")').count();
  await A.getByRole('button', { name: 'Начать' }).click();
  await A.waitForSelector('.bf-table', { timeout: 10000 });
  await B.sleep(2500);
  await shot(A, 'bf_table');
  const did = {}; let moves = 0, done = false, t0 = Date.now(), revealShots = 0, lastLog = 0;
  while (!done && Date.now() - t0 < 600000) {
    if (await A.locator('.dk-result').count()) { done = true; break; }
    if (revealShots < 3 && await A.locator('.bf-reveal').count()) { revealShots++; await A.screenshot({ path: __dirname + '/shots/bf_reveal' + revealShots + '.png' }); }
    const m = await B.bluffMove(A, { before: async (k) => { if (!did['shot_' + k]) { did['shot_' + k] = 1; await shot(A, 'bf_sel_' + k); } } });
    if (m) { moves++; did[m] = (did[m] || 0) + 1; if (moves === 6) await shot(A, 'bf_play'); }
    await B.sleep(150);
  }
  await B.sleep(1200);
  await shot(A, 'bf_result');
  const coins1 = q(`select public.coins_of('${admin}')`);
  await A.getByRole('button', { name: /Ещё раз/ }).click();
  await B.sleep(1800);
  const again = await A.locator('.dk-seat', { hasText: 'Бот' }).count();
  await shot(A, 'bf_again');
  await A.getByRole('button', { name: 'Закрыть' }).click();
  await B.sleep(800);
  const log = q("select count(*) from public.bluff_rooms where test and status = 'finished'");
  console.log((done ? 'партия против ' + BOTS + ' ботов закончена' : 'НЕ закончена') + ', ходов админа: ' + moves + ' ' + JSON.stringify(did)
    + '; другу тестовая комната ' + (seenByOther ? 'ВИДНА (плохо)' : 'не видна') + '; «Ещё раз» — ботов: ' + again
    + '; монеты админа ' + coins0 + ' → ' + coins1 + '; кадров проверки: ' + revealShots + '; законченных тестовых: ' + log);
  console.log(errors.length ? errors.slice(0, 20).join('\n') : 'ошибок на страницах нет');
  await browser.close();
  process.exit(done && !seenByOther && again === BOTS && coins0 === coins1 && !errors.length ? 0 : 1);
})().catch(e => { console.error('СБОЙ', e); process.exit(1); });
