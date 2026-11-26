// Нажатие мимо временного окошка закрывает его: комментарии под ответом (черновик остаётся), правка ответа
// (только если текст не меняли), «Новая дуэль», «Новая комната», предупреждение «Выйти» в «Дураке».
const B = require('./browser');
const { execFileSync } = require('child_process');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
// я — админ (у него в «Новой комнате» есть «Тестовая, с ботами»), друг — первый из остальных
const me = q('select user_id from public.admins limit 1');
const friend = q(`select id from public.profiles where id <> '${me}' order by created_at limit 1`);
const day = '2026-11-18', t = '2026-11-18T08:00:00Z';
const tables = {
  answers: [
    { id: 1, user_id: me, body: 'Мой ответ', created_at: t, updated_at: t, profiles: { display_name: 'Федя', color: '#E8743B', avatar: null } },
    { id: 2, user_id: friend, body: 'Ответ друга', created_at: t, updated_at: t, profiles: { display_name: 'Аня', color: '#4C8BF5', avatar: null } }
  ],
  comments: [{ id: 10, answer_id: 2, user_id: friend, body: 'Комментарий', created_at: t }]
};
const results = [];
const ok = (name, cond) => results.push((cond ? 'ok   ' : 'НЕТ  ') + name);
const outside = (p) => p.mouse.click(195, 18);   // шапка страницы — точно мимо всех окошек
(async () => {
  const browser = await B.launch(), errors = [];
  const ctxPage = await B.phone(browser, me, errors, { tag: 'я' });
  const p = ctxPage;
  await p.evaluate((tb) => localStorage.setItem('mock-tables', JSON.stringify(tb)), tables);
  await p.reload(); await p.waitForSelector('.ans:not(.mine) .cmt-btn', { timeout: 15000 });

  // 1. комментарии под ответом друга
  const friendCard = p.locator('.ans', { hasText: 'Ответ друга' });
  await friendCard.locator('.cmt-btn').click();
  await p.waitForSelector('#cmt-2');
  await p.fill('#cmt-2', 'черновик');
  await outside(p); await B.sleep(300);
  ok('комментарии закрылись нажатием мимо', !(await p.locator('#cmt-2').count()));
  await friendCard.locator('.cmt-btn').click(); await B.sleep(200);
  ok('черновик комментария сохранился', (await p.inputValue('#cmt-2')).toLowerCase() === 'черновик');
  await friendCard.locator('.cmt-btn').click(); await B.sleep(200);
  ok('кнопка комментариев по-прежнему закрывает (не открывает заново)', !(await p.locator('#cmt-2').count()));

  // 2. правка своего ответа
  await p.locator('.ans.mine .ans-body, .ans.mine [role="button"]').first().click();
  await p.getByRole('menuitem', { name: 'Изменить' }).click().catch(async () => { await p.getByText('Изменить', { exact: true }).click(); });
  await p.waitForSelector('#answer');
  await outside(p); await B.sleep(300);
  ok('правка без изменений отменилась нажатием мимо', !(await p.locator('#answer').count()));
  await p.locator('.ans.mine .ans-body, .ans.mine [role="button"]').first().click();
  await p.getByRole('menuitem', { name: 'Изменить' }).click().catch(async () => { await p.getByText('Изменить', { exact: true }).click(); });
  await p.waitForSelector('#answer');
  await p.fill('#answer', 'Мой новый ответ');
  await outside(p); await B.sleep(300);
  ok('правка с изменённым текстом осталась открытой', (await p.locator('#answer').count()) > 0 && (await p.inputValue('#answer')) === 'Мой новый ответ');

  // 3. «Новая дуэль» (Игры → Сектор)
  await p.locator('.bn-item').nth(3).click().catch(() => {});
  await p.evaluate(() => localStorage.setItem('game-mode', 'sector'));
  await p.goto(p.url().split('?')[0] + '?tab=game'); await B.sleep(1500);
  const duelBtn = p.getByRole('button', { name: 'Новая дуэль' });
  if (await duelBtn.count()) {
    await duelBtn.click(); await B.sleep(200);
    const opened = (await p.locator('#duel-sect .duel-form').count()) > 0;
    await outside(p); await B.sleep(300);
    ok('«Новая дуэль» закрылась нажатием мимо', opened && !(await p.locator('#duel-sect .duel-form').count()));
    await duelBtn.click(); await B.sleep(200);
    await p.getByRole('button', { name: 'Закрыть' }).click(); await B.sleep(300);
    ok('кнопка «Закрыть» у дуэли закрывает', !(await p.locator('#duel-sect .duel-form').count()));
  } else ok('раздел дуэлей найден', false);

  // 4. «Дурак»: «Новая комната» и предупреждение «Выйти»
  await B.openDurak(p);
  await p.getByRole('button', { name: 'Новая комната' }).click(); await B.sleep(200);
  const formOpen = (await p.locator('.duel-form').count()) > 0;
  await outside(p); await B.sleep(300);
  ok('«Новая комната» закрылась нажатием мимо', formOpen && !(await p.locator('.duel-form').count()));
  await p.getByRole('button', { name: 'Новая комната' }).click(); await B.sleep(200);
  await p.locator('.dk-test-chip').click();
  ok('нажатия внутри формы её не закрывают', (await p.locator('.duel-form').count()) > 0);
  await p.locator('.dk-rules summary').click(); await B.sleep(300);
  ok('«Правила» открылись, а «Новая комната» осталась (кнопки и разделы её не закрывают)', (await p.locator('.duel-form').count()) > 0 && (await p.locator('.dk-rules[open]').count()) > 0);
  await p.locator('.dk-rules summary').click(); await B.sleep(200);
  await p.getByRole('button', { name: 'Открыть тестовую комнату' }).click();
  await p.waitForSelector('.duel-lobby');
  await p.getByRole('button', { name: 'Добавить бота' }).click(); await B.sleep(300);
  await p.getByRole('button', { name: 'Начать' }).click();
  await B.chooseOpen(p);
  await p.waitForSelector('.dk-table');
  await p.locator('.dk-quit').click(); await B.sleep(200);
  const popOpen = (await p.locator('.dk-quit-pop').count()) > 0;
  await p.locator('.dk-mid').click({ force: true }); await B.sleep(300);
  ok('предупреждение «Выйти» закрылось нажатием мимо, игра идёт', popOpen && !(await p.locator('.dk-quit-pop').count()) && (await p.locator('.dk-table').count()) > 0);
  await p.locator('.dk-quit').click(); await B.sleep(200);
  await p.locator('.dk-quit').click(); await B.sleep(300);
  ok('кнопка «Выйти» второй раз закрывает предупреждение', !(await p.locator('.dk-quit-pop').count()));

  console.log(results.join('\n'));
  console.log(errors.length ? errors.join('\n') : 'ошибок на странице нет');
  await browser.close();
})().catch(e => { console.error('СБОЙ', e); console.log(results.join('\n')); process.exit(1); });
