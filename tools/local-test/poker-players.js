// Сценарий «Покер»: 2–6 живых игроков за одним столом через весь сайт (каждый — свой «телефон»).
//   node poker-players.js 4 6   — четверо, 6 раздач. Первый открывает стол 0,05/0,10, остальные садятся из списка.
// В конце все встают: монеты всех вместе должны сойтись до копейки (комиссии нет).
const { execFileSync } = require('child_process');
const B = require('./browser');
const N = Math.max(2, Math.min(6, parseInt(process.argv[2], 10) || 3));
const HANDS = Math.max(1, parseInt(process.argv[3], 10) || 5);
const shot = B.shooter(__dirname + '/shots');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
const ids = q('select string_agg(id::text, \',\' order by created_at) from public.profiles').split(',').slice(0, N);
const total = () => Number(q(`select sum(public.coins_of(id)) from public.profiles`));
(async () => {
  const browser = await B.launch(), errors = [];
  const c0 = total();
  const P = [];
  for (let i = 0; i < N; i++) { P.push(await B.phone(browser, ids[i], errors, { tag: 'игрок' + (i + 1), mode: 'poker' })); }
  for (const p of P) await B.openPoker(p);
  await P[0].getByRole('button', { name: 'Новый стол' }).click();
  await P[0].locator('.pk-level', { hasText: '0,05 / 0,10' }).click();
  await P[0].getByRole('button', { name: /^Открыть стол/ }).click();
  await P[0].waitForSelector('.pk-table');
  for (let i = 1; i < N; i++) {
    const p = P[i];
    for (let k = 0; k < 20 && !(await p.locator('.duel-row button', { hasText: 'Сесть' }).count()); k++) await B.sleep(500);
    await p.locator('.duel-row button', { hasText: 'Сесть' }).first().click();
    if (i === 1) await shot(p, 'pkp_sit');
    await p.locator('.pk-sit .duel-go').click();
    await p.waitForSelector('.pk-table');
  }
  const push = q(`select count(*) from public.push_calls where payload->>'type' = 'poker'`);
  let hands = 0, last = 0, moves = 0, t0 = Date.now(), shots = 0;
  while (hands <= HANDS && Date.now() - t0 < 600000) {
    const h = Number(q(`select coalesce(max(hand_no), 0) from public.poker_tables where status <> 'closed'`));
    if (h !== last) { last = h; hands++; }
    for (let i = 0; i < N; i++) {
      if (await B.pokerMove(P[i], { raise: 0.2, fold: 0.12 })) {
        moves++;
        if (shots < N && moves % 3 === 1) { shots++; await shot(P[i], 'pkp_' + N + '_' + shots); }
      }
      if (await P[i].locator('.pk-out .duel-go').count()) { await P[i].locator('.pk-out .duel-go').click(); }
    }
    await B.sleep(300);
  }
  // все встают
  for (let i = 0; i < N; i++) {
    const p = P[i];
    for (let k = 0; k < 10 && q(`select count(*) from public.poker_seats where user_id = '${ids[i]}' and left_at is null`) !== '0'; k++) {
      const quit = p.getByRole('button', { name: 'Выйти' });
      try {
        if (await quit.count()) { await quit.click({ timeout: 2000 }); await p.locator('.dk-quit-pop .btn.danger').click({ timeout: 2000 }); }
      } catch (e) { /* стол перерисовался — ещё раз */ }
      await B.sleep(700);
    }
  }
  await B.sleep(1500);
  const open = Number(q(`select count(*) from public.poker_tables where status <> 'closed'`));
  const c1 = total();
  console.log(`${N} игроков: раздач ${hands - 1}+, ходов ${moves}; уведомлений о столе: ${push} (карточные игры их не шлют — должно быть 0); открытых столов после выхода: ${open}; монеты всех ${c0} → ${c1}`);
  console.log(errors.length ? errors.slice(0, 20).join('\n') : 'ошибок на страницах нет');
  await browser.close();
  process.exit(hands > HANDS && open === 0 && c0 === c1 && push === '0' && !errors.length ? 0 : 1);
})().catch(e => { console.error('СБОЙ', e); process.exit(1); });
