// Сценарий «Покер»: админ (первый участник локальной базы) открывает тестовый стол, сажает ботов и играет раздачи.
//   node poker-bots.js 3 10   — трое ботов (1–5), 10 раздач
// Нужно: ./db.sh e2e ../../supabase/durak/0*.sql ../../supabase/poker/01_poker.sql (без тестов) и DB=e2e node server.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const BOTS = Math.max(1, Math.min(5, parseInt(process.argv[2], 10) || 3));
const HANDS = Math.max(1, parseInt(process.argv[3], 10) || 8);
const shot = B.shooter(__dirname + '/shots');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
const admin = q('select user_id from public.admins limit 1');
const other = q('select id from public.profiles where id not in (select user_id from public.admins) order by created_at limit 1');
const coins = (u) => Number(q(`select public.coins_of('${u}')`));
(async () => {
  const browser = await B.launch(), errors = [];
  const A = await B.phone(browser, admin, errors, { tag: 'админ' });
  const O = await B.phone(browser, other, errors, { tag: 'друг' });
  const c0 = coins(admin);
  // окошко «Карты»
  await A.locator('.bn-item', { hasText: 'Игры' }).click();
  await A.locator('.game-switch button', { hasText: 'Карты' }).click();
  await A.waitForSelector('.cards-pick');
  await shot(A, 'pk_pick');
  await A.locator('.cards-pick button', { hasText: 'Покер' }).click();
  await A.waitForSelector('.pk');
  await B.openPoker(O);
  await A.getByRole('button', { name: 'Новый стол' }).click();
  await A.waitForSelector('.dk-test-chip', { timeout: 5000 });
  await shot(A, 'pk_form');
  await A.locator('.dk-test-chip').click();
  await A.getByRole('button', { name: 'Открыть стол с ботами' }).click();
  await A.waitForSelector('.pk-table');
  await shot(A, 'pk_alone');
  for (let i = 0; i < BOTS; i++) { await A.getByRole('button', { name: '+ бот' }).click(); await B.sleep(600); }
  await B.sleep(1500);
  const seenByOther = await O.locator('.duel-row', { hasText: 'с ботами' }).count();
  let hands = 0, moves = 0, lastHand = 0, raiseShot = false, t0 = Date.now(), shots = 0, outSeen = false, coinSeen = false;
  // фишки админа почти кончились — проверим, что выдадут ещё
  q(`update public.poker_seats set stack = 0.04, buyin = buyin - (stack - 0.04) where user_id = '${admin}' and left_at is null`);
  while (hands < HANDS && Date.now() - t0 < 600000) {
    const h = Number(q(`select hand_no from public.poker_tables where test order by id desc limit 1`));
    if (h !== lastHand) { lastHand = h; hands++; }
    const did = await B.pokerMove(A, { raise: 0.25, fold: 0.08, shot: raiseShot ? null : async () => { raiseShot = true; await shot(A, 'pk_raise'); } });
    if (did) {
      moves++;
      if (moves === 2) await shot(A, 'pk_turn');
      if (moves % 5 === 3 && shots < 3) { await B.sleep(900); shots++; await A.screenshot({ path: __dirname + '/shots/pk_fly' + shots + '.png' }); }
    }
    if (await A.locator('.pk-pot.win').count() && shots < 6 && moves > 3) { shots = 6; await shot(A, 'pk_showdown'); }
    if (await A.locator('.pk-out').count()) { outSeen = true; }   // за столом с ботами вылета быть не должно
    if (!coinSeen && await A.locator('.pk-table .coin, .pk-table img').count()) coinSeen = true;
    await B.sleep(350);
  }
  await shot(A, 'pk_last');
  // докупить и встать
  const top = A.getByRole('button', { name: 'Докупить' });
  let topped = false;
  for (let i = 0; i < 40 && !topped; i++) {
    if (await top.count() && await top.isEnabled()) { await top.click(); await A.waitForSelector('.pk-top-pop'); await shot(A, 'pk_topup'); await A.locator('.pk-top-pop .btn.primary').click(); topped = true; }
    else { await B.pokerMove(A, { raise: 0, fold: 1 }); await B.sleep(500); }
  }
  await B.sleep(1200);
  await A.getByRole('button', { name: 'Выйти' }).click();
  await shot(A, 'pk_quit');
  await A.locator('.dk-quit-pop .btn.danger').click();
  await B.sleep(1500);
  await shot(A, 'pk_lobby');
  const closed = q(`select status from public.poker_tables where test order by id desc limit 1`);
  const c1 = coins(admin);
  const rebuys = Number(q(`select count(*) from public.poker_seats where user_id = '${admin}' and test and buyin > 2`));
  console.log(`выдача фишек: ${rebuys ? 'была' : 'НЕ было'}; экран «фишки закончились»: ${outSeen ? 'ПОЯВЛЯЛСЯ (плохо)' : 'не появлялся'}; монетки за столом: ${coinSeen ? 'ЕСТЬ (плохо)' : 'нет'}`);
  console.log(`раздач ${hands}, ходов админа ${moves}; другу тестовый стол ${seenByOther ? 'ВИДЕН (плохо)' : 'не виден'}; докупка ${topped ? 'да' : 'НЕТ'}; стол после выхода: ${closed}; монеты админа ${c0} → ${c1}`);
  console.log(errors.length ? errors.slice(0, 20).join('\n') : 'ошибок на страницах нет');
  await browser.close();
  process.exit(hands >= HANDS && rebuys && !outSeen && !coinSeen && !seenByOther && closed === 'closed' && c0 === c1 && !errors.length ? 0 : 1);
})().catch(e => { console.error('СБОЙ', e); process.exit(1); });
