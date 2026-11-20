// «Покер»: время на ход не ограничено. Мой ход «идёт» уже 2 минуты — на экране нет секунд и полоски времени,
// кнопки работают, база ничего за меня не делает; потом хожу сам — ход проходит.
//   node poker-no-clock.js
// Нужно: ./db.sh e2e ../../supabase/durak/0[1-6]*.sql ../../supabase/poker/01_poker.sql ../../supabase/poker/02_play_money.sql \
//          ../../supabase/poker/03_no_clock.sql  и  DB=e2e node server.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
let fails = 0;
const ok = (cond, text) => { console.log((cond ? '✓ ' : '✗ ') + text); if (!cond) fails++; };

(async () => {
  const browser = await B.launch(), errors = [];
  const admin = q('select user_id from public.admins limit 1');
  const A = await B.phone(browser, admin, errors, { tag: 'админ' });
  await B.openPoker(A);
  await A.locator('.dk-rules summary').click();
  const rules = await A.locator('.dk-rules-list').textContent();
  ok(/не ограничено/.test(rules) && !/30 секунд/.test(rules), 'в правилах: время на ход не ограничено');
  await A.getByRole('button', { name: 'Новый стол' }).click();
  await A.locator('.dk-test-chip').click();
  await A.getByRole('button', { name: 'Открыть стол с ботами' }).click();
  await A.waitForSelector('.pk-table');
  await A.getByRole('button', { name: '+ бот' }).click(); await B.sleep(600);
  const t = q('select id from public.poker_tables where test order by id desc limit 1');
  // ждём раздачу и свой ход (боты ходят сами)
  await A.waitForSelector('.pk-acts.on', { timeout: 20000 });
  // «прошло» 2 минуты с начала моего хода
  q(`update public.poker_tables set deadline = now() - interval '2 minutes' where id = ${t}`);
  const v0 = q(`select version from public.poker_tables where id = ${t}`);
  await B.sleep(3500);
  ok(q(`select version from public.poker_tables where id = ${t}`) === v0, 'через 2 минуты моего хода база ничего за меня не сделала');
  ok(await A.locator('.pk-acts.on').count() === 1 && await A.locator('.dk-turn-line.on').count() === 1, 'на экране «Твой ход» и кнопки');
  const line = (await A.locator('.dk-turn-line').textContent()).trim();
  ok(!/\d+\s*с/.test(line) && await A.locator('.dk-turn-left').count() === 0, 'секунд нет: «' + line + '»');
  ok(await A.locator('.pk-bar').count() === 0, 'полоски времени нет ни у меня, ни у соперников');
  await shot(A, 'pk_noclock');
  await A.locator('.pk-acts.on .btn').nth(1).click();
  await A.waitForFunction(() => !document.querySelector('.pk-acts.on'), null, { timeout: 5000 });
  ok(Number(q(`select version from public.poker_tables where id = ${t}`)) > Number(v0), 'сходил сам после долгой паузы — ход прошёл');
  await A.getByRole('button', { name: 'Выйти' }).click();
  if (await A.locator('.dk-quit-pop .btn.danger').count()) await A.locator('.dk-quit-pop .btn.danger').click();
  await B.sleep(800);
  ok(!errors.length, errors.length ? 'ошибки на странице: ' + errors.join(' | ') : 'ошибок на странице нет');
  await browser.close();
  console.log(fails ? `✗ не прошло: ${fails}` : '✓ всё прошло');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
