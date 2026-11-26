// «Свой вопрос» бесплатный: кнопка «Предложить» без цены, внизу «Бесплатно…»; если на проверке уже 5 своих —
// кнопка неактивна и подсказка «На проверке уже 5…». Предложения подставляются через localStorage 'mock-rpc'.
//   DB=… node sug-free.js   (любая база со stub.sql)
const { execFileSync } = require('child_process');
const B = require('./browser');
const DB = process.env.DB || 'e2e';
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-c', sql]).toString().trim();
let fails = 0;
const ok = (text, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + text + (extra ? ' — ' + extra : '')); if (!cond) fails++; };
const uid = q(`select id from public.profiles p where not exists (select 1 from public.admins a where a.user_id = p.id) order by created_at limit 1`);
const mine = (n) => Array.from({ length: n }, (_, i) => ({ s_id: 100 + i, s_kind: ['question', 'fill', 'poll'][i % 3], s_text: 'Моё предложение ' + (i + 1) + (i % 3 === 1 ? ' ___' : ''), s_status: 'pending', s_options: i % 3 === 2 ? ['а', 'б', 'в', 'г'] : null }));
(async () => {
  const browser = await B.launch(), errors = [];
  const p = await B.phone(browser, uid, errors, { tag: 'друг' });
  async function open(n) {
    await p.evaluate((m) => localStorage.setItem('mock-rpc', JSON.stringify({ my_suggestions: m })), mine(n));
    await p.reload(); await p.waitForSelector('.bn-item');
    await p.locator('.bn-item', { hasText: 'Вопрос' }).click();
    await p.waitForSelector('.sug-btn'); await p.locator('.sug-btn').first().click();
    await p.waitForSelector('#sug-form .segment button'); await B.sleep(300);
  }
  await open(2);
  for (const kind of ['Вопрос', 'Слово', 'Выбор']) {
    await p.locator('#sug-form .segment button', { hasText: kind }).click(); await B.sleep(150);
    const btn = p.locator('#sug-form button[type=submit]');
    ok(kind + ': кнопка «Предложить» без цены и активна', (await btn.innerText()).trim() === 'Предложить' && await btn.isEnabled(), await btn.innerText());
  }
  const rules = await p.locator('.sug-rules').innerText();
  ok('внизу — «Бесплатно, а за одобренное — +20… Ждать проверки могут до 5…», про возврат монет ничего', /Бесплатно, а за одобренное — \+20/.test(rules) && /Ждать проверки могут до 5/.test(rules) && !/вернутся/.test(rules), rules.replace(/\n/g, ' / '));
  await p.screenshot({ path: __dirname + '/shots/sug_free.png', fullPage: true });
  await open(5);
  const btn = p.locator('#sug-form button[type=submit]');
  ok('на проверке 5 своих — кнопка неактивна', !(await btn.isEnabled()));
  ok('подсказка «На проверке уже 5 твоих предложений…»', /На проверке уже 5 твоих предложений/.test(await p.locator('#sug-form').innerText()));
  await p.screenshot({ path: __dirname + '/shots/sug_free_full.png', fullPage: true });
  ok('ошибок на странице нет', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(fails ? '\nЕСТЬ ОШИБКИ: ' + fails : '\nВСЁ ХОРОШО');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
