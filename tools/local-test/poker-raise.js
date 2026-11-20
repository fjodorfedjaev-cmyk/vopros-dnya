// «Покер»: сумму повышения можно набрать на клавиатуре. Кнопки «−» / «+» — на 1 ББ, неверная сумма — подсказка вместо кнопки,
// Enter — повысить; набранное не стирается, даже если стол обновился, пока набираешь.
//   node poker-raise.js
// Нужно: ./db.sh e2e ../../supabase/durak/0[1-6]*.sql ../../supabase/poker/01_poker.sql ../../supabase/poker/02_play_money.sql \
//          ../../supabase/poker/03_no_clock.sql  и  DB=e2e node server.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
let fails = 0;
const ok = (cond, text) => { console.log((cond ? '✓ ' : '✗ ') + text); if (!cond) fails++; };
const num = (s) => Number(String(s).replace(',', '.'));
const txt = (n) => String(Math.round(n * 100) / 100).replace('.', ',');

(async () => {
  const browser = await B.launch(), errors = [];
  const admin = q('select user_id from public.admins limit 1');
  const A = await B.phone(browser, admin, errors, { tag: 'админ' });
  await B.openPoker(A);
  await A.getByRole('button', { name: 'Новый стол' }).click();
  await A.locator('.dk-test-chip').click();
  await A.getByRole('button', { name: 'Открыть стол с ботами' }).click();
  await A.waitForSelector('.pk-table');
  await A.getByRole('button', { name: '+ бот' }).click();
  const t = q('select id from public.poker_tables where test order by id desc limit 1');
  // мой ход, где можно повысить (не только ва-банк)
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await B.sleep(500);
    if (!(await A.locator('.pk-acts.on').count())) continue;
    const rb = A.locator('.pk-acts.on .btn').nth(2);
    if (await rb.isEnabled() && /Повысить|Ставка/.test(await rb.textContent())) ready = true;
    else await A.locator('.pk-acts.on .btn').nth(1).click().catch(() => {});
  }
  ok(ready, 'мой ход, повысить можно');
  await A.locator('.pk-acts.on .btn').nth(2).click();
  await A.waitForSelector('.pk-raise');
  const input = A.locator('.pk-raise-in'), go = A.locator('.pk-raise-go');
  const min = num(await input.inputValue());
  const bb = Number(q(`select bb from public.poker_tables where id = ${t}`));
  const max = Number(q(`select bet + stack from public.poker_seats where table_id = ${t} and user_id = '${admin}' and left_at is null`));
  ok(min > 0 && await input.getAttribute('inputmode') === 'decimal', `поле суммы с цифровой клавиатурой, в нём минимум ${txt(min)}`);
  ok(await A.locator('.pk-step').nth(0).isDisabled(), '«−» на минимуме не нажимается');
  await A.locator('.pk-step').nth(1).click();
  ok(num(await input.inputValue()) === Math.round((min + bb) * 100) / 100, `«+» — на 1 ББ: ${await input.inputValue()}`);
  await A.locator('.pk-step').nth(0).click();
  ok(num(await input.inputValue()) === min, '«−» — обратно на 1 ББ');
  // неверное — подсказка вместо кнопки
  await input.fill('');
  await input.type('абв');
  ok(await input.inputValue() === '' && await go.isDisabled() && /^От .+ до .+$/.test(await go.textContent()), `буквы не набираются; пусто — кнопка «${await go.textContent()}» не нажимается`);
  await input.fill(''); await input.type(txt(max + 5));
  ok(await go.isDisabled(), `больше, чем есть фишек (${txt(max + 5)}) — нельзя`);
  await input.fill(''); await input.type(txt(min / 2));
  ok(await go.isDisabled(), `меньше минимума (${txt(min / 2)}) — нельзя`);
  // верная сумма: кнопка и ползунок следуют за набранным
  const want = Math.round((min + 3 * bb + 0.01) * 100) / 100;
  await input.fill(''); await input.type(txt(want));
  ok(!(await go.isDisabled()) && (await go.textContent()).includes(txt(want)), `набрал ${txt(want)} — на кнопке «${await go.textContent()}»`);
  ok(Number(await A.locator('.pk-raise input[type=range]').inputValue()) === Math.round(want * 100), 'ползунок встал на набранную сумму');
  // стол обновился, пока набираю, — набранное на месте
  q(`update public.poker_tables set version = version + 1 where id = ${t}`);
  await B.sleep(1600);
  ok(await input.inputValue() === txt(want) && await A.locator('.pk-raise').count() === 1, 'стол обновился, пока набираю, — набранное не стёрлось');
  await shot(A, 'pk_raise_typed');
  // Enter — повысить
  const v0 = q(`select version from public.poker_tables where id = ${t}`);
  await input.press('Enter');
  await B.sleep(150);
  ok(await A.locator('.pk-raise').count() === 0, 'Enter — окошко закрылось сразу');
  let bet = 0;
  for (let i = 0; i < 20; i++) {
    await B.sleep(200);
    if (q(`select version from public.poker_tables where id = ${t}`) !== v0) {
      bet = Number(q(`select coalesce((select (e ->> 'bet')::numeric from jsonb_array_elements(log) e where e ->> 'kind' = 'act' and (e ->> 'seat')::int =
                     (select seat from public.poker_seats where table_id = ${t} and user_id = '${admin}' and left_at is null) order by (e ->> 'i')::int desc limit 1), 0)
                     from public.poker_tables where id = ${t}`));
      break;
    }
  }
  ok(bet === want, `повысил ровно до набранного: ${txt(bet)}`);
  await A.getByRole('button', { name: 'Выйти' }).click();
  if (await A.locator('.dk-quit-pop .btn.danger').count()) await A.locator('.dk-quit-pop .btn.danger').click();
  await B.sleep(800);
  ok(!errors.length, errors.length ? 'ошибки на странице: ' + errors.join(' | ') : 'ошибок на странице нет');
  await browser.close();
  console.log(fails ? `✗ не прошло: ${fails}` : '✓ всё прошло');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
