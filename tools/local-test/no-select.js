// Текст не выделяется (22.11): обход всего сайта одним «телефоном» — Вопрос / Слово / Выбор / Гороскоп и окно
// «Предложить», Игры (Сектор, Зигзаг, Ферма, окошко «Карты», списки Дурака, «Верю — не верю», Покера), Коллекция
// и Лавка, Казино (Дабл, Сапёр, Краш), Профиль и мини-профиль. На каждом экране: ни одна надпись, смайлик, аватарка
// и значок не выделяется; долгое нажатие (contextmenu) не даёт меню телефона; двойное нажатие ничего не выделяет;
// картинку не утащить; поля ввода выделяются и меню в них есть.
//   DB=… node no-select.js   (база с profile-seed.sql — чтобы были Участники)
const B = require('./browser');
const { execFileSync } = require('child_process');
const shot = B.shooter(__dirname + '/shots');
const u = execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c',
  "select id from public.profiles p where not exists (select 1 from public.admins a where a.user_id = p.id) order by created_at limit 1"]).toString().trim();
const FIELD = 'input, textarea, select, [contenteditable]';
async function audit(p, name) {
  const r = await p.evaluate((FIELD) => {
    const us = (e) => getComputedStyle(e).userSelect;
    const all = [...document.querySelectorAll('body *')].filter(e => e.getClientRects().length && !e.closest(FIELD) && !['SCRIPT', 'STYLE'].includes(e.tagName));
    const bad = all.filter(e => us(e) !== 'none').map(e => e.tagName.toLowerCase() + '.' + (e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className));
    // меню долгого нажатия: на надписях, аватарках, значках, картинках
    const probe = all.filter(e => e.children.length === 0 || e.tagName === 'svg' || e.tagName === 'IMG').slice(0, 400);
    let menu = 0;
    for (const e of probe) {
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      e.dispatchEvent(ev);
      if (!ev.defaultPrevented) menu++;
    }
    const fields = [...document.querySelectorAll(FIELD)].filter(e => e.getClientRects().length);
    const fieldsBad = fields.filter(e => us(e) === 'none').length;
    let fieldMenu = 0;
    for (const e of fields) { const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); e.dispatchEvent(ev); if (ev.defaultPrevented) fieldMenu++; }
    const avatars = document.querySelectorAll('.avatar').length;
    const imgs = [...document.querySelectorAll('img')].filter(e => e.getClientRects().length && getComputedStyle(e).webkitUserDrag !== 'none').length;
    return { n: all.length, bad: [...new Set(bad)].slice(0, 6), badN: bad.length, menu, probe: probe.length, fields: fields.length, fieldsBad, fieldMenu, avatars, imgs };
  }, FIELD);
  // двойное нажатие по нескольким надписям — ничего не выделяется
  const texts = p.locator('h1:visible, h2:visible, p:visible, .avatar:visible, .muted:visible');
  const k = Math.min(await texts.count(), 4);
  let picked = '';
  for (let i = 0; i < k; i++) { try { await texts.nth(i).dblclick({ timeout: 1500, force: true }); picked += await p.evaluate(() => String(getSelection())); await p.evaluate(() => getSelection().removeAllRanges()); } catch (e) { /* закрыто окном */ } }
  const ok = r.badN === 0 && r.menu === 0 && r.fieldsBad === 0 && r.fieldMenu === 0 && !picked && r.imgs === 0;
  console.log((ok ? 'ok   ' : 'FAIL ') + name.padEnd(26) + ` элементов ${r.n}, аватарок ${r.avatars}, проверено меню ${r.probe}` +
    (r.fields ? `, полей ${r.fields}` : '') + (ok ? '' : ` | выделяются: ${r.badN} ${r.bad.join(' ')} | меню: ${r.menu} | поля: ${r.fieldsBad}/${r.fieldMenu} | выделено: «${picked}» | картинки: ${r.imgs}`));
  return ok;
}
async function tap(p, name, exact = true) {
  const b = p.getByRole('button', typeof name === 'string' ? { name, exact } : { name });
  if (!(await b.count())) { console.log('     нет кнопки «' + name + '»'); return false; }
  await b.first().click(); await B.sleep(900); return true;
}
(async () => {
  const browser = await B.launch(), errors = [];
  const p = await B.phone(browser, u, errors, { tag: 'P1' });
  await B.sleep(2500);
  let fails = 0;
  const go = async (nav) => { await p.locator('.bn-item', { hasText: nav }).click(); await B.sleep(1000); };
  const check = async (name) => { if (!(await audit(p, name))) fails++; };
  await go('Вопрос'); await check('Вопрос');
  if (await tap(p, /Предложить/, false)) { await check('Предложить (окно)'); await p.keyboard.press('Escape'); await p.mouse.click(5, 5); await B.sleep(500); }
  for (const t of ['Слово', 'Выбор', 'Гороскоп']) { if (await tap(p, t)) await check('Вопрос → ' + t); }
  await go('Игры'); await check('Игры → Сектор');
  for (const t of ['Зигзаг', /Ферма/]) { if (await tap(p, t)) await check('Игры → ' + t); }
  if (await tap(p, 'Карты')) { await check('Карты (окошко)'); }
  await B.openDurak(p); await check('Дурак: список');
  await B.openBluff(p); await check('Верю — не верю: список');
  await B.openPoker(p); await check('Покер: список');
  await go('Коллекция'); await check('Коллекция');
  if (await tap(p, 'Лавка')) await check('Коллекция → Лавка');
  await go('Казино'); await check('Казино → Дабл');
  for (const t of ['Сапёр', 'Краш']) { if (await tap(p, t)) await check('Казино → ' + t); }
  await go('Профиль'); await check('Профиль');
  const person = p.locator('.members .person, .sect .person').first();
  if (await person.count()) { await person.click(); await B.sleep(1500); await check('Мини-профиль'); await shot(p, 'audit_people'); }
  console.log(errors.length ? errors.slice(0, 5).join('\n') : 'ошибок на страницах нет');
  console.log(fails ? 'ЕСТЬ ЗАМЕЧАНИЯ: ' + fails : 'ВСЁ ХОРОШО');
  await browser.close();
  process.exit(fails || errors.length ? 1 : 0);
})().catch(e => { console.error('СБОЙ', e); process.exit(1); });
