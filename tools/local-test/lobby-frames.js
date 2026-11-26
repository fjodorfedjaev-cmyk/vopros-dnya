// Списки карточных игр (26.11): «Новая комната» / «Новый стол», «Правила», «История игр» и «Сесть» не мешают друг другу —
// можно открыть всё сразу; кнопки и разделы не закрывают другие рамки. Форма закрывается своей кнопкой «Закрыть»
// или нажатием по пустому месту. В Покере: стола 0,01 / 0,02 нет, самый большой — 100 / 200.
// База (lf):
//   ./db.sh lf cards-stub.sql ../../supabase/cards/01_cards.sql ../../supabase/market/01_market.sql ../../supabase/durak/0[1-8]*.sql \
//     ../../supabase/poker/0[1-5]*.sql ../../supabase/market/02_bids.sql ../../supabase/bluff/0[1-4]*.sql ../../supabase/host/01_host.sql
//   DB=lf node server.js &   DB=lf node lobby-frames.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const DB = process.env.DB || 'lf';
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-c', sql]).toString().trim();
const rpc = (u, call) => q(`select set_config('request.jwt.claims', '{"sub":"${u}","role":"authenticated"}', true); select ${call};`).split('\n').pop();
let fails = 0;
const ok = (cond, text) => { console.log((cond ? '✓ ' : '✗ ') + text); if (!cond) fails++; };

(async () => {
  const admin = q('select user_id from public.admins limit 1');
  const friend = q(`select id from public.profiles where id <> '${admin}' order by created_at limit 1`);
  q(`insert into public.points_ledger (user_id, amount, reason, ref) select id, 1000, 'game', 'test:lf' from public.profiles`);
  // история: законченная партия Дурака и посиделка за покерным столом
  const room = q(`insert into public.durak_rooms (creator, stake, status, started_at, finished_at) values ('${admin}', 0, 'finished', now() - interval '5 minutes', now()) returning id`).split('\n').pop();
  q(`insert into public.durak_players (room_id, user_id, seat, stake, payout, place) values (${room}, '${admin}', 0, 0, 0, 1), (${room}, '${friend}', 1, 0, 0, 2)`);
  const t0 = rpc(admin, 'public.poker_create(2, 10)'); rpc(admin, `public.poker_leave(${t0})`);

  const browser = await B.launch(), errors = [];
  const p = await B.phone(browser, admin, errors, { tag: 'админ' });

  // ---- Дурак ----
  await B.openDurak(p);
  await p.waitForSelector('.dk-history');
  await p.getByRole('button', { name: 'Новая комната' }).click();
  await p.waitForSelector('.duel-form');
  await p.locator('.dk-history summary').click();
  await B.sleep(300);
  ok(await p.locator('.duel-form').count() === 1 && await p.locator('.dk-history[open]').count() === 1, 'Дурак: «Новая комната» открыта, нажал «История игр» — открыты обе');
  await p.locator('.dk-rules summary').click();
  await B.sleep(300);
  ok(await p.locator('.duel-form').count() === 1 && await p.locator('.dk-history[open]').count() === 1 && await p.locator('.dk-rules[open]').count() === 1,
    'Дурак: ещё «Правила» — открыто всё три');
  await shot(p, 'lf_durak_all');
  await p.locator('.dk-history summary').click();   // закрыть историю — форма остаётся
  await B.sleep(300);
  ok(await p.locator('.duel-form').count() === 1 && await p.locator('.dk-history[open]').count() === 0, 'Дурак: закрыл «Историю» — форма осталась');
  await p.locator('.dk-history summary').click();
  await p.getByRole('button', { name: 'Закрыть' }).click();
  await B.sleep(300);
  ok(await p.locator('.duel-form').count() === 0 && await p.locator('.dk-history[open]').count() === 1 && await p.locator('.dk-rules[open]').count() === 1,
    'Дурак: «Закрыть» убрал только форму, «Правила» и «История» открыты');
  await p.getByRole('button', { name: 'Новая комната' }).click();
  await p.waitForSelector('.duel-form');
  await p.locator('.duel-head h2').click();           // пустое место (заголовок «Комнаты»)
  await B.sleep(300);
  ok(await p.locator('.duel-form').count() === 0 && await p.locator('.dk-history[open]').count() === 1, 'Дурак: нажатие по пустому месту закрыло форму, «История» осталась');

  // ---- Покер ----
  rpc(friend, 'public.poker_create(2, 10)');   // чужой стол — у него «Сесть»
  await B.openPoker(p);
  await p.waitForSelector('.pk .dk-history');
  await p.getByRole('button', { name: 'Новый стол' }).click();
  await p.waitForSelector('.pk .duel-form');
  const levels = await p.locator('.pk-level').allTextContents();
  ok(levels.join(' | ') === '0,05 / 0,10 | 0,25 / 0,50 | 1 / 2 | 5 / 10 | 25 / 50 | 100 / 200', 'Покер: блайнды ' + levels.join(' · '));
  await p.locator('.pk-level', { hasText: '100 / 200' }).click();
  await B.sleep(200);
  const buy = await p.locator('#pk-buy').inputValue(), note = await p.locator('.pk .duel-form .msg').textContent();
  const goOff = await p.locator('.pk .duel-form .duel-go').isDisabled();
  ok(buy === '20000' && /Не хватает/.test(note) && goOff, 'Покер: 100 / 200 — сумма ' + buy + ', «' + note.trim() + '», кнопка неактивна (монет меньше 8 000)');
  await p.locator('.pk .dk-history summary').click();
  await B.sleep(300);
  ok(await p.locator('.pk .duel-form').count() === 1 && await p.locator('.pk .dk-history[open]').count() === 1, 'Покер: «Новый стол» и «История игр» открыты одновременно');
  for (let k = 0; k < 20 && !(await p.locator('.duel-row button', { hasText: 'Сесть' }).count()); k++) await B.sleep(500);
  await p.locator('.duel-row button', { hasText: 'Сесть' }).first().click();
  await B.sleep(300);
  ok(await p.locator('.pk-sit').count() === 1 && await p.locator('.pk .duel-form').count() === 1 && await p.locator('.pk .dk-history[open]').count() === 1,
    'Покер: «Сесть» открыл свою рамку, «Новый стол» и «История» не закрылись');
  await shot(p, 'lf_poker_all');
  await p.getByRole('button', { name: 'Новый стол' }).count();
  await p.locator('.duel-head button', { hasText: 'Закрыть' }).click();
  await B.sleep(300);
  ok(await p.locator('.pk-sit').count() === 1 && await p.locator('.pk .duel-form').count() === 0, 'Покер: «Закрыть» у формы не закрыл «Сесть»');
  // открыть стол 100 / 200 без 8 000 монет нельзя — кнопка неактивна; 0,05 / 0,10 — открывается
  await p.getByRole('button', { name: 'Новый стол' }).click();
  await p.locator('.pk-level', { hasText: '0,05 / 0,10' }).click();
  await p.getByRole('button', { name: /^Открыть стол/ }).click();
  await p.waitForSelector('.pk-table');
  ok(q(`select level || ':' || sb || '/' || bb from public.poker_tables where creator = '${admin}' and status <> 'closed'`) === '2:0.05/0.10', 'Покер: стол 0,05 / 0,10 открылся');

  // ---- Верю — не верю ----
  await B.openBluff(p);
  await p.getByRole('button', { name: 'Новая комната' }).click();
  await p.waitForSelector('.bf .duel-form');
  await p.locator('.bf .dk-rules summary').click();
  await B.sleep(300);
  ok(await p.locator('.bf .duel-form').count() === 1 && await p.locator('.bf .dk-rules[open]').count() === 1, '«Верю — не верю»: «Новая комната» и «Правила» открыты одновременно');

  console.log(errors.length ? errors.slice(0, 20).join('\n') : 'ошибок на страницах нет');
  await browser.close();
  process.exit(fails || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
