// Рамка игрока не «прыгает»: высота меняется только от числа карт, а не от того, чей сейчас ход.
// Админ играет против 2 ботов; каждые ~250 мс записываем высоту рамки, число карт в руке и вид карт на столе.
const B = require('./browser');
const { execFileSync } = require('child_process');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
const admin = q('select user_id from public.admins limit 1');
(async () => {
  const browser = await B.launch(), errors = [];
  const A = await B.phone(browser, admin, errors, { tag: 'админ' });
  await B.openDurak(A);
  await A.getByRole('button', { name: 'Новая комната' }).click();
  await A.locator('.dk-test-chip').click();
  await A.getByRole('button', { name: 'Открыть тестовую комнату' }).click();
  await A.waitForSelector('.duel-lobby');
  for (let i = 0; i < 2; i++) { await A.getByRole('button', { name: 'Добавить бота' }).click(); await B.sleep(400); }
  await A.getByRole('button', { name: 'Начать' }).click();
  await B.chooseOpen(A);
  await A.waitForSelector('.dk-table');
  const seen = new Map();   // вид рамки → набор высот
  let shotTurn = false, shotWait = false, samples = 0, turns = 0;
  for (let t = 0; t < 240; t++) {
    const s = await A.evaluate(() => {
      const me = document.querySelector('.dk-me'), wrap = document.querySelector('.dk-me-wrap');
      if (!me || document.querySelector('.dk-anim')) return null;
      return {
        turn: me.classList.contains('turn'),
        hand: me.querySelectorAll('.dk-hand .dk-card').length,
        rows: new Set([...me.querySelectorAll('.dk-hand .dk-card')].map(c => c.offsetTop)).size,
        many: !!me.querySelector('.dk-hand.many'),
        slots: (me.querySelector('.dk-slots') || {}).className || '',
        msg: !!me.querySelector('.msg:not(:empty)'),
        h: Math.round(me.getBoundingClientRect().height),
        wrapH: Math.round(wrap.getBoundingClientRect().height),
        done: !!document.querySelector('.dk-result')
      };
    });
    if (s && s.done) break;
    if (s && !s.msg) {
      samples++;
      // сравниваем рамки с одинаковым числом рядов карт в руке и одинаковым видом карт на столе
      const key = s.rows + '|' + s.many + '|' + s.slots;
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(s.wrapH);
      if (s.turn && !shotTurn) { await A.screenshot({ path: __dirname + '/shots/layout_turn.png' }); shotTurn = true; }
      if (!s.turn && !shotWait && samples > 3) { await A.screenshot({ path: __dirname + '/shots/layout_wait.png' }); shotWait = true; }
    }
    if (await B.moveIfMyTurn(A)) turns++;
    await B.sleep(250);
  }
  const jumpy = [...seen].filter(([, hs]) => hs.size > 1);
  console.log('замеров', samples, 'ходов админа', turns, 'видов рамки', seen.size);
  console.log(jumpy.length ? 'ПРЫГАЕТ: ' + jumpy.map(([k, hs]) => k + ' → ' + [...hs].join('/')).join('; ') : 'рамка не прыгает: при одинаковых картах высота одна и та же');
  console.log(errors.length ? errors.join('\n') : 'ошибок на странице нет');
  await browser.close();
})().catch(e => { console.error('СБОЙ', e); process.exit(1); });
