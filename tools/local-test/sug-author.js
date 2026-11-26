// «Свой вопрос» → «Показывать автора» (26.11): переключатель в форме (запоминается), в «Моих предложениях» — пометка,
// у админа при проверке — пометка без имени; вышедшие Вопрос, Слово и дополнительный Выбор — «Автор · аватарка Имя».
// База (sg): ./db.sh sg profile-stub.sql suggest-stub.sql ../../supabase/suggest/05_show_author.sql
//   DB=sg node server.js &   DB=sg node sug-author.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const DB = process.env.DB || 'sg';
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-c', sql]).toString().trim();
const rpc = (u, call) => q(`select set_config('request.jwt.claims', '{"sub":"${u}","role":"authenticated"}', true); select ${call};`).split('\n').pop();
let fails = 0;
const ok = (cond, text) => { console.log((cond ? '✓ ' : '✗ ') + text); if (!cond) fails++; };

async function phone(browser, uid, errors, tag) {
  const p = await B.phone(browser, uid, errors, { tag });
  await p.evaluate(() => localStorage.setItem('local-sug', '1'));
  await p.reload(); await p.waitForSelector('.bn-item');
  return p;
}
async function openSuggest(p, kind) {
  await p.locator('.bn-item', { hasText: 'Вопрос' }).click();
  await p.waitForSelector('.sug-btn'); await p.locator('.sug-btn').first().click();
  await p.waitForSelector('#sug-form .segment button');
  if (kind) await p.locator('#sug-form .segment button', { hasText: kind }).click();
  await B.sleep(200);
}

(async () => {
  const admin = q('select user_id from public.admins limit 1');
  const [author, viewer] = q(`select string_agg(id::text, ',' order by created_at) from public.profiles where id <> '${admin}'`).split(',');
  const authorName = q(`select display_name from public.profiles where id = '${author}'`);
  const browser = await B.launch(), errors = [];

  // 1. автор: переключатель выключен, включил — подсказка меняется; Вопрос и Слово — с автором, Выбор — с автором, ещё один Вопрос — без
  const a = await phone(browser, author, errors, 'автор');
  await openSuggest(a, 'Вопрос');
  const sw = a.locator('.sug-author');
  ok(await sw.getAttribute('aria-checked') === 'false' && /Никто не узнает/.test(await sw.textContent()), 'переключатель «Показывать автора» выключен: «' + (await sw.textContent()).trim() + '»');
  await sw.click();
  ok(await sw.getAttribute('aria-checked') === 'true' && /твоё имя и аватарка/.test(await sw.textContent()), 'включил — «Под вопросом будет твоё имя и аватарка»');
  await a.locator('#sug-form textarea').fill('Тестовый вопрос с автором?');
  await shot(a, 'sa_form');
  await a.locator('#sug-form button[type=submit]').click();
  await a.waitForFunction(() => /Отправлено/.test(document.body.textContent), null, { timeout: 5000 }).catch(() => {});
  await B.sleep(500);
  await a.locator('#sug-form .segment button', { hasText: 'Слово' }).click();
  ok(await a.locator('.sug-author').getAttribute('aria-checked') === 'true', 'переключатель запомнился (Слово — тоже включён)');
  await a.locator('#sug-form textarea').fill('Тестовая фраза с ___ от автора');
  await a.locator('#sug-form button[type=submit]').click(); await B.sleep(800);
  await a.locator('#sug-form .segment button', { hasText: 'Выбор' }).click();
  await a.locator('#sug-form input[aria-label="Вопрос"]').fill('Тестовый выбор с автором?');
  for (let i = 1; i <= 4; i++) await a.locator(`#sug-form input[aria-label="Вариант ${i}"]`).fill('Вариант ' + i);
  await a.locator('#sug-form button[type=submit]').click(); await B.sleep(800);
  await a.locator('#sug-form .segment button', { hasText: 'Вопрос' }).click();
  await a.locator('.sug-author').click();
  await a.locator('#sug-form textarea').fill('Тестовый вопрос без автора?');
  await a.locator('#sug-form button[type=submit]').click(); await B.sleep(800);
  const flags = q(`select string_agg(kind || ':' || show_author, ',' order by id) from public.suggestions where user_id = '${author}'`);
  ok(flags === 'question:true,fill:true,poll:true,question:false', 'в базе: ' + flags);
  const mineText = await a.locator('#sug-mine').textContent();
  ok((mineText.match(/С автором/g) || []).length === 1, '«Мои предложения» (Вопрос): пометка «С автором» только у одного из двух');
  await a.locator('#sug-mine').scrollIntoViewIfNeeded();
  await shot(a, 'sa_mine');

  // 2. админ: пометка без имени, одобряет
  const ad = await phone(browser, admin, errors, 'админ');
  await openSuggest(ad, 'Вопрос');
  const adm = await ad.locator('#sug-admin').textContent();
  ok(/Автор попросил показать имя/.test(adm) && !adm.includes(authorName), 'у админа: «Автор попросил показать имя», а самого имени нет');
  await ad.locator('#sug-admin').scrollIntoViewIfNeeded();
  await shot(ad, 'sa_admin');
  const ids = q(`select string_agg(id::text, ',' order by id) from public.suggestions where user_id = '${author}'`).split(',');
  for (const id of ids) rpc(admin, `public.admin_review_suggestion(${id}, true)`);
  const [tq, tf, tp, tq2] = ids.map((id) => q(`select target_id from public.suggestions where id = ${id}`));
  // сегодня выходят: вопрос с автором, фраза с автором; «Выбор» с автором — дополнительным; обычный «Выбор» — без автора
  q(`delete from public.daily_questions; delete from public.daily_fills; delete from public.daily_poll_extras;
     insert into public.daily_questions values (public.today_tallinn(), ${tq}); insert into public.daily_fills values (public.today_tallinn(), ${tf});
     update public.poll_questions set extra_from = public.today_tallinn() where id = ${tp}`);

  // 3. другой участник видит автора
  const v = await phone(browser, viewer, errors, 'друг');
  await v.locator('.bn-item', { hasText: 'Вопрос' }).click();
  await v.waitForSelector('.qcard .qtext');
  await B.sleep(500);
  const qa = v.locator('.qcard .q-author');
  ok(await qa.count() === 1 && (await qa.textContent()).includes(authorName) && await qa.locator('.avatar').count() === 1,
    'Вопрос дня: «Автор · ' + ((await qa.count()) ? (await qa.textContent()).replace('Автор', '').trim() : '—') + '» с аватаркой');
  ok(await v.locator('.qcard .q-author button.person').count() === 1, 'имя автора — кнопка (мини-профиль)');
  await shot(v, 'sa_question');
  await v.locator('.day-switch button', { hasText: 'Слово' }).click();
  await v.waitForSelector('.qcard .qtext'); await B.sleep(500);
  ok((await v.locator('.qcard .q-author').textContent().catch(() => '')).includes(authorName), 'Слово дня: тоже «Автор · ' + authorName + '»');
  await shot(v, 'sa_fill');
  await v.locator('.day-switch button', { hasText: 'Выбор' }).click();
  await v.waitForSelector('.poll-card'); await B.sleep(700);
  const cards = await v.locator('.poll-card').count();
  const main = await v.locator('.poll-card[data-slot="1"] .q-author').count();
  const extra = await v.locator('.poll-card[data-slot="2"] .q-author').textContent().catch(() => '');
  ok(cards === 2 && main === 0 && extra.includes(authorName), 'Выбор: у обычного автора нет, у дополнительного — «Автор · ' + authorName + '»');
  await shot(v, 'sa_poll');
  // вопрос без «Показывать автора» — без строки автора
  q(`delete from public.daily_questions; insert into public.daily_questions values (public.today_tallinn(), ${tq2})`);
  const v2 = await phone(browser, viewer, errors, 'друг2');
  await v2.locator('.bn-item', { hasText: 'Вопрос' }).click();
  await v2.waitForSelector('.qcard .qtext'); await B.sleep(500);
  ok((await v2.locator('.qcard .qtext').textContent()).includes('без автора') && await v2.locator('.q-author').count() === 0, 'вопрос, где автор не включил переключатель, — без строки автора');

  console.log(errors.length ? errors.slice(0, 20).join('\n') : 'ошибок на страницах нет');
  await browser.close();
  process.exit(fails || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
