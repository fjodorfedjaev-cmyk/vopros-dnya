// Сценарий «Предложения по видам»: в окне «Свой вопрос» видно только предложения выбранного вида
// (Вопрос / Слово / Выбор) — и в очереди админа, и в «Моих предложениях»; на переключателе — сколько ждёт у каждого вида;
// на кнопке «Предложить» — только своего вида; поле текста не растягивается рукой и само подстраивает высоту.
// Предложения подставляются через localStorage 'mock-rpc'. Запуск: DB=… node suggest-kinds.js (любая база со stub.sql)
const { execFileSync } = require('child_process');
const B = require('./browser');
const DB = process.env.DB || 'pf';
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-c', sql]).toString().trim();
const results = [];
const ok = (name, cond) => results.push((cond ? 'ok   ' : 'FAIL ') + name);
const A = q('select user_id from public.admins limit 1');
const now = new Date().toISOString();
const pending = [
  { s_id: 1, s_kind: 'question', s_text: 'Что ты терпишь, хотя давно пора перестать?', s_options: null, s_created: now },
  { s_id: 2, s_kind: 'question', s_text: 'Какая твоя самая вредная привычка?', s_options: null, s_created: now },
  { s_id: 3, s_kind: 'fill', s_text: 'Лучший завтрак — это ___', s_options: null, s_created: now },
  { s_id: 4, s_kind: 'poll', s_text: 'Что взять в поход?', s_options: ['Палатку', 'Гамак', 'Ничего', 'Друга'], s_created: now }
];
const mine = [
  { s_id: 10, s_kind: 'question', s_text: 'Мой вопрос про котов, очень длинный, чтобы проверить, что поле само растёт в высоту, когда текста много и он не помещается в две строки', s_status: 'pending', s_options: null },
  { s_id: 11, s_kind: 'fill', s_text: 'Моя фраза ___', s_status: 'approved', s_options: null }
];
(async () => {
  const browser = await B.launch(), errors = [];
  const p = await B.phone(browser, A, errors, { tag: 'админ' });
  await p.evaluate(([pe, mi]) => localStorage.setItem('mock-rpc', JSON.stringify({ admin_suggestions: pe, my_suggestions: mi })), [pending, mine]);
  await p.reload(); await p.waitForSelector('.bn-item');
  await p.locator('.bn-item', { hasText: 'Вопрос' }).click();
  await p.waitForSelector('.sug-btn');
  await B.sleep(600);
  ok('«Предложить» во «Вопросе»: на значке 2 (только вопросы)', (await p.locator('#sug-badge').innerText()).trim() === '2');
  await p.locator('.sug-btn').click();
  await p.waitForSelector('#sug-admin .sug-item');
  await B.sleep(300);
  await p.screenshot({ path: __dirname + '/shots/sug_question.png', fullPage: true });
  const segTxt = await p.locator('#sug-form .segment button').allInnerTexts();
  ok('переключатель: Вопрос 2 · Слово 1 · Выбор 1', /Вопрос\s*2/.test(segTxt[0]) && /Слово\s*1/.test(segTxt[1]) && /Выбор\s*1/.test(segTxt[2]));
  ok('очередь «Вопрос»: 2 вопроса, без фраз и «Выбора»', await p.locator('#sug-admin .sug-item').count() === 2 && !(await p.locator('#sug-admin .sug-item', { hasText: 'Лучший завтрак' }).count()));
  ok('«Мои предложения» «Вопрос»: только вопрос', await p.locator('#sug-mine .sug-item').count() === 1 && (await p.locator('#sug-mine').innerText()).includes('про котов'));
  const rz = await p.locator('#sug-admin textarea').first().evaluate(n => getComputedStyle(n).resize);
  const rz2 = await p.locator('#sug-form textarea').first().evaluate(n => getComputedStyle(n).resize);
  ok('поля не растягиваются рукой (resize: ' + rz + ', ' + rz2 + ')', rz === 'none' && rz2 === 'none');
  const ta = p.locator('#sug-form textarea');
  const h1 = (await ta.boundingBox()).height;
  await ta.fill('Очень длинный вопрос '.repeat(8));
  await B.sleep(150);
  const h2 = (await ta.boundingBox()).height;
  ok('поле само растёт под текст: ' + Math.round(h1) + ' → ' + Math.round(h2), h2 > h1 + 20);
  await p.locator('#sug-form .segment button', { hasText: 'Слово' }).click();
  await B.sleep(200);
  ok('«Слово»: в очереди 1 фраза, в моих — 1 фраза', await p.locator('#sug-admin .sug-item').count() === 1 && /ждут проверки · 1/i.test(await p.locator('#sug-admin').innerText())
    && await p.locator('#sug-mine .sug-item').count() === 1 && (await p.locator('#sug-mine').innerText()).includes('Моя фраза'));
  await p.locator('#sug-form .segment button', { hasText: 'Выбор' }).click();
  await B.sleep(200);
  await p.screenshot({ path: __dirname + '/shots/sug_poll.png', fullPage: true });
  ok('«Выбор»: в очереди 1 с вариантами, своих «Выборов» нет', await p.locator('#sug-admin .sug-item').count() === 1 && await p.locator('#sug-admin .sug-opts input').count() === 4
    && (await p.locator('#sug-mine').innerText()).includes('Здесь будут твои «Выборы»'));
  console.log(results.join('\n'));
  console.log(errors.length ? errors.slice(0, 20).join('\n') : 'ошибок на странице нет');
  await browser.close();
  process.exit(results.some(r => r.startsWith('FAIL')) || errors.length ? 1 : 0);
})().catch(e => { console.error('СБОЙ', e.message); console.log(results.join('\n')); process.exit(1); });
