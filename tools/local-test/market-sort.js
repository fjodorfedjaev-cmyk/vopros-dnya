// «Лавка → Рынок»: кнопки над плитками (21.11). «Коллекция ▾» — фильтр с окошком под кнопкой (закрывается нажатием мимо);
// «Цена» и «Редкость» — сортировки нажатием: выкл → ↓ → ↑ → выкл, можно обе сразу (сначала редкость, внутри цена).
// По умолчанию: сверху то, что в продаже (свежие лоты первыми), дальше — по порядку альбома.
// База: как для market-bids.js (свежая). Запуск: DB=coll node market-sort.js   (WIDTH=360 — узкий телефон)
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const DB = process.env.DB || 'coll';
const W = +process.env.WIDTH || 390;
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-c', sql]).toString().trim();
let fails = 0;
const ok = (cond, text) => { console.log((cond ? '✓ ' : '✗ ') + text); if (!cond) fails++; };

const A = q('select user_id from public.admins limit 1');
const F = q(`select id from public.profiles where id <> '${A}' order by created_at limit 1`);
// продавец A выставляет 4 карточки, в разное время: Трамплин — самый свежий, Монета — самый старый
const LOTS = [['Монета', 50, '3 hours'], ['Кубок', 80, '2 hours'], ['Ракета', 120, '1 hour'], ['Трамплин', 300, '10 minutes']];
q(`update public.card_listings set status = 'cancelled', closed_at = now() where status = 'active'`);
for (const [name, price, ago] of LOTS) {
  const copy = q(`update public.card_copies set state = 'owned', owner_id = '${A}', obtained_at = now()
                   where id = (select k.id from public.card_copies k join public.cards c on c.id = k.card_id where c.name = '${name}' and k.state = 'deck' order by k.serial limit 1)
                   returning id`);
  q(`insert into public.card_listings (copy_id, seller_id, price, created_at, updated_at) values (${copy}, '${A}', ${price}, now() - interval '${ago}', now() - interval '${ago}')`);
}

async function openMarket(p) {
  await p.locator('.bn-item', { hasText: 'Профиль' }).click();
  await p.locator('.bn-item', { hasText: 'Коллекция' }).click();
  await p.waitForSelector('.coll-switch');
  if ((await p.locator('.coll-switch button', { hasText: 'Лавка' }).getAttribute('aria-pressed')) !== 'true') await p.locator('.coll-switch button', { hasText: 'Лавка' }).click();
  await p.waitForSelector('.mk-tabs');
  await p.locator('.mk-tabs button', { hasText: 'Рынок' }).click();
  await p.waitForSelector('.mk-ctrl');
  await B.sleep(200);
}
const names = async (p, n) => (await p.locator('.mk-tl .mk-tl-name').allTextContents()).slice(0, n || 99);
const chip = (p, i) => p.locator('.mk-ctrl .mk-chip').nth(i);      // 0 Коллекция, 1 Цена, 2 Редкость
const PRICE = 1, RAR = 2;
const chipText = async (p, i) => (await chip(p, i).innerText()).replace(/\s+/g, ' ').trim();
const toast = async (p) => ((await p.locator('.toast').textContent().catch(() => '')) || '').trim();

(async () => {
  const browser = await B.launch(), errors = [];
  const p = await B.phone(browser, F, errors, { tag: 'покупатель' });
  await p.evaluate(() => { localStorage.removeItem('mk-sort-rar'); localStorage.removeItem('mk-sort-price'); localStorage.removeItem('mk-series'); });
  await openMarket(p);

  // 0. кнопки: три, в один ряд, сортировки выключены
  const labels = [];
  for (let i = 0; i < (await p.locator('.mk-ctrl .mk-chip').count()); i++) labels.push(await chipText(p, i));
  ok(labels.join(' | ') === 'Коллекция ▾ | Цена ⇅ | Редкость ⇅', 'кнопки: ' + labels.join(' | '));
  const tops = await p.locator('.mk-ctrl .mk-chip').evaluateAll((ns) => ns.map((n) => Math.round(n.getBoundingClientRect().top)));
  const right = await p.locator('.mk-ctrl .mk-chip').last().evaluate((n) => n.getBoundingClientRect().right);
  ok(new Set(tops).size === 1 && right <= W - 8, `в один ряд на ${W} px, правый край ${Math.round(right)}`);
  ok(!(await p.locator('.mk-sortbtn, .mk-ftag').count()), 'старой кнопки «Сортировка» и меток фильтров нет');
  await shot(p, 'ms_default');

  // 1. по умолчанию: в продаже сверху, свежие первыми; дальше — альбом (сначала обычные)
  let first = await names(p, 5);
  ok(first.slice(0, 4).join(',') === 'Трамплин,Ракета,Кубок,Монета' && (await p.locator('.mk-tl').count()) === 20,
    'по умолчанию: ' + first.join(', ') + ' (в продаже — по свежести, 20 плиток)');
  const restRar = await p.locator('.mk-tl').evaluateAll((ns) => ns.slice(4).map((n) => n.className.match(/r-(\w+)/)[1]));
  const order = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
  ok(restRar.every((r, i) => i === 0 || order.indexOf(restRar[i - 1]) <= order.indexOf(r)), 'остальные — по порядку альбома (обычные → легендарная)');

  // 2. «Редкость»: ⇅ → ↓ (сначала редкие) → ↑ (сначала обычные) → ⇅
  await chip(p, RAR).click(); await B.sleep(150);
  first = await names(p, 3);
  ok((await chipText(p, RAR)) === 'Редкость ↓' && (await toast(p)) === 'Сначала редкие' && first.join(',') === 'Солнце дня,Трамплин,Разворот',
    'одно нажатие: «Редкость ↓», всплыло «Сначала редкие»; ' + first.join(', ') + ' (эпические: в продаже — первой)');
  await shot(p, 'ms_rar_desc');
  await chip(p, RAR).click(); await B.sleep(150);
  first = await names(p, 2);
  ok((await chipText(p, RAR)) === 'Редкость ↑' && (await toast(p)) === 'Сначала обычные' && first[0] === 'Монета',
    'второе: «Редкость ↑», «Сначала обычные»; первой — ' + first[0] + ' (обычная в продаже)');
  await chip(p, RAR).click(); await B.sleep(150);
  ok((await chipText(p, RAR)) === 'Редкость ⇅' && (await names(p, 1))[0] === 'Трамплин' && /без сортировки/.test(await toast(p)),
    'третье: выключено, снова свежие лоты сверху («' + (await toast(p)) + '»)');

  // 3. «Цена»: ↓ дорогие сверху, ↑ дешёвые сверху, без продажи — всегда в конце
  await chip(p, PRICE).click(); await B.sleep(150);
  first = await names(p, 5);
  const lastFoot = (await p.locator('.mk-tl .mk-tl-price').last().textContent()).trim();
  ok((await chipText(p, PRICE)) === 'Цена ↓' && first.slice(0, 4).join(',') === 'Трамплин,Ракета,Кубок,Монета' && lastFoot === '—',
    'цена ↓: ' + first.slice(0, 4).join(', ') + ', без продажи — в конце');
  await chip(p, PRICE).click(); await B.sleep(150);
  first = await names(p, 4);
  ok((await chipText(p, PRICE)) === 'Цена ↑' && (await toast(p)) === 'Сначала дешёвые' && first.join(',') === 'Монета,Кубок,Ракета,Трамплин'
    && (await p.locator('.mk-tl .mk-tl-price').last().textContent()).trim() === '—', 'цена ↑: ' + first.join(', ') + ', без продажи — в конце');

  // 4. обе сразу: сначала по редкости, внутри — по цене
  await chip(p, PRICE).click(); await chip(p, PRICE).click(); await B.sleep(150);   // ↑ → выкл → ↓
  await chip(p, RAR).click(); await B.sleep(150);                               // редкость ↓
  first = await names(p, 3);
  ok((await chipText(p, RAR)) === 'Редкость ↓' && (await chipText(p, PRICE)) === 'Цена ↓' && first.join(',') === 'Солнце дня,Трамплин,Разворот',
    'обе ↓: ' + first.join(', ') + ' (группы по редкости, внутри — по цене)');
  const rares = await p.locator('.mk-tl.r-rare .mk-tl-name').allTextContents();
  ok(rares[0] === 'Кубок', 'синие: первым Кубок (единственный в продаже) — ' + rares.join(', '));
  await shot(p, 'ms_both');

  // 5. запоминается
  await openMarket(p);
  ok((await chipText(p, RAR)) === 'Редкость ↓' && (await chipText(p, PRICE)) === 'Цена ↓', 'зашёл заново — обе сортировки на месте');
  await chip(p, RAR).click(); await chip(p, RAR).click(); await chip(p, PRICE).click(); await chip(p, PRICE).click(); await B.sleep(150);
  ok((await chipText(p, RAR)) === 'Редкость ⇅' && (await chipText(p, PRICE)) === 'Цена ⇅', 'выключил обе');

  // 6. «Коллекция ▾»: окошко, нажатие мимо закрывает; выбрал «Начало» — закрылось, кнопка подсвечена
  await chip(p, 0).click(); await B.sleep(150);
  const pop0 = await p.locator('.mk-pop').count();
  const box = await p.locator('.mk-pop').boundingBox();
  await shot(p, 'ms_pop_series');
  await p.locator('.mk-grid').click({ position: { x: 5, y: 5 }, force: true }).catch(() => {});
  await p.mouse.click(W / 2, 40); await B.sleep(200);
  ok(pop0 === 1 && box.x + box.width <= W && (await p.locator('.mk-pop').count()) === 0, 'окошко коллекции открылось (в пределах экрана) и закрылось нажатием мимо');
  await chip(p, 0).click(); await B.sleep(150);
  await p.locator('.mk-pop .mk-pop-row', { hasText: 'Начало' }).click(); await B.sleep(150);
  ok((await p.locator('.mk-pop').count()) === 0 && (await chipText(p, 0)) === '«Начало» ▾' && (await chip(p, 0).getAttribute('class')).includes(' on'),
    'выбрал «Начало» — окошко закрылось, на кнопке «Начало», подсвечена');
  await chip(p, 0).click(); await p.locator('.mk-pop .mk-pop-row', { hasText: 'Все коллекции' }).click(); await B.sleep(150);
  ok((await chipText(p, 0)) === 'Коллекция ▾', '«Все коллекции» — снова «Коллекция»');

  ok(!(await p.locator('.mk-check, .mk-pop-reset').count()), 'фильтра редкостей (галочек) нет');

  // 8. коллекция + сортировка вместе; нажатие на сортировку закрывает открытое окошко
  await chip(p, 0).click(); await B.sleep(150);
  await chip(p, PRICE).click(); await B.sleep(200);
  first = await names(p, 4);
  ok((await p.locator('.mk-pop').count()) === 0 && (await chipText(p, PRICE)) === 'Цена ↓' && first.join(',') === 'Трамплин,Ракета,Кубок,Монета',
    'окошко было открыто, нажал «Цена» — закрылось и включилось «Цена ↓»');
  // 8б. самое широкое состояние: «Начало» и обе сортировки — один ряд
  await chip(p, RAR).click();
  await chip(p, 0).click(); await p.locator('.mk-pop .mk-pop-row', { hasText: 'Начало' }).click(); await B.sleep(150);
  const tops2 = await p.locator('.mk-ctrl .mk-chip').evaluateAll((ns) => ns.map((n) => Math.round(n.getBoundingClientRect().top)));
  const all2 = []; for (let i = 0; i < 3; i++) all2.push(await chipText(p, i));
  await shot(p, 'ms_widest');
  ok(new Set(tops2).size === 1, 'всё включено (' + all2.join(' | ') + ') — один ряд');
  await chip(p, RAR).click(); await chip(p, RAR).click(); await B.sleep(100);   // редкость: ↑ → выкл
  // 9. страница карточки открывается как раньше
  await p.locator('.mk-tl', { hasText: 'Монета' }).click();
  await p.waitForSelector('.mk-offers');
  ok((await p.locator('.mk-offer').count()) === 1, 'нажал на плитку — страница карточки с предложением продавца');

  ok(!errors.length, errors.length ? 'ошибки на странице: ' + errors.join(' | ') : 'ошибок на странице нет');
  await browser.close();
  console.log(fails ? `✗ не прошло: ${fails}` : '✓ всё прошло');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
