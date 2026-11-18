// Выбор открытых карт прямо на столе: снимки до выбора, с выбранными картами и после подтверждения; потом — середина партии.
const B = require('./browser');
const { execFileSync } = require('child_process');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
const admin = q('select user_id from public.admins limit 1');
const W = process.env.WIDTH || 390, N = +process.env.BOTS || 4;
(async () => {
  const browser = await B.launch(), errors = [];
  const A = await B.phone(browser, admin, errors, { tag: 'админ' });
  await B.openDurak(A);
  await A.getByRole('button', { name: 'Новая комната' }).click();
  await A.locator('.dk-test-chip').click();
  await A.getByRole('button', { name: 'Открыть тестовую комнату' }).click();
  await A.waitForSelector('.duel-lobby');
  for (let i = 0; i < N; i++) { await A.getByRole('button', { name: 'Добавить бота' }).click(); await B.sleep(350); }
  await A.getByRole('button', { name: 'Начать' }).click();
  await A.waitForSelector('.dk-pick button');
  const shot = (n) => A.screenshot({ path: __dirname + '/shots/choose_' + n + '_' + N + '_' + W + '.png' });
  await shot('1');
  const b = A.locator('.dk-pick button');
  for (const k of [0, 2]) { await b.nth(k).click(); await B.sleep(150); }
  await shot('2');
  await b.nth(4).click(); await B.sleep(150);
  await A.getByRole('button', { name: /^Положить/ }).click();
  await A.waitForSelector('.dk-turn-line:not(.wait)', { timeout: 10000 }).catch(() => {});
  await B.sleep(600);
  await shot('3');
  // поиграем, пока у кого-нибудь не кончится рука
  for (let t = 0; t < 400; t++) {
    await B.moveIfMyTurn(A);
    const st = await A.evaluate(() => ({ big: document.querySelectorAll('.dk-opp .dk-slots:not(.dim)').length, done: !!document.querySelector('.dk-result') }));
    if (st.done || st.big) break;
    await B.sleep(250);
  }
  await B.sleep(500);
  await shot('4');
  console.log(errors.length ? errors.join('\n') : 'ошибок на странице нет');
  await browser.close();
})().catch(e => { console.error('СБОЙ', e); process.exit(1); });
