/* Ядро «Сектора»: только правила, без рисования.
   Один и тот же файл работает на телефоне (game.js рисует игру по нему) и на сервере
   (функция duel-submit переигрывает дуэль по зерну и записи нажатий и сама считает счёт).
   ВАЖНО: копия этого файла лежит в supabase/functions/duel-submit/sector-core.js — они должны совпадать.

   Как устроено (простыми словами):
   * Всё случайное (где появится сектор, какого он цвета) берётся из «зерна» —
     одно зерно даёт одну и ту же игру. Сектор ставится относительно стрелки, поэтому у всех игроков
     каждый сектор на том же расстоянии впереди, той же ширины и того же цвета.
   * Время — миллисекунды от старта игры. Новый сектор появляется сразу в момент попадания (после ловушки — через
     150 мс после того, как стрелка её проехала). Первые 100 мс после попадания нажатия не считаются — защита от
     случайного двойного касания (честно попасть так быстро нельзя: сектор всегда дальше).
   * Пропустил сектор (стрелка проехала его, а нажатия не было) — проигрыш. Чтобы успевать, новый сектор
     появляется не ближе 90° и не ближе, чем стрелка доедет за 0,4 секунды — в начале игры. С каждым попаданием
     этот запас уменьшается: к 80-му сектору — 60° и 0,27 с.
   * Чем дальше, тем ближе в среднем новый сектор и тем меньше самое дальнее место, где он может быть —
     игра всё больше на реакцию.
   * Угол стрелки считается относительно круга: в режиме «крутится круг» сближение то же самое.
   * Виды секторов: обычный (оранжевый), ловушка (красный, нажимать нельзя), разворот (фиолетовый),
     «крутится круг» (бирюзовый), раздвоение (лаймовый). Впервые появляются по порядку:
     красный → фиолетовый → бирюзовый → лаймовый.
     Потом — случайно, и чем дальше, тем чаще особые и реже обычные (к 150-му сектору обычных почти нет).
   * Раздвоение: после попадания стрелка раздваивается — вторая идёт зеркально, в другую сторону. Пока стрелок две,
     сектор ставится только туда, где они встречаются, — обе влетают в него одновременно, считается так же, как с одной.
     Чаще — через полкруга (место встречи видно заранее, поэтому запас на реакцию вдвое меньше), реже — через целый круг. Следующий лаймовый (сразу или через один сектор) — снова одна стрелка;
     сектор после этого появляется дальше обычного (есть время понять, куда идёт стрелка). С «крутится круг» не пересекается.
   * Ловушка: любое нажатие, пока она на круге, — проигрыш. Стрелка проехала её — засчитывается как
     попадание (+1 очко), через 150 мс появляется следующий сектор.
   * Очки. Обычная игра: попал — 1, PERFECT (центр) — 2. В дуэли (zones3) сектор делится на 5 равных полос:
     края — 1 очко, ближе к центру — 2, центр — 3 (центр и есть PERFECT). */
(function (root) {
  'use strict';

  // Все параметры игры в одном месте. База (game_min_ms) считает минимальное время игры — см. minTimeMs.
  var CONFIG = {
    startSpeed: 110,      // градусов в секунду
    speedStep: 6,         // прибавка скорости за каждое попадание
    maxSpeed: 330,
    startWidth: 64,       // ширина сектора, градусы
    widthStep: 1.0,       // уменьшение ширины за каждое попадание
    widthStopAt: 35,      // после 35 попаданий сектор больше не сужается: 64 − 35 = 29°
    minWidth: 16,
    perfectShare: 0.2,    // центральные 20% сектора — PERFECT
    minPerfect: 4,        // но PERFECT-зона не уже 4°
    gapAhead: 90,         // новый сектор начинается не ближе 90° впереди стрелки…
    reactMs: 400,         // …и не ближе, чем стрелка доедет за 0,4 с (на большой скорости это больше 90°)
    gapAheadEnd: 60,      // к fullAt-му сектору запас уменьшается до 60°…
    reactMsEnd: 270,      // …и 0,27 с (между — плавно)
    gapBehind: 40,        // и заканчивается не ближе 40° позади неё
    farStart: 290,        // дальний край сектора — не дальше 290° впереди стрелки в начале игры…
    farEnd: 200,          // …и не дальше 200° к fullAt-му сектору (между — плавно)
    fullAt: 80,           // к этому сектору запас на реакцию и дальний край доходят до конечных значений
    nearBias: 1,          // место выбирается как r^(1 + nearBias·доля пути к fullAt): чем дальше, тем чаще ближе
    transitionMs: 0,      // новый сектор — сразу после попадания
    afterTrapMs: 150,     // после ловушки — через 150 мс (телефон ждёт 120 мс, вдруг нажатие ещё в пути)
    pressLockMs: 100,     // 100 мс после попадания нажатия не считаются (двойное касание)
    // Первое появление особых секторов (числа — сколько попаданий до него): строго по порядку.
    firstTrap: [4, 7],    // красный — 5-й…8-й сектор игры
    firstReverse: [9, 12],// фиолетовый — 10-й…13-й
    firstSpin: [15, 19],  // бирюзовый — 16-й…20-й
    firstSplit: [23, 27], // лаймовый (раздвоение) — 24-й…28-й
    // После первого появления — случайно, по «весам»: [попаданий, вес] — между точками вес меняется плавно,
    // после последней не меняется. Шанс вида = его вес / сумма весов тех видов, что сейчас возможны.
    // Особых всё больше, обычных всё меньше: оранжевых ~70% в начале, ~30% к 80-му, почти нет к 150-му.
    weights: {
      normal: [[0, 0.72], [80, 0.35], [150, 0.03]],
      trap:   [[0, 0.10], [80, 0.22], [150, 0.30]],
      rev:    [[0, 0.12], [80, 0.26], [150, 0.36]],
      spin:   [[0, 0.06], [80, 0.17], [150, 0.26]],
      split:  [[0, 0.05], [80, 0.12], [150, 0.18]]
    },
    trapMaxRow: 1,        // двух ловушек подряд не бывает
    trapNear: 0.5,        // ловушка ставится в ближней половине (чтобы не ждать её долго)
    spinBackAfter: [0, 1],// «крутится круг»: стрелка снова крутится — следующий сектор или через один
    spinRest: 2,          // после этого — хотя бы 2 сектора до нового «крутится круг»
    splitBackAfter: [0, 1],// раздвоение: снова одна стрелка — следующий сектор или через один
    splitRest: 2,         // после этого — хотя бы 2 сектора до нового раздвоения
    splitGapShare: 0.5,   // пока стрелок две: запас на реакцию — половина обычного (точку встречи видно заранее)
    splitFullChance: 0.3, // в 30% случаев сектор — через целый круг, иначе через полкруга
    afterSplitGap: 150,   // сектор сразу после раздвоения — не ближе 150°…
    afterSplitReactMs: 800,// …и не ближе, чем стрелка доедет за 0,8 с (вдвое больше обычного)
    mixFrom: 30           // до 30 попаданий, пока крутится круг или стрелок две, других особых секторов нет
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

  // Доля пути к CONFIG.fullAt (0 в начале игры, 1 — с fullAt-го сектора).
  function rampOf(hits) { return Math.min(1, Math.max(0, hits || 0) / CONFIG.fullAt); }
  // Сколько градусов минимум до нового сектора при такой скорости и таком числе попаданий.
  function gapFor(speed, hits) {
    var k = rampOf(hits);
    var deg = CONFIG.gapAhead + (CONFIG.gapAheadEnd - CONFIG.gapAhead) * k;
    var ms = CONFIG.reactMs + (CONFIG.reactMsEnd - CONFIG.reactMs) * k;
    return Math.max(deg, speed * ms / 1000);
  }

  // Центр нового сектора: впереди стрелки (по направлению движения) с запасом на реакцию.
  // r — случайное число от 0 до 1, dir — 1 по часовой или -1 против.
  // near — какую часть круга использовать (1 — весь, 0.5 — только ближнюю половину).
  // wide — сектор сразу после раздвоения: запас на реакцию больше обычного.
  // hits — сколько попаданий уже было: с ними дальний предел приближается, а место чаще выпадает ближе к стрелке.
  function placeSector(arrow, width, r, dir, speed, near, wide, hits) {
    var gap = wide ? Math.max(CONFIG.afterSplitGap, (speed || CONFIG.startSpeed) * CONFIG.afterSplitReactMs / 1000)
                   : gapFor(speed || CONFIG.startSpeed, hits);
    var k = rampOf(hits);
    var far = Math.min(360 - CONFIG.gapBehind, CONFIG.farStart + (CONFIG.farEnd - CONFIG.farStart) * k);
    var span = Math.max(0, far - gap - width) * (near || 1);
    return wrap(arrow + (dir === -1 ? -1 : 1) * (gap + width / 2 + Math.pow(r, 1 + CONFIG.nearBias * k) * span));
  }
  // Пока стрелок две (раздвоение): сектор — в точке, где стрелки встретятся. axis — точка раздвоения;
  // стрелки встречаются в axis и axis + 180°, то есть каждые полкруга. Ближайшая встреча (через полкруга) —
  // если до неё не меньше половины обычного запаса; в splitFullChance случаев (r) — следующая, через целый круг
  // (сектор появляется прямо под стрелками, они расходятся и встречаются в нём снова).
  // Возвращает путь стрелки до центра сектора в градусах (может быть чуть больше 360 — целый круг).
  function placeMirror(arrow, width, dir, speed, axis, hits, r) {
    var sign = dir === -1 ? -1 : 1;
    var gap = gapFor(speed || CONFIG.startSpeed, hits) * CONFIG.splitGapShare + width / 2;
    var d = wrap(sign * (axis - arrow)) % 180;
    while (d < gap) d += 180;
    if (r < CONFIG.splitFullChance && d + 180 <= 360 + width / 2) d += 180;
    return d;
  }
  // Случайное целое от a до b включительно. r — случайное число от 0 до 1.
  function between(range, r) { return range[0] + Math.min(range[1] - range[0], Math.floor(r * (range[1] - range[0] + 1))); }

  // Вес вида сектора при таком числе попаданий: плавно между точками из CONFIG.weights.
  function weightOf(kind, hits) {
    var pts = CONFIG.weights[kind];
    if (hits <= pts[0][0]) return pts[0][1];
    for (var i = 1; i < pts.length; i++) {
      if (hits <= pts[i][0]) {
        var a = pts[i - 1], b = pts[i];
        return a[1] + (b[1] - a[1]) * (hits - a[0]) / (b[0] - a[0]);
      }
    }
    return pts[pts.length - 1][1];
  }

  // Какой будет следующий сектор: 'normal', 'trap' (ловушка), 'rev' (разворот), 'spin' (крутится круг)
  // или 'split' (раздвоение). r — случайное число от 0 до 1. Порядок проверок:
  // 1) круг крутится / стрелок две и пора возвращать — бирюзовый / лаймовый;
  // 2) первое появление каждого вида — по порядку: красный, фиолетовый, бирюзовый, лаймовый;
  // 3) до CONFIG.mixFrom, пока крутится круг или стрелок две, — только обычные;
  // 4) иначе случайно, по весам — среди тех видов, что уже появлялись и сейчас возможны.
  //    «Крутится круг» и раздвоение никогда не идут одновременно.
  function pickKind(st, r) {
    if (st.spin && st.untilSpin <= 0) return 'spin';
    if (st.split && st.untilSplit <= 0) return 'split';
    if (!st.seen.trap && st.hits >= st.firstAt.trap) return 'trap';
    if (!st.seen.rev && st.hits >= st.firstAt.rev) return 'rev';
    if (!st.seen.spin && st.hits >= st.firstAt.spin && !st.split) return 'spin';
    if (!st.seen.split && st.hits >= st.firstAt.split && !st.spin) return 'split';
    if ((st.spin || st.split) && st.hits < CONFIG.mixFrom) return 'normal';
    var kinds = ['normal'];
    if (st.seen.trap && st.trapRow < CONFIG.trapMaxRow) kinds.push('trap');
    if (st.seen.rev) kinds.push('rev');
    if (st.seen.spin && !st.spin && !st.split && st.sinceSpin >= CONFIG.spinRest) kinds.push('spin');
    if (st.seen.split && !st.split && !st.spin && st.sinceSplit >= CONFIG.splitRest) kinds.push('split');
    var w = kinds.map(function (k) { return weightOf(k, st.hits); });
    var sum = w.reduce(function (a, b) { return a + b; }, 0), acc = 0;
    for (var i = 0; i < kinds.length; i++) { acc += w[i] / sum; if (r < acc) return kinds[i]; }
    return kinds[kinds.length - 1];
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

  // Минимально возможное время игры с таким числом попаданий — так же считает база (game_min_ms): по 45° на сектор
  // при скорости до 360. Это не строже настоящей игры (даже при двух стрелках запас не меньше ~45°), поэтому
  // честные результаты всегда проходят (база ещё и даёт запас 25%).
  function minTimeMs(hits) {
    var t = 0;
    for (var i = 0; i < hits; i++) t += 45 / Math.min(360, CONFIG.startSpeed + i * CONFIG.speedStep) * 1000;
    return t;
  }

  // Одна партия по зерну. Все t — мс от старта игры. opts.zones3 — очки по трём зонам (дуэль).
  function create(seed, opts) {
    var rnd = rng(seed);
    var zones3 = !!(opts && opts.zones3);
    var s = {
      seed: seed, zones3: zones3, phase: 'running', // running | transition | over
      a0: 0, t0: 0, speed: speedFor(0), dir: 1,
      kind: 'normal', spin: false, untilSpin: 0, sinceSpin: 0, trapRow: 0, traps: 0,
      split: false, axis: 0, untilSplit: 0, sinceSplit: 0, wide: false, // раздвоение: axis — где раздвоилась стрелка
      firstAt: { trap: 0, rev: 0, spin: 0, split: 0 },                 // на каком попадании впервые появится каждый вид
      seen: { trap: false, rev: false, spin: false, split: false },    // какие виды уже были в этой игре
      center: 0, width: widthFor(0), dist: 0, exitAt: 0, transitionEnd: 0, lockUntil: 0, // dist — путь стрелки до центра
      hits: 0, perfects: 0, score: 0, end: null, endAt: 0
    };
    function angleAt(t) { return wrap(s.a0 + s.dir * s.speed * Math.max(0, t - s.t0) / 1000); }
    function rebase(t) { s.a0 = angleAt(t); s.t0 = t; }
    // Когда стрелка проедет дальний край сектора (после этого — пропуск). dist — путь до центра от точки появления.
    function exitTime() { return s.t0 + (s.dist + s.width / 2) / s.speed * 1000; }
    s.firstAt.trap = between(CONFIG.firstTrap, rnd());
    s.firstAt.rev = between(CONFIG.firstReverse, rnd());
    s.firstAt.spin = between(CONFIG.firstSpin, rnd());
    s.firstAt.split = between(CONFIG.firstSplit, rnd());
    s.center = placeSector(0, s.width, rnd(), 1, s.speed);
    s.dist = wrap(s.center);
    s.exitAt = exitTime();

    function nextRound(t) {
      rebase(t);
      s.speed = speedFor(s.hits);
      s.width = widthFor(s.hits);
      s.kind = pickKind(s, rnd());
      s.trapRow = s.kind === 'trap' ? s.trapRow + 1 : 0;
      var r = rnd(), arrow = angleAt(t);
      if (s.split) {                                     // две стрелки — точка их встречи
        s.dist = placeMirror(arrow, s.width, s.dir, s.speed, s.axis, s.hits, r);
        s.center = wrap(arrow + s.dir * s.dist);
        // целый круг: стрелки сначала выходят из сектора — пока не выйдут, нажатия не считаются
        var firstPass = s.dist - 360 + s.width / 2;
        if (firstPass > 0) s.lockUntil = Math.max(s.lockUntil, t + firstPass / s.speed * 1000 + 1);
      } else {
        s.center = placeSector(arrow, s.width, r, s.dir, s.speed, s.kind === 'trap' ? CONFIG.trapNear : 1, s.wide, s.hits);
        s.dist = wrap(s.dir * (s.center - arrow));
      }
      s.wide = false;
      s.exitAt = exitTime();
      s.phase = 'running';
    }
    // Сектор пройден (попадание или ловушка позади) в момент t: счёт, смена режима, пауза до следующего.
    function cleared(t, kind, points) {
      s.hits += 1;
      if (kind === 'rev') { rebase(t); s.dir = -s.dir; }
      if (kind === 'spin') {
        s.spin = !s.spin;
        if (s.spin) s.untilSpin = between(CONFIG.spinBackAfter, rnd());
        else s.sinceSpin = 0;
      } else if (s.spin) s.untilSpin -= 1;
      else s.sinceSpin += 1;
      if (kind === 'split') {
        s.split = !s.split;
        if (s.split) { s.axis = angleAt(t); s.untilSplit = between(CONFIG.splitBackAfter, rnd()); }
        else { s.sinceSplit = 0; s.wide = true; }       // снова одна стрелка — следующий сектор дальше обычного
      } else if (s.split) s.untilSplit -= 1;
      else s.sinceSplit += 1;
      if (kind !== 'normal') s.seen[kind] = true;
      s.score += points;
      s.phase = 'transition';
      s.transitionEnd = t + (kind === 'trap' ? CONFIG.afterTrapMs : CONFIG.transitionMs);
      s.lockUntil = t + CONFIG.pressLockMs;
    }
    // Довести игру до момента t: стрелка проехала ловушку — она пройдена (ровно в момент выезда);
    // пауза между раундами закончилась — новый сектор (ровно в её конце).
    function tick(t) {
      for (var guard = 0; guard < 100; guard++) {
        if (s.phase === 'running' && s.kind === 'trap' && t > s.exitAt) { s.traps += 1; cleared(s.exitAt, 'trap', 1); }
        else if (s.phase === 'transition' && t >= s.transitionEnd) nextRound(s.transitionEnd);
        else break;
      }
    }
    function finish(t, reason) {
      if (s.phase === 'over') return;
      rebase(t); s.speed = 0; s.phase = 'over'; s.end = reason; s.endAt = t;
    }
    // Стрелка уже проехала сектор без нажатия? (ловушку проехать как раз и надо)
    function skipDue(t) { tick(t); return s.phase === 'running' && s.kind !== 'trap' && t > s.exitAt; }
    // Нажатие в момент t. Возвращает null (не считается — пауза между раундами или игра окончена)
    // или { res: 'perfect' | 'good' | 'hit' | 'miss' | 'skip' | 'trap', kind, points }.
    // 'trap' — нажатие на ловушке: проигрыш (для сервера и базы это 'miss').
    function press(t) {
      if (s.phase === 'over') return null;
      tick(t);
      if (s.phase !== 'running' || t < s.lockUntil) return null;   // пауза или защита от двойного касания
      if (s.kind === 'trap') { finish(Math.max(t, s.t0), 'miss'); return { res: 'trap', kind: 'trap' }; }
      if (t > s.exitAt) { finish(s.exitAt, 'skip'); return { res: 'skip', kind: s.kind }; }
      if (t < s.t0) t = s.t0;
      var res = (zones3 ? judge3 : judge)(angleAt(t), s.center, s.width);
      if (res === 'miss') { finish(t, 'miss'); return { res: 'miss', kind: s.kind }; }
      var kind = s.kind;
      var points = res === 'perfect' ? (zones3 ? 3 : 2) : res === 'good' ? 2 : 1;
      if (res === 'perfect') s.perfects += 1;
      cleared(t, kind, points);
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
    judge: judge, judge3: judge3, goodWidth: goodWidth, gapFor: gapFor, rampOf: rampOf, placeSector: placeSector, between: between, pickKind: pickKind, weightOf: weightOf, placeMirror: placeMirror,
    rng: rng, randomSeed: randomSeed, minTimeMs: minTimeMs, create: create, replay: replay
  };
  root.SectorCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
