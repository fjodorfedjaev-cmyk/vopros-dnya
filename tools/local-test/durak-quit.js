// «Выйти» во время игры: короткое предупреждение, после подтверждения — к списку комнат, в базе — последнее место.
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
  for (let i = 0; i < (+process.env.BOTS || 4); i++) { await A.getByRole('button', { name: 'Добавить бота' }).click(); await B.sleep(350); }
  await A.getByRole('button', { name: 'Начать' }).click();
  await B.chooseOpen(A);
  await A.waitForSelector('.dk-table');
  await B.sleep(4000);                                   // пусть боты сходят — у соперников появятся карты разного числа
  await A.screenshot({ path: __dirname + '/shots/quit_table' + (process.env.BOTS || 4) + '_' + (process.env.WIDTH || 390) + '.png' });
  await A.locator('.dk-quit').click();
  await A.waitForSelector('.dk-quit-pop');
  await A.screenshot({ path: __dirname + '/shots/quit_pop.png' });
  await A.locator('.dk-quit-pop').getByRole('button', { name: 'Остаться' }).click();
  const stayed = !(await A.locator('.dk-quit-pop').count()) && (await A.locator('.dk-table').count()) > 0;
  await A.locator('.dk-quit').click();
  await A.locator('.dk-quit-pop').getByRole('button', { name: 'Выйти' }).click();
  await A.waitForSelector('.duel-row, .muted', { timeout: 8000 });
  await B.sleep(800);
  const row = q(`select r.status || ' ' || p.place || ' ' || p.out_kind from public.durak_players p join public.durak_rooms r on r.id = p.room_id where p.user_id = '${admin}' order by r.id desc limit 1`);
  console.log('«Остаться» закрывает предупреждение:', stayed ? 'да' : 'НЕТ');
  console.log('после выхода в базе:', row, '(ждём: finished ' + ((+process.env.BOTS || 4) + 1) + ' left)');
  console.log('на экране список комнат:', (await A.locator('.dk-table').count()) === 0 ? 'да' : 'НЕТ');
  console.log(errors.length ? errors.join('\n') : 'ошибок на странице нет');
  await browser.close();
})().catch(e => { console.error('СБОЙ', e); process.exit(1); });
