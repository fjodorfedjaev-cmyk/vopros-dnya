// «3 минуты» (23.11, rooms/01_start_3min.sql): комната, где игра не началась за 3 минуты, закрывается, ставки возвращаются.
//  Дурак: двое в комнате — «Закроется через 2:5x, если игра не начнётся», отсчёт идёт; «прошло» почти 3 минуты —
//    «Комната закрыта», «За 3 минуты игра не началась — ставки вернулись», монеты как были; в правилах — строка про 3 минуты.
//  Верю — не верю: двое (играют от трёх) — тот же отсчёт и то же закрытие.
//   DB=wt node rooms-3min.js   (база — как для watch-wait.js плюс rooms/01_start_3min.sql)
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const DB = process.env.DB || 'wt';
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql]).toString().trim();
const rpc = (u, call) => q(`select set_config('request.jwt.claims', '{"sub":"${u}","role":"authenticated"}', true); select ${call};`).split('\n').pop();
let fails = 0;
const ok = (cond, text) => { console.log((cond ? '✓ ' : '✗ ') + text); if (!cond) fails++; };
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (await fn()) return true; await B.sleep(200); } return false; };
const aloneText = async (p) => ((await p.locator('.dk-alone').first().textContent().catch(() => '')) || '').trim();

(async () => {
  const browser = await B.launch(), errors = [];
  const ids = q(`select string_agg(id::text, ',' order by created_at) from public.profiles p
                  where not exists (select 1 from public.admins a where a.user_id = p.id)`).split(',').slice(0, 2);
  q(`insert into public.points_ledger (user_id, amount, reason, ref) select x, 500, 'game', 'test:3min' from unnest(array['${ids[0]}', '${ids[1]}']::uuid[]) x`);
  const coins = () => ids.map((u) => Number(q(`select public.coins_of('${u}')`)));
  const c0 = coins();
  const A = await B.phone(browser, ids[0], errors, { tag: 'первый' });

  // ===== Дурак =====
  const d = Number(rpc(ids[0], 'public.durak_create(10)'));
  rpc(ids[1], `public.durak_join(${d})`);
  await B.openDurak(A);
  await A.locator('.dk-rules summary').click();
  ok(/если игра не началась за 3 минуты — тоже/.test(await A.locator('.dk-rules-list').textContent()), 'Дурак: в правилах — строка про 3 минуты');
  await A.locator('.duel-row button', { hasText: /Вернуться|Открыть/ }).first().click();
  await A.waitForSelector('.duel-lobby');
  await B.sleep(800);
  const t1 = await aloneText(A);
  ok(/^Закроется через 2:5\d, если игра не начнётся$/.test(t1), 'Дурак: двое — «' + t1 + '»');
  await B.sleep(1300);
  ok((await aloneText(A)) !== t1, 'Дурак: отсчёт идёт — «' + (await aloneText(A)) + '»');
  await shot(A, 'r3_durak_wait');
  q(`update public.durak_rooms set created_at = created_at - interval '2 minutes 57 seconds' where id = ${d}`);
  ok(await waitFor(async () => (await A.locator('.duel-big', { hasText: 'Комната закрыта' }).count()) === 1, 10000), 'Дурак: 3 минуты — «Комната закрыта»');
  ok((await aloneText(A)) === 'За 3 минуты игра не началась — ставки вернулись', 'Дурак: причина — «' + (await aloneText(A)) + '»');
  await shot(A, 'r3_durak_closed');
  ok(JSON.stringify(coins()) === JSON.stringify(c0), 'Дурак: монеты как были');
  await A.getByRole('button', { name: 'К комнатам' }).click();

  // ===== Верю — не верю =====
  const b = Number(rpc(ids[0], 'public.bluff_create(10, 6, 2)'));
  rpc(ids[1], `public.bluff_join(${b})`);
  await B.openBluff(A);
  await A.locator('.duel-row button', { hasText: /Вернуться|Открыть/ }).first().click();
  await A.waitForSelector('.duel-lobby');
  await B.sleep(800);
  const t2 = await aloneText(A);
  ok(/^Закроется через 2:5\d, если игра не начнётся$/.test(t2), 'Верю: двое — «' + t2 + '»');
  q(`update public.bluff_rooms set created_at = created_at - interval '2 minutes 57 seconds' where id = ${b}`);
  ok(await waitFor(async () => (await A.locator('.duel-big', { hasText: 'Комната закрыта' }).count()) === 1, 10000), 'Верю: 3 минуты — «Комната закрыта»');
  ok((await aloneText(A)) === 'За 3 минуты игра не началась — ставки вернулись', 'Верю: причина — «' + (await aloneText(A)) + '»');
  await shot(A, 'r3_bluff_closed');
  ok(JSON.stringify(coins()) === JSON.stringify(c0), 'Верю: монеты как были');

  ok(!errors.length, errors.length ? 'ошибки на странице: ' + errors.join(' | ') : 'ошибок на странице нет');
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
