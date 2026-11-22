// «Верю — не верю»: ползунки в «Новой комнате» и стол (стопка по центру, бита в углу, «+N карт»).
//   node bluff-slider.js
// 1) ползунок колоды тянем мышью за ручки: верх → 10, низ → 5 («от 5 до 10», 24 карты); обе ручки на тузе — нижнюю можно увести влево;
//    нажатие на подпись деления; ползунок джокеров; комната создаётся с этой колодой (в базе low 5, high 10, jokers 2).
// 2) тестовая комната с ботами: стопка ровно по центру середины стола, бита в углу и не налезает на соперников,
//    при ходе над стопкой крупно «+N карт», на стопке — общее число карт, номиналы для хода — только 5…10.
// Нужно: ./db.sh … ../../supabase/bluff/01_bluff.sql ../../supabase/bluff/02_range.sql и DB=… node server.js
const { execFileSync } = require('child_process');
const B = require('./browser');
const shot = B.shooter(__dirname + '/shots');
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt', '-c', sql]).toString().trim();
const admin = q('select user_id from public.admins limit 1');
const checks = []; const ok = (name, cond, extra) => { checks.push([name, !!cond]); console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
(async () => {
  const browser = await B.launch(), errors = [];
  const A = await B.phone(browser, admin, errors, { tag: 'админ' });
  try { await A.evaluate(() => { localStorage.removeItem('bf-low'); localStorage.removeItem('bf-high'); localStorage.removeItem('bf-jokers'); }); } catch (e) { /* ничего */ }
  await B.openBluff(A);
  await A.getByRole('button', { name: 'Новая комната' }).click();
  await A.waitForSelector('.bf-range input');
  const box = async (sel, i) => (await A.locator(sel).nth(i).boundingBox());
  const tickX = async (sl, v) => { const t = await box('.bf-slider:nth-of-type(1) .bf-ticks span', 0); return t; };
  // координата деления v на ползунке колоды (по подписи под ним)
  const xOf = async (slider, v) => { const b = await A.locator('.bf-slider').nth(slider).locator('.bf-ticks span[data-v="' + v + '"]').boundingBox(); return b.x + b.width / 2; };
  const thumb = async (slider, i) => {   // центр ручки: дорожка 14px от краёв, ручка по значению
    const inp = A.locator('.bf-slider').nth(slider).locator('input').nth(i);
    const b = await inp.boundingBox(); const v = +(await inp.inputValue()); const min = +(await inp.getAttribute('min')), max = +(await inp.getAttribute('max'));
    return { x: b.x + 14 + (b.width - 28) * (v - min) / (max - min), y: b.y + b.height / 2 };
  };
  const drag = async (slider, i, v) => {
    const t = await thumb(slider, i), x = await xOf(slider, v);
    await A.mouse.move(t.x, t.y); await A.mouse.down(); await A.mouse.move((t.x + x) / 2, t.y, { steps: 4 }); await A.mouse.move(x, t.y, { steps: 6 }); await A.mouse.up();
    await B.sleep(150);
  };
  const vals = async () => A.evaluate(() => [...document.querySelectorAll('.bf-range input')].map(i => +i.value));
  const text = async (sel) => (await A.locator(sel).first().innerText()).trim();
  ok('сначала: от 6 до туза, джокеров нет', JSON.stringify(await vals()) === '[6,14,0]', JSON.stringify(await vals()) + ' · ' + await text('.bf-sl-val'));
  await shot(A, 'bfs_form0');
  await drag(0, 1, 10);
  ok('верхнюю ручку — на 10', JSON.stringify((await vals()).slice(0, 2)) === '[6,10]', await text('.bf-sl-val'));
  await drag(0, 0, 5);
  ok('нижнюю — на 5: «от 5 до 10», 24 карты', JSON.stringify((await vals()).slice(0, 2)) === '[5,10]' && (await text('.bf-sl-val')) === 'от 5 до 10'
     && /^24 карты · мест до 6$/.test(await text('.bf-deck-sum')), await text('.bf-deck-sum'));
  await drag(0, 0, 12);
  ok('нижнюю нельзя увести выше верхней', JSON.stringify((await vals()).slice(0, 2)) === '[10,10]', await text('.bf-sl-val'));
  await drag(0, 1, 14); await drag(0, 0, 14);
  ok('обе на тузе — «только тузы», 4 места', JSON.stringify((await vals()).slice(0, 2)) === '[14,14]' && (await text('.bf-sl-val')) === 'только тузы'
     && /мест до 4/.test(await text('.bf-deck-sum')), await text('.bf-deck-sum'));
  await drag(0, 0, 11);
  ok('обе на тузе — нижняя уводится влево (от валета до туза)', JSON.stringify((await vals()).slice(0, 2)) === '[11,14]', await text('.bf-sl-val'));
  await A.locator('.bf-slider').nth(0).locator('.bf-ticks span[data-v="5"]').click();
  await A.locator('.bf-slider').nth(0).locator('.bf-ticks span[data-v="10"]').click();
  ok('нажатие на подписи 5 и 10 — ближайшая ручка встаёт туда', JSON.stringify((await vals()).slice(0, 2)) === '[5,10]', await text('.bf-sl-val'));
  await drag(1, 0, 2);
  ok('джокеры ползунком — 2: «24 карты + 2 джокера»', (await vals())[2] === 2 && /^24 карты \+ 2 джокера · мест до 6$/.test(await text('.bf-deck-sum')), await text('.bf-deck-sum'));
  const onTicks = await A.locator('.bf-slider').nth(0).locator('.bf-ticks span.on').count();
  ok('подписи 5…10 выделены (6 штук)', onTicks === 6, String(onTicks));
  await shot(A, 'bfs_form');
  const fits = await A.evaluate(() => { const f = document.querySelector('.duel-form').getBoundingClientRect(); return [...document.querySelectorAll('.bf-ticks span')].every(s => { const r = s.getBoundingClientRect(); return r.left >= f.left && r.right <= f.right; }); });
  ok('подписи делений не вылезают за карточку', fits);
  await A.locator('.dk-test-chip').click();
  await A.getByRole('button', { name: 'Открыть тестовую комнату' }).click();
  await A.waitForSelector('.duel-lobby');
  const row = q("select low_rank || '-' || high_rank || '-' || jokers from public.bluff_rooms order by id desc limit 1");
  ok('в базе комната «от 5 до 10» + 2 джокера', row === '5-10-2', row);
  const saved = await A.evaluate(() => [localStorage.getItem('bf-low'), localStorage.getItem('bf-high'), localStorage.getItem('bf-jokers')].join(','));
  ok('колода запомнилась', saved === '5,10,2', saved);
  ok('в комнате подпись «от 5 до 10 + 2 джокера»', /от 5 до 10 \+ 2 джокера/.test(await text('.duel-lobby')));
  for (let i = 0; i < 4; i++) { await A.getByRole('button', { name: 'Добавить бота' }).click(); await B.sleep(350); }
  await A.getByRole('button', { name: 'Начать' }).click();
  await A.waitForSelector('.bf-table', { timeout: 10000 });
  // стол: стопка по центру, бита в углу
  let geo = null, plus = 0, pileN = 0, ranksOk = null; const t0 = Date.now();
  while (Date.now() - t0 < 90000 && (!geo || !plus || ranksOk == null)) {
    if (await A.locator('.dk-result').count()) break;
    if (!plus && await A.locator('.dk-flash.bf-plus').count()) { plus = 1; await A.screenshot({ path: __dirname + '/shots/bfs_plus.png' }); }
    if (!geo && await A.locator('.bf-pile-n').count() && !(await A.locator('.dk-anim').count())) {
      geo = await A.evaluate(() => {
        const r = (s) => document.querySelector(s).getBoundingClientRect();
        const mid = r('.bf-mid'), pile = r('.bf-pile'), ring = r('.dk-ring'), bita = document.querySelector('.bf-bita').getBoundingClientRect();
        const opps = [...document.querySelectorAll('.dk-opp')].map(o => o.getBoundingClientRect());
        const hit = opps.some(o => !(bita.right < o.left || bita.left > o.right || bita.bottom < o.top || bita.top > o.bottom));
        return { off: Math.round(Math.abs((pile.left + pile.right) / 2 - (mid.left + mid.right) / 2)), ringOff: Math.round(Math.abs((pile.left + pile.right) / 2 - (ring.left + ring.right) / 2)),
                 corner: Math.round(bita.left - ring.left) + ',' + Math.round(ring.bottom - bita.bottom), hit, n: document.querySelector('.bf-pile-n').textContent };
      });
      await A.screenshot({ path: __dirname + '/shots/bfs_table.png' });
    }
    if (ranksOk == null && await A.locator('.bf-ranks').count()) {
      ranksOk = (await A.locator('.bf-ranks .bf-chip').allInnerTexts()).join(' ');
      await A.screenshot({ path: __dirname + '/shots/bfs_round.png' });
    }
    await B.bluffMove(A);
    await B.sleep(120);
  }
  ok('стопка ровно по центру середины и стола', geo && geo.off <= 2 && geo.ringOff <= 2, JSON.stringify(geo));
  ok('бита в углу стола и не налезает на соперников', geo && !geo.hit, geo && geo.corner);
  ok('над стопкой крупно «+N карт»', plus);
  ok('номиналы для хода — только 5…10', ranksOk === '5 6 7 8 9 10', ranksOk);
  console.log(errors.length ? errors.slice(0, 10).join('\n') : 'ошибок на страницах нет');
  await A.getByRole('button', { name: 'Выйти' }).first().click().catch(() => {});
  await A.locator('.dk-quit-pop .btn.danger').click().catch(() => {});
  await B.sleep(500);
  await browser.close();
  const bad = checks.filter(c => !c[1]).length;
  console.log((checks.length - bad) + '/' + checks.length);
  process.exit(bad || errors.length ? 1 : 0);
})().catch(e => { console.error('СБОЙ', e); process.exit(1); });
