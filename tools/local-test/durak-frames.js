// Кадры анимации: админ против двух ботов; после своего хода снимаем экран каждые ~110 мс (полёт карты, ход бота, добор).
const { execFileSync } = require('child_process');
const B = require('./browser');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
const admin = q('select user_id from public.admins limit 1');
(async () => {
  const browser = await B.launch(), errors = [];
  const A = await B.phone(browser, admin, errors, { tag: 'админ' });
  await B.openDurak(A);
  await A.getByRole('button', { name: 'Новая комната' }).click();
  await A.locator('.dk-test-chip').click();
  await A.getByRole('button', { name: 'Открыть тестовую комнату' }).click();
  await A.waitForSelector('.dk-top');
  for (let i = 0; i < 2; i++) { await A.getByRole('button', { name: 'Добавить бота' }).click(); await B.sleep(400); }
  await A.getByRole('button', { name: 'Начать' }).click();
  await B.chooseOpen(A);
  let series = 0;
  for (let t = 0; t < 400 && series < 3; t++) {
    if (await A.locator('.dk-result').count()) break;
    if (await A.locator('.dk-me.turn').count()) {
      const can = A.locator('.dk-hand .dk-card.can');
      if (await can.count()) {
        await can.first().click();
        await A.locator('.dk-acts .btn.primary:not([disabled])').click({ timeout: 3000 }).catch(() => {});
        series++;
        for (let f = 0; f < 26; f++) { await A.screenshot({ path: __dirname + '/shots/frame' + series + '_' + String(f).padStart(2, '0') + '.png', clip: { x: 0, y: 220, width: 390, height: 520 } }); await B.sleep(60); }
        continue;
      }
      await B.moveIfMyTurn(A);
    }
    await B.sleep(300);
  }
  console.log('серий кадров: ' + series + (errors.length ? '\n' + errors.join('\n') : '; ошибок нет'));
  await browser.close();
})().catch(e => { console.error('СБОЙ', e); process.exit(1); });
