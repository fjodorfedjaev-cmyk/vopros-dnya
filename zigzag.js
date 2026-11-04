/* «Зигзаг» — игра на реакцию.
   Шарик сам катится по дорожке-зигзагу. Нажатие меняет направление: вверх-вправо ↔ вверх-влево.
   Не повернул вовремя или повернул раньше — шарик падает с дорожки, игра окончена.
   Очко — за каждый удачный поворот. Чем больше очков, тем быстрее шарик и тем короче прямые участки.
   На дорожке лежат монеты: шарик собирает их сам, каждая — 1 монета сайта (начисляет база после партии).
   Модуль отдаёт window.ZigzagGame: настройки, логику без экрана (её удобно проверять) и mount() для экрана игры. */
(function (root) {
  'use strict';

  // Все параметры игры в одном месте. Когда за игру будет начисляться золото,
  // сервер должен будет проверять результат по этим же числам (как «Сектор» в game_min_ms).
  var CONFIG = {
    startSpeed: 2.2,      // плиток в секунду в начале
    speedStep: 0.07,      // прибавка скорости за каждое очко
    maxSpeed: 6.2,        // потолок скорости (достигается примерно на 57 очках)
    startRun: 4,          // длина первого прямого участка
    // длина прямых участков: чем больше очков, тем они короче — повороты чаще
    lengths: [
      { from: 0, min: 2, max: 5 },
      { from: 10, min: 1, max: 4 },
      { from: 30, min: 1, max: 3 }
    ],
    // Монеты на дорожке: первая не раньше плитки №8 (9-я по счёту), дальше не ближе coinGap плиток друг к другу,
    // после этого на каждой плитке шанс coinChance. В среднем одна монета на ~26 плиток.
    // По партиям друзей: 7,7 монеты в минуту (было 5,9 при coinGap 25, а до того 4,0 с кристаллами).
    // Те же числа проверяет база (zz_max_coins).
    coinFrom: 8,
    coinGap: 16,
    coinChance: 0.1,
    ahead: 40,            // сколько плиток дорожки держать готовыми впереди шарика
    countdownMs: 600,     // один шаг обратного отсчёта после возврата на вкладку
    fallMs: 650           // сколько длится падение шарика
  };

  function speedFor(score) { return Math.min(CONFIG.maxSpeed, CONFIG.startSpeed + score * CONFIG.speedStep); }
  function lengthRange(score) {
    var r = CONFIG.lengths[0];
    for (var i = 0; i < CONFIG.lengths.length; i++) if (score >= CONFIG.lengths[i].from) r = CONFIG.lengths[i];
    return r;
  }
  // rnd — случайное число от 0 до 1
  function segmentLength(score, rnd) {
    var r = lengthRange(score);
    return r.min + Math.min(r.max - r.min, Math.floor(rnd * (r.max - r.min + 1)));
  }

  /* ---------- логика без экрана ----------
     Дорожка лежит на сетке. Направление 'x' — шаг по x (на экране вверх-вправо), 'y' — шаг по y (вверх-влево).
     Каждая плитка помнит номер участка (seg). Шарик перешёл на плитку нового участка — значит, повернул удачно: +1 очко.
     Шарик стоит на плитке, если его центр (округлённый) попадает в плитку дорожки. Нет плитки — падение. */
  function createRun(rand) {
    rand = rand || Math.random;
    var tiles = [];
    var at = {};
    var endX = -1, endY = 0, genDir = 'x', genSeg = 0, lastCoin = -1000;

    function add(x, y, seg) {
      var i = tiles.length;
      var coin = i >= CONFIG.coinFrom && i - lastCoin >= CONFIG.coinGap && rand() < CONFIG.coinChance;
      if (coin) lastCoin = i;
      at[x + ',' + y] = i;
      tiles.push({ x: x, y: y, seg: seg, gone: 0, coin: coin, got: 0 });
    }
    function addSegment(dir, len, seg) {
      for (var i = 0; i < len; i++) {
        if (dir === 'x') endX += 1; else endY += 1;
        add(endX, endY, seg);
      }
    }

    var run = {
      tiles: tiles,
      bx: 0, by: 0,       // центр шарика на сетке
      dir: 'x',
      score: 0,           // удачные повороты
      tile: 0,            // номер плитки под шариком
      seg: 0,
      coins: 0,           // собранные монеты
      alive: true,
      turns: 0,           // все нажатия
      tileAt: function (x, y) { var k = at[x + ',' + y]; return k === undefined ? -1 : k; },
      speed: function () { return speedFor(run.score); },
      turn: function () {
        if (!run.alive) return;
        run.dir = run.dir === 'x' ? 'y' : 'x';
        run.turns += 1;
      },
      // Сдвинуть шарик на sec секунд. Маленькими шагами, чтобы на большой скорости не «перепрыгнуть» край.
      advance: function (sec) {
        if (!run.alive || !(sec > 0)) return;
        var dist = speedFor(run.score) * sec;
        var steps = Math.max(1, Math.ceil(dist / 0.05));
        for (var i = 0; i < steps; i++) {
          if (run.dir === 'x') run.bx += dist / steps; else run.by += dist / steps;
          var k = run.tileAt(Math.round(run.bx), Math.round(run.by));
          if (k < 0) { run.alive = false; break; }
          if (k > run.tile) {
            // проехал по плиткам — собрал монеты на них
            for (var j = run.tile + 1; j <= k; j++) if (tiles[j].coin && !tiles[j].got) { tiles[j].got = -1; run.coins += 1; }
            run.tile = k;
          }
          var s = tiles[k].seg;
          if (s > run.seg) { run.score += s - run.seg; run.seg = s; }
        }
        extend();
      }
    };

    function extend() {
      while (tiles.length - run.tile < CONFIG.ahead) {
        genDir = genDir === 'x' ? 'y' : 'x';
        genSeg += 1;
        // номер участка = сколько очков будет у игрока, когда шарик до него доедет
        addSegment(genDir, segmentLength(genSeg, rand()), genSeg);
      }
    }

    addSegment('x', CONFIG.startRun, 0);
    extend();
    return run;
  }

  var reduceMotion = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /* ---------- экран игры ----------
     container — пустой элемент. opts:
     best()                — текущий личный рекорд (число);
     onStart()             — вызывается в начале игры (сайт заводит партию в базе);
     onOver(result)        — result = { score, tiles, coins }; может вернуть Promise<{ best, valid, coins }>;
     onStateChange(state)  — 'start' | 'play' | 'over' | 'gone', чтобы сайт знал, что идёт игра.
     Возвращает { destroy } — останавливает анимацию и снимает обработчики. */
  function mount(container, opts) {
    opts = opts || {};
    var css = {};
    (function readColors() {
      var s = getComputedStyle(document.documentElement);
      function v(name, fb) { var x = s.getPropertyValue(name).trim(); return x || fb; }
      css = { ink: v('--ink', '#E8E6E3'), muted: v('--muted', '#A0968E'), accent: v('--accent', '#F2782C'),
              btn: v('--btn', '#C4500B'), err: v('--err', '#FF7A6B') };
    })();
    var TOP = '#45403C', LEFT = css.btn, RIGHT = '#8E3D0B';

    var wrapEl = h('div', 'sector zz');
    var field = h('div', 'zz-field');
    field.setAttribute('role', 'button');
    field.setAttribute('aria-label', 'Игровое поле: нажми в любом месте экрана, чтобы шарик повернул');
    var canvas = h('canvas', 'zz-canvas');
    var scoreEl = h('div', 'sector-score zz-score', '0');
    var gemsEl = h('div', 'zz-gems', '🪙 0');
    gemsEl.setAttribute('aria-label', 'Монеты за партию');
    var hint = h('div', 'sector-hint zz-hint', '');
    field.appendChild(canvas); field.appendChild(scoreEl); field.appendChild(gemsEl); field.appendChild(hint);
    var panel = h('div', 'sector-panel');
    wrapEl.appendChild(field); wrapEl.appendChild(panel);
    container.appendChild(wrapEl);

    var ctx = canvas.getContext('2d');
    var W = 320, H = 400, dpr = 1, TW = 50, TH = 25, D = 20;

    var screen = 'start';   // start | play | over
    var phase = 'idle';     // running | paused | countdown | falling
    var run = createRun();
    var lastT = 0, fallAt = 0, countdownEnd = 0;
    var camX = 0, camY = 0;
    var raf = 0, destroyed = false;

    function proj(x, y) { return { x: (x - y) * TW / 2, y: -(x + y) * TH / 2 }; }

    function resize() {
      var w = Math.min(field.clientWidth || 320, 420);
      W = Math.max(240, Math.floor(w));
      H = Math.round(Math.min(W * 0.92, 380)); // поле ниже, чтобы кнопка «Играть» помещалась на экран
      TW = W / 6.4; TH = TW / 2; D = TW * 0.42;
      dpr = Math.min(root.devicePixelRatio || 1, 3);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      field.style.height = H + 'px';
      snapCamera();
      draw(performance.now());
    }
    function snapCamera() { var p = proj(run.bx, run.by); camX = p.x; camY = p.y; }

    function tilePath(sx, sy) {
      ctx.beginPath();
      ctx.moveTo(sx, sy - TH / 2); ctx.lineTo(sx + TW / 2, sy); ctx.lineTo(sx, sy + TH / 2); ctx.lineTo(sx - TW / 2, sy);
      ctx.closePath();
    }
    function drawTile(t, ox, oy, now) {
      var alpha = 1, drop = 0;
      if (t.gone) {
        var k = (now - t.gone) / 700;
        if (k >= 1) return;
        alpha = 1 - k;
        if (!reduceMotion) drop = k * k * H * 0.5;
      }
      var p = proj(t.x, t.y);
      var sx = p.x + ox, sy = p.y + oy + drop;
      if (sy < -TH * 2 || sy > H + TH * 2) return;
      ctx.globalAlpha = alpha;
      // левая и правая боковые грани, потом верх
      ctx.fillStyle = LEFT;
      ctx.beginPath(); ctx.moveTo(sx - TW / 2, sy); ctx.lineTo(sx, sy + TH / 2); ctx.lineTo(sx, sy + TH / 2 + D); ctx.lineTo(sx - TW / 2, sy + D); ctx.closePath(); ctx.fill();
      ctx.fillStyle = RIGHT;
      ctx.beginPath(); ctx.moveTo(sx, sy + TH / 2); ctx.lineTo(sx + TW / 2, sy); ctx.lineTo(sx + TW / 2, sy + D); ctx.lineTo(sx, sy + TH / 2 + D); ctx.closePath(); ctx.fill();
      ctx.fillStyle = TOP; tilePath(sx, sy); ctx.fill();
      ctx.globalAlpha = 1;
      if (t.coin) drawCoin(t, sx, sy, now, alpha);
    }
    // Монета стоит ребром над плиткой и медленно вращается; собранная — взлетает и тает.
    function drawCoin(t, sx, sy, now, alpha) {
      var k = 0;
      if (t.got) { k = t.got > 0 ? (now - t.got) / 380 : 0; if (k >= 1) return; }
      var r = TW * 0.17;
      var turn = reduceMotion ? 1 : Math.max(0.4, Math.abs(Math.cos(now / 420 + t.x + t.y))); // «вращение» — сжимаем по ширине
      var bob = reduceMotion || t.got ? 0 : Math.sin(now / 260 + t.x + t.y) * TH * 0.08;
      var cx = sx, cy = sy - TH * 0.7 + bob - (reduceMotion ? 0 : k * TH * 1.2);
      ctx.globalAlpha = alpha * (1 - k);
      if (!t.got) { ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(sx, sy, r * 0.8, r * 0.35, 0, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = '#B8860B'; // ребро
      ctx.beginPath(); ctx.ellipse(cx + r * 0.12 * turn, cy, r * turn, r, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#FFCB3D'; // лицевая сторона
      ctx.beginPath(); ctx.ellipse(cx, cy, r * turn, r, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#E0A100'; ctx.lineWidth = Math.max(1, r * 0.16);
      ctx.beginPath(); ctx.ellipse(cx, cy, r * 0.62 * turn, r * 0.62, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    function drawBall(ox, oy, now) {
      var p = proj(run.bx, run.by);
      var r = TW * 0.12; // шарик поменьше — видно, где он падает
      var sx = p.x + ox, sy = p.y + oy, drop = 0, alpha = 1;
      if (phase === 'falling' || screen === 'over') {
        var k = Math.min(1, (now - fallAt) / CONFIG.fallMs);
        drop = reduceMotion ? 0 : k * k * H * 0.45;
        alpha = 1 - k * 0.85;
      } else {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath(); ctx.ellipse(sx, sy, r * 0.9, r * 0.45, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = phase === 'falling' || screen === 'over' ? css.err : css.ink;
      ctx.beginPath(); ctx.arc(sx, sy - r * 0.9 + drop, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath(); ctx.arc(sx - r * 0.35, sy - r * 1.25 + drop, r * 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    function draw(now) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      var ox = W / 2 - camX, oy = H * 0.72 - camY;
      var row = run.bx + run.by;
      var from = Math.max(0, run.tile - 10), to = Math.min(run.tiles.length - 1, run.tile + 34);
      var falling = phase === 'falling' || screen === 'over';
      // дальние плитки рисуем первыми, ближние — поверх
      for (var i = to; i >= from; i--) {
        var t = run.tiles[i];
        if (falling && t.x + t.y <= row) continue;
        drawTile(t, ox, oy, now);
      }
      if (falling) {
        drawBall(ox, oy, now);
        for (var j = to; j >= from; j--) { var u = run.tiles[j]; if (u.x + u.y <= row) drawTile(u, ox, oy, now); }
      } else {
        drawBall(ox, oy, now);
      }
    }

    function frame(now) {
      raf = 0;
      if (destroyed) return;
      if (screen === 'play' && phase === 'running') {
        step(now);
      } else if (screen === 'play' && phase === 'countdown') {
        var left = countdownEnd - now;
        if (left <= 0) { phase = 'running'; hint.textContent = ''; lastT = now; }
        else hint.textContent = String(Math.ceil(left / CONFIG.countdownMs));
      }
      // камера плавно догоняет шарик
      var p = proj(run.bx, run.by);
      var k = reduceMotion ? 1 : 0.18;
      if (phase !== 'falling' && screen !== 'over') { camX += (p.x - camX) * k; camY += (p.y - camY) * k; }
      draw(now);
      var animating = screen === 'play' && (phase === 'running' || phase === 'countdown' || phase === 'falling');
      var fadingTiles = run.tiles.some(function (t) { return (t.gone && now - t.gone < 700) || (t.got > 0 && now - t.got < 380); });
      if (animating || fadingTiles || (screen === 'over' && now - fallAt < CONFIG.fallMs)) loop();
    }
    function loop() { if (!raf && !destroyed) raf = requestAnimationFrame(frame); }

    // Продвинуть игру до момента t (мс).
    function step(t) {
      if (t <= lastT) return;
      var sec = Math.min(0.1, (t - lastT) / 1000); // после зависания не телепортируемся
      lastT = t;
      var before = run.score, gemsBefore = run.coins;
      run.advance(sec);
      if (run.coins !== gemsBefore) {
        for (var g = Math.max(0, run.tile - 6); g <= run.tile; g++) if (run.tiles[g].got < 0) run.tiles[g].got = t; // время сбора — для анимации
        gemsEl.textContent = '🪙 ' + run.coins;
        gemsEl.classList.remove('bump'); void gemsEl.offsetWidth; gemsEl.classList.add('bump');
      }
      // плитки далеко позади осыпаются
      for (var i = Math.max(0, run.tile - 12); i < run.tile - 2; i++) if (!run.tiles[i].gone) run.tiles[i].gone = t;
      if (run.score !== before) {
        scoreEl.textContent = String(run.score);
        scoreEl.classList.remove('bump'); void scoreEl.offsetWidth; scoreEl.classList.add('bump');
      }
      if (!run.alive) lose(t);
    }

    function start() {
      run = createRun();
      screen = 'play'; phase = 'running';
      lastT = performance.now();
      snapCamera();
      scoreEl.textContent = '0'; gemsEl.textContent = '🪙 0'; hint.textContent = '';
      wrapEl.classList.add('playing'); wrapEl.classList.remove('over');
      document.documentElement.classList.add('sector-on');
      renderPanel();
      if (opts.onStateChange) opts.onStateChange('play');
      if (opts.onStart) { try { opts.onStart(); } catch (e) { /* игра идёт и без базы */ } }
      try { field.focus({ preventScroll: true }); } catch (e) { /* без фокуса тоже работает */ }
      loop();
    }

    function press(ts) {
      if (screen !== 'play' || phase !== 'running') return; // в паузе и при отсчёте нажатия не считаются
      var now = performance.now();
      var t = (typeof ts === 'number' && ts > 0 && Math.abs(ts - now) < 1000) ? ts : now;
      step(Math.max(t, lastT)); // сначала довести шарик до момента нажатия
      if (!run.alive) return;
      run.turn();
      loop();
    }

    function lose(t) {
      phase = 'falling';
      fallAt = performance.now();
      wrapEl.classList.remove('playing');
      document.documentElement.classList.remove('sector-on');
      var result = { score: run.score, tiles: run.tile, coins: run.coins };
      var prevBest = opts.best ? (opts.best() || 0) : 0;
      loop();
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
      }, reduceMotion ? 150 : CONFIG.fallMs);
    }

    function pause() {
      if (screen !== 'play' || (phase !== 'running' && phase !== 'countdown')) return;
      phase = 'paused';
      hint.textContent = '❚❚';
    }
    function startCountdown() {
      if (screen !== 'play' || phase !== 'paused') return;
      phase = 'countdown';
      countdownEnd = performance.now() + CONFIG.countdownMs * 3;
      loop();
    }

    function renderPanel(result, prevBest, info) {
      panel.replaceChildren();
      if (screen === 'start') {
        panel.appendChild(h('p', 'sector-lead', 'Жми — шарик повернёт. Не упади!'));
        panel.appendChild(h('p', 'sector-best', 'Рекорд: ' + (opts.best ? (opts.best() || 0) : 0) + ' · собирай 🪙 на дорожке'));
        var b = h('button', 'btn primary sector-play', 'Играть');
        b.type = 'button';
        b.addEventListener('click', function (ev) { ev.stopPropagation(); start(); });
        panel.appendChild(b);
      } else if (screen === 'over') {
        var best = Math.max(prevBest || 0, result.score, info && info.best ? info.best : 0);
        var isNew = result.score > 0 && result.score > (prevBest || 0);
        panel.appendChild(h('p', 'sector-over', 'GAME OVER'));
        if (isNew) panel.appendChild(h('p', 'sector-new', 'NEW RECORD!'));
        var row = h('div', 'sector-stats');
        function stat(n, l) { var s = h('div', 'sector-stat'); s.appendChild(h('span', 'n', String(n))); s.appendChild(h('span', 'l', l)); return s; }
        row.appendChild(stat(result.score, 'очки'));
        row.appendChild(stat(result.coins, 'монеты'));
        row.appendChild(stat(best, 'рекорд'));
        panel.appendChild(row);
        if (info && info.valid === false) panel.appendChild(h('p', 'sector-warn', 'Этот результат не прошёл проверку и не попадёт в рейтинг.'));
        // собранные монеты зачисляет база
        if (info && info.valid !== false && typeof info.coins === 'number') {
          panel.appendChild(h('p', 'sector-points' + (info.coins > 0 ? ' got' : ''), info.coins > 0
            ? '+' + info.coins + ' 🪙 зачислено на баланс'
            : 'Монеты лежат на дорожке — заезжай на них'));
        }
        var again = h('button', 'btn primary sector-play', 'Играть ещё');
        again.type = 'button';
        again.addEventListener('click', function (ev) { ev.stopPropagation(); start(); });
        panel.appendChild(again);
        setTimeout(function () { if (!destroyed) again.focus({ preventScroll: true }); }, 0);
      }
    }

    // Ввод: касание в любом месте экрана (кроме меню сайта) или пробел — как в «Секторе».
    function onPointer(ev) {
      if (screen !== 'play') return;
      if (ev.button !== undefined && ev.button > 0) return;
      var t = ev.target;
      if (t && t.closest && t.closest('.bottom-nav, nav.tabs, .me, a, .install-hint, .toast')) return;
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
    requestAnimationFrame(function () { if (!destroyed) resize(); });

    return {
      destroy: function () {
        destroyed = true;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        document.removeEventListener('pointerdown', onPointer);
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('visibilitychange', onVisibility);
        root.removeEventListener('blur', onBlur);
        root.removeEventListener('focus', onFocus);
        root.removeEventListener('resize', resize);
        document.documentElement.classList.remove('sector-on');
        if (opts.onStateChange) opts.onStateChange('gone');
      },
      // для проверок
      // рекорд пришёл из базы — обновить подпись на стартовом экране
      refreshBest: function () { if (!destroyed && screen === 'start') renderPanel(); },
      _state: function () { return { screen: screen, phase: phase, score: run.score, tile: run.tile, coins: run.coins, dir: run.dir, bx: run.bx, by: run.by, speed: speedFor(run.score), alive: run.alive }; },
      _run: function () { return run; },
      _press: press
    };
  }

  var api = { CONFIG: CONFIG, speedFor: speedFor, lengthRange: lengthRange, segmentLength: segmentLength, createRun: createRun, mount: mount };
  root.ZigzagGame = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
