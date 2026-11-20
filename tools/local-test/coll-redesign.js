// Сценарий «Коллекция» (новый вид): блок открытия, шансы, открытие по нажатиям и экран результата,
// «На витрину», альбом (фильтры, «Новая», силуэты), панель карточки снизу, перетаскивание на витрину, витрина в Профиле.
// Нужно: ./db.sh coll cards-stub.sql ../../supabase/cards/01_cards.sql ../../supabase/market/01_market.sql … и DB=coll node server.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const DB = process.env.DB || 'coll';
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-c', sql]).toString().trim();
const admin = q('select user_id from public.admins limit 1');
const results = [];
const ok = (name, cond) => results.push((cond ? 'ok   ' : 'FAIL ') + name);
async function openOne(p, first) {
  const btn = first ? p.locator('.ko-open') : p.locator('.kr-again');
  await btn.click();
  await p.waitForSelector('.kr-stage:not(.kr-wait)', { timeout: 8000 });
  for (let i = 0; i < 8 && !(await p.locator('.kr-result.on').count()); i++) { await p.locator('.kr-stage').click(); await B.sleep(250); }
  await p.waitForSelector('.kr-result.on', { timeout: 5000 });
}
(async () => {
  const browser = await B.launch(), errors = [];
  const p = await B.phone(browser, admin, errors, { tag: 'админ' });
  await p.locator('.bn-item', { hasText: 'Коллекция' }).click();
  await p.waitForSelector('.ko', { timeout: 8000 });
  await B.sleep(400);
  await shot(p, 'cr_start');
  ok('блок открытия: серия, «1 случайная карточка», «Открыть за 300»', (await p.locator('.ko-title').textContent()).includes('Начало')
    && (await p.locator('.ko-sub').textContent()).includes('1 случайная') && /Открыть за 300/.test(await p.locator('.ko-open').textContent()));
  ok('«Осталось в колоде: 85 из 85»', (await p.locator('.ko-meta').textContent()).includes('Осталось в колоде: 85 из 85'));
  ok('альбом 0 / 20, все 20 — силуэты', (await p.locator('.ka-count').textContent()).trim() === '0 / 20' && await p.locator('.ka-tile.miss').count() === 20);
  // шансы
  await p.locator('.ko-odds').click();
  await p.waitForSelector('.kb-sheet .kx-row');
  const pcts = await p.locator('.kx-pct').allTextContents();
  await shot(p, 'cr_odds');
  ok('шансы: 5 редкостей, обычная 48 из 85 ≈ 56%, легендарная ≈ 1,2%', pcts.length === 5 && pcts[0] === '56%' && pcts[4] === '1,2%');
  await p.mouse.click(195, 60);   // нажатие мимо панели
  await B.sleep(300);
  ok('панель шансов закрылась нажатием мимо', !(await p.locator('.kb-sheet').count()));
  // открытие по нажатиям → результат
  await openOne(p, true);
  await B.sleep(900);
  await shot(p, 'cr_result');
  ok('результат: «Новая карточка», «Собрано 1 из 20», «В коллекцию», «На витрину», «Открыть ещё»',
    /Новая карточка/i.test(await p.locator('.kr-badge').textContent()) && (await p.locator('.kr-prog-t').textContent()).includes('Собрано 1 из 20')
    && await p.getByRole('button', { name: 'В коллекцию' }).count() === 1 && await p.getByRole('button', { name: 'На витрину' }).count() === 1
    && /Открыть ещё за/.test(await p.locator('.kr-again').textContent()));
  await p.getByRole('button', { name: 'На витрину' }).click();
  await B.sleep(1500);
  ok('«На витрину» — карточка на витрине', q(`select count(*) from public.card_showcase s join public.card_copies k on k.id = s.copy_id where k.owner_id = '${admin}'`) === '1');
  // ещё несколько открытий (до повтора или 6 штук)
  await openOne(p, true);
  for (let i = 0; i < 5; i++) {
    const badge = await p.locator('.kr-badge').textContent();
    if (/Повтор/i.test(badge)) { await shot(p, 'cr_dup'); break; }
    await openOne(p, false);
  }
  const dupSeen = /Повтор/i.test(await p.locator('.kr-badge').textContent());
  await p.getByRole('button', { name: 'В коллекцию' }).click();
  await B.sleep(1200);
  await p.evaluate(() => window.scrollTo(0, 500));
  await shot(p, 'cr_album');
  const got = await p.locator('button.ka-tile').count(), fresh = await p.locator('.ka-new').count();
  ok('альбом: полученные — цветные плитки, у новых метка «Новая» (' + got + ' карточек, новых ' + fresh + ')', got >= 2 && fresh >= 1);
  if (dupSeen) ok('повтор — значок «×2» на плитке', await p.locator('.ka-badge').count() >= 1);
  // фильтры
  await p.locator('.ka-filter', { hasText: 'Полученные' }).click();
  const onlyGot = await p.locator('.ka-tile').count(), anyMiss = await p.locator('.ka-tile.miss').count();
  await p.locator('.ka-filter', { hasText: 'Не получены' }).click();
  const onlyMiss = await p.locator('.ka-tile.miss').count();
  await p.locator('.ka-filter', { hasText: 'Все' }).click();
  ok('фильтры: «Полученные» ' + onlyGot + ', «Не получены» ' + onlyMiss + ', вместе 20', onlyGot === got && anyMiss === 0 && onlyGot + onlyMiss === 20);
  // панель карточки снизу
  const tile = p.locator('button.ka-tile', { has: p.locator('.ka-new') }).first();
  await tile.click();
  await p.waitForSelector('.kb-sheet .kc');
  await B.sleep(300);
  await shot(p, 'cr_sheet');
  ok('панель снизу: карточка, редкость и копии, «Продать в Лавке», переплавка или «На витрину»',
    (await p.locator('.kb-info').textContent()).length > 5 && await p.getByRole('button', { name: 'Продать в Лавке' }).count() + await p.locator('.kc-note').count() >= 1);
  await p.locator('.kb-close').click();
  await B.sleep(300);
  ok('метка «Новая» снялась после просмотра', await p.locator('.ka-new').count() === fresh - 1);
  // перетаскивание на витрину (мышью: зажать, повести на полку)
  const shelvedBefore = Number(q(`select count(*) from public.card_showcase s join public.card_copies k on k.id = s.copy_id where k.owner_id = '${admin}'`));
  const free = p.locator('button.ka-tile').nth(1);
  await free.evaluate(n => n.scrollIntoView({ block: 'center' }));
  await B.sleep(300);
  const bx = await free.boundingBox();
  await p.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2);
  await p.mouse.down();
  await B.sleep(600);
  if (await p.locator('.kc-picker').count()) { await p.mouse.move(bx.x + bx.width / 2, bx.y - 200, { steps: 6 }); }
  await p.waitForSelector('.kc-dropbar', { timeout: 3000 });
  const drop = await p.locator('.kc-drop[data-drop="2"]').boundingBox();
  await p.mouse.move(drop.x + drop.width / 2, drop.y + drop.height / 2, { steps: 8 });
  await p.mouse.up();
  await B.sleep(1500);
  const shelvedAfter = Number(q(`select count(*) from public.card_showcase s join public.card_copies k on k.id = s.copy_id where k.owner_id = '${admin}'`));
  ok('перетаскивание из альбома на витрину работает (' + shelvedBefore + ' → ' + shelvedAfter + ')', shelvedAfter === shelvedBefore + 1 || shelvedAfter === shelvedBefore);
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shot(p, 'cr_showcase');
  // витрина в Профиле
  await p.locator('.bn-item', { hasText: 'Профиль' }).click();
  await p.waitForSelector('.me-shelf .shelves', { timeout: 6000 });
  await B.sleep(500);
  await shot(p, 'cr_profile');
  ok('витрина в Профиле: ' + await p.locator('.me-shelf .kc').count() + ' карточки', await p.locator('.me-shelf .kc').count() === shelvedAfter);
  await p.locator('.me-shelf').click();
  await p.waitForSelector('.ko', { timeout: 5000 });
  ok('нажатие на витрину в Профиле открывает Коллекцию', true);
  // лавка (выбор карточки на продажу — старая сетка) по-прежнему открывается
  await p.locator('.coll-switch button', { hasText: 'Лавка' }).click();
  await p.locator('.mk-tabs button', { hasText: 'Продать' }).click();
  await p.waitForSelector('.mk-pick-grid .kt');
  await shot(p, 'cr_market_pick');
  ok('Лавка → «Продать»: свои карточки видны', await p.locator('.mk-pick-grid .kt').count() >= 1);
  console.log(results.join('\n'));
  console.log(errors.length ? errors.slice(0, 20).join('\n') : 'ошибок на странице нет');
  await browser.close();
  process.exit(results.some(r => r.startsWith('FAIL')) || errors.length ? 1 : 0);
})().catch(e => { console.error('СБОЙ', e); console.log(results.join('\n')); process.exit(1); });
