// «Коллекция», правки 26.11: у «Лавки» на переключателе нет цифры; две копии одной карточки рядом на витрине;
// на витрине (в Коллекции и в Профиле) — номер копии; предупреждение переплавки пропадает от нажатия в любое другое место;
// рубашка с «?» в блоке открытия не начинает движение заново, когда нажимаешь кнопки (экран перерисовывается).
// База — как для «Коллекции» (README, база coll), сервер — DB=coll node server.js.
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const DB = process.env.DB || 'coll';
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-c', sql]).toString().trim();
const rpc = (u, call) => q(`select set_config('request.jwt.claims', '{"sub":"${u}","role":"authenticated"}', true); select ${call};`).split('\n').pop();
let fails = 0;
const ok = (cond, text) => { console.log((cond ? '✓ ' : '✗ ') + text); if (!cond) fails++; };
const give = (u, code, n) => q(`update public.card_copies k set state = 'owned', owner_id = '${u}', obtained_at = now()
  where k.id in (select x.id from public.card_copies x join public.cards c on c.id = x.card_id
                 where c.code = '${code}' and x.state = 'deck' order by x.serial limit ${n})`);

(async () => {
  const admin = q('select user_id from public.admins limit 1');
  const friend = q(`select id from public.profiles where id <> '${admin}' order by created_at limit 1`);
  q(`delete from public.card_showcase`);
  give(admin, 'coin', 2); give(admin, 'fire', 1); give(admin, 'rocket', 1);
  give(friend, 'ball', 1);
  const fcopy = q(`select k.id from public.card_copies k join public.cards c on c.id = k.card_id where c.code = 'ball' and k.owner_id = '${friend}' limit 1`);
  rpc(friend, `public.market_sell(${fcopy}, 50)`);
  ok(q(`select count(*) from public.card_listings where status = 'active'`) !== '0', 'у друга лот в Лавке (раньше у «Лавки» была бы цифра 1)');

  const browser = await B.launch(), errors = [];
  const p = await B.phone(browser, admin, errors, { tag: 'админ' });
  await p.locator('.bn-item', { hasText: 'Коллекция' }).click();
  await p.waitForSelector('.ko', { timeout: 8000 });
  await B.sleep(600);

  // 1. «Лавка» без цифры
  const sw = p.locator('.coll-switch button', { hasText: 'Лавка' });
  ok((await sw.locator('.seg-badge').count()) === 0 && (await sw.textContent()).trim() === 'Лавка', 'на кнопке «Лавка» нет цифры: «' + (await sw.textContent()).trim() + '»');
  await shot(p, 'cf_switch');

  // 2. рубашка с «?» продолжает движение после нажатия кнопки (фильтр альбома перерисовывает экран)
  const before = await p.evaluate(() => {
    const n = document.querySelector('.ko-pack'); const a = n.getAnimations()[0];
    return { y: n.getBoundingClientRect().y, t: a ? a.currentTime : null, now: document.timeline.currentTime };
  });
  await B.sleep(1300);
  await p.locator('.ka-filter', { hasText: 'Полученные' }).click();
  const after = await p.evaluate(() => {
    const n = document.querySelector('.ko-pack'); const a = n.getAnimations()[0];
    return { y: n.getBoundingClientRect().y, t: a ? a.currentTime : null, now: document.timeline.currentTime, same: n === window.__ko };
  });
  ok(after.t !== null && Math.abs(after.t - after.now) < 50 && after.t > 1200,
    'рубашка после перерисовки продолжает с того же места (время анимации ' + Math.round(after.t) + ' мс, а не с нуля)');
  await p.locator('.ka-filter', { hasText: 'Все' }).click();

  // 3. две копии «Монеты» рядом на витрине
  const coinTile = p.locator('button.ka-tile', { hasText: 'Монета' });
  await coinTile.click();
  await p.waitForSelector('.kb-sheet .kc');
  await p.getByRole('button', { name: 'На витрину' }).click();
  await B.sleep(1200);
  await coinTile.click();
  await p.waitForSelector('.kb-sheet .kc-copies');
  await p.locator('.kc-chip', { hasText: '№2' }).click();
  await B.sleep(300);
  const btnText = await p.locator('.kb-sheet .kc-actions .btn').first().textContent();
  ok(btnText === 'На витрину', 'у второй копии — «На витрину» (а не «Убрать»): «' + btnText + '»');
  await p.getByRole('button', { name: 'На витрину' }).click();
  await B.sleep(1200);
  const rows = q(`select string_agg(c.code || '#' || k.serial, ',' order by s.slot) from public.card_showcase s join public.card_copies k on k.id = s.copy_id join public.cards c on c.id = k.card_id where s.user_id = '${admin}'`);
  ok(rows === 'coin#1,coin#2', 'в базе на витрине две «Монеты»: ' + rows);
  const nums = await p.locator('.kw .shelf .kc-no').allTextContents();
  ok(nums.join(',') === '№1/6,№2/6', 'на витрине у карточек номера: ' + nums.join(', '));
  await p.locator('.kw').scrollIntoViewIfNeeded();
  await shot(p, 'cf_shelf_two');
  // третья — «Огонёк», полная витрина — «сначала убери одну»
  await p.locator('button.ka-tile', { hasText: 'Огонёк' }).click();
  await p.waitForSelector('.kb-sheet .kc');
  await p.getByRole('button', { name: 'На витрину' }).click();
  await B.sleep(1200);
  await p.locator('button.ka-tile', { hasText: 'Ракета' }).click();
  await p.waitForSelector('.kb-sheet .kc');
  await p.getByRole('button', { name: 'На витрину' }).click();
  await B.sleep(500);
  ok(/Витрина полная/.test(await p.locator('.kb-sheet .msg').textContent()), 'четвёртая — «Витрина полная: сначала убери одну карточку»');
  await p.locator('.kb-close').click();
  await B.sleep(300);
  // номер виден и не налезает на рисунок
  const box = await p.evaluate(() => {
    const k = document.querySelector('.kw .shelf .kc'); const no = k.querySelector('.kc-no').getBoundingClientRect();
    const art = k.querySelector('.kc-mid .kc-art').getBoundingClientRect(); const r = k.getBoundingClientRect();
    return { inside: no.right <= r.right + 0.5 && no.top >= r.top, over: no.bottom > art.top + 2 && no.left < art.right && no.right > art.left, h: no.height };
  });
  ok(box.inside && !box.over && box.h > 6, 'номер в правом верхнем углу, на рисунок не налезает');

  // 4. перетаскивание: копия №2 «Монеты» с витрины меняется местами с «Огоньком» — обе «Монеты» остаются
  await p.locator('.kw').scrollIntoViewIfNeeded(); await B.sleep(300);
  const t1 = await p.locator('.kw .shelf').nth(1).boundingBox(), t2 = await p.locator('.kw .shelf').nth(2).boundingBox();
  await p.mouse.move(t1.x + t1.width / 2, t1.y + t1.height / 2); await p.mouse.down(); await B.sleep(500);
  await p.mouse.move(t2.x + t2.width / 2, t2.y + t2.height / 2, { steps: 8 }); await B.sleep(150); await p.mouse.up();
  await B.sleep(1500);
  const rows2 = q(`select string_agg(c.code || '#' || k.serial, ',' order by s.slot) from public.card_showcase s join public.card_copies k on k.id = s.copy_id join public.cards c on c.id = k.card_id where s.user_id = '${admin}'`);
  ok(rows2 === 'coin#1,fire#1,coin#2', 'перетаскивание поменяло местами, обе «Монеты» на витрине: ' + rows2);

  // 5. переплавка: предупреждение пропадает от нажатия в другое место
  await p.locator('button.ka-tile', { hasText: 'Ракета' }).click();
  await p.waitForSelector('.kb-sheet .kc-hold');
  await p.locator('.kc-hold').click();
  ok(await p.locator('.kc-warn').isVisible(), 'первое нажатие «Переплавить» — красное предупреждение');
  await shot(p, 'cf_melt_warn');
  await p.locator('.kb-sheet > .kc').click();          // по самой карточке
  await B.sleep(200);
  ok(!(await p.locator('.kc-warn').count()) && /Переплавить за/.test(await p.locator('.kc-hold').textContent()), 'нажатие по карточке — предупреждение пропало, кнопка снова «Переплавить за …»');
  await p.locator('.kc-hold').click();
  await p.locator('.kb-info').click();                // по подписи «Необычная · у тебя …»
  await B.sleep(200);
  ok(!(await p.locator('.kc-warn').count()), 'нажатие по подписи — тоже пропало');
  await p.locator('.kc-hold').click();
  await p.locator('.kc-warn').click();                // по самому предупреждению — остаётся
  await B.sleep(200);
  ok(await p.locator('.kc-warn').isVisible(), 'нажатие по самому предупреждению — оно остаётся');
  // удержание всё ещё работает (5 с)
  const hb = await p.locator('.kc-hold').boundingBox();
  await p.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await p.mouse.down(); await B.sleep(5400); await p.mouse.up();
  await B.sleep(1500);
  ok(q(`select count(*) from public.card_copies k join public.cards c on c.id = k.card_id where c.code = 'rocket' and k.owner_id = '${admin}' and k.state = 'melted'`) === '1', 'удержание 5 с после этого — переплавлено');

  // 6. витрина в Профиле — тоже с номерами
  await p.locator('.bn-item', { hasText: 'Профиль' }).click();
  await p.waitForSelector('.me-shelf .kc');
  await B.sleep(500);
  const pn = await p.locator('.me-shelf .kc-no').allTextContents();
  ok(pn.join(',') === '№1/6,№1/6,№2/6', 'в Профиле на витрине номера: ' + pn.join(', '));
  await p.locator('.me-shelf').scrollIntoViewIfNeeded();
  await shot(p, 'cf_profile');

  console.log(errors.length ? errors.slice(0, 20).join('\n') : 'ошибок на страницах нет');
  await browser.close();
  process.exit(fails || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
