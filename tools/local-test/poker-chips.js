// «Покер»: колода и фишки на столе.
//   1) стол в нужном положении (ставится прямо в базе): колода, банк фишками и суммой, ставки фишкой с суммой, моя ставка — на столе;
//   2) живая игра против ботов: все карты летят из колоды (раздача и общие карты), мои фишки едут из моей стопки на стол,
//      ставки уходят в банк, банк — победителю. Кадры полёта — в shots/pk_fx_*.png.
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
async function leave(A) {
  await A.getByRole('button', { name: 'Выйти' }).click();
  if (await A.locator('.dk-quit-pop .btn.danger').count()) await A.locator('.dk-quit-pop .btn.danger').click();
  await A.waitForSelector('.pk-list, .duel-head', { timeout: 5000 }).catch(() => {});
  await B.sleep(500);
}

(async () => {
  const browser = await B.launch(), errors = [];
  const admin = q('select user_id from public.admins limit 1');
  const A = await B.phone(browser, admin, errors, { tag: 'админ' });
  await B.openPoker(A);

  // ===== 1. Стол в нужном положении =====
  let t = await openBotTable(A, 3);
  const me = q(`select seat from public.poker_seats where table_id = ${t} and user_id = '${admin}' and left_at is null`);
  const bots = q(`select seat from public.poker_seats where table_id = ${t} and bot_name is not null and left_at is null order by seat`).split('\n');
  // флоп; в банке 0,40 (сумма put − bet), на столе ставки: у меня 0,04, у бота 0,10
  q(`update public.poker_seats set in_hand = true, folded = false, allin = false, bet = 0, put = 0.10, last_act = null,
       hole = ${arr([card(9, 0), card(9, 1)])} where table_id = ${t} and left_at is null`);
  q(`update public.poker_seats set bet = 0.04, put = 0.14, hole = ${arr([card(14, 2), card(13, 2)])} where table_id = ${t} and seat = ${me}`);
  q(`update public.poker_seats set bet = 0.10, put = 0.20, last_act = 'raise' where table_id = ${t} and seat = ${bots[0]}`);
  q(`update public.poker_tables set status = 'play', street = 'flop', board = ${arr([card(14, 0), card(7, 3), card(2, 1)])},
       cur_bet = 0.10, turn_seat = ${me}, deadline = now() + interval '1 hour', next_at = now() + interval '1 hour', result = null, shown = '{}',
       version = version + 1 where id = ${t}`);
  await A.waitForFunction(() => document.querySelectorAll('.pk-slot .dk-card').length === 3 && document.querySelector('.pk-pile'), null, { timeout: 8000 });
  await B.sleep(400);
  ok(await A.locator('.pk-mid-top .pk-deck .dk-card.back').count() === 3, 'на столе колода (три рубашки стопкой)');
  const potText = (await A.locator('.pk-pot .pk-pot-n').textContent()).trim();
  ok(potText === '0,4' || potText === '0,40', 'банк: сумма «' + potText + '»');
  ok(await A.locator('.pk-pot .pk-pile .pk-chip').count() >= 3, 'банк фишками: ' + await A.locator('.pk-pot .pk-pile .pk-chip').count() + ' фишек (банк 20 ББ)');
  ok(await A.locator(`.pk-mid-bet [data-bet="${me}"] .pk-chip`).count() === 1 && (await A.locator(`.pk-mid-bet [data-bet="${me}"]`).textContent()).trim() === '0,04',
     'моя ставка лежит на столе (под общими картами): фишка и 0,04');
  ok(await A.locator('.pk-me [data-bet]').count() === 0, 'в моей рамке ставки больше нет');
  ok((await A.locator(`.pk-opp[data-seat="${bots[0]}"] .pk-bet`).textContent()).trim() === '0,1' && await A.locator(`.pk-opp[data-seat="${bots[0]}"] .pk-bet .pk-chip`).count() === 1,
     'ставка бота — фишка и сумма');
  await shot(A, 'pk_chips_table');
  // банк побольше — стопок больше
  q(`update public.poker_seats set put = put + 3 where table_id = ${t} and left_at is null`);
  q(`update public.poker_tables set version = version + 1 where id = ${t}`);
  await A.waitForFunction(() => document.querySelectorAll('.pk-pile-col').length === 3, null, { timeout: 8000 }).catch(() => {});
  ok(await A.locator('.pk-pile-col').count() === 3, 'большой банк — три стопки фишек (' + await A.locator('.pk-pile .pk-chip').count() + ' фишек)');
  await shot(A, 'pk_chips_bigpot');
  q(`update public.poker_tables set status = 'closed', closed_at = now() where id = ${t}`);
  q(`update public.poker_seats set left_at = now(), cashout = stack, left_kind = 'closed' where table_id = ${t} and left_at is null`);
  await A.reload(); await B.openPoker(A);

  // ===== 2. Живая игра: откуда летят карты и фишки =====
  t = await openBotTable(A, 2);
  await A.evaluate(() => {
    window.__fl = [];
    const mid = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const near = (c, el) => { if (!el) return false; const m = mid(el.getBoundingClientRect()); return Math.abs(c.x - m.x) < 14 && Math.abs(c.y - m.y) < 14; };
    new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => {
      if (!(n instanceof HTMLElement) || !n.classList.contains('dk-flying')) return;
      const c = mid(n.getBoundingClientRect());
      window.__fl.push({
        kind: n.classList.contains('pk-chip') ? 'chip' : n.classList.contains('dk-flip') ? 'flip' : 'card',
        deck: near(c, document.querySelector('.pk-deck')), myStack: near(c, document.querySelector('.pk-me .pk-stack')),
        pot: near(c, document.querySelector('.pk-pot')), bet: [...document.querySelectorAll('.pk-bet')].some((b) => near(c, b)),
        stack: [...document.querySelectorAll('.pk-stack')].some((b) => near(c, b))
      });
    }))).observe(document.body, { childList: true, subtree: true });
  });
  let hands = 0, last = 0, myPays = 0, frames = 0, t0 = Date.now(); const shots = {};
  while (hands < 4 && Date.now() - t0 < 120000) {
    const h = Number(q(`select hand_no from public.poker_tables where id = ${t}`));
    if (h !== last) { last = h; hands++; }
    const did = await B.pokerMove(A, { raise: 0.35, fold: 0 });
    if (did && did !== 'check') {
      myPays++;
      if (frames < 1) { frames++; for (let f = 0; f < 8; f++) { await A.screenshot({ path: __dirname + '/shots/pk_fx_bet' + f + '.png' }); await B.sleep(45); } }
    }
    // кадры раздачи (карты рук спрятаны, летят рубашки) и флопа (летят рубашки, рук не прятали)
    const flying = await A.locator('#dk-fx .dk-fly-back').count();
    const dealing = flying && await A.locator('.pk-hole[style*="hidden"]').count();
    if (flying && dealing && !shots.deal) { shots.deal = 1; for (let f = 0; f < 7; f++) { await A.screenshot({ path: __dirname + '/shots/pk_fx_deal' + f + '.png' }); await B.sleep(55); } }
    else if (flying && !dealing && !shots.flop) { shots.flop = 1; for (let f = 0; f < 6; f++) { await A.screenshot({ path: __dirname + '/shots/pk_fx_flop' + f + '.png' }); await B.sleep(50); } }
    await B.sleep(40);
  }
  const fl = await A.evaluate(() => window.__fl);
  const cards = fl.filter((f) => f.kind === 'card'), chips = fl.filter((f) => f.kind === 'chip');
  ok(cards.length >= 10 && cards.every((f) => f.deck), `все карты летят из колоды: ${cards.filter((f) => f.deck).length} из ${cards.length} (раздача и общие карты)`);
  ok(myPays > 0 && chips.some((f) => f.myStack), `мои фишки едут из моей стопки на стол (моих ставок ${myPays}, полётов из моей стопки ${chips.filter((f) => f.myStack).length})`);
  ok(chips.some((f) => f.stack && !f.myStack), 'фишки ботов и блайнды тоже едут из стопок на стол: ' + chips.filter((f) => f.stack && !f.myStack).length);
  ok(chips.some((f) => f.bet), 'ставки уходят со стола в банк: ' + chips.filter((f) => f.bet).length);
  ok(chips.some((f) => f.pot), 'банк — победителю: ' + chips.filter((f) => f.pot).length);
  ok(chips.every((f) => f.stack || f.bet || f.pot), 'других фишек (ниоткуда) нет');
  console.log(`раздач ${hands}; полётов карт ${cards.length}, фишек ${chips.length}`);
  await leave(A);

  ok(!errors.length, errors.length ? 'ошибки на странице: ' + errors.join(' | ') : 'ошибок на странице нет');
  await browser.close();
  console.log(fails ? `✗ не прошло: ${fails}` : '✓ всё прошло');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
