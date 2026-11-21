// «Покер»: на ход 1 минута; один за столом минуту — стол закрывается (04_clock_alone.sql).
// Двое живых за столом на монеты через весь сайт:
//  1) в правилах — «1 минута» и «один человек»; один за новым столом — «Ждём игроков» и отсчёт «закроется через N с»;
//  2) сел второй — отсчёт пропал; в свой ход — «Твой ход», секунды (~60) и полоска, у соперника — тонкая полоска;
//  3) время вышло (подвинули срок в базе) — база сходила за игрока (пас или чек);
//  4) второй вышел — у первого снова отсчёт; «прошла» минута — стол закрыт, «За минуту никто не сел…», монеты сошлись.
//   node poker-clock.js
// Нужно: ./db.sh e2e ../../supabase/durak/0[1-6]*.sql ../../supabase/poker/0[1-4]*.sql  и  DB=e2e node server.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
let fails = 0;
const ok = (cond, text) => { console.log((cond ? '✓ ' : '✗ ') + text); if (!cond) fails++; };
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (await fn()) return true; await B.sleep(200); } return false; };

(async () => {
  const browser = await B.launch(), errors = [];
  const ids = q(`select string_agg(id::text, ',' order by created_at) from public.profiles p
                  where not exists (select 1 from public.admins a where a.user_id = p.id)`).split(',').slice(0, 2);
  const coins = () => ids.map((u) => Number(q(`select public.coins_of('${u}')`)));
  const c0 = coins();
  const A = await B.phone(browser, ids[0], errors, { tag: 'первый', mode: 'poker' });
  const Bp = await B.phone(browser, ids[1], errors, { tag: 'второй', mode: 'poker' });
  await B.openPoker(A); await B.openPoker(Bp);

  // 1. правила и один за новым столом
  await A.locator('.dk-rules summary').click();
  const rules = await A.locator('.dk-rules-list').textContent();
  ok(/На ход 1 минута/.test(rules) && /один человек/.test(rules) && !/не ограничено/.test(rules), 'в правилах: на ход 1 минута, один за столом — закрывается через минуту');
  await A.getByRole('button', { name: 'Новый стол' }).click();
  await A.locator('.pk-level', { hasText: '0,01 / 0,02' }).click();
  await A.getByRole('button', { name: /^Открыть стол/ }).click();
  await A.waitForSelector('.pk-table');
  const t = q(`select id from public.poker_tables where creator = '${ids[0]}' order by id desc limit 1`);
  await B.sleep(600);
  const wait1 = (await A.locator('.pk-pot.wait').textContent()) || '';
  const sec1 = Number((wait1.match(/закроется через (\d+) с/) || [])[1]);
  ok(/Ждём игроков/.test(wait1) && sec1 >= 57 && sec1 <= 60, 'один за новым столом: «' + wait1.trim() + '»');
  await shot(A, 'pk_alone_wait');

  // 2. сел второй: отсчёт пропал, ход с секундами и полоской
  for (let k = 0; k < 20 && !(await Bp.locator('.duel-row button', { hasText: 'Сесть' }).count()); k++) await B.sleep(500);
  await Bp.locator('.duel-row button', { hasText: 'Сесть' }).first().click();
  await Bp.locator('.pk-sit .duel-go').click();
  await Bp.waitForSelector('.pk-table');
  ok(await waitFor(async () => (await A.locator('[data-alone]').count()) === 0), 'сел второй — отсчёта «закроется» больше нет');
  ok(await waitFor(async () => (await A.locator('.pk-acts.on').count()) + (await Bp.locator('.pk-acts.on').count()) === 1, 15000), 'раздача началась, ход у одного из двоих');
  await B.sleep(400);
  const aTurn = (await A.locator('.pk-acts.on').count()) === 1;
  const me = aTurn ? A : Bp, other = aTurn ? Bp : A;
  const line = (await me.locator('.dk-turn-line').textContent()).trim();
  const sec = Number((line.match(/(\d+)\s*с/) || [])[1]);
  ok(/Твой ход/.test(line) && sec >= 55 && sec <= 60, 'в свой ход: «' + line + '»');
  const w1 = await me.locator('.pk-me .pk-bar.on > i').evaluate((n) => parseFloat(n.style.width));
  ok(w1 > 85 && w1 <= 100, 'моя полоска времени почти полная: ' + w1.toFixed(1) + '%');
  ok(await other.locator('.pk-opp .pk-bar.sm.on').count() === 1, 'у соперника — тонкая полоска на моей рамке');
  ok(await me.locator('.pk-opp .pk-bar.on').count() === 0, 'у меня полоски соперника нет (ходит не он)');
  await B.sleep(2200);
  const line2 = (await me.locator('.dk-turn-line').textContent()).trim();
  const sec2 = Number((line2.match(/(\d+)\s*с/) || [])[1]);
  ok(sec2 <= sec - 1 && sec2 >= sec - 3, 'секунды идут: ' + sec + ' → ' + sec2);
  await shot(me, 'pk_clock_turn');

  // 3. время вышло: «прошло» 59 секунд — база сходит за игрока через секунду-две
  const v0 = Number(q(`select version from public.poker_tables where id = ${t}`));
  const seat = q(`select turn_seat from public.poker_tables where id = ${t}`);
  q(`update public.poker_tables set deadline = now() + interval '3 seconds' where id = ${t}`);
  await B.sleep(1300);
  const line3 = (await me.locator('.dk-turn-line').textContent()).trim();
  ok(/Твой ход[0-2] с/.test(line3), 'осталась пара секунд: «' + line3 + '»');
  ok(await waitFor(async () => Number(q(`select version from public.poker_tables where id = ${t}`)) > v0, 6000), 'время вышло — база сходила за игрока');
  // новая раздача стирает подпись действия, поэтому смотрим журнал стола (ход с пометкой auto) и счётчик пропусков
  const auto = q(`select string_agg(e->>'act', ',') from public.poker_tables g, jsonb_array_elements(g.log) e
                   where g.id = ${t} and e->>'kind' = 'act' and (e->>'auto')::boolean and e->>'seat' = '${seat}'`);
  const miss = q(`select misses from public.poker_seats where table_id = ${t} and seat = ${seat} and left_at is null`);
  ok(/^(fold|check)$/.test(auto) && miss === '1', 'за игрока: ' + auto + ', пропусков подряд: ' + miss);
  await B.sleep(1500);
  await shot(other, 'pk_clock_auto');

  // 4. второй уходит — у первого снова отсчёт; «прошла» минута — стол закрыт
  const leaver = Bp;
  await waitFor(async () => (await leaver.getByRole('button', { name: 'Выйти' }).count()) > 0);
  await leaver.getByRole('button', { name: 'Выйти' }).click();
  if (await leaver.locator('.dk-quit-pop .btn.danger').count()) await leaver.locator('.dk-quit-pop .btn.danger').click();
  ok(await waitFor(async () => (await A.locator('[data-alone]').count()) === 1, 12000), 'второй ушёл — у первого «Ждём игроков» и отсчёт');
  await B.sleep(500);
  const wait2 = (await A.locator('.pk-pot.wait').textContent()) || '';
  ok(/закроется через (5[5-9]|60) с/.test(wait2), 'отсчёт с ухода второго: «' + wait2.trim() + '»');
  // «прошло» 57 секунд: и уход второго, и открытие стола — раньше на 57 с
  q(`update public.poker_seats set left_at = left_at - interval '57 seconds' where table_id = ${t} and left_at is not null`);
  q(`update public.poker_tables set created_at = created_at - interval '57 seconds' where id = ${t}`);
  await B.sleep(700);
  const wait3 = (await A.locator('.pk-pot.wait').textContent()) || '';
  ok(/закроется через [1-4] с/.test(wait3), 'почти минута: «' + wait3.trim() + '»');
  await shot(A, 'pk_alone_soon');
  ok(await waitFor(async () => (await A.locator('.pk-out .duel-big', { hasText: 'Стол закрыт' }).count()) === 1, 8000), 'минута прошла — «Стол закрыт»');
  const why = (await A.locator('.pk-why').textContent().catch(() => '')) || '';
  ok(/За минуту никто не сел/.test(why), 'причина: «' + why + '»');
  ok(q(`select status from public.poker_tables where id = ${t}`) === 'closed', 'в базе стол закрыт');
  await shot(A, 'pk_alone_closed');
  const c1 = coins();
  ok(c0[0] + c0[1] === c1[0] + c1[1] && q(`select count(*) from public.poker_seats where table_id = ${t} and left_at is null`) === '0',
    `монеты двоих сошлись: ${c0.join(' + ')} → ${c1.join(' + ')}, за столом никого`);
  // у ушедшего — просто «Стол закрыт» (он ушёл сам)
  await B.sleep(1500);
  const lv = await leaver.locator('.pk-why').count();
  ok(lv === 0, 'у ушедшего раньше причины «никто не сел» нет');

  ok(!errors.length, errors.length ? 'ошибки на странице: ' + errors.join(' | ') : 'ошибок на странице нет');
  await browser.close();
  console.log(fails ? `✗ не прошло: ${fails}` : '✓ всё прошло');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
