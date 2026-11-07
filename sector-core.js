/* Ядро «Сектора»: только правила, без рисования.
   Один и тот же файл работает на телефоне (game.js рисует игру по нему) и на сервере
   (функция duel-submit переигрывает дуэль по зерну и записи нажатий и сама считает счёт).
   ВАЖНО: копия этого файла лежит в supabase/functions/duel-submit/sector-core.js — они должны совпадать.

   Как устроено (простыми словами):
   * Всё случайное (где появится сектор, когда будет фиолетовый или бирюзовый) берётся из «зерна» —
     одно зерно даёт одну и ту же игру. Сектор ставится относительно стрелки, поэтому у всех игроков
     каждый сектор на том же расстоянии впереди, той же ширины и того же цвета.
   * Время — миллисекунды от старта игры. Новый сектор появляется ровно через 300 мс после попадания.
   * Пропустил сектор (стрелка проехала его, а нажатия не было) — проигрыш. Чтобы успевать, новый сектор
     появляется не ближе 90° и не ближе, чем стрелка доедет за 0,4 секунды.
   * Угол стрелки считается относительно круга: в режиме «крутится круг» сближение то же самое.
   * Очки. Обычная игра: попал — 1, PERFECT (центр) — 2. В дуэли (zones3) сектор делится на 5 равных полос:
     края — 1 очко, ближе к центру — 2, центр — 3 (центр и есть PERFECT). */
(function (root) {
  'use strict';

  // Все параметры игры в одном месте. База (game_min_ms) считает минимум по 90° и скорости до 360 —
  // это не строже настоящей игры, поэтому честные результаты всегда проходят.
  var CONFIG = {
    startSpeed: 110,      // градусов в секунду
    speedStep: 6,         // прибавка скорости за каждое попадание
    maxSpeed: 320,
    startWidth: 64,       // ширина сектора, градусы
    widthStep: 1.0,       // уменьшение ширины за каждое попадание
    widthStopAt: 35,      // после 35 попаданий сектор больше не сужается: 64 − 35 = 29°
    minWidth: 16,
    perfectShare: 0.2,    // центральные 20% сектора — PERFECT
    minPerfect: 4,        // но PERFECT-зона не уже 4°
    gapAhead: 90,         // новый сектор начинается не ближе 90° впереди стрелки…
    reactMs: 400,         // …и не ближе, чем стрелка доедет за 0,4 с (на большой скорости это больше 90°)
    gapBehind: 40,        // и заканчивается не ближе 40° позади неё
    transitionMs: 300,    // пауза между раундами
    // Развороты (фиолетовые). Числа — сколько попаданий до следующего.
    firstReverse: [4, 7], // первый — 5-й…8-й сектор игры
    backAfter: [0, 4],    // возврат по часовой — сразу (0) или через 1–4 попадания
    nextReverse: [5, 9],  // следующий разворот — через 5–9 попаданий после возврата
    // «Крутится круг» (бирюзовые).
    firstSpin: [15, 19],  // первый — 16-й…20-й сектор игры
    spinBackAfter: [0, 1],// стрелка снова крутится — следующий сектор или через один
    nextSpin: [6, 10],    // следующий «крутится круг» — через 6–10 попаданий
    mixFrom: 30           // с 30 попаданий разворот и «крутится круг» могут идти одновременно
  };

  function speedFor(hits) { return Math.min(CONFIG.maxSpeed, CONFIG.startSpeed + hits * CONFIG.speedStep); }
  function widthFor(hits) { return Math.max(CONFIG.minWidth, CONFIG.startWidth - Math.min(hits, CONFIG.widthStopAt) * CONFIG.widthStep); }
  function perfectWidth(w) { return Math.max(CONFIG.minPerfect, w * CONFIG.perfectShare); }
  // Разница углов в диапазоне (-180, 180] — правильно работает и на переходе 359° → 0°.
  function norm(d) { d = ((d % 360) + 360) % 360; return d > 180 ? d - 360 : d; }
  function wrap(a) { return ((a % 360) + 360) % 360; }

  // Попал ли угол стрелки в сектор: 'perfect', 'hit' или 'miss'.
  function judge(angle, center, width) {
    var d = Math.abs(norm(angle - center));
    if (d <= perfectWidth(width) / 2) return 'perfect';
    if (d <= width / 2) return 'hit';
    return 'miss';
  }
  // Ширина зоны «2 очка» в дуэли (вместе с центром): средние 3 полосы из 5
  function goodWidth(w) { return Math.max(perfectWidth(w), w * 0.6); }
  // Дуэль, три зоны: 'perfect' (центр, 3 очка), 'good' (2), 'hit' (края, 1) или 'miss'
  function judge3(angle, center, width) {
    var d = Math.abs(norm(angle - center));
    if (d <= perfectWidth(width) / 2) return 'perfect';
    if (d <= goodWidth(width) / 2) return 'good';
    if (d <= width / 2) return 'hit';
    return 'miss';
  }

  // Сколько градусов минимум до нового сектора при такой скорости.
  function gapFor(speed) { return Math.max(CONFIG.gapAhead, speed * CONFIG.reactMs / 1000); }

  // Центр нового сектора: впереди стрелки (по направлению движения) с запасом на реакцию.
  // r — случайное число от 0 до 1, dir — 1 по часовой или -1 против.
  function placeSector(arrow, width, r, dir, speed) {
    var gap = gapFor(speed || CONFIG.startSpeed);
    var span = Math.max(0, 360 - gap - CONFIG.gapBehind - width);
    return wrap(arrow + (dir === -1 ? -1 : 1) * (gap + width / 2 + r * span));
  }
  // Случайное целое от a до b включительно. r — случайное число от 0 до 1.
  function between(range, r) { return range[0] + Math.min(range[1] - range[0], Math.floor(r * (range[1] - range[0] + 1))); }

  // Какой будет следующий сектор: 'normal', 'rev' (разворот) или 'spin' (крутится круг).
  // До CONFIG.mixFrom режимы не пересекаются. Если оба «созрели» сразу — первым идёт тот,
  // что возвращает к обычной игре; второй — в следующий раз.
  function pickKind(st) {
    var revOk = st.untilRev <= 0, spinOk = st.untilSpin <= 0;
    if (st.hits < CONFIG.mixFrom) {
      if (revOk && st.dir === 1 && st.spin) revOk = false;
      if (spinOk && !st.spin && st.dir === -1) spinOk = false;
    }
    if (revOk && spinOk) {
      if (st.dir === -1) return 'rev';
      if (st.spin) return 'spin';
      return 'rev';
    }
    return revOk ? 'rev' : spinOk ? 'spin' : 'normal';
  }

  // Генератор случайных чисел по зерну (mulberry32): одно зерно — одна и та же последовательность.
  function rng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randomSeed() { return 1 + Math.floor(Math.random() * 2147483646); }

  // Минимально возможное время игры с таким числом попаданий (как считает база — по 90°).
  function minTimeMs(hits) {
    var t = 0;
    for (var i = 0; i < hits; i++) t += CONFIG.gapAhead / Math.min(360, CONFIG.startSpeed + i * CONFIG.speedStep) * 1000;
    return t + Math.max(hits - 1, 0) * CONFIG.transitionMs;
  }

  // Одна партия по зерну. Все t — мс от старта игры. opts.zones3 — очки по трём зонам (дуэль).
  function create(seed, opts) {
    var rnd = rng(seed);
    var zones3 = !!(opts && opts.zones3);
    var s = {
      seed: seed, zones3: zones3, phase: 'running', // running | transition | over
      a0: 0, t0: 0, speed: speedFor(0), dir: 1,
      kind: 'normal', spin: false, untilRev: 0, untilSpin: 0,
      center: 0, width: widthFor(0), exitAt: 0, transitionEnd: 0,
      hits: 0, perfects: 0, score: 0, end: null, endAt: 0
    };
    function angleAt(t) { return wrap(s.a0 + s.dir * s.speed * Math.max(0, t - s.t0) / 1000); }
    function rebase(t) { s.a0 = angleAt(t); s.t0 = t; }
    // Когда стрелка проедет дальний край сектора (после этого — пропуск)
    function exitTime() {
      var far = s.center + s.dir * s.width / 2;
      return s.t0 + wrap(s.dir * (far - s.a0)) / s.speed * 1000;
    }
    s.untilRev = between(CONFIG.firstReverse, rnd());
    s.untilSpin = between(CONFIG.firstSpin, rnd());
    s.center = placeSector(0, s.width, rnd(), 1, s.speed);
    s.exitAt = exitTime();

    function nextRound(t) {
      rebase(t);
      s.speed = speedFor(s.hits);
      s.width = widthFor(s.hits);
      s.kind = pickKind(s);
      s.center = placeSector(angleAt(t), s.width, rnd(), s.dir, s.speed);
      s.exitAt = exitTime();
      s.phase = 'running';
    }
    // Довести игру до момента t: если пауза между раундами закончилась — новый сектор (ровно в её конце)
    function tick(t) { if (s.phase === 'transition' && t >= s.transitionEnd) nextRound(s.transitionEnd); }
    function finish(t, reason) {
      if (s.phase === 'over') return;
      rebase(t); s.speed = 0; s.phase = 'over'; s.end = reason; s.endAt = t;
    }
    // Стрелка уже проехала сектор без нажатия?
    function skipDue(t) { tick(t); return s.phase === 'running' && t > s.exitAt; }
    // Нажатие в момент t. Возвращает null (не считается — пауза между раундами или игра окончена)
    // или { res: 'perfect' | 'good' | 'hit' | 'miss' | 'skip', kind, points }.
    function press(t) {
      if (s.phase === 'over') return null;
      tick(t);
      if (s.phase !== 'running') return null;
      if (t > s.exitAt) { finish(s.exitAt, 'skip'); return { res: 'skip', kind: s.kind }; }
      if (t < s.t0) t = s.t0;
      var res = (zones3 ? judge3 : judge)(angleAt(t), s.center, s.width);
      if (res === 'miss') { finish(t, 'miss'); return { res: 'miss', kind: s.kind }; }
      var kind = s.kind;
      s.hits += 1;
      if (kind === 'rev') {
        rebase(t);
        s.dir = -s.dir;
        s.untilRev = between(s.dir === -1 ? CONFIG.backAfter : CONFIG.nextReverse, rnd());
        s.untilSpin -= 1;
      } else if (kind === 'spin') {
        s.spin = !s.spin;
        s.untilSpin = between(s.spin ? CONFIG.spinBackAfter : CONFIG.nextSpin, rnd());
        s.untilRev -= 1;
      } else { s.untilRev -= 1; s.untilSpin -= 1; }
      var points = res === 'perfect' ? (zones3 ? 3 : 2) : res === 'good' ? 2 : 1;
      if (res === 'perfect') s.perfects += 1;
      s.score += points;
      s.phase = 'transition';
      s.transitionEnd = t + CONFIG.transitionMs;
      return { res: res, kind: kind, points: points };
    }
    return { state: s, angleAt: angleAt, tick: tick, press: press, finish: finish, skipDue: skipDue };
  }

  // Переиграть партию по зерну и записи нажатий (так проверяет сервер).
  // presses — моменты нажатий (мс от старта, по возрастанию), end — как закончилась: 'miss' | 'skip' | 'win' | 'quit',
  // endT — когда (для 'win' и 'quit'). Результат считается по правилам, а не по словам телефона.
  function replay(seed, presses, end, endT, opts) {
    var g = create(seed, opts), s = g.state, last = 0;
    for (var i = 0; i < presses.length && s.phase !== 'over'; i++) {
      var t = Number(presses[i]);
      if (!isFinite(t) || t < last) break;   // время нажатий только растёт
      last = t;
      g.press(t);
    }
    if (s.phase !== 'over') {
      if (end === 'win' || end === 'quit') {
        var te = Math.max(Number(endT) || 0, last);
        if (g.skipDue(te)) g.finish(s.exitAt, 'skip');
        else g.finish(te, end);
      } else {
        g.tick(1e12);                        // нажатий больше нет — стрелка проедет сектор
        g.finish(s.exitAt, 'skip');
      }
    }
    return { score: s.score, hits: s.hits, perfects: s.perfects, end: s.end, endAt: s.endAt };
  }

  var api = {
    CONFIG: CONFIG, speedFor: speedFor, widthFor: widthFor, perfectWidth: perfectWidth, norm: norm, wrap: wrap,
    judge: judge, judge3: judge3, goodWidth: goodWidth, gapFor: gapFor, placeSector: placeSector, between: between, pickKind: pickKind,
    rng: rng, randomSeed: randomSeed, minTimeMs: minTimeMs, create: create, replay: replay
  };
  root.SectorCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
