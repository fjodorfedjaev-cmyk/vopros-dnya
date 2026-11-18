// Сценарий: N живых игроков (2–5) играют партию в «Дурака» через весь сайт.
//   node durak-players.js 3            — трое
//   node durak-players.js 5 --afk      — пятеро, последний не ходит (проверка времени и выбывания)
// Нужно: ./db.sh e2e ../../supabase/durak/*.sql (без тестов) и DB=e2e node server.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const N = Math.max(2, Math.min(5, parseInt(process.argv[2], 10) || 3));
const AFK = process.argv.includes('--afk');
const shot = B.shooter(__dirname + '/shots');
const ids = execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c',
  'select id from public.profiles order by created_at limit ' + N]).toString().trim().split('\n');
(async () => {
  const browser = await B.launch(), errors = [];
  const pages = [];
  for (const [i, u] of ids.entries()) { const p = await B.phone(browser, u, errors, { tag: 'P' + (i + 1) }); await B.openDurak(p); pages.push(p); }
  const [A] = pages, idle = AFK ? pages[pages.length - 1] : null;
  await A.getByRole('button', { name: 'Новая комната' }).click();
  await A.fill('#dk-stake', '50');
  await A.getByRole('button', { name: /Открыть комнату/ }).click();
  await A.waitForSelector('.dk-top');
  for (const p of pages.slice(1)) {
    await p.waitForSelector('.duel-row button:has-text("Войти")', { timeout: 12000 });
    await p.locator('.duel-row button:has-text("Войти")').first().click();
    await p.waitForSelector('.dk-top');
  }
  await B.sleep(1500);
  await shot(A, 'players_room');
  await A.getByRole('button', { name: 'Начать' }).click();
  await B.sleep(1500);
  for (const p of pages.slice(1)) await p.getByRole('button', { name: 'Готов' }).click();
  for (const p of pages) await B.chooseOpen(p);
  await B.sleep(1500);
  await shot(A, 'players_table');
  let moves = 0, done = false;
  for (let t = 0; t < 5000 && !done; t++) {
    for (const p of pages) {
      if (await p.locator('.dk-result').count()) { done = true; break; }
      if (p === idle) continue;
      if (await B.moveIfMyTurn(p)) { moves++; await B.sleep(300); }
    }
    await B.sleep(200);
  }
  await B.sleep(1500);
  for (const [i, p] of pages.entries()) await shot(p, 'players_result_' + (i + 1));
  console.log((done ? 'партия закончена' : 'НЕ закончена') + ', ходов: ' + moves);
  console.log(errors.length ? errors.slice(0, 20).join('\n') : 'ошибок на страницах нет');
  await browser.close();
  process.exit(done && !errors.length ? 0 : 1);
})().catch(e => { console.error('СБОЙ', e); process.exit(1); });
