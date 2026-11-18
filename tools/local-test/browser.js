// Общая часть сценариев: открыть сайт на телефоне (390×844) от имени участника локальной базы.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const SHIM = fs.readFileSync(path.join(__dirname, 'shim.js'), 'utf8');
const SITE = 'http://localhost:8099/';

async function launch() { return chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true }); }

// Одна «вкладка телефона» для участника uid. errors — общий список ошибок страницы.
async function phone(browser, uid, errors, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: opts.width || 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
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
  await p.locator('.game-switch button', { hasText: 'Дурак' }).click();
  await p.waitForSelector('.dk', { timeout: 5000 });
}

// Сделать ход, если сейчас мой: открыть закрытую / положить младшую подходящую / забрать стопку
async function moveIfMyTurn(p) {
  if (!(await p.locator('.dk-me.turn').count())) return false;
  const flip = p.locator('.dk-slots.mine .dk-card.back.can');
  const can = p.locator('.dk-slots.mine .dk-card.top.can, .dk-hand .dk-card.can');
  if (await flip.count()) { await flip.first().click(); return true; }
  if (await can.count()) { await can.first().click(); await p.locator('.dk-acts .btn.primary').click(); return true; }
  const take = p.getByRole('button', { name: 'Забрать стопку' });
  if (await take.count()) { await take.click(); return true; }
  return false;
}

// Выбрать три открытые карты (1-ю, 3-ю, 5-ю) и подтвердить
async function chooseOpen(p) {
  await p.waitForSelector('.dk-pick button', { timeout: 10000 });
  const b = p.locator('.dk-pick button');
  for (const k of [0, 2, 4]) { await b.nth(k).click(); await p.waitForTimeout(120); }
  await p.getByRole('button', { name: 'Положить открытыми' }).click();
}

function shooter(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return (p, name) => p.screenshot({ path: path.join(dir, name + '.png'), fullPage: true });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
module.exports = { launch, phone, openDurak, moveIfMyTurn, chooseOpen, shooter, sleep };
