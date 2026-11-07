/* «Сектор» — экран игры: рисует круг, стрелку и сектор, ловит нажатия.
   Правила (где сектор, попал ли, пропуск, развороты, «крутится круг») — в sector-core.js:
   тот же файл переигрывает дуэли на сервере, поэтому игра на телефоне и проверка совпадают.

   Что видно игроку:
   * стрелка вращается; нажми, когда она внутри выделенного сектора; пропустил сектор — проигрыш;
   * красный сектор в полоску — ловушка: нажимать нельзя, стрелка должна его проехать;
   * фиолетовый сектор — разворот: стрелка крутится в другую сторону;
   * бирюзовый — «крутится круг»: стрелка замирает, вращается весь круг вместе со счётом;
   * лаймовый — раздвоение: появляется вторая стрелка, зеркальная; сектор ставится туда, где стрелки встретятся;
     следующий лаймовый — снова одна (вторая плавно гаснет);
   * сектор мягко светится своим цветом (сильнее с уровнем), у него слегка скруглённые углы, и появляется он плавно (0,1 с);
   * рамка, кружок вокруг счёта, деления циферблата и сами цифры счёта разгораются (смягчаются) к 40-му сектору и вспыхивают цветом особого сектора при попадании
     (и красным — когда ловушка позади);
   * в дуэли у сектора три зоны: края — 1 очко, ближе к центру — 2, центр — 3.
   Модуль отдаёт window.SectorGame: mount() и функции ядра (для проверок). */
(function (root) {
  'use strict';

  var Core = root.SectorCore;
  var CONFIG = Core.CONFIG;
  var GLOW_FULL = 40;        // рамка разгорается на полную к 40-му сектору
  var COUNTDOWN_MS = 600;    // один шаг обратного отсчёта после возврата на вкладку
  var SKIP_GRACE_MS = 120;   // пропуск объявляем чуть позже: вдруг нажатие ещё в пути
  var WIN_STOP_MS = 1400;    // при победе в дуэли стрелка плавно останавливается за это время
  var SECTOR_W = 24;         // толщина дуги сектора, px
  var CORNER = 4;            // скругление углов сектора, px (края остаются ровно на границе попадания)
  var FADE_IN_MS = 60;       // новый сектор появляется сразу ярким (с 40%) и за 0,06 с доходит до полной яркости
  var FADE_OUT_MS = 180;     // пройденный сектор гаснет за 0,18 с (уже рядом с новым)
  var wrap = Core.wrap;

  var reduceMotion = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function h(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) { if (window.Coin) window.Coin.fill(n, text); else n.textContent = text; } // 🪙 → наша монета
    return n;
  }

  /* Экран игры. container — пустой элемент. opts:
     best()                — текущий личный рекорд (число);
     onStart()             — вызывается в начале одиночной игры;
     onOver(result)        — result = { score, hits, perfects }; может вернуть Promise<{ best, newRecord }>;
     onStateChange(state)  — 'start' | 'play' | 'over', чтобы сайт знал, что идёт игра.
     duel — для дуэли (тогда кнопки «Играть» нет, игра стартует сама):
       { seed, startAt — performance.now() момента старта (у обоих одинаковый по часам базы),
         opponent() — { name, score, done, forfeit } для показа и победы,
         onProgress({ score, hits }), onEnd(result), overPanel(panel, result) — чем заполнить низ после конца }
     Возвращает { destroy, win? } — останавливает анимацию и снимает обработчики. */
  function mount(container, opts) {
    opts = opts || {};
    var duel = opts.duel || null;
    var css = {}; // цвета берём из CSS-переменных сайта
    function readColors() {
      var s = getComputedStyle(document.documentElement);
      function v(name, fb) { var x = s.getPropertyValue(name).trim(); return x || fb; }
      css = {
        line: v('--line', '#333131'), ink: v('--ink', '#E8E6E3'), muted: v('--muted', '#A0968E'),
        accent: v('--accent', '#F2782C'), btn: v('--btn', '#C4500B'), surface: v('--surface', '#1E1E1E'),
        tile: v('--tile', '#262422'), err: v('--err', '#FF7A6B'),
        special: v('--special', '#9B7BFF'), specialHi: v('--special-hi', '#CDBEFF'),
        turq: v('--turq', '#2EC4B6'), turqHi: v('--turq-hi', '#A6EEE6'),
        trap: v('--trap', '#E8364F'), trapDark: v('--trap-dark', '#5C1220'),
        split: v('--split', '#C8E650'), splitHi: v('--split-hi', '#F0FAC8'),
        mono: v('--font-mono', 'ui-monospace, monospace')
      };
    }
    readColors();

    var wrapEl = h('div', 'sector' + (duel ? ' sector-duel' : ''));
    var field = h('div', 'sector-field');
    field.setAttribute('role', 'button');
    field.setAttribute('aria-label', 'Игровое поле: нажми в любом месте экрана, когда стрелка в секторе');
    var canvas = h('canvas', 'sector-canvas');
    var hub = h('div', 'sector-hub');
    // Счёт видно на холсте (точно по центру круга и поворачивается вместе с ним); этот элемент — для экранного диктора.
    var scoreEl = h('div', 'sector-score sr', '0');
    var hint = h('div', 'sector-hint low', '');
    hub.appendChild(scoreEl); hub.appendChild(hint);
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
    if (document.fonts && document.fonts.load) {
      document.fonts.load('600 44px ' + css.mono).then(function () { if (!destroyed) draw(performance.now()); }, function () {});
    }

    // Состояние экрана
    var screen = 'start';   // start | wait (дуэль: ждём старта) | play | over
    var paused = false, countdownEnd = 0, pauseAt = 0;
    var g = null;           // партия (ядро)
    var base = 0;           // performance.now() в момент «0 мс» партии (паузы сдвигают его вперёд)
    var presses = [];       // моменты нажатий, мс от старта — по ним сервер переигрывает дуэль
    var sectorFadeFrom = 0, pulseAt = -1, missAt = -1, bumpAt = -1;
    var prevSec = null;     // пройденный сектор, который ещё гаснет: { center, width, kind, at }
    var trapsShown = 0;     // сколько пройденных ловушек уже показали (вспышка, счёт)
    // свечение кружка вокруг счёта — то же, что у рамки: glowV — сколько должно гореть, glowShow — сколько горит сейчас
    // (догоняет плавно, как рамка в CSS), вспышка — цветом особого сектора
    var glowV = 0, glowShow = 0, lastDrawAt = 0, flashColor = '', flashAt = -1, flashK = 0;
    var ghostEndAt = -1, ghostAxis = 0;   // раздвоение кончилось: вторая стрелка гаснет за 0,25 с
    var rot = 0, arrowScreen = 0;   // поворот круга на экране и место стрелки, пока крутится круг
    var winAt = -1, winA = 0, winV = 0;
    var oppShown = '';
    var raf = 0, destroyed = false;

    function et(now) { return now - base; }                  // время партии
    function st() { return g ? g.state : null; }
    // угол стрелки относительно круга сейчас
    function relAngle(now) {
      var s = st();
      if (!s) return 0;
      if (winAt >= 0) {                                       // победа: плавная остановка
        var tau = Math.min(WIN_STOP_MS, now - winAt) / 1000, T = WIN_STOP_MS / 1000;
        return wrap(winA + winV * (tau - tau * tau / (2 * T)));
      }
      if (screen === 'play' && paused) return g.angleAt(et(pauseAt));
      if (screen === 'play' || screen === 'over') return g.angleAt(et(now));
      return 0;
    }
    function dialRot(rel) { var s = st(); return s && s.spin ? wrap(arrowScreen - rel) : rot; }
    function setGlow(v) {
      glowV = Math.max(0, Math.min(1, v));
      wrapEl.style.setProperty('--glow', String(glowV));
    }
    // Вспышка цветом особого сектора — такой же силы, как сейчас разгорелась рамка (совсем слабой не бывает).
    function flash(color) {
      if (!flashEl.animate) return;
      var k = Math.max(0.3, Math.min(1, st().hits / GLOW_FULL));
      flashColor = color; flashAt = performance.now(); flashK = k;   // та же вспышка — на кружке вокруг счёта
      flashEl.style.setProperty('--fc', color);
      flashEl.animate(reduceMotion
        ? [{ opacity: k }, { opacity: 0 }]
        : [{ opacity: 0 }, { opacity: k, offset: 0.08 }, { opacity: 0.35 * k, offset: 0.2 }, { opacity: k, offset: 0.32 }, { opacity: 0 }],
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
    // '#RRGGBB' (или '#RGB') → 'rgba(r,g,b,a)': нужно, чтобы менять силу свечения
    function rgba(hex, a) {
      var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
      if (!m) return hex;
      var h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
      return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16) + ',' + a + ')';
    }
    // Контур кусочка кольца (сектора) от угла d0 до d1 (градусы) толщиной w со скруглёнными углами радиуса r.
    // Скругление «внутрь»: крайние линии остаются ровно на границе попадания.
    function bandPath(c, R, w, d0, d1, r) {
      var ro = R + w / 2, ri = R - w / 2, a0 = rad(d0), a1 = rad(d1);
      r = Math.max(0, Math.min(r, w / 2, (a1 - a0) * ri / 2));   // узкий кусочек — скругление меньше
      var dO = r / ro, dI = r / ri;
      function pt(rr, a) { return [c + Math.cos(a) * rr, c + Math.sin(a) * rr]; }
      var p;
      ctx.beginPath();
      ctx.arc(c, c, ro, a0 + dO, a1 - dO);
      p = pt(ro, a1); var q = pt(ro - r, a1); ctx.quadraticCurveTo(p[0], p[1], q[0], q[1]);
      q = pt(ri + r, a1); ctx.lineTo(q[0], q[1]);
      p = pt(ri, a1); q = pt(ri, a1 - dI); ctx.quadraticCurveTo(p[0], p[1], q[0], q[1]);
      ctx.arc(c, c, ri, a1 - dI, a0 + dI, true);
      p = pt(ri, a0); q = pt(ri + r, a0); ctx.quadraticCurveTo(p[0], p[1], q[0], q[1]);
      q = pt(ro - r, a0); ctx.lineTo(q[0], q[1]);
      p = pt(ro, a0); q = pt(ro, a0 + dO); ctx.quadraticCurveTo(p[0], p[1], q[0], q[1]);
      ctx.closePath();
    }

    // Сила вспышки сейчас (0…1) — по тем же шагам, что у вспышки рамки: ярко → слабее → снова ярко → гаснет за 1,2 с.
    function flashLevel(now) {
      if (flashAt < 0) return 0;
      var x = (now - flashAt) / 1200;
      if (x >= 1) { flashAt = -1; return 0; }
      var p = 1 - (1 - x) * (1 - x);                         // ease-out, как у рамки
      if (reduceMotion) return flashK * (1 - p);
      var pts = [[0, 0], [0.08, 1], [0.2, 0.35], [0.32, 1], [1, 0]];
      for (var i = 1; i < pts.length; i++) {
        if (p <= pts[i][0]) {
          var a = pts[i - 1], b = pts[i];
          return flashK * (a[1] + (b[1] - a[1]) * (p - a[0]) / (b[0] - a[0]));
        }
      }
      return 0;
    }
    // Нарисовать сектор (центр и ширина в градусах на круге). dead — проигрыш (всё красное), zones3 — три зоны дуэли.
    function drawSector(c, R, center, width, kind, alpha, dead, zones3) {
      var col = dead ? css.err : kind === 'trap' ? css.trap : kind === 'rev' ? css.special : kind === 'spin' ? css.turq : kind === 'split' ? css.split : css.btn;
      var d0 = center - width / 2, d1 = center + width / 2;
      ctx.save();
      ctx.globalAlpha = alpha;
      // сам сектор + мягкое свечение его цвета: немного всегда, сильнее — по мере разгорания рамки
      ctx.shadowColor = rgba(col, 0.35 + 0.55 * glowShow);
      ctx.shadowBlur = 8 + 14 * glowShow;
      ctx.fillStyle = col;
      bandPath(c, R, SECTOR_W, d0, d1, CORNER); ctx.fill();
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
      if (kind === 'trap') {
        // ловушка: тёмные поперечные полосы, как на шлагбауме (внутри контура); центра (PERFECT) у неё нет
        ctx.save();
        bandPath(c, R, SECTOR_W, d0, d1, CORNER); ctx.clip();
        ctx.strokeStyle = css.trapDark; ctx.lineWidth = SECTOR_W + 2; ctx.lineCap = 'butt';
        ctx.setLineDash([3, 6]);
        ctx.beginPath(); ctx.arc(c, c, R, rad(d0), rad(d1)); ctx.stroke();
        ctx.restore();
      } else if (zones3) {
        // дуэль: средняя зона «2 очка» — промежуточным цветом
        var gw = Core.goodWidth(width);
        ctx.fillStyle = dead ? css.err : kind === 'rev' ? '#B9A2FF' : kind === 'spin' ? '#6FD9CE' : kind === 'split' ? '#DCEF8A' : '#E8803A';
        bandPath(c, R, SECTOR_W, center - gw / 2, center + gw / 2, CORNER / 2); ctx.fill();
      }
      if (kind !== 'trap') {
        var pw = Core.perfectWidth(width);
        ctx.fillStyle = dead ? css.err : kind === 'rev' ? css.specialHi : kind === 'spin' ? css.turqHi : kind === 'split' ? css.splitHi : '#FFB37A';
        bandPath(c, R, SECTOR_W, center - pw / 2, center + pw / 2, CORNER / 2); ctx.fill();
      }
      ctx.restore();
    }
    // Деления циферблата (12 палочек между внутренним и внешним кругом). color/alpha/blur — для свечения поверх обычных.
    function ticks(c, R, color, alpha, blur) {
      if (alpha <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineCap = 'round';
      if (blur) { ctx.shadowColor = color; ctx.shadowBlur = blur; }
      for (var i = 0; i < 12; i++) {
        var a = rad(i * 30), r2 = R - (i % 3 === 0 ? 32 : 28);
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * (R - 22), c + Math.sin(a) * (R - 22));
        ctx.lineTo(c + Math.cos(a) * r2, c + Math.sin(a) * r2);
        ctx.stroke();
      }
      ctx.restore();
    }
    // Светящийся кружок вокруг счёта: оранжевый градиент крутится, как на рамке (пока идёт игра), плюс мягкое свечение.
    function hubRing(now, c, r, color, alpha) {
      if (alpha <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.shadowColor = color; ctx.shadowBlur = 18;
      var stroke = color;
      if (ctx.createConicGradient && !reduceMotion) {
        var spin = screen === 'play' ? (now / 5000) * Math.PI * 2 : 0;
        var gr = ctx.createConicGradient(spin, c, c);
        gr.addColorStop(0, color); gr.addColorStop(0.22, 'rgba(0,0,0,0)'); gr.addColorStop(0.5, color);
        gr.addColorStop(0.72, 'rgba(0,0,0,0)'); gr.addColorStop(1, color);
        // сначала ровное мягкое свечение, поверх — яркий бегущий градиент
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.globalAlpha = Math.min(1, alpha) * 0.55;
        ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = Math.min(1, alpha);
        stroke = gr;
      }
      ctx.strokeStyle = stroke; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    function draw(now) {
      var c = size / 2, R = size / 2 - 18, s = st();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      var ang = relAngle(now);
      var turn = dialRot(ang);
      // свечение (кружок и деления): догоняет нужную силу примерно за 0,6 с, как рамка; сверху — вспышка
      var dt = lastDrawAt ? Math.max(0, Math.min(100, now - lastDrawAt)) : 0;
      lastDrawAt = now;
      glowShow = glowV + (glowShow - glowV) * Math.exp(-dt / 200);
      var fl = flashLevel(now);
      if (turn) { ctx.translate(c, c); ctx.rotate(turn * Math.PI / 180); ctx.translate(-c, -c); }
      // дорожка
      ctx.lineWidth = 12; ctx.strokeStyle = css.tile;
      ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.stroke();
      // деления, как на циферблате; разгораются вместе с рамкой и вспыхивают цветом особого сектора
      ticks(c, R, css.line, 1, 0);
      ticks(c, R, css.accent, glowShow, 10);
      ticks(c, R, flashColor, fl, 12);
      // пройденный сектор гаснет (новый уже на своём месте)
      if (prevSec) {
        var pk = (now - prevSec.at) / FADE_OUT_MS;
        if (pk >= 1 || reduceMotion) prevSec = null;
        else drawSector(c, R, prevSec.center, prevSec.width, prevSec.kind, 1 - pk, false, s && s.zones3);
      }
      // сектор
      var center = s ? s.center : 120, width = s ? s.width : CONFIG.startWidth, kind = s ? s.kind : 'normal';
      var alpha = 1;
      // новый сектор: сразу ярко, за 0,06 с — на полную (возраст сектора — время партии с его появления)
      if (s && s.phase === 'running' && screen === 'play' && !reduceMotion) {
        var age = (paused ? et(pauseAt) : et(now)) - s.t0;
        if (age < FADE_IN_MS) { var fk = Math.max(0, age / FADE_IN_MS); alpha = 0.4 + 0.6 * fk * (2 - fk); }
      }
      if (s && s.phase === 'transition') alpha = 0;          // ловушка позади, следующий сектор ещё не появился
      if (screen === 'start' || screen === 'wait') alpha = 0.9;
      if (winAt >= 0) alpha = Math.max(0, 1 - (now - winAt) / 500);   // победа: сектор тает
      if (alpha > 0) drawSector(c, R, center, width, kind, alpha, missAt >= 0, s && s.zones3);
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
      // стрелка (в повёрнутом круге — по её углу на круге)
      var hubR = size * 0.17;
      var ar = rad(ang);
      ctx.strokeStyle = missAt >= 0 ? css.err : css.ink;
      ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(ar) * (hubR - 2), c + Math.sin(ar) * (hubR - 2));
      ctx.lineTo(c + Math.cos(ar) * (R + 8), c + Math.sin(ar) * (R + 8));
      ctx.stroke();
      // вторая стрелка (раздвоение): зеркально относительно точки, где стрелка раздвоилась
      var ghostA = s && s.split ? 1 : ghostEndAt >= 0 ? 1 - (now - ghostEndAt) / 250 : 0;
      if (ghostA <= 0) ghostEndAt = -1;
      else if (s) {
        var gr2 = rad(wrap(2 * (s.split ? s.axis : ghostAxis) - ang));
        ctx.globalAlpha = Math.min(1, ghostA);
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(gr2) * (hubR - 2), c + Math.sin(gr2) * (hubR - 2));
        ctx.lineTo(c + Math.cos(gr2) * (R + 8), c + Math.sin(gr2) * (R + 8));
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // центр
      ctx.fillStyle = css.surface;
      ctx.beginPath(); ctx.arc(c, c, hubR, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = css.line; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(c, c, hubR, 0, Math.PI * 2); ctx.stroke();
      // свечение кружка (сила посчитана в начале draw)
      hubRing(now, c, hubR, css.accent, glowShow);
      hubRing(now, c, hubR, flashColor, fl);
      // в центре — счёт (или отсчёт перед дуэлью): центр самих цифр ровно в центре круга
      var txt = String(s ? s.score : 0), color = missAt >= 0 ? css.err : css.ink;
      if (screen === 'wait') {
        var left = base - now;
        txt = left > 0 ? String(Math.min(9, Math.ceil(left / 1000))) : '0';
        color = css.accent;
      }
      var fs = Math.min(44, Math.round(hubR * 0.86));
      var sc = 1;
      if (bumpAt >= 0) {
        var bk = (now - bumpAt) / 220;
        if (bk >= 1 || reduceMotion) bumpAt = -1; else sc = 1 + 0.12 * Math.sin(Math.PI * bk);
      }
      ctx.save();
      ctx.translate(c, c);
      if (sc !== 1) ctx.scale(sc, sc);
      ctx.font = '600 ' + fs + 'px ' + css.mono;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      var m = ctx.measureText(txt);
      var mL = m.actualBoundingBoxLeft || 0, mR = m.actualBoundingBoxRight || m.width;
      var asc = m.actualBoundingBoxAscent || fs * 0.72, desc = m.actualBoundingBoxDescent || 0;
      ctx.fillStyle = color;
      var tx = (mL - mR) / 2, ty = (asc - desc) / 2;
      // цифры смягчаются вместе с рамкой: снаружи — оранжевый ореол, у самых краёв — лёгкое размытие их цвета
      if (glowShow > 0.01 && !reduceMotion) {
        ctx.shadowColor = rgba(css.accent, 0.55 * glowShow); ctx.shadowBlur = 16 * glowShow;
        ctx.fillText(txt, tx, ty);
        ctx.shadowColor = rgba(color, 0.75 * glowShow); ctx.shadowBlur = 5 * glowShow;
      }
      ctx.fillText(txt, tx, ty);
      ctx.restore();
    }

    function frame(now) {
      raf = 0;
      if (destroyed) return;
      if (screen === 'wait' && now >= base) beginPlay();
      if (screen === 'play') {
        if (paused) {
          if (countdownEnd) {
            var left = countdownEnd - now;
            if (left <= 0) resume(now);
            else hint.textContent = String(Math.ceil(left / COUNTDOWN_MS));
          }
        } else {
          var t = et(now), s = st();
          // ловушку засчитываем с той же задержкой, что и пропуск: вдруг нажатие ещё в пути
          // (сервер учтёт его по времени — значит, и телефон должен успеть его учесть)
          var snap = trapSnap();
          if (!(s.phase === 'running' && s.kind === 'trap' && t - SKIP_GRACE_MS <= s.exitAt)) g.tick(t);
          syncTraps(now, snap);
          // пропуск: стрелка проехала сектор без нажатия
          if (s.phase === 'over') { /* уже закончилась — ждём экрана итога */ }
          else if (s.phase === 'running' && s.kind !== 'trap' && t - SKIP_GRACE_MS > s.exitAt) {
            g.finish(s.exitAt, 'skip');
            lose('skip');
          } else if (duel) {
            showOpponent();
            var o = duel.opponent && duel.opponent();
            if (o && o.done && (o.forfeit || s.score > o.score)) win(now);
          }
        }
      }
      draw(now);
      if (screen === 'wait' || (screen === 'play' && !paused) || (screen === 'play' && countdownEnd)) loop();
      else if (pulseAt >= 0 || bumpAt >= 0 || (missAt >= 0 && now - missAt < 1000) || (winAt >= 0 && now - winAt < WIN_STOP_MS + 50)) loop();
    }
    function loop() { if (!raf && !destroyed) raf = requestAnimationFrame(frame); }

    function setScore(v) { scoreEl.textContent = String(v); }

    function resetRound(seed) {
      g = Core.create(seed, { zones3: !!duel });
      presses = []; missAt = -1; pulseAt = -1; bumpAt = -1; winAt = -1; trapsShown = 0; prevSec = null;
      rot = 0; arrowScreen = 0; paused = false; countdownEnd = 0;
      setScore(0); hint.textContent = ''; pop.textContent = ''; pop.className = 'sector-pop';
      setGlow(0); glowShow = 0; flashAt = -1; ghostEndAt = -1;
    }
    // одиночная игра: «Играть»
    function start() {
      resetRound(Core.randomSeed());
      base = performance.now();
      beginPlay();
      if (opts.onStart) { try { opts.onStart(); } catch (e) { /* игра идёт и без базы */ } }
    }
    function beginPlay() {
      screen = 'play';
      wrapEl.classList.add('playing'); wrapEl.classList.remove('over');
      document.documentElement.classList.add('sector-on');
      renderPanel();
      if (opts.onStateChange) opts.onStateChange('play');
      field.focus({ preventScroll: true });
      loop();
    }

    function showPop(text, cls) {
      pop.textContent = text;
      pop.className = 'sector-pop ' + cls;
      void pop.offsetWidth; // перезапуск анимации
      pop.classList.add('show');
    }

    function press(ts) {
      if (screen !== 'play' || paused) return; // во время паузы и отсчёта нажатия не считаются
      var now = performance.now();
      var at = (typeof ts === 'number' && ts > 0 && Math.abs(ts - now) < 1000) ? ts : now;
      // время нажатия округляем до тысячной миллисекунды — ровно это число уйдёт на сервер для проверки
      var t = Math.round(et(at) * 1000) / 1000;
      if (t < 0) return;
      var snap = trapSnap();
      var r = g.press(t);
      syncTraps(now, snap);                  // ловушка могла остаться позади как раз к этому нажатию
      if (!r) return;                        // пауза после ловушки или защита от двойного касания — не считается
      presses.push(t);
      if (r.res === 'skip' || r.res === 'miss' || r.res === 'trap') { lose(r.res); return; }
      var s = st();
      // попал: пройденный сектор гаснет, а новый появляется тут же (ядро ставит его в момент нажатия)
      prevSec = { center: s.center, width: s.width, kind: r.kind, at: now };
      g.tick(t);
      if (r.kind === 'rev') flash(css.special);
      else if (r.kind === 'spin') {
        // «крутится круг»: стрелка на экране замирает (или снова едет), круг продолжает без рывка
        var rel = g.angleAt(t);
        if (s.spin) arrowScreen = wrap(rel + rot); else rot = wrap(arrowScreen - rel);
        flash(css.turq);
      } else if (r.kind === 'split') {
        if (!s.split) { ghostEndAt = now; ghostAxis = s.axis; }   // снова одна стрелка — вторая гаснет
        flash(css.split);
      }
      if (r.res === 'perfect') { pulseAt = now; showPop('PERFECT +' + r.points, 'perfect'); }
      else if (r.points > 1) showPop('+' + r.points, 'good');
      setScore(s.score);
      bumpAt = now;
      setGlow(s.hits / GLOW_FULL);
      sectorFadeFrom = now;
      if (duel && duel.onProgress) duel.onProgress({ score: s.score, hits: s.hits });
      loop();
    }

    // Ловушка на круге сейчас (запоминаем, чтобы она плавно погасла, когда останется позади).
    function trapSnap() { var s = st(); return s && s.phase === 'running' && s.kind === 'trap' ? { center: s.center, width: s.width } : null; }
    // Стрелка проехала ловушку: +1 очко, рамка вспыхивает красным — как при попадании в особый сектор.
    function syncTraps(now, snap) {
      var s = st();
      if (!s || s.traps <= trapsShown) return;
      trapsShown = s.traps;
      if (snap) prevSec = { center: snap.center, width: snap.width, kind: 'trap', at: now };
      flash(css.trap);
      setScore(s.score);
      bumpAt = now;
      setGlow(s.hits / GLOW_FULL);
      sectorFadeFrom = now;
      if (duel && duel.onProgress) duel.onProgress({ score: s.score, hits: s.hits });
      loop();
    }

    function result() {
      var s = st();
      return { score: s.score, hits: s.hits, perfects: s.perfects, presses: presses.slice(), end: s.end, endT: s.endAt, seed: s.seed };
    }

    function endScreen() {
      wrapEl.classList.remove('playing');
      document.documentElement.classList.remove('sector-on');
    }

    function lose(reason) {
      missAt = performance.now();
      setGlow(0);
      endScreen();
      if (reason === 'skip') showPop('ПРОПУСК', 'miss');
      draw(missAt);
      loop();
      var res = result();
      if (duel) {
        if (duel.onEnd) duel.onEnd(res);
        setTimeout(function () { if (destroyed) return; screen = 'over'; wrapEl.classList.add('over'); renderPanel(res); if (opts.onStateChange) opts.onStateChange('over'); }, reduceMotion ? 150 : 450);
        return;
      }
      var prevBest = opts.best ? (opts.best() || 0) : 0;
      setTimeout(function () {
        if (destroyed) return;
        screen = 'over';
        wrapEl.classList.add('over');
        renderPanel(res, prevBest, null);
        if (opts.onStateChange) opts.onStateChange('over');
        var p = opts.onOver ? opts.onOver(res) : null;
        if (p && typeof p.then === 'function') {
          p.then(function (info) { if (!destroyed && screen === 'over') renderPanel(res, prevBest, info || null); })
            .catch(function () { /* показали локальный результат */ });
        }
      }, reduceMotion ? 150 : 450);
    }

    // Дуэль выиграна (соперник уже закончил, а ты его обогнал): сектор тает, стрелка плавно останавливается.
    function win(now) {
      if (screen !== 'play' || winAt >= 0) return;
      var s = st(), t = Math.round(et(now) * 1000) / 1000;
      winA = g.angleAt(t); winV = s.dir * s.speed;
      g.finish(t, 'win');
      winAt = now;
      glowV = 1;                             // как рамка при победе — кружок горит на полную
      endScreen();
      var res = result();
      if (duel && duel.onEnd) duel.onEnd(res);
      loop();
      setTimeout(function () {
        if (destroyed) return;
        screen = 'over';
        wrapEl.classList.add('over', 'won');
        renderPanel(res);
        if (opts.onStateChange) opts.onStateChange('over');
      }, reduceMotion ? 200 : WIN_STOP_MS);
    }

    // Пауза — только в одиночной игре. В дуэли свернул приложение — проигрыш.
    function pause() {
      if (screen !== 'play' || paused) return;
      if (duel) { if (st().phase !== 'over') quitDuel(); return; }
      pauseAt = performance.now();
      paused = true; countdownEnd = 0;
      hint.textContent = '❚❚';
    }
    function startCountdown() {
      if (screen !== 'play' || !paused || countdownEnd) return;
      countdownEnd = performance.now() + COUNTDOWN_MS * 3;
      loop();
    }
    function resume(now) {
      base += now - pauseAt;                 // время партии продолжается с места паузы
      paused = false; countdownEnd = 0;
      hint.textContent = '';
    }
    function quitDuel() {
      var now = performance.now();
      g.finish(Math.max(0, Math.round(et(now) * 1000) / 1000), 'quit');
      lose('quit');
    }

    function showOpponent() {
      var o = duel.opponent && duel.opponent();
      var text = !o ? '' : o.done
        ? (o.forfeit ? 'Соперник вышел из игры' : o.name + ': ' + o.score + ' · игра окончена — обгони!')
        : o.name + ': ' + (o.score || 0);
      if (text === oppShown) return;
      oppShown = text;
      var line = panel.querySelector('.sector-opp');
      if (line) line.textContent = text;
    }

    function renderPanel(res, prevBest, info) {
      panel.replaceChildren();
      if (duel) {
        if (screen === 'wait') {
          panel.appendChild(h('p', 'sector-lead', 'Дуэль начинается'));
          if (duel.title) panel.appendChild(h('p', 'sector-best', duel.title));
        } else if (screen === 'play') {
          oppShown = '';
          panel.appendChild(h('p', 'sector-opp', ''));
          showOpponent();
        } else if (screen === 'over' && duel.overPanel) {
          duel.overPanel(panel, res);
        }
        return;
      }
      if (screen === 'start') {
        panel.appendChild(h('p', 'sector-lead', 'Останови стрелку в выделенном секторе'));
        var b = opts.best ? (opts.best() || 0) : 0;
        panel.appendChild(h('p', 'sector-best', 'Личный рекорд: ' + b));
        var btn = h('button', 'btn primary sector-play', 'Играть');
        btn.type = 'button';
        btn.addEventListener('click', function (ev) { ev.stopPropagation(); start(); });
        panel.appendChild(btn);
      } else if (screen === 'over') {
        var best = Math.max(prevBest || 0, res.score, info && info.best ? info.best : 0);
        var isNew = res.score > 0 && res.score > (prevBest || 0);
        panel.appendChild(h('p', 'sector-over', 'GAME OVER'));
        if (isNew) panel.appendChild(h('p', 'sector-new', 'NEW RECORD!'));
        var row = h('div', 'sector-stats');
        function stat(n, l) { var x = h('div', 'sector-stat'); x.appendChild(h('span', 'n', String(n))); x.appendChild(h('span', 'l', l)); return x; }
        row.appendChild(stat(res.score, 'очки'));
        row.appendChild(stat(res.perfects, 'perfect'));
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
    function onBlur() { if (!duel) pause(); }   // в дуэли проигрыш только если приложение свернули
    function onFocus() { if (!document.hidden) startCountdown(); }

    field.tabIndex = 0;
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);
    root.addEventListener('blur', onBlur);
    root.addEventListener('focus', onFocus);
    root.addEventListener('resize', resize);

    if (duel) {
      // дуэль: та же партия по зерну, старт в назначенный базой момент
      resetRound(duel.seed);
      base = duel.startAt;
      if (performance.now() >= base) beginPlay();
      else { screen = 'wait'; renderPanel(); if (opts.onStateChange) opts.onStateChange('wait'); loop(); }
    } else renderPanel();
    // Размер считаем, когда элемент уже на странице.
    requestAnimationFrame(function () { if (!destroyed) resize(); });

    return {
      destroy: function () {
        // ушли с экрана посреди дуэли — это выход из игры (проигрыш)
        if (duel && screen === 'play' && !paused && st() && st().phase !== 'over') { try { quitDuel(); } catch (e) { /* ничего */ } }
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
      // перерисовать низ после конца дуэли (когда стал известен итог)
      refreshPanel: function () { if (screen === 'over') renderPanel(result()); },
      // для проверок
      _state: function () {
        var s = st(), now = performance.now(), rel = relAngle(now);
        if (!s) return { screen: screen };
        return { screen: screen, phase: s.phase, hits: s.hits, perfects: s.perfects, score: s.score, center: s.center, width: s.width,
          speed: s.speed, dir: s.dir, kind: s.kind, spin: s.spin, untilSpin: s.untilSpin, traps: s.traps, split: s.split, axis: s.axis,
          exitAt: s.exitAt, t: et(now), angle: rel, rot: dialRot(rel), arrowScreen: wrap(rel + dialRot(rel)), end: s.end, presses: presses.slice(), seed: s.seed };
      },
      _press: press
    };
  }

  var api = {
    CONFIG: CONFIG, speedFor: Core.speedFor, widthFor: Core.widthFor, perfectWidth: Core.perfectWidth,
    norm: Core.norm, judge: Core.judge, placeSector: Core.placeSector, between: Core.between, pickKind: Core.pickKind,
    minTimeMs: Core.minTimeMs, mount: mount
  };
  root.SectorGame = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
