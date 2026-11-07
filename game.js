/* «Сектор» — аркада на реакцию, точность и опыт.
   Стрелка вращается по часовой стрелке; нажми, когда она внутри выделенного сектора.
   Иногда сектор фиолетовый — это разворот: попал в него, и стрелка крутится в другую сторону.
   Следующий фиолетовый (возврат по часовой) может быть сразу или через 1–4 попадания.
   С 16-го сектора бывает бирюзовый — «крутится круг»: стрелка замирает, а вращается весь круг
   вместе с делениями, сектором и счётом. Следующий бирюзовый снова запускает стрелку, а круг
   останавливается где был (счёт может остаться вверх ногами). До 30 попаданий режимы идут по одному,
   с 30 — могут идти одновременно.
   Внутри игра считает угол стрелки ОТНОСИТЕЛЬНО круга — он меняется с той же скоростью в любом режиме,
   поэтому проверка честности в базе (game_min_ms) не меняется.
   Углы считаются в градусах по часовой стрелке от 12 часов.
   Модуль отдаёт window.SectorGame: настройки, чистые функции (их удобно проверять) и mount() для экрана игры. */
(function (root) {
  'use strict';

  // Все параметры игры в одном месте. Если меняешь скорость, шаг или переход —
  // поменяй те же числа в функции базы game_min_ms, иначе честные результаты могут не засчитаться.
  var CONFIG = {
    startSpeed: 110,      // градусов в секунду
    speedStep: 6,         // прибавка скорости за каждое попадание
    maxSpeed: 360,
    startWidth: 64,       // ширина сектора, градусы
    widthStep: 1.0,       // уменьшение ширины за каждое попадание (было 1.6 — сужался быстрее)
    widthStopAt: 35,      // после 35 попаданий сектор больше не сужается: 64 − 35 = 29°
    minWidth: 16,
    perfectShare: 0.2,    // центральные 20% сектора — PERFECT
    minPerfect: 4,        // но PERFECT-зона не уже 4°
    gapAhead: 90,         // новый сектор начинается не ближе 90° впереди стрелки
    gapBehind: 40,        // и заканчивается не ближе 40° позади неё
    transitionMs: 300,    // пауза между раундами
    // Развороты (фиолетовые сектора). Числа — сколько обычных попаданий до следующего разворота.
    firstReverse: [4, 7], // первый разворот — 5-й…8-й сектор игры
    backAfter: [0, 4],    // возврат по часовой — сразу (0) или через 1–4 попадания после разворота
    nextReverse: [5, 9],  // следующий разворот — через 5–9 попаданий после возврата
    // «Крутится круг» (бирюзовые сектора). Числа — сколько попаданий до следующего бирюзового.
    firstSpin: [15, 19],  // первый — 16-й…20-й сектор игры
    spinBackAfter: [2, 5],// стрелка снова крутится — через 2–5 попаданий
    nextSpin: [6, 10],    // следующий «крутится круг» — через 6–10 попаданий
    mixFrom: 30,          // с 30 попаданий разворот и «крутится круг» могут идти одновременно
    glowFull: 40,         // рамка разгорается на полную к 40-му сектору
    countdownMs: 600      // один шаг обратного отсчёта после возврата на вкладку
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

  // Центр нового сектора: впереди стрелки с запасом на реакцию. r — случайное число от 0 до 1.
  // dir — куда крутится стрелка: 1 — по часовой, -1 — против. «Впереди» считается по направлению движения,
  // поэтому запас на реакцию и проверка базы (game_min_ms) одинаковые в обе стороны.
  function placeSector(arrow, width, r, dir) {
    var span = Math.max(0, 360 - CONFIG.gapAhead - CONFIG.gapBehind - width);
    return wrap(arrow + (dir === -1 ? -1 : 1) * (CONFIG.gapAhead + width / 2 + r * span));
  }
  // Случайное целое от a до b включительно. r — случайное число от 0 до 1.
  function between(range, r) { return range[0] + Math.min(range[1] - range[0], Math.floor(r * (range[1] - range[0] + 1))); }

  // Какой будет следующий сектор: 'normal', 'rev' (разворот) или 'spin' (крутится круг).
  // st = { hits, dir, spin, untilRev, untilSpin }. До CONFIG.mixFrom режимы не пересекаются:
  // разворот не начинается, пока крутится круг, и круг не начинает крутиться во время разворота.
  // Если оба «созрели» сразу — первым идёт тот, что возвращает к обычной игре; второй — в следующий раз.
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

  // Минимально возможное время игры с таким числом попаданий (так же считает база).
  function minTimeMs(hits) {
    var t = 0;
    for (var i = 0; i < hits; i++) t += CONFIG.gapAhead / speedFor(i) * 1000;
    return t + Math.max(hits - 1, 0) * CONFIG.transitionMs;
  }

  var reduceMotion = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) { if (window.Coin) window.Coin.fill(n, text); else n.textContent = text; } // 🪙 → наша монета
    return n;
  }

  /* Экран игры. container — пустой элемент. opts:
     best()                — текущий личный рекорд (число);
     onStart()             — вызывается в начале игры;
     onOver(result)        — result = { score, hits, perfects }; может вернуть Promise<{ best, newRecord }>;
     onStateChange(state)  — 'start' | 'play' | 'over', чтобы сайт знал, что идёт игра.
     Возвращает { destroy } — останавливает анимацию и снимает обработчики. */
  function mount(container, opts) {
    opts = opts || {};
    var css = {}; // цвета берём из CSS-переменных сайта
    function readColors() {
      var s = getComputedStyle(document.documentElement);
      function v(name, fb) { var x = s.getPropertyValue(name).trim(); return x || fb; }
      css = {
        line: v('--line', '#333131'), ink: v('--ink', '#E8E6E3'), muted: v('--muted', '#A0968E'),
        accent: v('--accent', '#F2782C'), btn: v('--btn', '#C4500B'), surface: v('--surface', '#1E1E1E'),
        tile: v('--tile', '#262422'), err: v('--err', '#FF7A6B'),
        special: v('--special', '#9B7BFF'), specialHi: v('--special-hi', '#CDBEFF'),
        turq: v('--turq', '#2EC4B6'), turqHi: v('--turq-hi', '#A6EEE6')
      };
    }
    readColors();

    var wrapEl = h('div', 'sector');
    var field = h('div', 'sector-field');
    field.setAttribute('role', 'button');
    field.setAttribute('aria-label', 'Игровое поле: нажми в любом месте экрана, когда стрелка в секторе');
    var canvas = h('canvas', 'sector-canvas');
    var hub = h('div', 'sector-hub');
    var scoreEl = h('div', 'sector-score', '0');
    var scoreRot = h('div', 'sector-rot');   // поворачивается вместе с кругом
    var hint = h('div', 'sector-hint', '');
    scoreRot.appendChild(scoreEl);
    hub.appendChild(scoreRot); hub.appendChild(hint);
    var pop = h('div', 'sector-pop', '');
    pop.setAttribute('aria-live', 'polite');
    field.appendChild(canvas); field.appendChild(hub); field.appendChild(pop);
    var panel = h('div', 'sector-panel');
    // светящаяся рамка: glow разгорается с попаданиями, flash — вспышка цветом особого сектора
    var glowEl = h('div', 'sector-glow'), flashEl = h('div', 'sector-flash');
    glowEl.setAttribute('aria-hidden', 'true'); flashEl.setAttribute('aria-hidden', 'true');
    wrapEl.appendChild(glowEl); wrapEl.appendChild(flashEl);
    wrapEl.appendChild(field); wrapEl.appendChild(panel);
    container.appendChild(wrapEl);

    var ctx = canvas.getContext('2d');
    var size = 300, dpr = 1;

    // Состояние одной игры.
    var screen = 'start';   // start | play | over
    var phase = 'idle';     // running | transition | paused | countdown | dead
    var a0 = 0, t0 = 0, speed = CONFIG.startSpeed;
    var dir = 1;            // 1 — по часовой, -1 — против (после фиолетового сектора)
    var kind = 'normal';    // текущий сектор: normal | rev (фиолетовый разворот) | spin (бирюзовый «крутится круг»)
    var untilRev = 0;       // сколько попаданий до следующего разворота
    var untilSpin = 0;      // сколько попаданий до следующего бирюзового
    var spin = false;       // сейчас крутится круг, а стрелка стоит
    var rot = 0;            // на сколько градусов повёрнут круг на экране (когда он не крутится)
    var arrowScreen = 0;    // где стоит стрелка на экране, пока крутится круг
    var rotShown = null;    // последний поворот счёта (чтобы не трогать страницу каждый кадр зря)
    var center = 120, width = CONFIG.startWidth;
    var hits = 0, perfects = 0, score = 0;
    var transitionEnd = 0, sectorFadeFrom = 0;
    var pauseAt = 0, pauseAngle = 0, countdownEnd = 0, transitionLeft = 0;
    var pulseAt = -1, missAt = -1;
    var raf = 0, destroyed = false;

    // Угол стрелки относительно круга (по нему и считается попадание).
    function angleAt(t) { return wrap(a0 + dir * speed * Math.max(0, t - t0) / 1000); }
    function rebase(t) { a0 = angleAt(t); t0 = t; }
    // Поворот круга на экране при таком относительном угле стрелки:
    // пока крутится круг, стрелка на экране стоит, значит круг повёрнут на (где стрелка − её угол на круге).
    function dialRot(rel) { return spin ? wrap(arrowScreen - rel) : rot; }
    // Переключить «крутится круг» в момент t (стрелка и круг продолжают движение без рывка)
    function toggleSpin(t) {
      var rel = angleAt(t);
      if (!spin) { arrowScreen = wrap(rel + rot); spin = true; }
      else { rot = wrap(arrowScreen - rel); spin = false; }
    }
    // Рамка: чем дальше в игре, тем ярче (0 — нет, 1 — на полную)
    function setGlow(v) { wrapEl.style.setProperty('--glow', String(Math.max(0, Math.min(1, v)))); }
    function flash(color) {
      if (!flashEl.animate) return;
      flashEl.style.setProperty('--fc', color);
      flashEl.animate(reduceMotion
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 0.35, offset: 0.2 }, { opacity: 1, offset: 0.32 }, { opacity: 0 }],
        { duration: 1200, easing: 'ease-out' });
    }

    function resize() {
      var w = Math.min(field.clientWidth || 300, 360);
      size = Math.max(200, Math.floor(w));
      dpr = Math.min(root.devicePixelRatio || 1, 3);
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      canvas.style.width = size + 'px';
      canvas.style.height = size + 'px';
      field.style.height = size + 'px';
      draw(performance.now());
    }

    function rad(deg) { return (deg - 90) * Math.PI / 180; }

    function draw(now) {
      var c = size / 2, R = size / 2 - 18;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      // угол стрелки относительно круга и поворот круга на экране
      var ang = (screen === 'play' && (phase === 'running' || phase === 'transition')) ? angleAt(now)
        : (phase === 'paused' || phase === 'countdown') ? pauseAngle : a0;
      var turn = dialRot(ang);
      if (turn) { ctx.translate(c, c); ctx.rotate(turn * Math.PI / 180); ctx.translate(-c, -c); }
      var shown = Math.round(turn * 10) / 10;
      if (shown !== rotShown) { rotShown = shown; scoreRot.style.transform = shown ? 'rotate(' + shown + 'deg)' : ''; }
      // дорожка
      ctx.lineWidth = 12; ctx.strokeStyle = css.tile;
      ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.stroke();
      // деления, как на циферблате
      ctx.strokeStyle = css.line; ctx.lineWidth = 2; ctx.lineCap = 'round';
      for (var i = 0; i < 12; i++) {
        var a = rad(i * 30);
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * (R - 22), c + Math.sin(a) * (R - 22));
        ctx.lineTo(c + Math.cos(a) * (R - (i % 3 === 0 ? 32 : 28)), c + Math.sin(a) * (R - (i % 3 === 0 ? 32 : 28)));
        ctx.stroke();
      }
      // сектор
      var alpha = 1;
      if (phase === 'transition') alpha = Math.max(0, 1 - (now - sectorFadeFrom) / (CONFIG.transitionMs * 0.6));
      if (screen !== 'play' && screen !== 'over') alpha = 0.9;
      if (alpha > 0) {
        var dead = missAt >= 0;
        ctx.globalAlpha = alpha;
        ctx.lineCap = 'butt';
        ctx.lineWidth = 24;
        ctx.strokeStyle = dead ? css.err : kind === 'rev' ? css.special : kind === 'spin' ? css.turq : css.btn;
        ctx.beginPath(); ctx.arc(c, c, R, rad(center - width / 2), rad(center + width / 2)); ctx.stroke();
        var pw = perfectWidth(width);
        ctx.strokeStyle = dead ? css.err : kind === 'rev' ? css.specialHi : kind === 'spin' ? css.turqHi : '#FFB37A';
        ctx.beginPath(); ctx.arc(c, c, R, rad(center - pw / 2), rad(center + pw / 2)); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // мягкое кольцо при PERFECT
      if (pulseAt >= 0 && !reduceMotion) {
        var k = (now - pulseAt) / 450;
        if (k < 1) {
          ctx.globalAlpha = 0.5 * (1 - k);
          ctx.strokeStyle = css.accent; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(c, c, R + 4 + k * 12, 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = 1;
        } else pulseAt = -1;
      }
      // стрелка (рисуем в повёрнутом круге по её углу на круге — на экране она там, где нужно)
      var hubR = size * 0.17;
      var ar = rad(ang);
      ctx.strokeStyle = missAt >= 0 ? css.err : css.ink;
      ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(ar) * (hubR - 2), c + Math.sin(ar) * (hubR - 2));
      ctx.lineTo(c + Math.cos(ar) * (R + 8), c + Math.sin(ar) * (R + 8));
      ctx.stroke();
      // центр (в нём счёт)
      ctx.fillStyle = css.surface;
      ctx.beginPath(); ctx.arc(c, c, hubR, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = css.line; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(c, c, hubR, 0, Math.PI * 2); ctx.stroke();
    }

    function frame(now) {
      raf = 0;
      if (destroyed) return;
      if (screen === 'play') {
        if (phase === 'transition' && now >= transitionEnd) nextRound(now);
        if (phase === 'countdown') {
          var left = countdownEnd - now;
          if (left <= 0) resume(now);
          else hint.textContent = String(Math.ceil(left / CONFIG.countdownMs));
        }
      }
      draw(now);
      if (screen === 'play' && phase !== 'dead' && phase !== 'paused') loop();
      else if (pulseAt >= 0 || missAt >= 0) loop();
    }
    function loop() { if (!raf && !destroyed) raf = requestAnimationFrame(frame); }

    function setScore(v) { scoreEl.textContent = String(v); }

    function start() {
      screen = 'play'; phase = 'running';
      hits = 0; perfects = 0; score = 0; missAt = -1; pulseAt = -1;
      speed = speedFor(0); width = widthFor(0);
      var now = performance.now();
      a0 = 0; t0 = now;
      dir = 1; kind = 'normal'; spin = false; rot = 0; arrowScreen = 0;
      untilRev = between(CONFIG.firstReverse, Math.random());
      untilSpin = between(CONFIG.firstSpin, Math.random());
      setGlow(0);
      center = placeSector(0, width, Math.random(), 1);
      setScore(0); hint.textContent = ''; pop.textContent = ''; pop.className = 'sector-pop';
      wrapEl.classList.add('playing'); wrapEl.classList.remove('over');
      document.documentElement.classList.add('sector-on');
      renderPanel();
      if (opts.onStateChange) opts.onStateChange('play');
      if (opts.onStart) { try { opts.onStart(); } catch (e) { /* игра идёт и без базы */ } }
      field.focus({ preventScroll: true });
      loop();
    }

    function nextRound(now) {
      rebase(now);
      speed = speedFor(hits);
      width = widthFor(hits);
      kind = pickKind({ hits: hits, dir: dir, spin: spin, untilRev: untilRev, untilSpin: untilSpin });
      center = placeSector(angleAt(now), width, Math.random(), dir);
      phase = 'running';
    }

    function showPop(text, cls) {
      pop.textContent = text;
      pop.className = 'sector-pop ' + cls;
      void pop.offsetWidth; // перезапуск анимации
      pop.classList.add('show');
    }

    function press(ts) {
      if (screen !== 'play' || phase !== 'running') return; // во время перехода, паузы и отсчёта нажатия не считаются
      var now = performance.now();
      var t = (typeof ts === 'number' && ts > 0 && Math.abs(ts - now) < 1000) ? ts : now;
      if (t < t0) t = t0;
      var res = judge(angleAt(t), center, width);
      if (res === 'miss') { lose(t); return; }
      hits += 1;
      if (kind === 'rev') {
        // разворот: стрелка (или круг) сразу крутится в другую сторону
        rebase(t);
        dir = -dir;
        untilRev = between(dir === -1 ? CONFIG.backAfter : CONFIG.nextReverse, Math.random());
        untilSpin -= 1;
        flash(css.special);
      } else if (kind === 'spin') {
        // «крутится круг»: стрелка замирает и крутится круг — или наоборот
        rebase(t);
        toggleSpin(t);
        untilSpin = between(spin ? CONFIG.spinBackAfter : CONFIG.nextSpin, Math.random());
        untilRev -= 1;
        flash(css.turq);
      } else { untilRev -= 1; untilSpin -= 1; }
      setGlow(hits / CONFIG.glowFull);
      if (res === 'perfect') { perfects += 1; score += 2; pulseAt = now; showPop('PERFECT +2', 'perfect'); }
      else { score += 1; }
      setScore(score);
      scoreEl.classList.remove('bump'); void scoreEl.offsetWidth; scoreEl.classList.add('bump');
      phase = 'transition';
      sectorFadeFrom = now;
      transitionEnd = now + CONFIG.transitionMs;
      loop();
    }

    function lose(t) {
      rebase(t);
      speed = 0; // стрелка замирает там, где было нажатие
      phase = 'dead';
      missAt = performance.now();
      setGlow(0);
      wrapEl.classList.remove('playing');
      document.documentElement.classList.remove('sector-on');
      draw(performance.now());
      var result = { score: score, hits: hits, perfects: perfects };
      var prevBest = opts.best ? (opts.best() || 0) : 0;
      setTimeout(function () {
        if (destroyed) return;
        screen = 'over';
        wrapEl.classList.add('over');
        renderPanel(result, prevBest, null);
        if (opts.onStateChange) opts.onStateChange('over');
        var p = opts.onOver ? opts.onOver(result) : null;
        if (p && typeof p.then === 'function') {
          p.then(function (info) { if (!destroyed && screen === 'over') renderPanel(result, prevBest, info || null); })
            .catch(function () { /* показали локальный результат */ });
        }
      }, reduceMotion ? 150 : 450);
    }

    function pause() {
      if (screen !== 'play' || (phase !== 'running' && phase !== 'transition' && phase !== 'countdown')) return;
      var now = performance.now();
      if (phase !== 'countdown') {
        pauseAngle = angleAt(now);
        transitionLeft = phase === 'transition' ? Math.max(0, transitionEnd - now) : -1;
      }
      pauseAt = now;
      phase = 'paused';
      hint.textContent = '❚❚';
    }

    function startCountdown() {
      if (screen !== 'play' || phase !== 'paused') return;
      phase = 'countdown';
      countdownEnd = performance.now() + CONFIG.countdownMs * 3;
      loop();
    }

    function resume(now) {
      a0 = pauseAngle; t0 = now;
      hint.textContent = '';
      if (transitionLeft >= 0) { phase = 'transition'; transitionEnd = now + transitionLeft; sectorFadeFrom = now - CONFIG.transitionMs; }
      else phase = 'running';
    }

    function renderPanel(result, prevBest, info) {
      panel.replaceChildren();
      if (screen === 'start') {
        panel.appendChild(h('p', 'sector-lead', 'Останови стрелку в выделенном секторе'));
        var b = opts.best ? (opts.best() || 0) : 0;
        panel.appendChild(h('p', 'sector-best', 'Личный рекорд: ' + b));
        var btn = h('button', 'btn primary sector-play', 'Играть');
        btn.type = 'button';
        btn.addEventListener('click', function (ev) { ev.stopPropagation(); start(); });
        panel.appendChild(btn);
      } else if (screen === 'over') {
        var best = Math.max(prevBest || 0, result.score, info && info.best ? info.best : 0);
        var isNew = result.score > 0 && result.score > (prevBest || 0);
        panel.appendChild(h('p', 'sector-over', 'GAME OVER'));
        if (isNew) panel.appendChild(h('p', 'sector-new', 'NEW RECORD!'));
        var row = h('div', 'sector-stats');
        function stat(n, l) { var s = h('div', 'sector-stat'); s.appendChild(h('span', 'n', String(n))); s.appendChild(h('span', 'l', l)); return s; }
        row.appendChild(stat(result.score, 'очки'));
        row.appendChild(stat(result.perfects, 'perfect'));
        row.appendChild(stat(best, 'рекорд'));
        panel.appendChild(row);
        if (info && info.valid === false) panel.appendChild(h('p', 'sector-warn', 'Этот результат не прошёл проверку и не попадёт в рейтинг.'));
        // баллы за игру (их начисляет база: 1 балл за 10 очков, без ограничений)
        if (info && info.valid !== false && typeof info.points === 'number') {
          var txt = info.points > 0
            ? '+' + info.points + ' 🪙 за эту игру'
            : 'Монеты: 1 за каждые 10 очков';
          panel.appendChild(h('p', 'sector-points' + (info.points > 0 ? ' got' : ''), txt));
        }
        var again = h('button', 'btn primary sector-play', 'Играть ещё');
        again.type = 'button';
        again.addEventListener('click', function (ev) { ev.stopPropagation(); start(); });
        panel.appendChild(again);
        setTimeout(function () { if (!destroyed) again.focus({ preventScroll: true }); }, 0);
      }
    }

    // Ввод: касание или клик в любом месте экрана (кроме меню сайта), пробел на клавиатуре.
    // Так палец не закрывает круг: можно нажимать хоть под ним.
    function onPointer(ev) {
      if (screen !== 'play') return;
      if (ev.button !== undefined && ev.button > 0) return;
      var t = ev.target;
      if (t && t.closest && t.closest('.bottom-nav, nav.tabs, .me, a, .install-hint, .toast')) return; // на всякий случай: меню во время игры и так не нажимается (см. style.css)
      ev.preventDefault();
      press(ev.timeStamp);
    }
    function onKey(ev) {
      if (screen !== 'play') return;
      if (ev.code === 'Space' || ev.key === ' ') {
        ev.preventDefault();
        if (!ev.repeat) press(ev.timeStamp);
      }
    }
    function onVisibility() { if (document.hidden) pause(); else startCountdown(); }
    function onBlur() { pause(); }
    function onFocus() { if (!document.hidden) startCountdown(); }

    field.tabIndex = 0;
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
    root.addEventListener('blur', onBlur);
    root.addEventListener('focus', onFocus);
    root.addEventListener('resize', resize);

    renderPanel();
    // Размер считаем, когда элемент уже на странице.
    requestAnimationFrame(function () { if (!destroyed) resize(); });

    return {
      destroy: function () {
        destroyed = true;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        document.removeEventListener('pointerdown', onPointer);
        document.documentElement.classList.remove('sector-on');
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('visibilitychange', onVisibility);
        root.removeEventListener('blur', onBlur);
        root.removeEventListener('focus', onFocus);
        root.removeEventListener('resize', resize);
        if (opts.onStateChange) opts.onStateChange('gone');
      },
      // для проверок
      _state: function () {
        var now = performance.now(), rel = angleAt(now);
        return { screen: screen, phase: phase, hits: hits, perfects: perfects, score: score, center: center, width: width, speed: speed, dir: dir,
          kind: kind, special: kind === 'rev', spin: spin, untilRev: untilRev, untilSpin: untilSpin, angle: rel, rot: dialRot(rel), arrowScreen: wrap(rel + dialRot(rel)) };
      },
      _press: press
    };
  }

  var api = {
    CONFIG: CONFIG, speedFor: speedFor, widthFor: widthFor, perfectWidth: perfectWidth,
    norm: norm, judge: judge, placeSector: placeSector, between: between, pickKind: pickKind, minTimeMs: minTimeMs, mount: mount
  };
  root.SectorGame = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
