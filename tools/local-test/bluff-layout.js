// «Верю — не верю»: как выглядит стол на телефоне (кадры экрана, без прокрутки) — мой ход в начале круга, выбор карт, ответ.
//   node bluff-layout.js 5         — пятеро ботов; LOW (с какой карты), JOKERS, WIDTH / HEIGHT — размер экрана
const { execFileSync } = require('child_process');
const B = require('./browser');
const BOTS = Math.max(2, Math.min(5, parseInt(process.argv[2], 10) || 5));
const LOW = process.env.LOW || '2', HIGH = process.env.HIGH || '14', JOKERS = process.env.JOKERS || '0', TAG = process.env.TAG || ('n' + BOTS);
const dir = __dirname + '/shots/';
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
const admin = q('select user_id from public.admins limit 1');
(async () => {
  const browser = await B.launch(), errors = [];
  const A = await B.phone(browser, admin, errors, { tag: 'админ' });
  await B.openBluff(A);
  await A.getByRole('button', { name: 'Новая комната' }).click();
  await A.waitForSelector('.dk-test-chip', { timeout: 5000 });
  await B.bluffDeck(A, +LOW, +HIGH, +JOKERS);
  await A.locator('.dk-test-chip').click();
  await A.getByRole('button', { name: 'Открыть тестовую комнату' }).click();
  await A.waitForSelector('.duel-lobby');
  for (let i = 0; i < BOTS; i++) { await A.getByRole('button', { name: 'Добавить бота' }).click(); await B.sleep(400); }
  await A.getByRole('button', { name: 'Начать' }).click();
  await A.waitForSelector('.bf-table', { timeout: 10000 });
  const got = {}; const t0 = Date.now();
  const fits = async () => A.evaluate(() => {
    const me = document.querySelector('.dk-me'), nav = document.querySelector('.bottom-nav, .bn, nav');
    const r = me.getBoundingClientRect(), navTop = nav ? nav.getBoundingClientRect().top : innerHeight;
    return { meBottom: Math.round(r.bottom), navTop: Math.round(navTop), scroll: Math.round(scrollY), page: document.documentElement.scrollHeight, vh: innerHeight };
  });
  while (Date.now() - t0 < 240000 && !(got.round && got.call)) {
    if (await A.locator('.dk-result').count()) break;
    if (await A.locator('.dk-me.turn').count() && !(await A.locator('.dk-anim').count())) {
      await B.sleep(500);
      if (await A.locator('.bf-put').count()) {
        if (!got.round) {
          got.round = await fits();
          await A.screenshot({ path: dir + 'bfl_' + TAG + '_round.png' });
          const c = A.locator('.bf-hand button.dk-card');
          await c.nth(0).click(); await c.nth(1).click(); await c.nth(2).click();
          await A.screenshot({ path: dir + 'bfl_' + TAG + '_sel.png' });
        }
        await B.bluffMove(A);
      } else if (await A.locator('.bf-doubt').count()) {
        if (!got.call) {
          got.call = await fits();
          await A.locator('.bf-hand button.dk-card').nth(0).click();
          await A.screenshot({ path: dir + 'bfl_' + TAG + '_call.png' });
          await A.locator('.bf-add').click();
        } else await B.bluffMove(A);
      }
    }
    await B.sleep(200);
  }
  console.log(TAG, JSON.stringify(got));
  console.log(errors.length ? errors.slice(0, 10).join('\n') : 'ошибок на страницах нет');
  await A.getByRole('button', { name: 'Выйти' }).first().click().catch(() => {});
  await B.sleep(300);
  await A.locator('.dk-quit-pop .btn.danger').click().catch(() => {});
  await B.sleep(500);
  await browser.close();
})().catch(e => { console.error('СБОЙ', e); process.exit(1); });
