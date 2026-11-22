// «Наблюдать» в картах, «Участники» в Профиле (5,5 строки), цена «Выбора» в «Своём вопросе».
//  Дурак: двое играют (ходы — прямо в базе), третий в браузере видит «Наблюдать», смотрит стол (без своих карт,
//    над столом «наблюдаешь» и «К комнатам»), игра идёт — ошибок нет; второй вышел — «ИГРА ОКОНЧЕНА» без «Ещё раз».
//  Верю — не верю: шестеро играют, седьмой наблюдает (внизу — первый игрок, в круге — пятеро), ходы идут; итог без «Ещё раз».
//  Покер: двое за столом — у третьего «Наблюдать» рядом с «Сесть», за столом «Ты наблюдаешь», карт игроков не видно.
//  Профиль: таблица «Участники» — видно 5 строк и половину шестой, прокручивается.
//  «Свой вопрос»: у «Выбора» кнопка «Предложить за 50», у Вопроса — «за 100».
//   DB=wt node watch.js         (WIDTH / HEIGHT — размер телефона; если участников меньше 7 — добавит недостающих)
// Нужно: база с миграциями 08_watch.sql (Дурак) и 03_watch.sql (Верю — не верю) — строка в README; DB=wt node server.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const DB = process.env.DB || 'wt';
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql]).toString().trim();
// вызвать функцию базы от имени участника
const rpc = (u, call) => q(`select set_config('request.jwt.claims', '{"sub":"${u}","role":"authenticated"}', true); select ${call};`).split('\n').pop();
const view = (fn, id, u) => JSON.parse(rpc(u, `public.${fn}(${id})`));
let fails = 0;
const ok = (cond, text) => { console.log((cond ? '✓ ' : '✗ ') + text); if (!cond) fails++; };
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (await fn()) return true; await B.sleep(200); } return false; };

// Дурак: сходить за того, чей ход (первая подходящая карта, иначе забрать стопку, иначе открыть закрытую)
function durakStep(room, ids) {
  for (const u of ids) {
    const v = view('durak_view', room, u);
    if (v.status !== 'play' || !v.my || !v.my.turn) continue;
    if (v.my.playable.length) rpc(u, `public.durak_play(${room}, array[${v.my.playable[0]}])`);
    else if (v.my.can_take) rpc(u, `public.durak_take(${room})`);
    else rpc(u, `public.durak_flip(${room}, ${1 + v.players.find((p) => p.me).closed.indexOf(true)})`);
    return true;
  }
  return false;
}
// Верю — не верю: новый круг — одна карта своего номинала; ответ — по очереди «Верю» / «Не верю»
let bfK = 0;
function bluffStep(room, ids) {
  for (const u of ids) {
    const v = view('bluff_view', room, u);
    if (v.status !== 'play' || !v.my || !v.my.turn) continue;
    const c = v.my.hand[0];
    if (v.my.new_round) rpc(u, `public.bluff_put(${room}, array[${c}], ${c >= 52 ? v.low : Math.floor(c / 4) + 2})`);
    else if (v.my.can_call) rpc(u, `public.bluff_call(${room}, '${bfK++ % 2 ? 'doubt' : 'trust'}')`);
    else rpc(u, `public.bluff_put(${room}, array[${c}])`);
    return true;
  }
  return false;
}

(async () => {
  const browser = await B.launch(), errors = [];
  // нужно 7 участников без админа (шестеро за столом «Верю — не верю» и наблюдатель)
  q(`insert into public.profiles (id, display_name, color) select gen_random_uuid(), 'Игрок ' || g, '#4C95F5'
       from generate_series(1, greatest(0, 7 - (select count(*) from public.profiles p where not exists (select 1 from public.admins a where a.user_id = p.id)))) g`);
  q(`insert into public.points_ledger (user_id, amount, reason, ref) select p.id, 1000, 'game', 'test:watch' from public.profiles p
       where not exists (select 1 from public.points_ledger l where l.user_id = p.id)`);
  const ids = q(`select string_agg(id::text, ',' order by created_at) from public.profiles p
                  where not exists (select 1 from public.admins a where a.user_id = p.id)`).split(',');
  ok(ids.length >= 7, 'участников без админа: ' + ids.length);
  const watcher = ids[ids.length - 1];
  const w0 = Number(q(`select public.coins_of('${watcher}')`));
  const W = await B.phone(browser, watcher, errors, { tag: 'наблюдатель' });

  // ===== Дурак =====
  const d = Number(rpc(ids[0], 'public.durak_create(10)'));
  rpc(ids[1], `public.durak_join(${d})`);
  rpc(ids[0], `public.durak_start(${d})`); rpc(ids[0], `public.durak_ready(${d})`); rpc(ids[1], `public.durak_ready(${d})`);
  for (const u of ids.slice(0, 2)) {
    const v = view('durak_view', d, u);
    rpc(u, `public.durak_choose(${d}, array[${v.my.pick.slice(0, 3).join(',')}])`);
  }
  await B.openDurak(W);
  const dRow = W.locator('.duel-row', { hasText: 'Идёт игра' });
  ok(await waitFor(async () => (await dRow.count()) > 0), 'Дурак: в списке — «Идёт игра»');
  ok(await dRow.getByRole('button', { name: 'Наблюдать' }).count() === 1, 'Дурак: кнопка «Наблюдать»');
  await shot(W, 'watch-durak-list');
  await dRow.getByRole('button', { name: 'Наблюдать' }).click();
  ok(await waitFor(async () => (await W.locator('.dk-table').count()) > 0), 'Дурак: стол открылся');
  ok(/наблюдаешь/.test(await W.locator('.dk-bank').textContent()), 'Дурак: над столом «наблюдаешь»');
  ok(await W.locator('.dk-quit', { hasText: 'К комнатам' }).count() === 1, 'Дурак: «К комнатам» вместо «Выйти»');
  ok(await W.locator('.dk-me').count() === 0 && await W.locator('.dk-watch .dk-opp').count() === 1 && await W.locator('.dk-ring .dk-opp').count() === 1,
    'Дурак: своей рамки нет, внизу — первый игрок, в круге — второй');
  ok(await W.locator('.dk-hand').count() === 0 && await W.locator('button.dk-card').count() === 0, 'Дурак: карт в руке не видно, нажимать нечего');
  await shot(W, 'watch-durak-table');
  for (let i = 0; i < 6; i++) { durakStep(d, ids.slice(0, 2)); await B.sleep(1800); }
  ok(await W.locator('.dk-table').count() === 1, 'Дурак: 6 ходов — стол на месте');
  await shot(W, 'watch-durak-moves');
  rpc(ids[1], `public.durak_leave(${d})`);
  ok(await waitFor(async () => (await W.locator('.dk-result').count()) > 0), 'Дурак: второй вышел — итог');
  ok(/ИГРА ОКОНЧЕНА/.test(await W.locator('.dk-result .duel-title').textContent()) && await W.getByRole('button', { name: /Ещё раз/ }).count() === 0,
    'Дурак: «ИГРА ОКОНЧЕНА», без «Ещё раз»');
  await shot(W, 'watch-durak-result');
  await W.getByRole('button', { name: 'К комнатам' }).click();

  // ===== Верю — не верю: шестеро играют =====
  const five = ids.slice(0, 6);
  const b = Number(rpc(five[0], 'public.bluff_create(10, 6, 2)'));
  five.slice(1).forEach((u) => rpc(u, `public.bluff_join(${b})`));
  rpc(five[0], `public.bluff_start(${b})`);
  five.slice(1).forEach((u) => rpc(u, `public.bluff_ready(${b})`));
  await B.openBluff(W);
  const bRow = W.locator('.duel-row', { hasText: 'Идёт игра' });
  ok(await waitFor(async () => (await bRow.count()) > 0), 'Верю: в списке — «Идёт игра»');
  ok(/^6 игроков/.test(await bRow.locator('.duel-line').textContent()), 'Верю: в строке — ' + (await bRow.locator('.duel-line').textContent()));
  await shot(W, 'watch-bluff-list');
  await bRow.getByRole('button', { name: 'Наблюдать' }).click();
  ok(await waitFor(async () => (await W.locator('.bf-table').count()) > 0), 'Верю: стол открылся');
  ok(await W.locator('.dk-me').count() === 0 && await W.locator('.dk-watch .dk-opp').count() === 1 && await W.locator('.dk-ring .dk-opp').count() === five.length - 1,
    'Верю: внизу — первый игрок, в круге — остальные ' + (five.length - 1));
  for (let i = 0; i < 5; i++) { bluffStep(b, five); await B.sleep(2200); }
  ok(await W.locator('.bf-table').count() === 1, 'Верю: 5 ходов — стол на месте');
  await shot(W, 'watch-bluff-table');
  five.slice(1).forEach((u) => { try { rpc(u, `public.bluff_leave(${b})`); } catch (e) { /* уже вне игры */ } });
  ok(await waitFor(async () => (await W.locator('.dk-result').count()) > 0, 12000), 'Верю: все вышли — итог');
  ok(/ИГРА ОКОНЧЕНА/.test(await W.locator('.dk-result .duel-title').textContent()) && await W.getByRole('button', { name: /Ещё раз/ }).count() === 0,
    'Верю: «ИГРА ОКОНЧЕНА», без «Ещё раз»');
  await W.getByRole('button', { name: 'К комнатам' }).click();

  // ===== Покер: двое за столом =====
  const bb = Number(q('select bb from public.poker_level(1)'));
  const t = Number(rpc(ids[0], `public.poker_create(1, ${50 * bb})`));
  rpc(ids[1], `public.poker_sit(${t}, ${50 * bb})`);
  await B.openPoker(W);
  const tRow = W.locator('.duel-row').filter({ has: W.getByRole('button', { name: 'Наблюдать' }) });
  ok(await waitFor(async () => (await tRow.count()) > 0), 'Покер: у стола с двумя игроками — «Наблюдать»');
  ok(await tRow.getByRole('button', { name: 'Сесть' }).count() === 1, 'Покер: и «Сесть» рядом');
  await shot(W, 'watch-poker-list');
  await tRow.getByRole('button', { name: 'Наблюдать' }).click();
  ok(await waitFor(async () => (await W.locator('.pk-table').count()) > 0), 'Покер: стол открылся');
  ok(await waitFor(async () => /Ты наблюдаешь/.test(await W.locator('.pk-out').textContent().catch(() => ''))), 'Покер: «Ты наблюдаешь»');
  ok(await W.locator('.dk-quit', { hasText: 'К столам' }).count() === 1, 'Покер: «К столам» над столом');
  ok(await waitFor(async () => (await W.locator('.pk-ring .pk-opp').count()) === 2), 'Покер: в круге оба игрока');
  const faces = await W.locator('.pk-ring .dk-card:not(.back):not(.blank)').count();
  const board = await W.locator('.pk-board .dk-card:not(.back):not(.blank)').count().catch(() => 0);
  ok(faces - board === 0, 'Покер: карт игроков не видно (открытых карт у игроков: ' + (faces - board) + ')');
  await shot(W, 'watch-poker-table');
  rpc(ids[0], `public.poker_leave(${t})`); rpc(ids[1], `public.poker_leave(${t})`);
  await W.getByRole('button', { name: 'К столам' }).first().click();

  ok(Number(q(`select public.coins_of('${watcher}')`)) === w0, 'монеты наблюдателя не менялись');

  // ===== Профиль: «Участники» — 5,5 строки =====
  await W.locator('.bn-item', { hasText: 'Профиль' }).click();
  const wrap = W.locator('.members-wrap');
  await wrap.waitFor({ timeout: 8000 });
  await B.sleep(500);
  const m = await wrap.evaluate((el) => {
    const r = el.getBoundingClientRect(), rows = [...el.querySelectorAll('tbody tr')];
    const visible = rows.map((tr) => { const b = tr.getBoundingClientRect(); return Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top)) / b.height; });
    return { n: rows.length, seen: visible.reduce((a, x) => a + x, 0), scroll: el.scrollHeight > el.clientHeight };
  });
  ok(m.n <= 5 || (m.scroll && Math.abs(m.seen - 5.5) < 0.25), 'Участники: строк ' + m.n + ', видно ' + m.seen.toFixed(2) + ', прокрутка ' + m.scroll);
  await wrap.scrollIntoViewIfNeeded();
  await shot(W, 'watch-members');
  await wrap.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await B.sleep(200);
  const headTop = await W.locator('.members-wrap thead th').first().evaluate((th) => th.getBoundingClientRect().top - th.closest('.members-wrap').getBoundingClientRect().top);
  ok(Math.abs(headTop) < 6, 'Участники: прокрутил вниз — шапка осталась сверху');
  await shot(W, 'watch-members-scrolled');

  // ===== «Свой вопрос»: цена по виду =====
  await W.locator('.bn-item', { hasText: 'Вопрос' }).click();
  await W.waitForSelector('.sug-btn');
  await W.locator('.sug-btn').first().click();
  await W.waitForSelector('#sug-form .segment button');
  await W.locator('#sug-form .segment button', { hasText: 'Выбор' }).click();
  ok(await waitFor(async () => (await W.getByRole('button', { name: /Предложить за 50/ }).count()) > 0), '«Свой вопрос» → Выбор: «Предложить за 50»');
  ok(/Не подошло — 50/.test(await W.locator('.sug-rules').textContent()), 'Выбор: «Не подошло — 50 🪙 вернутся»');
  await shot(W, 'watch-sug-poll');
  await W.locator('#sug-form .segment button', { hasText: 'Вопрос' }).click();
  ok(await waitFor(async () => (await W.getByRole('button', { name: /Предложить за 100/ }).count()) > 0), 'Вопрос: «Предложить за 100»');

  ok(errors.length === 0, 'ошибок на странице нет' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
  await browser.close();
  console.log(fails ? '\nЕСТЬ ОШИБКИ: ' + fails : '\nВСЁ ХОРОШО');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
