// Создатель стола (supabase/host/01_host.sql) и последние карты в «Верю — не верю» (supabase/bluff/04_last_cards.sql)
// через весь сайт, трое живых «телефонов».
//   DB=… node host-last.js
// 1. Дурак и «Верю — не верю»: создатель ушёл в другой раздел сайта больше чем на 5 с — «создатель» и «Начать»
//    у следующего; вернулся — снова у него; «Начать» нажимает он.
// 2. «Верю — не верю»: без карт, круг дошёл — в рамке только «Верю» / «Не верю» и подпись; у соперников — «без карт»;
//    «Не верю» на враньё — стопку забрал совравший, у того, кто был без карт, — место.
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
const ids = q('select id from public.profiles p where not exists (select 1 from public.admins a where a.user_id = p.id) order by created_at limit 3').split('\n');
const fails = [];
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails.push(what); };
// кого телефон показывает создателем и есть ли у него «Начать»
const lobby = (p) => p.evaluate(() => {
  const seat = [...document.querySelectorAll('.duel-lobby .dk-seat')].find(s => (s.querySelector('.dk-seat-tag') || {}).textContent === 'создатель');
  return { host: seat ? seat.querySelector('.dk-seat-name').textContent.replace(' (ты)', '') : null,
           start: !![...document.querySelectorAll('.duel-lobby .btn')].find(b => b.textContent === 'Начать') };
});
const nameOf = (u) => q(`select display_name from public.profiles where id = '${u}'`);
async function away(p) { await p.locator('.bn-item', { hasText: 'Вопрос' }).click(); }   // ушёл в другой раздел — комната не спрашивается

async function hostPart(pages, game) {
  const [A, Bp, C] = pages, open = game === 'durak' ? B.openDurak : B.openBluff;
  for (const p of pages) await open(p);
  await A.getByRole('button', { name: 'Новая комната' }).click();
  await A.fill(game === 'durak' ? '#dk-stake' : '#bf-stake', '0');
  await A.getByRole('button', { name: /Открыть комнату/ }).click();
  await A.waitForSelector('.duel-lobby');
  for (const p of [Bp, C]) {
    await p.waitForSelector('.duel-row button:has-text("Войти")', { timeout: 12000 });
    await p.locator('.duel-row button:has-text("Войти")').first().click();
    await p.waitForSelector('.duel-lobby');
  }
  await B.sleep(1500);
  const n1 = nameOf(ids[0]), n2 = nameOf(ids[1]);
  let a = await lobby(A), b = await lobby(Bp), c = await lobby(C);
  check(a.host === n1 && b.host === n1 && c.host === n1 && a.start && !b.start && !c.start, game + ': создатель — открывший комнату, «Начать» только у него');
  await away(A);
  await B.sleep(7000);
  b = await lobby(Bp); c = await lobby(C);
  await shot(Bp, 'host_' + game + '_away');
  check(b.host === n2 && b.start && c.host === n2 && !c.start, game + ': создатель ушёл больше чем на 5 с — «создатель» и «Начать» у зашедшего следующим');
  await open(A);
  await A.waitForSelector('.duel-lobby', { timeout: 5000 });
  await B.sleep(2500);
  a = await lobby(A); b = await lobby(Bp);
  check(a.host === n1 && a.start && b.host === n1 && !b.start, game + ': вернулся — снова создатель');
  await A.getByRole('button', { name: 'Начать' }).click();
  await B.sleep(1000);
  for (const p of [Bp, C]) await p.getByRole('button', { name: game === 'durak' ? 'Готов' : 'Готово' }).click();
  await A.waitForSelector(game === 'durak' ? '.dk-table' : '.bf-table', { timeout: 10000 });
  check(true, game + ': «Начать» у вернувшегося сработало, игра идёт');
}

(async () => {
  const browser = await B.launch(), errors = [];
  const pages = [];
  for (const [i, u] of ids.entries()) pages.push(await B.phone(browser, u, errors, { tag: 'P' + (i + 1) }));
  const [A, Bp, C] = pages;

  await hostPart(pages, 'durak');
  // дурак: все выходят (поражение) — освобождаем людей для следующей комнаты
  const dk = q(`select max(id) from public.durak_rooms`);
  q(`update public.durak_rooms set status = 'cancelled' where id = ${dk}`);
  for (const p of pages) { await p.reload(); await p.waitForSelector('.bn-item', { timeout: 15000 }); }

  await hostPart(pages, 'bluff');

  // ===== последние карты: раскладываем стол прямо в базе =====
  // колода от 6 + 1 джокер (как в «Новой комнате» по умолчанию — неважно): у первого карт нет, круг дошёл до него
  const r = q('select max(id) from public.bluff_rooms');
  const seat = (u) => q(`select seat from public.bluff_players where room_id = ${r} and user_id = '${u}'`);
  const s1 = +seat(ids[0]), s2 = +seat(ids[1]), s3 = +seat(ids[2]);
  // карты 28 (9♠), 32 (10♠), 33 (10♥), 40 (Q♠): первый положил «девятку» последней, второй доложил 10♠ (враньё), третий — Q♠ (враньё)
  q(`update public.bluff_players set hand = case seat when ${s1} then '{}'::integer[] when ${s2} then '{33}'::integer[] else '{44,45}'::integer[] end,
       emptied_at = case seat when ${s1} then now() - interval '20 seconds' end, misses = 0, place = null, out_kind = null where room_id = ${r};
     update public.bluff_rooms set pile = '{28,32,40}', claim_rank = 9, last_seat = ${s3}, last_n = 1, turn_seat = ${s1},
       bita = public.bluff_deck_n(low_rank, high_rank, jokers) - 6, deadline = now() + interval '30 seconds', log = '[]', version = version + 1 where id = ${r}`);
  await B.sleep(2500);
  const me = await A.evaluate(() => ({
    btns: [...document.querySelectorAll('.bf-acts .btn')].map(b => b.textContent),
    text: (document.querySelector('.bf-empty-hand') || {}).textContent || ''
  }));
  await shot(A, 'last_empty_turn');
  check(me.btns.join('|') === 'Верю|Не верю' && /круг дошёл до тебя/.test(me.text), 'без карт, круг дошёл: только «Верю» / «Не верю» и подпись — ' + me.btns.join(', ') + ' · ' + me.text);
  const tag = await Bp.evaluate((s) => (document.querySelector('.bf-opp[data-seat="' + s + '"] .dk-opp-tag') || {}).textContent, String(s1));
  await shot(Bp, 'last_empty_opp');
  check(tag === 'без карт', 'у соперника подпись «без карт» — ' + tag);
  await A.getByRole('button', { name: 'Не верю' }).click();
  await B.sleep(4500);   // анимация открытия
  const after = q(`select string_agg(seat || ':' || coalesce(place::text, '-') || ':' || cardinality(hand), ',' order by seat) from public.bluff_players where room_id = ${r}`);
  await shot(A, 'last_after');
  const mine = await A.evaluate(() => (document.querySelector('.dk-me-done') || {}).textContent || '');
  check(after.split(',').find(x => x.startsWith(s1 + ':')) === s1 + ':1:0' && after.split(',').find(x => x.startsWith(s3 + ':')) === s3 + ':-:5'
        && /1 место/.test(mine), '«Не верю» на враньё: стопку забрал совравший, без карт — первое место (' + after + ', «' + mine + '»)');

  // выходим из игры, чтобы не мешать следующим проверкам
  q(`update public.bluff_rooms set status = 'cancelled' where id = ${r}`);
  console.log(errors.length ? errors.slice(0, 10).join('\n') : 'ошибок на страницах нет');
  await browser.close();
  if (fails.length || errors.length) process.exit(1);
})().catch(e => { console.error('СБОЙ', e); process.exit(1); });
