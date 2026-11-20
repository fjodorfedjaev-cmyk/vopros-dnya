// «Покер»: подсказка лучшей комбинации на телефоне (bestHand из poker.js) считает так же, как база (poker_eval / poker_name).
//   node poker-combo.js 5000   — столько случайных наборов из 2–7 карт (+ особые случаи)
// Нужно: ./db.sh e2e ../../supabase/durak/0[1-6]*.sql ../../supabase/poker/01_poker.sql
const fs = require('fs');
const { execFileSync } = require('child_process');
const N = parseInt(process.argv[2], 10) || 5000;
const src = fs.readFileSync(__dirname + '/../../poker.js', 'utf8');
const body = src.slice(src.indexOf('// combo:start'), src.indexOf('// combo:end'));
const bestHand = new Function(body + '\nreturn bestHand;')();
// запрос большой — отдаём его psql через stdin, а не в командной строке
const q = (sql) => execFileSync('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', process.env.DB || 'e2e', '-qAt'], { input: sql, maxBuffer: 64 << 20 }).toString().trim();
const R = (c) => Math.floor(c / 4) + 2;
const card = (r, s) => (r - 2) * 4 + s;   // s: 0 ♠ 1 ♥ 2 ♦ 3 ♣

const hands = [
  [card(14, 0), card(14, 1)],                                                   // пара тузов на руках
  [card(14, 0), card(13, 1)],                                                   // старшая карта
  [card(14, 0), card(2, 1), card(3, 2), card(4, 3), card(5, 0), card(9, 1)],    // стрит с тузом снизу
  [card(14, 0), card(13, 0), card(12, 0), card(11, 0), card(10, 0), card(9, 0), card(2, 1)],  // роял-флеш
  [card(9, 0), card(8, 0), card(7, 0), card(6, 0), card(5, 0), card(4, 0), card(14, 0)],      // стрит-флеш до девятки
  [card(5, 1), card(4, 1), card(3, 1), card(2, 1), card(14, 1), card(13, 1)],   // стрит-флеш с тузом снизу (не флеш с тузом)
  [card(7, 0), card(7, 1), card(7, 2), card(9, 0), card(9, 1), card(9, 2), card(2, 3)],       // две тройки → фулл-хаус
  [card(7, 0), card(7, 1), card(7, 2), card(7, 3), card(9, 0), card(9, 1), card(9, 2)],       // каре + тройка
  [card(3, 0), card(3, 1), card(5, 0), card(5, 1), card(8, 0), card(8, 1), card(14, 2)],      // три пары
  [card(2, 0), card(3, 0), card(4, 0), card(5, 0), card(7, 0), card(6, 1), card(14, 2)],      // флеш и стрит одновременно
  [card(10, 0), card(10, 1), card(10, 2), card(4, 0), card(4, 1), card(9, 3), card(9, 0)],    // тройка + две пары
];
for (let i = 0; i < N; i++) {
  const n = 2 + Math.floor(Math.random() * 6), deck = [...Array(52).keys()], h = [];
  for (let k = 0; k < n; k++) h.push(deck.splice(Math.floor(Math.random() * deck.length), 1)[0]);
  hands.push(h);
}
const rows = q(`select public.poker_eval(h)::text || '|' || public.poker_name(public.poker_eval(h))
                  from (values ${hands.map((h, i) => `(${i}, array[${h.join(',')}]::int[])`).join(',')}) v(i, h) order by i`).split('\n');
const SIZE = [1, 2, 4, 3, 5, 5, 5, 4, 5];
let bad = 0;
const byCat = {};
hands.forEach((h, i) => {
  const [score, name] = rows[i].split('|'); const s = Number(score), cat = s >> 20;
  const nib = (k) => (s >> (16 - 4 * k)) & 15;   // k-е достоинство в счёте базы
  const b = bestHand(h), errs = [];
  if (b.cat !== cat) errs.push('категория ' + b.cat + ' ≠ ' + cat);
  if (b.name !== name) errs.push('название «' + b.name + '» ≠ «' + name + '»');
  if (b.cards.length !== SIZE[cat]) errs.push('карт ' + b.cards.length);
  if (new Set(b.cards).size !== b.cards.length || b.cards.some((c) => h.indexOf(c) < 0)) errs.push('чужие или повторные карты');
  const ranks = b.cards.map(R);
  const want = {
    0: [nib(0)], 1: [nib(0), nib(0)], 2: [nib(0), nib(0), nib(1), nib(1)], 3: [nib(0), nib(0), nib(0)],
    7: [nib(0), nib(0), nib(0), nib(0)], 6: [nib(0), nib(0), nib(0), nib(1), nib(1)],
    5: [nib(0), nib(1), nib(2), nib(3), nib(4)]
  }[cat];
  if (want && ranks.join() !== want.join()) errs.push('достоинства ' + ranks + ' ≠ ' + want);
  if (cat === 4 || cat === 8) {
    const top = nib(0), row = [0, 1, 2, 3, 4].map((k) => (top - k === 1 ? 14 : top - k));
    if (ranks.join() !== row.join()) errs.push('стрит ' + ranks + ' ≠ ' + row);
    if (cat === 8 && new Set(b.cards.map((c) => c % 4)).size !== 1) errs.push('стрит-флеш разных мастей');
  }
  if (cat === 5 && new Set(b.cards.map((c) => c % 4)).size !== 1) errs.push('флеш разных мастей');
  byCat[name] = (byCat[name] || 0) + 1;
  if (errs.length) { bad++; if (bad <= 10) console.log('✗', JSON.stringify(h), errs.join('; ')); }
});
console.log(Object.entries(byCat).map(([k, v]) => k + ' ' + v).join(' · '));
console.log(bad ? `✗ расхождений: ${bad} из ${hands.length}` : `✓ все ${hands.length} наборов совпали с базой (название, карты комбинации, достоинства)`);
process.exit(bad ? 1 : 0);
