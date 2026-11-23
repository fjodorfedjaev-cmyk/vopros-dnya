// Сценарий «Паки» (23.11): колода «Начала» опустела — подарок-паки тем, кто открывал (1 карточка — 1 пак, не больше 3).
// Админ открывает последнюю карточку на сайте → «Серия закончилась», веер паков, «Забрать» → страница едет к плитке
// пака в альбоме (после легендарной, «×3», подсветка), на месте сундука — «Скоро новая коллекция»; окно пака (шансы как в полной колоде), открытие (упаковка рвётся,
// дальше по нажатиям), номер сверх тиража, «Открыть ещё пак», два быстрых нажатия, продажа пака в Лавке;
// друг без покупок — сразу «Скоро новая коллекция», покупает пак в Лавке и открывает; второй друг — свой подарок.
// База: ./db.sh pk cards-stub.sql profile-stub.sql ../../supabase/cards/01_cards.sql ../../supabase/market/01_market.sql \
//   ../../supabase/durak/0[1-7]*.sql ../../supabase/poker/0[1-4]*.sql ../../supabase/market/02_bids.sql \
//   ../../supabase/duels/01_duels.sql ../../supabase/members/02_member_profile.sql ../../supabase/cards/02_packs.sql
// Сервер: DB=pk node server.js &   Запуск: DB=pk node packs.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const DB = process.env.DB || 'pk';
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-c', sql]).toString().trim();
const as = (uid, sql) => q(`select set_config('request.jwt.claims', json_build_object('sub', '${uid}', 'role', 'authenticated')::text, false); ${sql}`);
const results = [];
const ok = (name, cond) => results.push((cond ? 'ok   ' : 'FAIL ') + name);
const ids = q(`select string_agg(id::text, ',' order by created_at, id) from public.profiles`).split(',');
const admin = q('select user_id from public.admins limit 1');
const [u2, u3] = ids.filter(x => x !== admin);
const dump = ids.filter(x => x !== admin && x !== u2 && x !== u3)[0];
const packId = q(`select id from public.cards where rarity = 'pack'`);

// до конца раскрыть карточку: нажимать на сцену, пока не появится результат
async function tapThrough(p) {
  await p.waitForSelector('.kr-stage:not(.kr-wait)', { timeout: 8000 });
  for (let i = 0; i < 10 && !(await p.locator('.kr-result.on').count()); i++) { await p.locator('.kr-stage').click(); await B.sleep(300); }
  await p.waitForSelector('.kr-result.on', { timeout: 5000 });
}
async function toColl(p) {
  await p.locator('.bn-item', { hasText: 'Коллекция' }).click();
  if (await p.locator('.coll-switch button', { hasText: 'Коллекция' }).getAttribute('aria-pressed') !== 'true') await p.locator('.coll-switch button', { hasText: 'Коллекция' }).click();
  await p.waitForSelector('.ko', { timeout: 8000 });
  await B.sleep(400);
}

(async () => {
  // монеты всем; админ — 2 карточки, u2 — 5, остаток колоды (кроме одной) уходит участнику без покупок
  q(`insert into public.points_ledger (user_id, amount, reason, ref) select id, 5000, 'game', 'test:packs' from public.profiles`);
  for (let i = 0; i < 2; i++) as(admin, `select copy_id from public.cards_open(1, public.cards_price(1))`);
  for (let i = 0; i < 5; i++) as(u2, `select copy_id from public.cards_open(1, public.cards_price(1))`);
  q(`update public.card_copies set state = 'owned', owner_id = '${dump}', obtained_at = now()
      where state = 'deck' and id <> (select id from public.card_copies where state = 'deck' order by id limit 1)`);

  const browser = await B.launch(), errors = [];
  const p = await B.phone(browser, admin, errors, { tag: 'админ' });
  await toColl(p);
  ok('в колоде 1 из 85', (await p.locator('.ko-meta').textContent()).includes('Осталось в колоде: 1 из 85'));
  // последняя карточка — на сайте
  await p.locator('.ko-open').click();
  await tapThrough(p);
  ok('после последней: «Колода закончилась» вместо «Открыть ещё»', /Колода закончилась/.test(await p.locator('.kr-again').textContent()));
  await p.getByRole('button', { name: 'В коллекцию' }).click();
  await B.sleep(1200);
  await shot(p, 'pk_gift');
  ok('подарок: «Серия «Начало» закончилась», «3 пака», «Забрать», веер из 3 паков',
    (await p.locator('.ko-gift .ko-title').textContent()).includes('Серия «Начало» закончилась')
    && (await p.locator('.ko-gift-n').textContent()).trim() === '3 пака'
    && await p.locator('.ko-gift .ko-open').textContent() === 'Забрать' && await p.locator('.ko-fan .kpk').count() === 3);
  ok('до «Забрать» плитки пака в альбоме нет, внизу подарка нет строки «1 пак за каждую…»', !(await p.locator('.ka-tile.r-pack').count())
    && !(await p.locator('.ko-gift').textContent()).includes('за каждую'));
  // «Забрать» — два быстрых нажатия: паков всё равно 3
  await p.locator('.ko-gift .ko-open').dblclick();
  await B.sleep(1300);
  const pt = p.locator('.ka-tile.r-pack');
  const arrive = await pt.evaluate(n => n.classList.contains('ka-arrive')).catch(() => false);
  await B.sleep(700);
  await shot(p, 'pk_claimed');
  const inView = await pt.evaluate(n => { const r = n.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }).catch(() => false);
  ok('«Забрать»: в базе ровно 3 пака, плитка пака «×3» в альбоме', (await pt.locator('.ka-badge').textContent()).trim() === '×3'
    && q(`select count(*) from public.card_copies where card_id = ${packId} and owner_id = '${admin}' and state = 'owned'`) === '3');
  ok('страница доехала до плитки пака, плитка подсвечена', inView && arrive);
  ok('плитка пака — последняя, после легендарной: «Пак», «Новые»; «X / 20», плиток 21; блока «Мои паки» нет',
    await p.locator('.ka-tile').count() === 21 && await p.locator('.ka-tile').last().evaluate(n => n.classList.contains('r-pack'))
    && (await pt.locator('.ka-rar').textContent()).includes('Пак') && (await pt.locator('.ka-new').textContent()) === 'Новые'
    && / \/ 20$/.test((await p.locator('.ka-count').textContent()).trim()) && !(await p.locator('.kp').count()));
  ok('на месте сундука — «Скоро новая коллекция» без строки «…разошлись»', (await p.locator('.ko-soon .ko-title').textContent()).includes('Скоро новая коллекция')
    && !(await p.locator('.ko-soon').textContent()).includes('разошлись') && !(await p.locator('.ko-gift').count()) && !(await p.locator('.ko-open').count()));
  // окно пака: шансы как в полной колоде
  await pt.click();
  await p.waitForSelector('.kb-sheet .kpk');
  await B.sleep(400);
  const pcts = await p.locator('.kb-sheet .kx-pct').allTextContents();
  const lefts = await p.locator('.kb-sheet .kx-left').allTextContents();
  await shot(p, 'pk_sheet');
  ok('окно пака: 5 редкостей, обычные 48 из 85 = 56%, легендарная 1 из 85 = 1,2%', pcts.length === 5 && pcts[0] === '56%' && pcts[4] === '1,2%' && lefts[0] === '48 из 85' && lefts[4] === '1 из 85');
  ok('окно пака: «Открыть пак», «Продать в Лавке», «у тебя 3»', await p.locator('.kb-sheet').getByRole('button', { name: 'Открыть пак' }).count() === 1
    && await p.locator('.kb-sheet').getByRole('button', { name: 'Продать в Лавке' }).count() === 1 && (await p.locator('.kb-sheet .kb-info').textContent()).includes('у тебя 3'));
  await p.mouse.click(195, 40);
  await B.sleep(300);
  ok('окно пака закрылось нажатием мимо, метка «Новые» снята', !(await p.locator('.kb-sheet').count()) && !(await pt.locator('.ka-new').count()));

  // открыть пак: упаковка → рвётся → рубашка → по нажатиям → результат
  await pt.click();
  await p.waitForSelector('.kb-sheet .kpk');
  await p.locator('.kb-sheet').getByRole('button', { name: 'Открыть пак' }).click();
  await p.waitForSelector('.kr-stage:not(.kr-wait)', { timeout: 8000 });
  await B.sleep(300);
  await shot(p, 'pk_open_0');
  ok('открытие: сначала пак поверх рубашки', await p.locator('.kr-cover').count() === 1);
  await p.locator('.kr-stage').click();
  await B.sleep(220);
  await shot(p, 'pk_open_tear');
  await B.sleep(600);
  ok('первое нажатие — упаковка порвалась и исчезла, под ней рубашка', !(await p.locator('.kr-cover').count()) && await p.locator('.kr-back .kc-back').count() === 1);
  await tapThrough(p);
  await B.sleep(800);
  await shot(p, 'pk_result');
  const sub = await p.locator('.kr-result .kr-sub').first().textContent();
  const no = await p.locator('.kr-front .kc-no').textContent();
  ok('результат: «из пака · №7/6, сверх тиража» (номер сверх тиража) — ' + sub.trim(), /из пака · №\d+\/\d+, сверх тиража/.test(sub) && /^№\d+\/\d+$/.test(no)
    && Number(no.slice(1).split('/')[0]) > Number(no.split('/')[1]));
  ok('«Открыть ещё пак · осталось 2»', (await p.locator('.kr-again').textContent()).includes('Открыть ещё пак · осталось 2'));
  await p.locator('.kr-again').click();
  await tapThrough(p);
  ok('второй пак открыт, паков больше не 2 → 1: «осталось 1»', (await p.locator('.kr-again').textContent()).includes('осталось 1'));
  await p.getByRole('button', { name: 'В коллекцию' }).click();
  await B.sleep(1200);
  ok('остался 1 пак: плитка без «×N», в базе 2 открыто', await pt.count() === 1 && !(await pt.locator('.ka-badge').count())
    && q(`select count(*) from public.card_events where kind = 'unpack' and from_user = '${admin}'`) === '2');

  // последний пак — в Лавку за 150
  await pt.click();
  await p.waitForSelector('.kb-sheet .kpk');
  await p.locator('.kb-sheet').getByRole('button', { name: 'Продать в Лавке' }).click();
  await p.waitForSelector('#mk-p');
  await shot(p, 'pk_sell');
  ok('продажа пака: без выбора номера, «Паков у тебя: 1», «Это твой последний пак.»', !(await p.locator('.kc-copies').count())
    && (await p.locator('.kb-sheet .kb-info').textContent()).includes('Паков у тебя: 1') && (await p.locator('.kb-sheet').textContent()).includes('Это твой последний пак.'));
  await p.locator('#mk-p').fill('150');
  await p.locator('.kb-sheet .btn.primary').click();
  await B.sleep(1500);
  ok('пак выставлен за 150, плитка пака из альбома исчезла', q(`select count(*) from public.card_listings l join public.card_copies k on k.id = l.copy_id where k.card_id = ${packId} and l.status = 'active' and l.price = 150`) === '1'
    && !(await pt.count()));
  // витрина и профиль: «Собрано X из 20»
  await p.locator('.bn-item', { hasText: 'Профиль' }).click();
  await B.sleep(1200);
  const prof = await p.locator('.me-shelf-n').textContent().catch(() => '');
  ok('Профиль: «Собрано X из 20» — ' + prof, / из 20$/.test(prof));

  // друг без покупок: сразу «Скоро новая коллекция»; в Лавке покупает пак и открывает
  const f = await B.phone(browser, u3, errors, { tag: 'друг' });
  await toColl(f);
  await shot(f, 'pk_friend_soon');
  ok('друг без покупок: сразу «Скоро новая коллекция», подарка нет', await f.locator('.ko-soon').count() === 1 && !(await f.locator('.ko-gift').count()));
  await f.locator('.coll-switch button', { hasText: 'Лавка' }).click();
  await f.waitForSelector('.mk-tl', { timeout: 8000 });
  await B.sleep(400);
  await shot(f, 'pk_market');
  const tile = f.locator('.mk-tl.r-pack');
  ok('Рынок: плитка пака переливом, «1» в продаже, 150', await tile.count() === 1 && (await tile.locator('.mk-tl-n').textContent()) === '1'
    && (await tile.locator('.mk-tl-price').textContent()).includes('150'));
  await tile.click();
  await f.waitForSelector('.mk-sheet');
  await shot(f, 'pk_market_card');
  ok('страница пака: «Начало · 1 случайная карточка»', (await f.locator('.mk-sheet .mk-sub').textContent()).includes('1 случайная карточка'));
  const buy = f.locator('.mk-sheet .btn.primary').first();
  await buy.click(); await B.sleep(200); await buy.click();
  await B.sleep(1600);
  ok('друг купил пак', q(`select count(*) from public.card_copies where card_id = ${packId} and owner_id = '${u3}' and state = 'owned'`) === '1');
  await f.locator('.coll-switch button', { hasText: 'Коллекция' }).click();
  await B.sleep(600);
  ok('у друга в альбоме плитка пака', await f.locator('.ka-tile.r-pack').count() === 1);
  // два быстрых нажатия «Открыть пак» — открывается один раз
  await f.locator('.ka-tile.r-pack').click();
  await f.waitForSelector('.kb-sheet .kpk');
  await f.locator('.kb-sheet').getByRole('button', { name: 'Открыть пак' }).dblclick();
  await tapThrough(f);
  ok('друг открыл пак: «Новая карточка», «Собрано 1 из 20», без «Открыть ещё»', /Новая карточка/i.test(await f.locator('.kr-badge').textContent())
    && (await f.locator('.kr-prog-t').textContent()).includes('Собрано 1 из 20') && !(await f.locator('.kr-again').count())
    && q(`select count(*) from public.card_events where kind = 'unpack' and from_user = '${u3}'`) === '1');
  await f.getByRole('button', { name: 'На витрину' }).click();
  await B.sleep(1500);
  ok('карточку из пака можно поставить на витрину', q(`select count(*) from public.card_showcase where user_id = '${u3}'`) === '1');

  // второй друг: свой подарок — 3 пака (открыл 5)
  const g = await B.phone(browser, u2, errors, { tag: 'друг2', width: 360, height: 740 });
  await toColl(g);
  await shot(g, 'pk_friend2_gift');
  ok('друг2 (открыл 5): подарок «3 пака»', (await g.locator('.ko-gift-n').textContent()).trim() === '3 пака');

  await browser.close();
  console.log(results.join('\n'));
  console.log(errors.length ? 'ОШИБКИ СТРАНИЦ:\n' + errors.join('\n') : 'ошибок на страницах нет');
  process.exit(results.some(r => r.startsWith('FAIL')) || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
