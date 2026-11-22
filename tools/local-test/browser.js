// Общая часть сценариев: открыть сайт на телефоне (390×844) от имени участника локальной базы.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const SHIM = fs.readFileSync(path.join(__dirname, 'shim.js'), 'utf8');
const SITE = 'http://localhost:8099/';

async function launch() { return chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true }); }

// Одна «вкладка телефона» для участника uid. errors — общий список ошибок страницы.
async function phone(browser, uid, errors, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: opts.width || +process.env.WIDTH || 390, height: opts.height || +process.env.HEIGHT || 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await ctx.addInitScript(([u, mode]) => {
    localStorage.setItem('mock-user', u);
    localStorage.setItem('install-hint-seen', '1');   // без подсказок «установить» и «уведомления»
    localStorage.setItem('push-hint-seen', '1');
    if (mode) localStorage.setItem('game-mode', mode);
  }, [uid, opts.mode || null]);
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'text/javascript', body: SHIM }));
  await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('https://fonts.gstatic.com/**', r => r.abort());
  const p = await ctx.newPage();
  const tag = opts.tag || uid.slice(0, 4);
  p.on('pageerror', e => errors.push(tag + ' ошибка страницы: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push(tag + ' консоль: ' + m.text()); });
  await p.goto(SITE);
  await p.waitForSelector('.bn-item', { timeout: 15000 });
  return p;
}

// Открыть Игры → Дурак
async function openDurak(p) {
  await p.locator('.bn-item', { hasText: 'Игры' }).click();
  if (!(await p.locator('.dk:not(.pk)').count())) {   // «Карты» → «Китайский дурак»
    await p.locator('.game-switch button', { hasText: 'Карты' }).click();
    await p.locator('.cards-pick button', { hasText: 'Китайский дурак' }).click();
  }
  await p.waitForSelector('.dk:not(.pk)', { timeout: 5000 });
}

// Открыть Игры → Карты → Покер (через окошко выбора карточной игры)
async function openPoker(p) {
  await p.locator('.bn-item', { hasText: 'Игры' }).click();
  if (!(await p.locator('.pk').count())) {
    await p.locator('.game-switch button', { hasText: 'Карты' }).click();
    await p.locator('.cards-pick button', { hasText: 'Покер' }).click();
  }
  await p.waitForSelector('.pk', { timeout: 5000 });
}

// Открыть Игры → Карты → «Верю — не верю»
async function openBluff(p) {
  await p.locator('.bn-item', { hasText: 'Игры' }).click();
  if (!(await p.locator('.bf').count())) {
    await p.locator('.game-switch button', { hasText: 'Карты' }).click();
    await p.locator('.cards-pick button', { hasText: 'Верю — не верю' }).click();
  }
  await p.waitForSelector('.bf', { timeout: 5000 });
}

// «Верю — не верю», новая комната: колода «от low до high» и джокеры — двигаем ползунки (значение + событие input, как пальцем)
async function bluffDeck(p, low, high, jokers) {
  await p.evaluate(([l, h, j]) => {
    const ins = document.querySelectorAll('.bf-range input');
    const set = (inp, v) => { inp.value = String(v); inp.dispatchEvent(new Event('input', { bubbles: true })); };
    if (l > Number(ins[1].value)) { set(ins[1], h); set(ins[0], l); } else { set(ins[0], l); set(ins[1], h); }
    set(ins[2], j);
  }, [low, high, jokers]);
}

// «Верю — не верю»: сходить, если мой ход. Новый круг — 1–3 карты (обычно одного номинала, иногда враньё);
// ответ — «Не верю» / «Верю» / доложить 1–2 карты. Возвращает, что сделано.
async function bluffMove(p, opts) {
  opts = opts || {};
  if (!(await p.locator('.dk-me.turn').count()) || await p.locator('.dk-anim').count()) return null;
  try {
    const cards = p.locator('.bf-hand button.dk-card');
    const n = await cards.count();
    if (await p.locator('.bf-put').count()) {
      const k = Math.min(n, 1 + Math.floor(Math.random() * 3));
      for (let i = 0; i < k; i++) await cards.nth(Math.floor(Math.random() * n)).click({ timeout: 2000 });
      if (await p.locator('.bf-put[disabled]').count()) {   // номинал не угадался — выбрать на кнопках
        const r = p.locator('.bf-ranks .bf-chip');
        await r.nth(Math.floor(Math.random() * await r.count())).click({ timeout: 2000 });
      }
      if (opts.before) await opts.before('put');
      await p.locator('.bf-put').click({ timeout: 2000 });
      return 'put';
    }
    if (!(await p.locator('.bf-doubt').count())) return null;
    const r = Math.random();
    if (r < (opts.doubt || 0.4)) { await p.locator('.bf-doubt').click({ timeout: 2000 }); return 'doubt'; }
    if (r < (opts.doubt || 0.4) + (opts.trust || 0.2) || !n) { await p.locator('.bf-trust').click({ timeout: 2000 }); return 'trust'; }
    const k = Math.min(n, 1 + Math.floor(Math.random() * 2));
    for (let i = 0; i < k; i++) await cards.nth(i).click({ timeout: 2000 });
    if (opts.before) await opts.before('add');
    await p.locator('.bf-add').click({ timeout: 2000 });
    return 'add';
  } catch (e) { return null; }   // стол успел смениться — попробуем снова
}

// Покер: сходить, если сейчас мой ход. Чаще уравнять/чек, иногда повысить через ползунок, иногда пас. Возвращает, что сделано.
async function pokerMove(p, opts) {
  opts = opts || {};
  if (!(await p.locator('.pk-acts.on').count())) return null;
  const btns = p.locator('.pk-acts.on .btn');
  const r = Math.random();
  try {
    if (r < (opts.raise || 0.2)) {
      const rb = btns.nth(2);
      if (await rb.isEnabled()) {
        const label = (await rb.textContent()) || '';
        await rb.click({ timeout: 2000 });
        if (/Ва-банк/.test(label)) return 'allin';
        await p.waitForSelector('.pk-raise', { timeout: 2000 });
        if (opts.shot) await opts.shot();
        const q = p.locator('.pk-raise-quick .btn');
        const k = Math.random();
        if (k < 0.4) await q.nth(0).click(); else if (k < 0.6) await q.nth(1).click(); else if (k < 0.65) await q.nth(2).click();
        else {   // ползунок: подвинуть клавишами
          const range = p.locator('.pk-raise input[type=range]');
          await range.focus();
          for (let i = 0; i < 3; i++) await p.keyboard.press('ArrowRight');
        }
        await p.locator('.pk-raise-go').click({ timeout: 2000 });
        return 'raise';
      }
    }
    if (r > 1 - (opts.fold || 0.1)) { await btns.nth(0).click({ timeout: 2000 }); return 'fold'; }
    await btns.nth(1).click({ timeout: 2000 });
    return 'call';
  } catch (e) { return null; }   // стол успел смениться — попробуем снова
}

// Сделать ход, если сейчас мой: открыть закрытую / положить подходящую / забрать стопку
async function moveIfMyTurn(p) {
  if (!(await p.locator('.dk-me.turn').count())) return false;
  const flip = p.locator('.dk-slots.mine .dk-card.back.can');
  const can = p.locator('.dk-slots.mine .dk-card.top.can, .dk-hand .dk-card.can');
  if (await flip.count()) { try { await flip.first().click({ timeout: 2000 }); return true; } catch (e) { return false; } }
  const n = await can.count();
  if (n) {
    // обычно младшую; иногда случайную — иначе двое последних могут ходить по кругу бесконечно
    try { await can.nth(Math.random() < 0.25 ? Math.floor(Math.random() * n) : 0).click({ timeout: 2000 }); } catch (e) { return false; }
    const put = p.locator('.dk-acts .btn.primary:not([disabled])');
    try { await put.click({ timeout: 3000 }); return true; } catch (e) { return false; }   // стол успел смениться — попробуем снова
  }
  const take = p.getByRole('button', { name: 'Забрать стопку' });
  if (await take.count()) { try { await take.click({ timeout: 2000 }); return true; } catch (e) { return false; } }
  return false;
}

// Выбрать три открытые карты (1-ю, 3-ю, 5-ю) и подтвердить
async function chooseOpen(p) {
  await p.waitForSelector('.dk-pick button', { timeout: 10000 });
  const b = p.locator('.dk-pick button');
  for (const k of [0, 2, 4]) { await b.nth(k).click(); await p.waitForTimeout(120); }
  await p.getByRole('button', { name: /^Положить/ }).click();
}

function shooter(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return (p, name) => p.screenshot({ path: path.join(dir, name + '.png'), fullPage: true });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
module.exports = { launch, phone, openDurak, openPoker, openBluff, bluffMove, bluffDeck, pokerMove, moveIfMyTurn, chooseOpen, shooter, sleep };
