// Кадры переворота закрытой карты: админ против бота; руку и открытые карты админа очищаем в базе,
// затем открываем закрытую карту дважды — сначала подходит (летит в стопку), потом не подходит (забирает стопку).
const { execFileSync } = require('child_process');
const B = require('./browser');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
const admin = q('select user_id from public.admins limit 1');
const setTurn = (room, seat, pile) => q(`update public.durak_rooms set turn_seat = ${seat}, pile = '${pile}', deck = '{}', deadline = now() + interval '30 s', version = version + 1 where id = ${room}`);
(async () => {
  const browser = await B.launch(), errors = [];
  const A = await B.phone(browser, admin, errors, { tag: 'админ' });
  await B.openDurak(A);
  await A.getByRole('button', { name: 'Новая комната' }).click();
  await A.locator('.dk-test-chip').click();
  await A.getByRole('button', { name: 'Открыть тестовую комнату' }).click();
  await A.waitForSelector('.duel-lobby');
  await A.getByRole('button', { name: 'Добавить бота' }).click(); await B.sleep(400);
  await A.getByRole('button', { name: 'Начать' }).click();
  await B.chooseOpen(A);
  await A.waitForSelector('.dk-table');
  const room = q(`select room_id from public.durak_players where user_id = '${admin}' order by joined_at desc limit 1`);
  const seat = q(`select seat from public.durak_players where room_id = ${room} and user_id = '${admin}'`);
  // В руке и на столе пусто, закрытые: В♠, 6♠, 5♥
  q(`update public.durak_players set hand = '{}', open = '{NULL,NULL,NULL}', closed = '{36,16,13}' where room_id = ${room} and user_id = '${admin}'`);
  const shoot = async (tag) => {
    for (let f = 0; f < 30; f++) { await A.screenshot({ path: __dirname + '/shots/flip' + tag + '_' + String(f).padStart(2, '0') + '.png', clip: { x: 0, y: 150, width: 390, height: 600 } }); await B.sleep(50); }
  };
  setTurn(room, seat, '{4}');              // в стопке тройка — валет подходит
  await A.waitForSelector('.dk-slots.mine .dk-card.back.can', { timeout: 8000 });
  await A.locator('.dk-slots.mine .dk-slot[data-pos="1"] .dk-card.back.can').click();
  await shoot('A');
  await B.sleep(2500);                      // бот ходит
  setTurn(room, seat, '{51}');             // в стопке туз — шестёрка не подходит
  await A.waitForSelector('.dk-slots.mine .dk-slot[data-pos="2"] .dk-card.back.can', { timeout: 8000 });
  await A.locator('.dk-slots.mine .dk-slot[data-pos="2"] .dk-card.back.can').click();
  await shoot('B');
  console.log(errors.length ? errors.join('\n') : 'ошибок нет');
  await browser.close();
})().catch(e => { console.error('СБОЙ', e); process.exit(1); });
