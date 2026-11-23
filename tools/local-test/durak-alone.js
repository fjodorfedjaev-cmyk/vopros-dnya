// «Дурак»: один в комнате минуту — комната закрывается (07_alone.sql). Двое живых через весь сайт:
//  1) в правилах — строка про одного в комнате; открыл комнату (ставка 10) — «Закроется через 1:00 / N с, если никто не зайдёт»;
//  2) зашёл второй — отсчёт до 3 минут с открытия «…, если игра не начнётся» (rooms/01_start_3min.sql); вышел — снова минута;
//  3) «прошло» 57 секунд — через пару секунд «Комната закрыта», «За минуту никто не зашёл — ставка вернулась», монеты как были.
//   node durak-alone.js
// Нужно: ./db.sh e2e ../../supabase/durak/0[1-7]*.sql ../../supabase/poker/0[1-4]*.sql  и  DB=e2e node server.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
let fails = 0;
const ok = (cond, text) => { console.log((cond ? '✓ ' : '✗ ') + text); if (!cond) fails++; };
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (await fn()) return true; await B.sleep(200); } return false; };
const aloneText = async (p) => ((await p.locator('.dk-alone').textContent().catch(() => '')) || '').trim();
// «через 1:00» или «через 45 с» → секунды
const secs = (t) => { const m = t.match(/через (\d+):(\d\d)/); if (m) return Number(m[1]) * 60 + Number(m[2]); const s = t.match(/через (\d+) с/); return s ? Number(s[1]) : NaN; };

(async () => {
  const browser = await B.launch(), errors = [];
  const ids = q(`select string_agg(id::text, ',' order by created_at) from public.profiles p
                  where not exists (select 1 from public.admins a where a.user_id = p.id)`).split(',').slice(0, 2);
  const coins = () => ids.map((u) => Number(q(`select public.coins_of('${u}')`)));
  const c0 = coins();
  const A = await B.phone(browser, ids[0], errors, { tag: 'первый' });
  const Bp = await B.phone(browser, ids[1], errors, { tag: 'второй' });
  await B.openDurak(A); await B.openDurak(Bp);

  // 1. правила и один в новой комнате
  await A.locator('.dk-rules summary').click();
  const rules = await A.locator('.dk-rules-list').textContent();
  ok(/один человек, через минуту она закрывается/.test(rules), 'в правилах — строка про одного в комнате');
  await A.getByRole('button', { name: 'Новая комната' }).click();
  await A.fill('#dk-stake', '10');
  await A.getByRole('button', { name: /Открыть комнату/ }).click();
  await A.waitForSelector('.duel-lobby');
  const r = q(`select id from public.durak_rooms where creator = '${ids[0]}' order by id desc limit 1`);
  await B.sleep(700);
  const t1 = await aloneText(A), s1 = secs(t1);
  ok(s1 >= 57 && s1 <= 60 && /если никто не зайдёт/.test(t1), 'один в новой комнате: «' + t1 + '»');
  await B.sleep(1300);
  const s1b = secs(await aloneText(A));
  ok(s1b <= s1 - 1, 'отсчёт идёт: ' + s1 + ' → ' + s1b);
  await shot(A, 'dk_alone_wait');

  // 2. второй зашёл — отсчёт пропал; вышел — снова
  await Bp.waitForSelector('.duel-row button:has-text("Войти")', { timeout: 12000 });
  await Bp.locator('.duel-row button:has-text("Войти")').first().click();
  await Bp.waitForSelector('.duel-lobby');
  ok(await waitFor(async () => /если игра не начнётся/.test(await aloneText(A))), 'зашёл второй — отсчёт до 3 минут: «' + (await aloneText(A)) + '»');
  ok(q(`select alone_since is null from public.durak_rooms where id = ${r}`) === 't', 'в базе отметки «один» нет');
  await Bp.getByRole('button', { name: /^Выйти/ }).click();
  ok(await waitFor(async () => /если никто не зайдёт/.test(await aloneText(A))), 'второй вышел — у первого снова «если никто не зайдёт»');
  await B.sleep(600);
  const s2 = secs(await aloneText(A));
  ok(s2 >= 57 && s2 <= 60, 'новая минута с выхода второго: ' + s2 + ' с');

  // 3. «прошло» 57 секунд — закрывается
  q(`update public.durak_rooms set alone_since = alone_since - interval '57 seconds' where id = ${r}`);
  await B.sleep(1500);
  const s3 = secs(await aloneText(A));
  ok(s3 >= 0 && s3 <= 3, 'почти минута: ' + s3 + ' с');
  await shot(A, 'dk_alone_soon');
  ok(await waitFor(async () => (await A.locator('.duel-big', { hasText: 'Комната закрыта' }).count()) === 1, 8000), 'минута прошла — «Комната закрыта»');
  const why = await aloneText(A);
  ok(why === 'За минуту никто не зашёл — ставка вернулась', 'причина: «' + why + '»');
  ok(q(`select status from public.durak_rooms where id = ${r}`) === 'cancelled', 'в базе комната закрыта');
  await shot(A, 'dk_alone_closed');
  const c1 = coins();
  ok(c1[0] === c0[0] && c1[1] === c0[1], `монеты как были: ${c0.join(', ')} → ${c1.join(', ')}`);
  await A.getByRole('button', { name: 'К комнатам' }).click();
  ok(await waitFor(async () => (await A.locator('.dk-rules').count()) === 1), '«К комнатам» — снова список');

  ok(!errors.length, errors.length ? 'ошибки на странице: ' + errors.join(' | ') : 'ошибок на странице нет');
  await browser.close();
  console.log(fails ? `✗ не прошло: ${fails}` : '✓ всё прошло');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
