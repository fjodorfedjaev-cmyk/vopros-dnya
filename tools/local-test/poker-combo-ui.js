// «Покер»: подсветка лучшей комбинации на экране. Ставим стол в нужное положение прямо в базе и смотрим, что подсвечено.
//   node poker-combo-ui.js
// Нужно: ./db.sh e2e ../../supabase/durak/0[1-6]*.sql ../../supabase/poker/01_poker.sql ../../supabase/poker/02_play_money.sql
//        и DB=e2e node server.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
const card = (r, s) => (r - 2) * 4 + s;   // s: 0 ♠ 1 ♥ 2 ♦ 3 ♣
const arr = (a) => `'{${a.join(',')}}'::int[]`;
let fails = 0;
const ok = (cond, text) => { console.log((cond ? '✓ ' : '✗ ') + text); if (!cond) fails++; };

(async () => {
  const browser = await B.launch(), errors = [];
  const admin = q('select user_id from public.admins limit 1');
  const A = await B.phone(browser, admin, errors, { tag: 'админ' });
  await B.openPoker(A);
  await A.getByRole('button', { name: 'Новый стол' }).click();
  await A.locator('.dk-test-chip').click();
  await A.getByRole('button', { name: 'Открыть стол с ботами' }).click();
  await A.waitForSelector('.pk-table');
  for (let i = 0; i < 2; i++) { await A.getByRole('button', { name: '+ бот' }).click(); await B.sleep(600); }
  const t = q('select id from public.poker_tables where test order by id desc limit 1');
  const me = q(`select seat from public.poker_seats where table_id = ${t} and user_id = '${admin}' and left_at is null`);
  const bots = q(`select seat from public.poker_seats where table_id = ${t} and bot_name is not null and left_at is null order by seat`).split('\n');
  // положение стола: ставим, отключаем ход игры на час, поднимаем версию — телефон перерисует
  const set = (o) => {
    q(`update public.poker_seats set in_hand = true, folded = false, allin = false, bet = 0, put = 0.02, last_act = null, hole = '{}' where table_id = ${t} and left_at is null`);
    Object.entries(o.holes).forEach(([seat, h]) => q(`update public.poker_seats set hole = ${arr(h)} where table_id = ${t} and seat = ${seat}`));
    (o.folded || []).forEach((seat) => q(`update public.poker_seats set folded = true where table_id = ${t} and seat = ${seat}`));
    q(`update public.poker_tables set status = '${o.status}', street = '${o.street}', board = ${arr(o.board)},
         turn_seat = ${o.status === 'play' ? o.turn : 'null'}, deadline = ${o.status === 'play' ? "now() + interval '1 hour'" : 'null'},
         next_at = now() + interval '1 hour', shown = '${JSON.stringify(o.shown || {})}'::jsonb,
         result = ${o.result ? `'${JSON.stringify(o.result)}'::jsonb` : 'null'}, version = version + 1 where id = ${t}`);
  };
  const hits = async () => A.$$eval('.pk-table .dk-card.pk-hit', (els) => els.map((e) => Number(e.dataset.card)).sort((a, b) => a - b));
  const combo = async () => (await A.locator('.pk-combo').textContent()).trim();
  const sorted = (a) => a.slice().sort((x, y) => x - y);

  // 1. Моя раздача, флоп: у меня В♣ 5♥, на столе В♥ Т♣ 5♠ → две пары (4 карты подсвечены)
  set({ status: 'play', street: 'flop', turn: bots[0], board: [card(11, 1), card(14, 3), card(5, 0)],
        holes: { [me]: [card(11, 3), card(5, 1)], [bots[0]]: [card(2, 0), card(3, 0)], [bots[1]]: [card(7, 2), card(8, 2)] } });
  await A.waitForFunction(() => document.querySelectorAll('.pk-slot .dk-card').length === 3, null, { timeout: 8000 });
  await B.sleep(400);
  ok(await combo() === 'Две пары', 'в раздаче: в моей рамке «' + await combo() + '»');
  ok(JSON.stringify(await hits()) === JSON.stringify(sorted([card(11, 3), card(5, 1), card(11, 1), card(5, 0)])), 'в раздаче подсвечены мои 4 карты двух пар (валеты и пятёрки), туз — нет');
  await shot(A, 'pk_combo_play');

  // 2. Стрит с тузом снизу на тёрне: у меня 2♦ 3♦, на столе Т♠ 4♥ 5♣ К♦
  set({ status: 'play', street: 'turn', turn: bots[0], board: [card(14, 0), card(4, 1), card(5, 3), card(13, 2)],
        holes: { [me]: [card(2, 2), card(3, 2)], [bots[0]]: [card(9, 0), card(9, 1)], [bots[1]]: [card(7, 2), card(8, 2)] } });
  await A.waitForFunction(() => document.querySelectorAll('.pk-slot .dk-card').length === 4, null, { timeout: 8000 });
  await B.sleep(400);
  ok(await combo() === 'Стрит', 'стрит Т-2-3-4-5: «' + await combo() + '», подсвечено ' + (await hits()).length + ' карт');
  ok(JSON.stringify(await hits()) === JSON.stringify(sorted([card(2, 2), card(3, 2), card(14, 0), card(4, 1), card(5, 3)])), 'король в стрит не входит');

  // 3. Я спасовал — названия нет, ничего не подсвечено
  set({ status: 'play', street: 'turn', turn: bots[0], board: [card(14, 0), card(4, 1), card(5, 3), card(13, 2)], folded: [me],
        holes: { [me]: [card(2, 2), card(3, 2)], [bots[0]]: [card(9, 0), card(9, 1)], [bots[1]]: [card(7, 2), card(8, 2)] } });
  await A.waitForFunction(() => !document.querySelector('.pk-combo') || !document.querySelector('.pk-combo').textContent.trim(), null, { timeout: 8000 });
  ok((await hits()).length === 0, 'после паса: названия нет, подсветки нет');

  // 4. Вскрытие, выиграл бот: у него К♠ Д♦ (две пары: дамы и двойки), у меня 8♠ 9♦ (пара двоек)
  const board = [card(12, 1), card(2, 3), card(2, 0), card(4, 3), card(11, 1)];
  const botHole = [card(13, 0), card(12, 2)], myHole = [card(8, 0), card(9, 2)];
  set({ status: 'open', street: 'show', board, folded: [bots[1]],
        holes: { [me]: myHole, [bots[0]]: botHole, [bots[1]]: [card(7, 2), card(6, 2)] },
        shown: { [me]: myHole, [bots[0]]: botHole },
        result: { hand: 1, showdown: true, pots: [{ amount: 0.06, seats: [Number(bots[0])], name: 'Две пары' }], won: { [bots[0]]: 0.06 }, win: { [bots[0]]: 0.04 }, back: {} } });
  await A.waitForFunction(() => document.querySelector('.pk-pot.win'), null, { timeout: 8000 });
  await B.sleep(400);
  ok(await combo() === 'Пара' && await A.locator('.pk-combo.off').count() === 1, 'вскрытие: у меня в рамке «' + await combo() + '» (моя комбинация, серым — проиграл)');
  ok(JSON.stringify(await hits()) === JSON.stringify(sorted([card(12, 2), card(12, 1), card(2, 3), card(2, 0)])), 'вскрытие: подсвечены карты победителя — его дама и дамы/двойки на столе; мои карты и король — нет');
  ok(await A.locator(`.pk-opp[data-seat="${bots[0]}"] .dk-card.pk-hit`).count() === 1, 'у победителя подсвечена одна карта из двух (маленькая)');
  await shot(A, 'pk_combo_show');

  // 5. Флеш: из шести черв подсвечены пять старших
  set({ status: 'play', street: 'river', turn: bots[0], board: [card(2, 1), card(9, 1), card(13, 1), card(7, 1), card(4, 0)],
        holes: { [me]: [card(14, 1), card(3, 1)], [bots[0]]: [card(9, 0), card(9, 2)], [bots[1]]: [card(7, 2), card(8, 2)] } });
  await A.waitForFunction(() => document.querySelectorAll('.pk-slot .dk-card').length === 5 && !document.querySelector('.pk-pot.win'), null, { timeout: 8000 });
  await B.sleep(400);
  ok(await combo() === 'Флеш' && JSON.stringify(await hits()) === JSON.stringify(sorted([card(14, 1), card(13, 1), card(9, 1), card(7, 1), card(3, 1)])),
     'флеш: «' + await combo() + '», подсвечены 5 старших черв (двойка — нет)');
  await shot(A, 'pk_combo_flush');

  q(`update public.poker_tables set status = 'closed', closed_at = now() where id = ${t}`);
  ok(!errors.length, errors.length ? 'ошибки на странице: ' + errors.join(' | ') : 'ошибок на странице нет');
  await browser.close();
  console.log(fails ? `✗ не прошло: ${fails}` : '✓ всё прошло');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
