// Сценарий «Мини-профиль» (people.js): нажал на имя — маленькое окно по центру: аватарка, имя, знак, серия дней,
// «сегодня», витрина (карточка крупно); без «с нами с…», ответов, реакций, монет, игр и дуэлей; свой профиль;
// открывается из Участников, ленты ответов (меню ответа при этом не открывается) и у продавца в Лавке.
// База: как для market-bids.js, плюс profile-stub.sql (после cards-stub.sql), ../../supabase/duels/01_duels.sql,
// ../../supabase/members/02_member_profile.sql и profile-seed.sql. Запуск: DB=pf node people.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const DB = process.env.DB || 'pf';
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-c', sql]).toString().trim();
const results = [];
const ok = (name, cond) => results.push((cond ? 'ok   ' : 'FAIL ') + name);
const A = q('select user_id from public.admins limit 1');
const F = q(`select id from public.profiles where id <> '${A}' order by created_at limit 1`);
const fname = q(`select display_name from public.profiles where id = '${F}'`);
const aname = q(`select display_name from public.profiles where id = '${A}'`);

(async () => {
  const browser = await B.launch(), errors = [];
  const p = await B.phone(browser, A, errors, { tag: 'админ' });

  // 1. Профиль → Участники → имя друга
  await p.locator('.bn-item', { hasText: 'Профиль' }).click();
  await p.waitForSelector('table.board .person');
  await p.locator('table.board .person', { hasText: fname }).click();
  await p.waitForSelector('.pf .pf-shelves', { timeout: 6000 });
  await B.sleep(400);
  await p.screenshot({ path: __dirname + '/shots/pf_friend.png' });
  const txt = await p.locator('.pf').innerText();
  ok('окно: имя, «Лев», «5 дней подряд», «Сегодня: ответ есть»', txt.includes(fname) && txt.includes('Лев') && txt.includes('5 дней подряд') && txt.includes('Сегодня: ответ есть'));
  ok('витрина: 3 карточки, «Собрано 3 из 20»', await p.locator('.pf-shelves .kc').count() === 3 && txt.includes('Собрано 3 из 20'));
  ok('нет «с нами с», ответов, реакций, монет, лучшей серии, игр, дуэлей и кнопки «Вызвать на дуэль»',
    !/с нами с|ответов|реакц|монет|лучшая|Сектор|Зигзаг|Дуэли|Дурак|Ваши дуэли/.test(txt) && !(await p.getByRole('button', { name: 'Вызвать на дуэль' }).count()));
  const box = await p.locator('.pf').boundingBox();
  ok('окно маленькое: ' + Math.round(box.width) + '×' + Math.round(box.height) + ' (влезает в экран без прокрутки)', box.height < 560 && box.width <= 320);
  // карточка крупно и назад
  await p.locator('.pf-shelves .shelf').first().click();
  await p.waitForSelector('.pf-zoom .kc');
  await p.screenshot({ path: __dirname + '/shots/pf_zoom.png' });
  ok('карточка с витрины открывается крупно', (await p.locator('.pf .kb-info').innerText()).includes('Легендарная'));
  await p.getByRole('button', { name: 'Назад' }).click();
  ok('«Назад» — снова профиль', await p.locator('.pf .pf-shelves').count() === 1);
  // закрыть нажатием мимо
  await p.mouse.click(8, 8);
  await B.sleep(200);
  ok('окно закрывается нажатием мимо', !(await p.locator('.pf').count()));

  // 2. свой профиль
  await p.locator('table.board .person', { hasText: aname }).click();
  await p.waitForSelector('.pf .pf-shelves');
  await p.screenshot({ path: __dirname + '/shots/pf_me.png' });
  ok('свой профиль: «это ты», есть «Изменить профиль»', await p.locator('.pf-me').count() === 1 && await p.getByRole('button', { name: 'Изменить профиль' }).count() === 1);
  await p.keyboard.press('Escape');
  await B.sleep(150);
  ok('Esc закрывает', !(await p.locator('.pf').count()));

  // 4. лента ответов: нажал на имя в ответе — профиль, меню ответа не открылось
  await p.evaluate(([a, f, an, fn]) => {
    localStorage.setItem('mock-tables', JSON.stringify({ answers: [
      { id: 1, user_id: a, body: 'мой ответ', created_at: new Date().toISOString(), updated_at: null, profiles: { display_name: an, color: '#F2782C', avatar: null } },
      { id: 2, user_id: f, body: 'ответ друга', created_at: new Date().toISOString(), updated_at: null, profiles: { display_name: fn, color: '#4C95F5', avatar: null } }
    ] }));
  }, [A, F, aname, fname]);
  await p.reload();
  await p.waitForSelector('.bn-item');
  await p.locator('.bn-item', { hasText: 'Вопрос' }).click();
  await p.waitForSelector('.ans .person', { timeout: 8000 });
  await p.locator('.ans .person', { hasText: fname }).first().click();
  await p.waitForSelector('.pf', { timeout: 5000 });
  ok('лента ответов: имя открывает профиль', (await p.locator('.pf-name').innerText()) === fname);
  await p.keyboard.press('Escape');
  await p.evaluate(() => localStorage.removeItem('mock-tables'));

  // 5. Лавка: продавец на странице карточки
  const rocket = q(`select id from public.cards where name = 'Ракета'`);
  q(`update public.card_copies set state = 'owned', owner_id = '${F}' where card_id = ${rocket} and serial = 1`);
  execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt',
    '-c', `set request.jwt.claims = '{"sub":"${F}","role":"authenticated"}'`,
    '-c', `select public.market_sell((select id from public.card_copies where card_id = ${rocket} and serial = 1), 150)`]);
  await p.reload();
  await p.waitForSelector('.bn-item');
  await p.locator('.bn-item', { hasText: 'Коллекция' }).click();
  await p.locator('.coll-switch button', { hasText: 'Лавка' }).click();
  await p.locator('.mk-tabs button', { hasText: 'Рынок' }).click();
  await p.locator('.mk-tl', { hasText: 'Ракета' }).click();
  await p.waitForSelector('.mk-offer .person');
  await p.locator('.mk-offer .person').first().click();
  await p.waitForSelector('.pf', { timeout: 5000 });
  ok('Лавка: имя продавца открывает его профиль поверх страницы карточки', (await p.locator('.pf-name').innerText()) === fname && await p.locator('.mk-sheet').count() === 1);
  await p.keyboard.press('Escape');
  await B.sleep(150);
  ok('после закрытия — снова страница карточки, номер не сменился', await p.locator('.mk-sheet').count() === 1 && !(await p.locator('.pf').count()));

  console.log(results.join('\n'));
  console.log(errors.length ? errors.slice(0, 20).join('\n') : 'ошибок на страницах нет');
  await browser.close();
  process.exit(results.some(r => r.startsWith('FAIL')) || errors.length ? 1 : 0);
})().catch(e => { console.error('СБОЙ', e); console.log(results.join('\n')); process.exit(1); });
