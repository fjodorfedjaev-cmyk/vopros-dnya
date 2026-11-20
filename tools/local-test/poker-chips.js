// «Покер»: колода, бита и куча фишек на столе.
//   1) стол в нужном положении (ставится прямо в базе): над общими картами колода слева, банк кучей фишек посередине, бита справа;
//      в куче — и банк, и ставки круга; ставки — подписи суммы; бита считает сожжённые карты и пасы; большой банк — массивная куча;
//   2) живая игра против ботов — каждый полёт записывается (откуда и куда):
//      раздача и общие карты — из колоды; перед улицей карта сжигается (колода → бита); пас — карты в биту; конец раздачи — всё в биту,
//      бита возвращается в колоду; фишки — из стопки игрока сразу в банк, банк — победителю; мой пас — рамка пустая.
//   Кадры полёта — в shots/pk_fx_*.png.
//   node poker-chips.js
// Нужно: ./db.sh e2e ../../supabase/durak/0[1-6]*.sql ../../supabase/poker/01_poker.sql ../../supabase/poker/02_play_money.sql \
//          ../../supabase/poker/03_no_clock.sql  и  DB=e2e node server.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
const card = (r, s) => (r - 2) * 4 + s;
const arr = (a) => `'{${a.join(',')}}'::int[]`;
let fails = 0;
const ok = (cond, text) => { console.log((cond ? '✓ ' : '✗ ') + text); if (!cond) fails++; };

async function openBotTable(A, bots) {
  await A.getByRole('button', { name: 'Новый стол' }).click();
  await A.locator('.dk-test-chip').click();
  await A.getByRole('button', { name: 'Открыть стол с ботами' }).click();
  await A.waitForSelector('.pk-table');
  for (let i = 0; i < bots; i++) { await A.getByRole('button', { name: '+ бот' }).click(); await B.sleep(600); }
  return q('select id from public.poker_tables where test order by id desc limit 1');
}
const text = async (A, sel) => ((await A.locator(sel).first().textContent()) || '').trim();

(async () => {
  const browser = await B.launch(), errors = [];
  const admin = q('select user_id from public.admins limit 1');
  const A = await B.phone(browser, admin, errors, { tag: 'админ' });
  await B.openPoker(A);

  // ===== 1. Стол в нужном положении =====
  let t = await openBotTable(A, 3);
  const me = q(`select seat from public.poker_seats where table_id = ${t} and user_id = '${admin}' and left_at is null`);
  const bots = q(`select seat from public.poker_seats where table_id = ${t} and bot_name is not null and left_at is null order by seat`).split('\n');
  // флоп; в банке с прошлых кругов 0,40, ставки этого круга: у меня 0,04, у бота 0,10 — в куче всего 0,54
  q(`update public.poker_seats set in_hand = true, folded = false, allin = false, bet = 0, put = 0.10, last_act = null,
       hole = ${arr([card(9, 0), card(9, 1)])} where table_id = ${t} and left_at is null`);
  q(`update public.poker_seats set bet = 0.04, put = 0.14, hole = ${arr([card(14, 2), card(13, 2)])} where table_id = ${t} and seat = ${me}`);
  q(`update public.poker_seats set bet = 0.10, put = 0.20, last_act = 'raise' where table_id = ${t} and seat = ${bots[0]}`);
  q(`update public.poker_tables set status = 'play', street = 'flop', board = ${arr([card(14, 0), card(7, 3), card(2, 1)])},
       cur_bet = 0.10, turn_seat = ${me}, deadline = now() + interval '1 hour', next_at = now() + interval '1 hour', result = null, shown = '{}',
       version = version + 1 where id = ${t}`);
  await A.waitForFunction(() => document.querySelectorAll('.pk-slot .dk-card').length === 3 && document.querySelector('.pk-pile'), null, { timeout: 8000 });
  await B.sleep(400);
  const box = async (sel) => A.locator(sel).first().boundingBox();
  const [dk, bt, pl, b0, b4] = [await box('.pk-mid-top .pk-deck'), await box('.pk-mid-top .pk-bita'), await box('.pk-pot'), await box('.pk-slot[data-pos="0"]'), await box('.pk-slot[data-pos="4"]')];
  ok(dk && bt && pl && dk.x < pl.x && pl.x + pl.width <= bt.x + 1, 'над общими картами: колода слева, банк посередине, бита справа');
  ok(dk && b0 && bt && b4 && Math.abs(dk.x - b0.x) < 14 && Math.abs((bt.x + bt.width) - (b4.x + b4.width)) < 10, 'колода — над первой общей картой, бита — над последней');
  ok(await A.locator('.pk-deck .dk-card.back').count() === 3, 'колода — три рубашки стопкой');
  ok(await A.locator('.pk-bita .dk-card.back').count() === 1, 'в бите 1 карта (сожжена перед флопом)');
  ok(await text(A, '.pk-pot .pk-pot-n') === '0,54', 'в куче и банк, и ставки круга: «' + await text(A, '.pk-pot .pk-pot-n') + '» (0,40 + 0,04 + 0,10)');
  const chips27 = Number(await A.locator('.pk-pile').getAttribute('data-chips'));
  ok(chips27 === 14 && await A.locator('.pk-pile .pk-chip').count() === 14, 'куча: ' + chips27 + ' фишек при банке 27 ББ');
  ok(await text(A, `.pk-me [data-bet="${me}"]`) === '0,04' && await A.locator('.pk-bet .pk-chip').count() === 0, 'ставки — подписи суммы без фишек; моя — снова в моей рамке');
  ok(await text(A, `.pk-opp[data-seat="${bots[0]}"] .pk-bet`) === '0,1', 'ставка бота — подпись 0,1');
  await shot(A, 'pk_chips_table');
  // бот спасовал — +2 в биту; банк большой — массивная куча
  q(`update public.poker_seats set folded = true, last_act = 'fold' where table_id = ${t} and seat = ${bots[1]}`);
  q(`update public.poker_seats set put = put + 3 where table_id = ${t} and left_at is null`);
  q(`update public.poker_tables set version = version + 1 where id = ${t}`);
  await A.waitForFunction(() => document.querySelector('.pk-pile-row.front'), null, { timeout: 8000 }).catch(() => {});
  await B.sleep(300);
  ok(await A.locator('.pk-bita .dk-card').count() === 3, 'бот спасовал — в бите 3 карты (1 сожжённая + 2 его)');
  ok(await A.locator('.pk-pile .pk-chip').count() === 40 && await A.locator('.pk-pile-col').count() === 8 && await A.locator('.pk-pile-row.front').count() === 1,
     'большой банк (' + await text(A, '.pk-pot-n') + ') — куча из 40 фишек: 8 стопок в два ряда');
  const top0 = (await box('.pk-slot[data-pos="0"]')).y;
  ok(Math.abs(top0 - b0.y) < 1, 'куча выросла, а общие карты не сдвинулись');
  await shot(A, 'pk_chips_bigpot');
  q(`update public.poker_tables set status = 'closed', closed_at = now() where id = ${t}`);
  q(`update public.poker_seats set left_at = now(), cashout = stack, left_kind = 'closed' where table_id = ${t} and left_at is null`);
  await A.reload(); await B.openPoker(A);

  // ===== 2. Живая игра: откуда и куда летят карты и фишки =====
  t = await openBotTable(A, 2);
  await A.evaluate(() => {
    window.__fl = [];
    const where = (n) => {
      if (!n || !n.closest) return '?';
      const me = n.closest('.pk-me') ? ':me' : '';
      if (n.closest('.pk-deck')) return 'deck';
      if (n.closest('.pk-bita')) return 'bita';
      if (n.closest('.pk-slot')) return 'slot';
      if (n.closest('.pk-hole')) return 'hole' + me;
      if (n.closest('.pk-stack')) return 'stack' + me;
      if (n.closest('.pk-bet')) return 'bet';
      if (n.closest('.pk-pot')) return 'pot';
      return 'other:' + (n.className || n.tagName);
    };
    const fly = window.PlayingCards.fly;
    window.PlayingCards.fly = function (node, from, to, o) {
      window.__fl.push({ kind: node.classList.contains('pk-chip') ? 'chip' : 'card', from: where(from), to: where(to) });
      return fly.apply(this, arguments);
    };
  });
  let hands = 0, last = 0, myPays = 0, myFold = null, frames = 0, t0 = Date.now(); const shots = {};
  while (hands < 5 && Date.now() - t0 < 150000) {
    const h = Number(q(`select hand_no from public.poker_tables where id = ${t}`));
    if (h !== last) { last = h; hands++; }
    // в третьей раздаче пасую сам — карты должны уйти в биту, рамка — опустеть
    if (hands === 3 && myFold === null && await A.locator('.pk-acts.on').count()) {
      await A.locator('.pk-acts.on .btn').nth(0).click();
      await A.waitForFunction(() => !document.querySelector('.pk-me .pk-hole .dk-card'), null, { timeout: 5000 }).catch(() => {});
      myFold = await A.locator('.pk-me .pk-hole .dk-card').count();
      await shot(A, 'pk_fx_myfold');
      continue;
    }
    const did = await B.pokerMove(A, { raise: 0.35, fold: 0.01 });
    if (did) {
      myPays++;
      if (frames < 1) { frames++; for (let f = 0; f < 8; f++) { await A.screenshot({ path: __dirname + '/shots/pk_fx_bet' + f + '.png' }); await B.sleep(45); } }
    }
    const flying = await A.locator('#dk-fx .dk-fly-back').count();
    const dealing = flying && await A.locator('.pk-hole[style*="hidden"]').count();
    if (flying && dealing && !shots.deal) { shots.deal = 1; for (let f = 0; f < 10; f++) { await A.screenshot({ path: __dirname + '/shots/pk_fx_deal' + f + '.png' }); await B.sleep(70); } }
    else if (flying && !dealing && !shots.flop) { shots.flop = 1; for (let f = 0; f < 6; f++) { await A.screenshot({ path: __dirname + '/shots/pk_fx_flop' + f + '.png' }); await B.sleep(50); } }
    await B.sleep(40);
  }
  const fl = await A.evaluate(() => window.__fl);
  const cards = fl.filter((f) => f.kind === 'card'), chips = fl.filter((f) => f.kind === 'chip');
  const route = (list, from, to) => list.filter((f) => (from instanceof RegExp ? from.test(f.from) : f.from === from) && (to instanceof RegExp ? to.test(f.to) : f.to === to)).length;
  const toHand = cards.filter((f) => /^(hole|slot)/.test(f.to));
  ok(toHand.length >= 12 && toHand.every((f) => f.from === 'deck'), `в руки и на стол карты летят только из колоды: ${route(cards, 'deck', /^(hole|slot)/)} из ${toHand.length}`);
  ok(route(cards, 'deck', 'bita') > 0, 'перед флопом / тёрном / ривером карта сжигается — из колоды в биту: ' + route(cards, 'deck', 'bita'));
  ok(route(cards, /^(hole|slot)/, 'bita') > 0, 'пасы и конец раздачи — карты со стола в биту: ' + route(cards, /^(hole|slot)/, 'bita'));
  ok(route(cards, 'bita', 'deck') > 0, 'перед новой раздачей бита возвращается в колоду: ' + route(cards, 'bita', 'deck'));
  ok(cards.every((f) => /^(deck|bita|slot|hole)/.test(f.from) && /^(deck|bita|slot|hole)/.test(f.to)), 'других полётов карт нет');
  ok(myPays > 0 && route(chips, 'stack:me', 'pot') > 0, `мои фишки едут из моей стопки сразу в банк: ${route(chips, 'stack:me', 'pot')}`);
  ok(route(chips, 'stack', 'pot') > 0, 'фишки ботов и блайнды — тоже сразу в банк: ' + route(chips, 'stack', 'pot'));
  ok(route(chips, 'pot', /^stack/) > 0, 'банк — победителю: ' + route(chips, 'pot', /^stack/));
  ok(chips.every((f) => (/^stack/.test(f.from) && f.to === 'pot') || (f.from === 'pot' && /^stack/.test(f.to))), 'фишки к подписям ставок больше не летают');
  ok(myFold === 0 && route(cards, 'hole:me', 'bita') >= 2, `мой пас: мои карты улетели в биту (${route(cards, 'hole:me', 'bita')}), в рамке пусто`);
  console.log(`раздач ${hands}; полётов карт ${cards.length}, фишек ${chips.length}`);
  await A.getByRole('button', { name: 'Выйти' }).click();
  if (await A.locator('.dk-quit-pop .btn.danger').count()) await A.locator('.dk-quit-pop .btn.danger').click();
  await B.sleep(800);

  ok(!errors.length, errors.length ? 'ошибки на странице: ' + errors.join(' | ') : 'ошибок на странице нет');
  await browser.close();
  console.log(fails ? `✗ не прошло: ${fails}` : '✓ всё прошло');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
