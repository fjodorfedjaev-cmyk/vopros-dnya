/* Казино «Вопроса дня»: Дабл, Сапёр, Краш.
   Ставки на монеты сайта (купить или вывести их нельзя). Все игры честные — без преимущества заведения.
   Исход каждой ставки решает база (функции casino_* в Supabase); здесь только интерфейс и анимация.
   Связь с сайтом — через window.AppAPI (sb, el, toast, баланс). */
(function () {
  'use strict';
  var A = null;                // AppAPI, появляется после запуска сайта
  var root = null;             // корневой элемент вкладки (живёт между перерисовками)
  var C = {
    game: load('casino-game', 'double'),
    bet: c2(parseFloat(load('casino-bet', '10'))) || 10,
    busy: false,
    history: {},               // game → последние раунды
    mines: { count: Math.min(24, Math.max(2, parseInt(load('casino-mines', '3'), 10) || 3)), round: null, opened: [], mult: 1, payout: 0, over: null },
    crash: { auto: load('casino-auto', ''), round: null, startMs: 0, offset: 0, timer: 0, raf: 0, last: null }
  };
  var reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // монеты считаются до сотых
  function c2(x) { x = Number(x); return isFinite(x) ? Math.round(x * 100) / 100 : 0; }
  function floor2(x) { return Math.floor(Number(x) * 100 + 1e-7) / 100; }
  function load(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) { /* ничего */ } }
  function el() { return A.el.apply(null, arguments); }
  function fmt(n) { return A.fmt(n); }
  function bal() { return A.balance(); }
  function one(d) { return Array.isArray(d) ? d[0] : d; }

  function errText(e) {
    var m = String((e && (e.message || e.details)) || e || '');
    if (/not_enough/.test(m)) return 'Не хватает монет на такую ставку.';
    if (/bad_bet/.test(m)) return 'Ставка — от 0,01 монеты, не больше двух знаков после запятой.';
    if (/active_round/.test(m)) return 'У тебя уже идёт раунд — продолжим его.';
    if (/round_over/.test(m)) return 'Этот раунд уже закончился.';
    if (/not_member/.test(m)) return 'Сначала войди по коду приглашения.';
    return 'Не получилось. Проверь интернет и попробуй ещё раз.';
  }
  async function rpc(name, args) {
    var r = await A.sb().rpc(name, args || {});
    if (r.error) throw r.error;
    return r.data;
  }

  /* ---------- общий каркас вкладки ---------- */
  var GAMES = [['double', 'Дабл'], ['mines', 'Сапёр'], ['crash', 'Краш']];

  function view() {
    if (!root) {
      root = el('div', { class: 'casino' });
      draw();
    }
    return [root];
  }

  function draw() {
    if (!root) return;
    var seg = el('div', { class: 'segment casino-seg', role: 'group', 'aria-label': 'Игра' }, GAMES.map(function (g) {
      return el('button', {
        type: 'button', text: g[1], 'aria-pressed': String(C.game === g[0]), disabled: locked() && C.game !== g[0] ? true : null,
        onclick: function () { if (C.game !== g[0] && !locked()) { C.game = g[0]; save('casino-game', g[0]); draw(); loadHistory(); } }
      });
    }));
    var head = el('div', { class: 'card casino-bal' }, [
      el('span', { class: 'muted', text: 'Баланс' }),
      el('span', { class: 'casino-bal-n', id: 'casino-bal', text: '🪙 ' + fmt(bal()) })
    ]);
    var game = el('section', { class: 'card casino-game', id: 'casino-game' });
    if (C.game === 'double') drawDouble(game);
    else if (C.game === 'mines') drawMines(game);
    else drawCrash(game);
    var hist = el('section', { class: 'sect casino-hist', id: 'casino-hist' });
    drawHistory(hist);
    root.replaceChildren(head, seg, game, hist);
  }

  // во время раунда нельзя переключать игру
  function locked() { return C.busy || !!C.mines.round || !!C.crash.round; }

  function updBal(v) {
    if (v !== undefined && v !== null && isFinite(Number(v))) A.setBalance(c2(v));
    var b = document.getElementById('casino-bal');
    if (b) b.textContent = '🪙 ' + fmt(bal());
  }

  // Поле ставки с быстрыми кнопками.
  function betRow(disabled) {
    var input = el('input', {
      type: 'number', inputmode: 'decimal', min: 0.01, step: 0.01, id: 'casino-bet', class: 'casino-bet-in',
      'aria-label': 'Ставка', value: String(C.bet), disabled: disabled ? true : null
    });
    input.addEventListener('input', function () {
      var v = c2(parseFloat(String(input.value).replace(',', '.')));
      if (v > 0) { C.bet = v; save('casino-bet', v); }
    });
    function quick(label, fn) {
      return el('button', {
        type: 'button', class: 'btn casino-q', text: label, disabled: disabled ? true : null,
        onclick: function () { C.bet = Math.max(0.01, floor2(fn(C.bet))); input.value = String(C.bet); save('casino-bet', C.bet); }
      });
    }
    return el('div', { class: 'casino-betrow' }, [
      el('label', { class: 'lbl', for: 'casino-bet', text: 'Ставка' }),
      el('div', { class: 'casino-betline' }, [
        input,
        quick('½', function (b) { return b / 2; }),
        quick('×2', function (b) { return Math.min(b * 2, Math.max(bal(), 0.01)); }),
        quick('Всё', function () { return Math.max(bal(), 0.01); })
      ])
    ]);
  }
  function readBet() {
    var i = document.getElementById('casino-bet');
    var raw = i ? parseFloat(String(i.value).replace(',', '.')) : C.bet;
    var v = c2(raw);
    if (!(v >= 0.01)) { A.toast('Ставка — от 0,01 монеты'); return 0; }
    if (v > bal() + 1e-9) { A.toast('Не хватает монет: у тебя ' + fmt(bal())); return 0; }
    C.bet = v; save('casino-bet', v);
    return v;
  }
  function resultLine(id) { return el('p', { class: 'casino-res', id: id, role: 'status' }); }
  function setResult(id, text, cls) {
    var r = document.getElementById(id);
    if (!r) return;
    r.textContent = text;
    r.className = 'casino-res' + (cls ? ' ' + cls : '');
  }
  function signed(delta) { delta = c2(delta); return (delta > 0 ? '+' : delta < 0 ? '−' : '±') + fmt(Math.abs(delta)) + ' 🪙'; }

  /* ---------- история ---------- */
  async function loadHistory() {
    var g = C.game;
    try { C.history[g] = await rpc('casino_history', { p_game: g, p_limit: 12 }) || []; } catch (e) { C.history[g] = C.history[g] || []; }
    var h = document.getElementById('casino-hist');
    if (h && C.game === g) drawHistory(h);
  }
  function drawHistory(sect) {
    var list = C.history[C.game];
    sect.replaceChildren(el('h2', { text: 'Последние игры' }));
    if (!list) { sect.appendChild(el('p', { class: 'muted', text: 'Загружаю…' })); return; }
    if (!list.length) { sect.appendChild(el('p', { class: 'empty', text: 'Пока ни одной игры.' })); return; }
    if (C.game === 'double') {
      sect.appendChild(el('div', { class: 'dbl-hist' }, list.map(function (r) {
        var c = r.info && r.info.color;
        return el('span', { class: 'dbl-dot ' + c, title: signed(Number(r.payout) - Number(r.bet)), text: String(r.info ? r.info.slot : '') });
      })));
    } else if (C.game === 'crash') {
      sect.appendChild(el('div', { class: 'crash-hist' }, list.map(function (r) {
        var cp = Number(r.info && r.info.crash);
        return el('span', { class: 'crash-chip' + (cp >= 2 ? ' hi' : ''), text: '×' + cp.toFixed(2) });
      })));
    }
    sect.appendChild(el('div', { class: 'casino-rows' }, list.slice(0, 8).map(function (r) {
      var d = Number(r.payout || 0) - Number(r.bet);
      var what = C.game === 'double' ? colorName(r.info && r.info.pick)
        : C.game === 'mines' ? (r.info.mines + ' ' + A.plural(r.info.mines, 'мина', 'мины', 'мин') + ', открыто ' + (r.info.opened || []).length)
          : (r.info && r.info.cashed ? 'забрал на ×' + Number(r.info.cashed).toFixed(2) : 'взрыв ×' + Number(r.info.crash).toFixed(2));
      return el('div', { class: 'casino-row' }, [
        el('span', { class: 'muted', text: what }),
        el('span', { class: 'casino-row-d ' + (d > 0 ? 'win' : d < 0 ? 'lose' : ''), text: signed(d) })
      ]);
    })));
  }
  function colorName(c) { return c === 'red' ? 'на красное' : c === 'black' ? 'на чёрное' : c === 'green' ? 'на зелёное' : ''; }

  /* ---------- Дабл ---------- */
  // Ячейки: 0 — зелёная, нечётные — красные, чётные — чёрные. Порядок на ленте как на колесе.
  var ORDER = [0, 1, 8, 2, 9, 3, 10, 4, 11, 5, 12, 6, 13, 7, 14];
  function slotColor(n) { return n === 0 ? 'green' : n % 2 === 1 ? 'red' : 'black'; }
  var TILE = 64; // ширина ячейки ленты, px (с отступом)

  function drawDouble(box) {
    var strip = el('div', { class: 'dbl-strip', id: 'dbl-strip' });
    for (var rep = 0; rep < 8; rep++) {
      ORDER.forEach(function (n) { strip.appendChild(el('span', { class: 'dbl-tile ' + slotColor(n), text: String(n) })); });
    }
    var win = el('div', { class: 'dbl-window' }, [strip, el('div', { class: 'dbl-marker', 'aria-hidden': 'true' })]);
    function pick(color, label, mult) {
      return el('button', {
        type: 'button', class: 'btn dbl-pick ' + color, disabled: C.busy ? true : null,
        onclick: function () { spin(color); }
      }, [el('span', { class: 'dbl-pick-l', text: label }), el('span', { class: 'dbl-pick-x', text: mult })]);
    }
    box.replaceChildren(
      win,
      betRow(C.busy),
      el('div', { class: 'dbl-picks' }, [pick('red', 'Красное', '×2'), pick('green', 'Зелёное', '×15'), pick('black', 'Чёрное', '×2')]),
      resultLine('dbl-res')
    );
    // начальная позиция ленты: зелёная ячейка по центру
    // лента стоит там, где остановилась в прошлый раз (сначала — на зелёной)
    var pos = C.dblPos || { rep: 2, idx: 0, jitter: 0 };
    requestAnimationFrame(function () { placeStrip(strip, pos.rep, pos.idx, pos.jitter, true); });
  }

  // Ставит ячейку (повтор rep, позиция idx в ORDER) под маркер.
  function placeStrip(strip, rep, idx, jitter, instant, ms) {
    var w = strip.parentNode ? strip.parentNode.clientWidth : 320;
    var x = -((rep * ORDER.length + idx) * TILE + TILE / 2 + jitter) + w / 2;
    strip.style.transition = instant ? 'none' : 'transform ' + ms + 'ms cubic-bezier(0.12, 0.6, 0.15, 1)';
    strip.style.transform = 'translateX(' + Math.round(x) + 'px)';
  }

  async function spin(color) {
    if (C.busy) return;
    var bet = readBet(); if (!bet) return;
    C.busy = true; draw();
    setResult('dbl-res', 'Крутится…', '');
    var strip = document.getElementById('dbl-strip');
    var res;
    try {
      res = one(await rpc('casino_double', { p_bet: bet, p_color: color }));
    } catch (e) {
      C.busy = false; draw(); setResult('dbl-res', errText(e), 'lose'); return;
    }
    updBal(Number(res.balance) - Number(res.payout)); // ставка уже списана; выигрыш покажем после остановки
    var idx = ORDER.indexOf(res.slot);
    var jitter = (Math.random() - 0.5) * (TILE - 16);
    var ms = reduce ? 200 : 4200;
    if (strip) {
      placeStrip(strip, 1, 0, 0, true);
      void strip.offsetWidth;
      placeStrip(strip, 6, idx, jitter, false, ms);
    }
    setTimeout(function () {
      C.busy = false;
      C.dblPos = { rep: 6, idx: idx, jitter: jitter };
      updBal(res.balance);
      draw();
      var d = res.payout - bet;
      var name = res.color === 'red' ? 'красное' : res.color === 'black' ? 'чёрное' : 'зелёное';
      setResult('dbl-res', 'Выпало ' + name + ' ' + res.slot + ' · ' + (d === 0 ? 'ставка вернулась' : signed(d)), d > 0 ? 'win' : d < 0 ? 'lose' : '');
      loadHistory();
    }, ms + 80);
  }

  /* ---------- Сапёр ---------- */
  // Оранжевый кристалл (статичная разметка, без пользовательских данных).
  var GEM = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10l4 6-9 12L3 9z" fill="#F2782C"/><path d="M3 9h18M7 3l2 6 3 12M17 3l-2 6-3 12M9 9l3-6 3 6" fill="none" stroke="#FFB37A" stroke-width="1.1" stroke-linejoin="round"/><path d="M7 3h10l4 6-9 12L3 9z" fill="none" stroke="#C4500B" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  function gem() { var g = el('span', { class: 'gem' }); g.innerHTML = GEM; return g; }

  // Как в базе: 14/15 от честного множителя (прибыль казино ≈6,7%); пока ничего не открыто — ×1.
  function minesMult(m, k) { if (k <= 0) return 1; var x = 14 / 15; for (var i = 0; i < k; i++) x *= (25 - i) / (25 - m - i); return x; }

  function drawMines(box) {
    var M = C.mines;
    var playing = !!M.round;
    var grid = el('div', { class: 'mines-grid', role: 'grid', 'aria-label': 'Поле 5 на 5' });
    for (var i = 0; i < 25; i++) {
      (function (cell) {
        var opened = M.opened.indexOf(cell) >= 0;
        var isMine = M.over && M.over.mines && M.over.mines.indexOf(cell) >= 0;
        var boom = M.over && M.over.boom === cell;
        var cls = 'mine-cell' + (opened ? ' safe' : '') + (isMine ? ' bomb' : '') + (boom ? ' boom' : '');
        var b = el('button', {
          type: 'button', class: cls, 'aria-label': 'Клетка ' + (cell + 1),
          disabled: (!playing || opened || C.busy) ? true : null,
          text: isMine && !opened ? '💣' : '',
          onclick: function () { openCell(cell); }
        });
        if (opened) b.appendChild(gem());
        grid.appendChild(b);
      })(i);
    }
    var info, actions;
    if (playing) {
      var k = M.opened.length;
      var next = minesMult(M.count, k + 1);
      info = el('div', { class: 'mines-info' }, [
        el('span', { text: 'Множитель ×' + minesMult(M.count, k).toFixed(2) }),
        el('span', { class: 'muted', text: k + 1 <= 25 - M.count ? 'следующая ×' + next.toFixed(2) : '' })
      ]);
      actions = el('div', { class: 'row actions' }, [el('button', {
        type: 'button', class: 'btn primary mines-cash', disabled: C.busy ? true : null,
        text: 'Забрать ' + fmt(M.payout || C.bet) + ' 🪙', onclick: cashMines
      })]);
    } else {
      var minesIn = el('input', { type: 'range', min: 2, max: 24, step: 1, value: String(M.count), id: 'mines-n', 'aria-label': 'Сколько мин' });
      var minesLbl = el('span', { class: 'mines-n', text: M.count + ' ' + A.plural(M.count, 'мина', 'мины', 'мин') });
      var hint = el('span', { class: 'muted small', text: 'первая клетка ×' + minesMult(M.count, 1).toFixed(2) });
      minesIn.addEventListener('input', function () {
        M.count = parseInt(minesIn.value, 10); save('casino-mines', M.count);
        minesLbl.textContent = M.count + ' ' + A.plural(M.count, 'мина', 'мины', 'мин');
        hint.textContent = 'первая клетка ×' + minesMult(M.count, 1).toFixed(2);
      });
      info = el('div', { class: 'mines-setup' }, [
        el('div', { class: 'row between' }, [el('label', { class: 'lbl', for: 'mines-n', text: 'Мины' }), minesLbl]),
        minesIn, hint
      ]);
      actions = el('div', { class: 'row actions' }, [el('button', {
        type: 'button', class: 'btn primary', text: M.over ? 'Играть ещё' : 'Начать', disabled: C.busy ? true : null, onclick: startMines
      })]);
    }
    box.replaceChildren(grid, playing ? info : betRow(C.busy), playing ? actions : info, playing ? el('span') : actions, resultLine('mines-res'));
    if (M.over && M.over.text) { var mt = M.over.text, mc = M.over.cls; setTimeout(function () { setResult('mines-res', mt, mc); }, 0); }
  }

  async function startMines() {
    var bet = readBet(); if (!bet) return;
    var M = C.mines;
    C.busy = true; draw();
    try {
      var r = one(await rpc('casino_mines_start', { p_bet: bet, p_mines: M.count }));
      M.round = r.round; M.bet = bet; M.opened = []; M.payout = bet; M.over = null;
      updBal(r.balance);
    } catch (e) {
      if (/active_round/.test(String(e && e.message))) await resume();
      else setTimeout(function () { setResult('mines-res', errText(e), 'lose'); }, 0);
    }
    C.busy = false; draw();
  }

  async function openCell(cell) {
    var M = C.mines;
    if (!M.round || C.busy) return;
    C.busy = true;
    try {
      var r = one(await rpc('casino_mines_open', { p_round: M.round, p_cell: cell }));
      M.opened = r.opened || M.opened;
      if (r.result === 'safe') {
        M.payout = r.payout;
      } else {
        var bet = M.bet;
        M.round = null;
        M.over = r.result === 'mine'
          ? { mines: r.mines, boom: cell, text: '💥 Мина! ' + signed(-bet), cls: 'lose' }
          : { mines: r.mines, text: 'Все клетки открыты! ×' + Number(r.mult).toFixed(2) + ' · ' + signed(r.payout - bet), cls: 'win' };
        updBal(r.balance);
        loadHistory();
      }
    } catch (e) {
      setResult('mines-res', errText(e), 'lose');
      if (/round_over|bad_round/.test(String(e && e.message))) M.round = null;
    }
    C.busy = false; draw();
  }

  async function cashMines() {
    var M = C.mines;
    if (!M.round || C.busy) return;
    C.busy = true; draw();
    try {
      var r = one(await rpc('casino_mines_cashout', { p_round: M.round }));
      var bet = M.bet;
      M.round = null;
      M.over = { mines: r.mines, text: 'Забрал ×' + Number(r.mult).toFixed(2) + ' · ' + signed(r.payout - bet), cls: r.payout > bet ? 'win' : '' };
      updBal(r.balance);
      loadHistory();
    } catch (e) { setResult('mines-res', errText(e), 'lose'); }
    C.busy = false; draw();
  }

  /* ---------- Краш ---------- */
  var K = 0.07; // скорость роста: ×(e^0,07·t), как в базе
  function crashMult(sec) { return Math.floor(100 * Math.exp(K * Math.max(0, sec))) / 100; }

  function drawCrash(box) {
    var R = C.crash;
    var running = !!R.round;
    var canvas = el('canvas', { class: 'crash-canvas', id: 'crash-canvas', 'aria-hidden': 'true' });
    var big = el('div', { class: 'crash-mult' + (R.last && R.last.cls ? ' ' + R.last.cls : ''), id: 'crash-mult', text: running ? '×1.00' : (R.last ? R.last.big : '×1.00') });
    var stage = el('div', { class: 'crash-stage' }, [canvas, big]);
    var autoIn = el('input', {
      type: 'number', inputmode: 'decimal', min: 1.01, step: 0.01, id: 'crash-auto', class: 'casino-bet-in',
      placeholder: 'нет', value: R.auto || '', 'aria-label': 'Автозабор, множитель', disabled: running || C.busy ? true : null
    });
    autoIn.addEventListener('input', function () { R.auto = autoIn.value; save('casino-auto', autoIn.value); });
    var btn = running
      ? el('button', { type: 'button', class: 'btn primary crash-btn cash', id: 'crash-btn', text: 'Забрать', onclick: cashCrash })
      : el('button', { type: 'button', class: 'btn primary crash-btn', id: 'crash-btn', text: 'Поставить', disabled: C.busy ? true : null, onclick: startCrash });
    box.replaceChildren(
      stage,
      running ? el('span') : betRow(C.busy),
      running ? el('span') : el('div', { class: 'casino-betrow' }, [
        el('label', { class: 'lbl', for: 'crash-auto', text: 'Автозабор на ×' }),
        el('div', { class: 'casino-betline' }, [autoIn, el('span', { class: 'muted small', text: 'необязательно' })])
      ]),
      el('div', { class: 'row actions' }, [btn]),
      resultLine('crash-res')
    );
    requestAnimationFrame(function () { sizeCanvas(); paintCrash(running ? liveSec() : (R.last ? R.last.sec : 0), R.last && R.last.cls === 'lose'); });
    if (R.last && R.last.text) { var rt = R.last.text, rc = R.last.cls; setTimeout(function () { setResult('crash-res', rt, rc); }, 0); }
  }

  function sizeCanvas() {
    var c = document.getElementById('crash-canvas');
    if (!c) return;
    var w = c.parentNode.clientWidth || 320, h = Math.round(Math.min(220, w * 0.6));
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.width = w + 'px'; c.style.height = h + 'px';
    c.parentNode.style.height = h + 'px';
  }
  function liveSec() { var R = C.crash; return (Date.now() + R.offset - R.startMs) / 1000; }

  function paintCrash(sec, crashed) {
    var c = document.getElementById('crash-canvas');
    if (!c) return;
    var ctx = c.getContext('2d'), dpr = c.width / (c.clientWidth || 1);
    var w = c.clientWidth, h = c.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var css = getComputedStyle(document.documentElement);
    var line = css.getPropertyValue('--line').trim() || '#333';
    var acc = css.getPropertyValue('--accent').trim() || '#F2782C';
    var err = css.getPropertyValue('--err').trim() || '#FF7A6B';
    var maxT = Math.max(8, sec * 1.15), maxM = Math.max(2, Math.exp(K * maxT));
    var pad = 10;
    function X(t) { return pad + (t / maxT) * (w - pad * 2); }
    function Y(m) { return h - pad - ((m - 1) / (maxM - 1)) * (h - pad * 2); }
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad, h - pad); ctx.lineTo(w - pad, h - pad); ctx.stroke();
    if (sec <= 0) return;
    ctx.strokeStyle = crashed ? err : acc; ctx.lineWidth = 3; ctx.lineJoin = 'round';
    ctx.beginPath();
    var steps = 60;
    for (var i = 0; i <= steps; i++) {
      var t = sec * i / steps, x = X(t), y = Y(Math.exp(K * t));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    var ex = X(sec), ey = Y(Math.exp(K * sec));
    ctx.fillStyle = crashed ? err : acc;
    ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI * 2); ctx.fill();
  }

  async function startCrash() {
    var R = C.crash;
    var bet = readBet(); if (!bet) return;
    var auto = parseFloat(String(R.auto || '').replace(',', '.'));
    if (R.auto && !(auto >= 1.01)) { A.toast('Автозабор — от ×1.01'); return; }
    C.busy = true; draw();
    try {
      var t0 = Date.now();
      var r = one(await rpc('casino_crash_start', { p_bet: bet, p_auto: auto >= 1.01 ? auto : null }));
      var rtt = Date.now() - t0;
      R.round = r.round; R.bet = bet; R.startMs = Number(r.started_ms);
      R.offset = Number(r.started_ms) + rtt / 2 - Date.now(); // разница часов телефона и базы
      R.last = null;
      updBal(r.balance);
      C.busy = false; draw();
      runCrash();
    } catch (e) {
      C.busy = false; draw();
      if (/active_round/.test(String(e && e.message))) { await resume(); draw(); if (C.crash.round) runCrash(); }
      else setResult('crash-res', errText(e), 'lose');
    }
  }

  function runCrash() {
    var R = C.crash;
    stopCrashLoops();
    function frame() {
      R.raf = 0;
      if (!R.round) return;
      var s = liveSec();
      var m = document.getElementById('crash-mult');
      if (m) m.textContent = '×' + crashMult(s).toFixed(2);
      var b = document.getElementById('crash-btn');
      if (b && !C.busy) b.textContent = 'Забрать ' + fmt(floor2(R.bet * crashMult(s))) + ' 🪙';
      paintCrash(s, false);
      R.raf = requestAnimationFrame(frame);
    }
    R.raf = requestAnimationFrame(frame);
    // база говорит, не взорвалось ли (точку взрыва телефон не знает)
    (function poll() {
      R.timer = setTimeout(async function () {
        if (!R.round) return;
        try {
          var st = one(await rpc('casino_crash_step', { p_round: R.round, p_cashout: false }));
          if (st.result !== 'running') finishCrash(st);
          else poll();
        } catch (e) { poll(); }
      }, 300);
    })();
  }
  function stopCrashLoops() {
    var R = C.crash;
    if (R.raf) cancelAnimationFrame(R.raf);
    if (R.timer) clearTimeout(R.timer);
    R.raf = 0; R.timer = 0;
  }

  async function cashCrash() {
    var R = C.crash;
    if (!R.round || C.busy) return;
    C.busy = true;
    var b = document.getElementById('crash-btn'); if (b) { b.disabled = true; b.textContent = 'Забираю…'; }
    try {
      var st = one(await rpc('casino_crash_step', { p_round: R.round, p_cashout: true }));
      C.busy = false;
      finishCrash(st);
    } catch (e) {
      C.busy = false;
      setResult('crash-res', errText(e), 'lose');
      if (b) { b.disabled = false; }
    }
  }

  function finishCrash(st) {
    var R = C.crash;
    if (!R.round) return;
    stopCrashLoops();
    var bet = R.bet;
    var sec = Math.log(Math.max(1, Number(st.crash || st.mult || 1))) / K;
    if (st.result === 'won') {
      var d = st.payout - bet;
      R.last = { big: '×' + Number(st.mult).toFixed(2), cls: 'win', sec: Math.log(Math.max(1, Number(st.mult))) / K,
        text: 'Забрал на ×' + Number(st.mult).toFixed(2) + ' · ' + signed(d) + ' (взрыв был на ×' + Number(st.crash).toFixed(2) + ')' };
    } else {
      R.last = { big: '💥 ×' + Number(st.crash).toFixed(2), cls: 'lose', sec: sec, text: 'Взрыв на ×' + Number(st.crash).toFixed(2) + ' · ' + signed(-bet) };
    }
    R.round = null;
    updBal(st.balance);
    draw();
    loadHistory();
  }

  /* ---------- продолжить незаконченный раунд ---------- */
  async function resume() {
    var list;
    try { list = await rpc('casino_active') || []; } catch (e) { return; }
    list.forEach(function (r) {
      if (r.game === 'mines') {
        C.mines.round = r.round; C.mines.bet = r.bet; C.mines.count = r.info.mines;
        C.mines.opened = r.info.opened || []; C.mines.over = null;
        C.mines.payout = floor2(Number(r.bet) * minesMult(r.info.mines, C.mines.opened.length));
        C.game = 'mines';
      } else if (r.game === 'crash') {
        C.crash.round = r.round; C.crash.bet = r.bet; C.crash.startMs = Number(r.started_ms);
        C.crash.offset = Number(r.server_ms) - Date.now(); C.crash.last = null;
        C.game = 'crash';
      }
    });
  }

  /* ---------- вход и выход с вкладки ---------- */
  async function enter() {
    A = window.AppAPI;
    if (!A) return;
    try { await A.loadPoints(); } catch (e) { /* покажем то, что есть */ }
    updBal();
    await resume();
    draw();
    loadHistory();
    if (C.crash.round) runCrash();
  }
  function leave() {
    stopCrashLoops();   // раунд краша продолжится в базе; при возврате продолжим
    root = null;
  }
  window.addEventListener('resize', function () { if (root && C.game === 'crash') { sizeCanvas(); paintCrash(C.crash.round ? liveSec() : (C.crash.last ? C.crash.last.sec : 0), C.crash.last && C.crash.last.cls === 'lose'); } });

  window.Casino = {
    view: function () { A = window.AppAPI; return view(); },
    enter: enter, leave: leave,
    // для проверок
    _state: function () { return C; },
    _mult: { mines: minesMult, crash: crashMult }
  };
})();
