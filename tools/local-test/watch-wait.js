// «Наблюдать» до начала игры (23.11): у комнаты, где ещё ждут игроков, рядом с «Войти» — «Наблюдать».
//  Дурак: наблюдатель видит комнату ожидания («Ты наблюдаешь», кто сидит, «Войти · 10», «К комнатам»; «Выйти» и «Начать» нет),
//    видит, как заходят другие; «Войти» прямо из наблюдения — стал игроком (−10), «Выйти» — ставка вернулась;
//    снова «Наблюдать» — игра началась, стол виден как у наблюдателя.
//  Верю — не верю: то же до начала (и «Играют от 3 человек»).
//  Покер: «Наблюдать» и у стола с одним игроком — «Ты наблюдаешь».
//   DB=wt node watch-wait.js   (база — как для watch.js плюс host/01_host.sql и bluff/04_last_cards.sql)
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const DB = process.env.DB || 'wt';
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql]).toString().trim();
const rpc = (u, call) => q(`select set_config('request.jwt.claims', '{"sub":"${u}","role":"authenticated"}', true); select ${call};`).split('\n').pop();
const view = (fn, id, u) => JSON.parse(rpc(u, `public.${fn}(${id})`));
let fails = 0;
const ok = (cond, text) => { console.log((cond ? '✓ ' : '✗ ') + text); if (!cond) fails++; };
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (await fn()) return true; await B.sleep(200); } return false; };

(async () => {
  const browser = await B.launch(), errors = [];
  q(`insert into public.profiles (id, display_name, color) select gen_random_uuid(), 'Игрок ' || g, '#4C95F5'
       from generate_series(1, greatest(0, 4 - (select count(*) from public.profiles p where not exists (select 1 from public.admins a where a.user_id = p.id)))) g`);
  q(`insert into public.points_ledger (user_id, amount, reason, ref) select p.id, 1000, 'game', 'test:wwait' from public.profiles p
       where not exists (select 1 from public.points_ledger l where l.user_id = p.id)`);
  const ids = q(`select string_agg(id::text, ',' order by created_at) from public.profiles p
                  where not exists (select 1 from public.admins a where a.user_id = p.id)`).split(',');
  const watcher = ids[ids.length - 1];
  const coins = () => Number(q(`select public.coins_of('${watcher}')`));
  const w0 = coins();
  const W = await B.phone(browser, watcher, errors, { tag: 'наблюдатель' });

  // ===== Дурак =====
  const d = Number(rpc(ids[0], 'public.durak_create(10)'));
  await B.openDurak(W);
  const dRow = W.locator('.duel-row').filter({ has: W.getByRole('button', { name: 'Наблюдать' }) });
  ok(await waitFor(async () => (await dRow.count()) > 0), 'Дурак: у комнаты, где ждут игроков, — «Наблюдать»');
  ok(await dRow.getByRole('button', { name: /Войти/ }).count() === 1 && await dRow.evaluate(n => n.classList.contains('two')), 'Дурак: и «Войти · 10» рядом, две кнопки в ряд');
  await shot(W, 'ww-durak-list');
  await dRow.getByRole('button', { name: 'Наблюдать' }).click();
  ok(await waitFor(async () => /Ждём игроков/.test(await W.locator('.duel-lobby').textContent().catch(() => ''))), 'Дурак: комната ожидания — «Ждём игроков»');
  const lobby = W.locator('.duel-lobby');
  ok(/Ты наблюдаешь/.test(await lobby.textContent()) && await lobby.getByRole('button', { name: /Войти · 10/ }).count() === 1
    && await lobby.getByRole('button', { name: 'К комнатам' }).count() === 1 && await lobby.getByRole('button', { name: /Выйти/ }).count() === 0
    && await lobby.getByRole('button', { name: 'Начать' }).count() === 0, 'Дурак: «Ты наблюдаешь», «Войти · 10», «К комнатам»; «Выйти» и «Начать» нет');
  ok(coins() === w0, 'Дурак: наблюдение монет не стоит');
  await shot(W, 'ww-durak-wait');
  rpc(ids[1], `public.durak_join(${d})`);
  ok(await waitFor(async () => /В комнате 2 из 5/.test(await lobby.textContent().catch(() => ''))), 'Дурак: зашёл второй — наблюдатель видит «В комнате 2 из 5»');
  await lobby.getByRole('button', { name: /Войти · 10/ }).click();
  ok(await waitFor(async () => (await W.getByRole('button', { name: /Выйти — ставка вернётся/ }).count()) === 1), 'Дурак: «Войти» из наблюдения — теперь игрок («Выйти — ставка вернётся»)');
  ok(await waitFor(async () => coins() === w0 - 10), 'Дурак: ставка 10 списана');
  await W.getByRole('button', { name: /Выйти — ставка вернётся/ }).click();
  ok(await waitFor(async () => coins() === w0), 'Дурак: вышел — ставка вернулась');
  await W.waitForSelector('.duel-row', { timeout: 8000 });
  await W.locator('.duel-row').filter({ has: W.getByRole('button', { name: 'Наблюдать' }) }).getByRole('button', { name: 'Наблюдать' }).click();
  await waitFor(async () => (await W.locator('.duel-lobby').count()) > 0);
  rpc(ids[0], `public.durak_start(${d})`); rpc(ids[0], `public.durak_ready(${d})`); rpc(ids[1], `public.durak_ready(${d})`);
  for (const u of ids.slice(0, 2)) { const v = view('durak_view', d, u); rpc(u, `public.durak_choose(${d}, array[${v.my.pick.slice(0, 3).join(',')}])`); }
  ok(await waitFor(async () => (await W.locator('.dk-table').count()) > 0, 10000), 'Дурак: игра началась — наблюдатель видит стол');
  ok(/наблюдаешь/.test(await W.locator('.dk-bank').textContent()), 'Дурак: над столом «наблюдаешь»');
  await shot(W, 'ww-durak-table');
  rpc(ids[1], `public.durak_leave(${d})`);
  await waitFor(async () => (await W.locator('.dk-result').count()) > 0);
  await W.getByRole('button', { name: 'К комнатам' }).first().click();

  // ===== Верю — не верю =====
  const b = Number(rpc(ids[0], 'public.bluff_create(10, 6, 2)'));
  await B.openBluff(W);
  const bRow = W.locator('.duel-row').filter({ has: W.getByRole('button', { name: 'Наблюдать' }) });
  ok(await waitFor(async () => (await bRow.count()) > 0), 'Верю: у комнаты, где ждут игроков, — «Наблюдать»');
  ok(await bRow.getByRole('button', { name: /Войти/ }).count() === 1, 'Верю: и «Войти · 10» рядом');
  await shot(W, 'ww-bluff-list');
  await bRow.getByRole('button', { name: 'Наблюдать' }).click();
  ok(await waitFor(async () => /Ждём игроков/.test(await W.locator('.duel-lobby').textContent().catch(() => ''))), 'Верю: комната ожидания');
  const bl = W.locator('.duel-lobby');
  ok(/Ты наблюдаешь/.test(await bl.textContent()) && /Играют от 3 человек/.test(await bl.textContent())
    && await bl.getByRole('button', { name: /Войти · 10/ }).count() === 1 && await bl.getByRole('button', { name: 'К комнатам' }).count() === 1
    && await bl.getByRole('button', { name: /Выйти/ }).count() === 0, 'Верю: «Ты наблюдаешь», «Войти · 10», «К комнатам», без «Выйти»');
  await shot(W, 'ww-bluff-wait');
  await bl.getByRole('button', { name: 'К комнатам' }).click();
  rpc(ids[0], `public.bluff_leave(${b})`);

  // ===== Покер: один за столом =====
  const bb = Number(q('select bb from public.poker_level(1)'));
  const t = Number(rpc(ids[2], `public.poker_create(1, ${50 * bb})`));
  await B.openPoker(W);
  const tRow = W.locator('.duel-row').filter({ has: W.getByRole('button', { name: 'Наблюдать' }) });
  ok(await waitFor(async () => (await tRow.count()) > 0), 'Покер: у стола с одним игроком — «Наблюдать»');
  await tRow.getByRole('button', { name: 'Наблюдать' }).click();
  ok(await waitFor(async () => /Ты наблюдаешь/.test(await W.locator('.pk-out').textContent().catch(() => ''))), 'Покер: «Ты наблюдаешь»');
  await shot(W, 'ww-poker');
  rpc(ids[2], `public.poker_leave(${t})`);

  ok(coins() === w0, 'монеты наблюдателя в итоге те же');
  await browser.close();
  console.log(errors.length ? 'ОШИБКИ СТРАНИЦ:\n' + errors.join('\n') : 'ошибок на страницах нет');
  process.exit(fails || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
