// «Верю — не верю»: N живых игроков (3–6) играют партию на монеты через весь сайт.
//   node bluff-players.js 4             — четверо, ставка 10
//   node bluff-players.js 5 --afk       — последний не ходит: за него ходит база, после двух пропусков — вне игры
//   node bluff-players.js 4 --leave     — второй посреди игры нажимает «Выйти» (поражение)
// В конце: у всех экран итога, монеты всех вместе не изменились, выплаты по местам.
// Колода — LOW (с какой карты), JOKERS. Нужно: ./db.sh … ../../supabase/bluff/01_bluff.sql и DB=… node server.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const N = Math.max(3, Math.min(6, parseInt(process.argv[2], 10) || 4));
const AFK = process.argv.includes('--afk'), LEAVE = process.argv.includes('--leave');
const LOW = process.env.LOW || '6', HIGH = process.env.HIGH || '14', JOKERS = process.env.JOKERS || '1';
const shot = B.shooter(__dirname + '/shots');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
const ids = q('select id from public.profiles order by created_at limit ' + N).split('\n');
const total = () => q(`select sum(public.coins_of(id)) from public.profiles where id in (${ids.map(i => "'" + i + "'").join(',')})`);
(async () => {
  const browser = await B.launch(), errors = [];
  const before = total();
  const coins0 = ids.map(u => +q(`select public.coins_of('${u}')`));
  const pages = [];
  for (const [i, u] of ids.entries()) { const p = await B.phone(browser, u, errors, { tag: 'P' + (i + 1) }); await B.openBluff(p); pages.push(p); }
  const [A] = pages, idle = AFK ? pages[pages.length - 1] : null, quitter = LEAVE ? pages[1] : null;
  await A.getByRole('button', { name: 'Новая комната' }).click();
  await A.fill('#bf-stake', '10');
  await B.bluffDeck(A, +LOW, +HIGH, +JOKERS);
  await A.getByRole('button', { name: /Открыть комнату/ }).click();
  await A.waitForSelector('.duel-lobby');
  await shot(A, 'bfp_alone');
  for (const p of pages.slice(1)) {
    await p.waitForSelector('.duel-row button:has-text("Войти")', { timeout: 12000 });
    if (p === pages[1]) await shot(p, 'bfp_list');
    await p.locator('.duel-row button:has-text("Войти")').first().click();
    await p.waitForSelector('.duel-lobby');
  }
  await B.sleep(1500);
  await shot(A, 'bfp_room');
  await A.getByRole('button', { name: 'Начать' }).click();
  await B.sleep(1500);
  await shot(pages[1], 'bfp_ready');
  for (const p of pages.slice(1)) await p.getByRole('button', { name: 'Готово' }).click();
  await A.waitForSelector('.bf-table', { timeout: 10000 });
  await B.sleep(1500);
  await shot(A, 'bfp_table');
  const did = {}; let moves = 0, done = false, left = false, t0 = Date.now();
  while (!done && Date.now() - t0 < 900000) {
    for (const p of pages) {
      if (await A.locator('.dk-result').count()) { done = true; break; }
      if (p === idle || (p === quitter && left)) continue;
      if (p === quitter && moves >= 8) {
        await p.getByRole('button', { name: 'Выйти' }).click();
        await shot(p, 'bfp_quit_ask');
        await p.locator('.dk-quit-pop .btn.danger').click();
        left = true; await B.sleep(600);
        continue;
      }
      const m = await B.bluffMove(p, { doubt: 0.35, trust: 0.2 });
      if (m) { moves++; did[m] = (did[m] || 0) + 1; await B.sleep(200); }
    }
    await B.sleep(150);
  }
  await B.sleep(2500);
  for (const [i, p] of pages.entries()) { if (!(p === quitter && left)) await shot(p, 'bfp_result_' + (i + 1)); }
  const after = total();
  const rows = q(`select p.seat || ':' || coalesce(p.place::text, '-') || ':' || coalesce(p.out_kind, '-') || ':' || coalesce(p.payout::text, '-')
                  from public.bluff_players p where p.room_id = (select max(id) from public.bluff_rooms) order by p.place`).split('\n');
  const results = await Promise.all(pages.map(async (p) => (await p.locator('.dk-result').count()) ? 1 : 0));
  console.log((done ? 'партия закончена' : 'НЕ закончена') + ', ходов: ' + moves + ' ' + JSON.stringify(did));
  console.log('места (место:кто вышел:выплата): ' + rows.join('  ') + '; экран итога у ' + results.reduce((a, b) => a + b, 0) + ' из ' + N);
  console.log('монеты всех вместе: ' + before + ' → ' + after + '; по людям: ' + coins0.join(',') + ' → ' + ids.map(u => q(`select public.coins_of('${u}')`)).join(','));
  console.log(errors.length ? errors.slice(0, 20).join('\n') : 'ошибок на страницах нет');
  await browser.close();
  process.exit(done && before === after && !errors.length ? 0 : 1);
})().catch(e => { console.error('СБОЙ', e); process.exit(1); });
