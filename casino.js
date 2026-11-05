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
    bets: {}, // своя ставка у каждой игры: { double: 10, mines: 2, crash: 5 }
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
  // текст с 🪙 → текст с нашей монетой
  function setText(n, t) { if (window.Coin) window.Coin.fill(n, t); else n.textContent = t; }
  function fmt(n) { return A.fmt(n); }
  // Ставка текущей игры. Хранится отдельно для Дабла, Сапёра и Краша (casino-bet-double и т. д.).
  // Если своей ещё нет — берём старую общую ставку (casino-bet), чтобы у всех ничего не сбросилось.
  function getBet() {
    var g = C.game;
    if (!(C.bets[g] > 0)) C.bets[g] = c2(parseFloat(load('casino-bet-' + g, load('casino-bet', '10')))) || 10;
    return C.bets[g];
  }
  function setBet(v) { C.bets[C.game] = v; save('casino-bet-' + C.game, v); }
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
    if (b) setText(b, '🪙 ' + fmt(bal()));
  }

  // Поле ставки с быстрыми кнопками.
  function betRow(disabled) {
    var input = el('input', {
      type: 'number', inputmode: 'decimal', min: 0.01, step: 0.01, id: 'casino-bet', class: 'casino-bet-in',
      'aria-label': 'Ставка', value: String(getBet()), disabled: disabled ? true : null
    });
    input.addEventListener('input', function () {
      var v = c2(parseFloat(String(input.value).replace(',', '.')));
      if (v > 0) setBet(v);
    });
    function quick(label, fn) {
      return el('button', {
        type: 'button', class: 'btn casino-q', text: label, disabled: disabled ? true : null,
        onclick: function () { var v = Math.max(0.01, floor2(fn(getBet()))); setBet(v); input.value = String(v); }
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
    var raw = i ? parseFloat(String(i.value).replace(',', '.')) : getBet();
    var v = c2(raw);
    if (!(v >= 0.01)) { A.toast('Ставка — от 0,01 монеты'); return 0; }
    if (v > bal() + 1e-9) { A.toast('Не хватает монет: у тебя ' + fmt(bal())); return 0; }
    setBet(v);
    return v;
  }
  function resultLine(id) { return el('p', { class: 'casino-res', id: id, role: 'status' }); }
  function setResult(id, text, cls) {
    var r = document.getElementById(id);
    if (!r) return;
    setText(r, text);
    r.className = 'casino-res' + (cls ? ' ' + cls : '');
  }
  function signed(delta) { delta = c2(delta); return (delta > 0 ? '+' : delta < 0 ? '−' : '±') + fmt(Math.abs(delta)) + ' 🪙'; }

  /* ---------- история ---------- */
  // fresh = true после сыгранной партии: новая строка сверху ненадолго подсвечивается
  async function loadHistory(fresh) {
    var g = C.game;
    try { C.history[g] = await rpc('casino_history', { p_game: g, p_limit: 12 }) || []; } catch (e) { C.history[g] = C.history[g] || []; }
    var h = document.getElementById('casino-hist');
    if (h && C.game === g) { C.fresh = fresh ? g : null; drawHistory(h); C.fresh = null; }
  }
  function hhmm(ts) {
    var d = new Date(ts);
    return isNaN(d) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  function drawHistory(sect) {
    var list = C.history[C.game];
    // «Сапёр»: если ставку забрали сразу, не открыв ни одной клетки, — это не игра, в истории её не показываем
    if (list && C.game === 'mines') list = list.filter(function (r) { return r.state !== 'refund'; });
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
    sect.appendChild(el('div', { class: 'casino-rows' }, list.slice(0, 8).map(function (r, i) {
      var d = Number(r.payout || 0) - Number(r.bet);
      var refund = r.state === 'refund';
      var what = C.game === 'double' ? colorName(r.info && r.info.pick)
        : C.game === 'mines' ? (r.info.mines + ' ' + A.plural(r.info.mines, 'мина', 'мины', 'мин') + ', открыто ' + (r.info.opened || []).length)
          : (r.info && r.info.cashed ? 'забрал на ×' + Number(r.info.cashed).toFixed(2) : 'взрыв ×' + Number(r.info.crash).toFixed(2));
      return el('div', { class: 'casino-row' + (i === 0 && C.fresh === C.game ? ' fresh' : '') }, [
        el('span', { class: 'casino-row-l' }, [
          el('span', { class: 'muted', text: what }),
          el('span', { class: 'casino-row-t', text: hhmm(r.finished_at) + ' · ставка ' + fmt(r.bet) + ' 🪙' })
        ]),
        el('span', { class: 'casino-row-d ' + (refund ? 'refund' : d > 0 ? 'win' : d < 0 ? 'lose' : ''), text: refund ? 'возврат' : signed(d) })
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
      draw(); // итог под кнопками не пишем — он виден в «Последних играх»
      loadHistory(true);
    }, ms + 80);
  }

  /* ---------- Сапёр ---------- */
  // Оранжевый кристалл (статичная разметка, без пользовательских данных).
  var GEM = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10l4 6-9 12L3 9z" fill="#F2782C"/><path d="M3 9h18M7 3l2 6 3 12M17 3l-2 6-3 12M9 9l3-6 3 6" fill="none" stroke="#FFB37A" stroke-width="1.1" stroke-linejoin="round"/><path d="M7 3h10l4 6-9 12L3 9z" fill="none" stroke="#C4500B" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  function gem() { var g = el('span', { class: 'gem' }); g.innerHTML = GEM; return g; }

  // Как в базе: 14/15 от честного множителя (прибыль казино ≈6,7%); пока ничего не открыто — ×1.
  var MINES_MIN = 2, MINES_MAX = 24; // как в базе (casino_mines_start)
  // Целое число мин из поля ввода или 0, если вписано что-то не то.
  function readMines(v) { var n = Number(String(v).trim()); return n === Math.floor(n) && n >= MINES_MIN && n <= MINES_MAX ? n : 0; }
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
        text: 'Забрать ' + fmt(M.payout || M.bet) + ' 🪙', onclick: cashMines
      })]);
    } else {
      // Число мин: можно вписать (от 2 до 24) или менять кнопками − и +. Всё в одной строке с «Начать».
      var minesIn = el('input', {
        type: 'number', inputmode: 'numeric', min: MINES_MIN, max: MINES_MAX, step: 1, value: String(M.count), id: 'mines-n',
        class: 'casino-bet-in mines-in', 'aria-label': 'Сколько мин, от ' + MINES_MIN + ' до ' + MINES_MAX, disabled: C.busy ? true : null
      });
      var hint = el('span', { class: 'muted small mines-hint', id: 'mines-hint' });
      function showHint() {
        var v = readMines(minesIn.value);
        minesIn.classList.toggle('bad', !v);
        hint.textContent = v ? 'первая клетка ×' + minesMult(v, 1).toFixed(2)
                             : 'мин можно от ' + MINES_MIN + ' до ' + MINES_MAX;
      }
      function setCount(v) {
        v = Math.min(MINES_MAX, Math.max(MINES_MIN, v));
        M.count = v; save('casino-mines', v); minesIn.value = String(v); showHint();
      }
      minesIn.addEventListener('input', function () { var v = readMines(minesIn.value); if (v) { M.count = v; save('casino-mines', v); } showHint(); });
      // неверное число не исправляем молча (это ставка денег): поле краснеет, «Начать» не запустит игру
      minesIn.addEventListener('change', function () { var v = readMines(minesIn.value); if (v) setCount(v); else showHint(); });
      function step(label, d, name) {
        return el('button', { type: 'button', class: 'btn mines-stepbtn', text: label, 'aria-label': name, disabled: C.busy ? true : null,
          onclick: function () { setCount((readMines(minesIn.value) || M.count) + d); } });
      }
      showHint();
      info = el('div', { class: 'mines-setup' }, [
        el('div', { class: 'mines-row' }, [
          el('label', { class: 'lbl', for: 'mines-n', text: 'Мины' }),
          el('div', { class: 'mines-step' }, [step('−', -1, 'Меньше мин'), minesIn, step('+', 1, 'Больше мин')]),
          el('button', { type: 'button', class: 'btn primary mines-go', text: M.over ? 'Ещё раз' : 'Начать', disabled: C.busy ? true : null, onclick: startMines })
        ]),
        hint
      ]);
    }
    box.replaceChildren(grid, playing ? info : betRow(C.busy), playing ? actions : info, resultLine('mines-res'));
  }

  async function startMines() {
    var M = C.mines;
    var inp = document.getElementById('mines-n');
    var n = inp ? readMines(inp.value) : M.count;
    if (!n) { setResult('mines-res', 'Мин можно от ' + MINES_MIN + ' до ' + MINES_MAX + '.', 'lose'); return; }
    M.count = n; save('casino-mines', n);
    var bet = readBet(); if (!bet) return;
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
        M.round = null;
        // итог под кнопкой не пишем — поле показывает мины, а сумма видна в «Последних играх»
        M.over = r.result === 'mine' ? { mines: r.mines, boom: cell } : { mines: r.mines };
        updBal(r.balance);
        loadHistory(true);
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
      var back = Number(r.payout) === Number(bet); // забрал сразу — ставка вернулась, ничего не пишем
      M.round = null;
      M.over = { mines: r.mines };
      updBal(r.balance);
      loadHistory(!back);
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
      ? cashBtnParts(el('button', { type: 'button', class: 'btn primary crash-btn cash', id: 'crash-btn', onclick: cashCrash }))
      : el('button', { type: 'button', class: 'btn primary crash-btn', id: 'crash-btn', text: 'Поставить', disabled: C.busy ? true : null, onclick: startCrash });
    box.replaceChildren(
      stage,
      running ? el('span') : betRow(C.busy),
      running ? el('span') : el('div', { class: 'casino-betrow' }, [
        el('label', { class: 'lbl', for: 'crash-auto', text: 'Автозабор на ×' }),
        el('div', { class: 'casino-betline' }, [autoIn])
      ]),
      el('div', { class: 'row actions' }, [btn]),
      resultLine('crash-res')
    );
    requestAnimationFrame(function () {
      sizeCanvas();
      if (R.anim) return; // идёт показ «до взрыва» — рисует он
      paintCrash(running ? liveSec() : (R.last ? R.last.sec : 0), R.last && R.last.cls === 'lose', R.last && !running ? R.last.cashedSec : null);
    });
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

  // Сетка «Краша»: линии множителей (×1.5, ×2, ×5…) и линии времени.
  // Масштаб растёт вместе с иксом, поэтому линии плывут вниз и влево, а слишком частые
  // плавно растворяются и сменяются более редкими — так видно, как быстро растёт множитель.
  // Цвет едва заметный, чтобы сетка не отвлекала от линии и большого числа.
  // шаги вложены друг в друга (каждый делится на предыдущий), чтобы линии не путались
  var Y_STEPS = [0.25, 0.5, 1, 2, 10, 20, 100, 200, 1000, 2000, 10000];
  var T_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  function fadeIn(px, from, to) { return Math.max(0, Math.min(1, (px - from) / (to - from))); }
  function drawGrid(ctx, w, h, pad, maxT, maxM, X, Y, mono) {
    var plotW = w - pad * 2, plotH = h - pad * 2, seen = {}, i, k, s, px, a;
    ctx.lineWidth = 1;
    ctx.font = '500 10px ' + mono;
    ctx.textBaseline = 'bottom';
    // вертикальные — время (без подписей)
    for (i = T_STEPS.length - 1; i >= 0; i--) {
      s = T_STEPS[i]; px = s * plotW / maxT; a = fadeIn(px, 18, 44);
      if (a <= 0) break; // дальше шаги ещё мельче — линии слишком густые
      for (k = 1; k * s < maxT; k++) {
        if (seen['t' + k * s]) continue; seen['t' + k * s] = 1;
        var x = Math.round(X(k * s)) + 0.5;
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.045 * a).toFixed(3) + ')';
        ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, h - pad); ctx.stroke();
      }
    }
    // горизонтальные — множитель, у заметных линий слева маленькая подпись «×2»
    for (i = Y_STEPS.length - 1; i >= 0; i--) {
      s = Y_STEPS[i]; px = s * plotH / (maxM - 1); a = fadeIn(px, 14, 40);
      if (a <= 0) break;
      var la = fadeIn(px, 22, 38);
      for (k = Math.floor(1 / s) + 1; k * s < maxM; k++) { // круглые значения: ×1.25, ×1.5, ×2, ×4, ×10, ×20…
        var m = Math.round(k * s * 100) / 100;
        if (seen['m' + m]) continue; seen['m' + m] = 1;
        var y = Math.round(Y(m)) + 0.5;
        if (y < pad + 2) continue;
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.07 * a).toFixed(3) + ')';
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
        if (la > 0 && y > pad + 12) {
          ctx.fillStyle = 'rgba(160,150,142,' + (0.7 * la).toFixed(3) + ')';
          ctx.fillText('×' + m, pad + 4, y - 2);
        }
      }
    }
  }

  function paintCrash(sec, crashed, cashedSec) {
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
    drawGrid(ctx, w, h, pad, maxT, maxM, X, Y, css.getPropertyValue('--font-mono').trim() || 'monospace');
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
    // где сработал забор — светлая точка с обводкой
    if (typeof cashedSec === 'number' && cashedSec > 0 && cashedSec <= sec + 1e-6) {
      var cx = X(cashedSec), cy = Y(Math.exp(K * cashedSec));
      ctx.fillStyle = '#FFB37A'; ctx.strokeStyle = acc; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  // После выигрыша линия не останавливается: на месте забора остаётся точка,
  // а линия от того места, где была на экране, быстро «догоняет» до взрыва этого раунда.
  function revealAfterWin(cashed, cp, fromSec) {
    var R = C.crash;
    stopReveal();
    var big = document.getElementById('crash-mult');
    var s0 = Math.log(cashed) / K, s1 = Math.log(cp) / K;
    if (!big || reduce || cp <= cashed) return;
    var sa = Math.min(s1, Math.max(s0, fromSec || s0)); // откуда продолжаем: не назад и не дальше взрыва
    if (sa >= s1) return;
    big.textContent = '×' + crashMult(sa).toFixed(2);
    big.className = 'crash-mult rising';
    paintCrash(sa, false, s0);
    var dur = Math.max(700, Math.min(1600, 600 + (s1 - sa) * 90));
    var t0 = 0;
    function frame(now) {
      if (C.crash.round || !document.getElementById('crash-mult')) { R.anim = 0; return; }
      if (!t0) t0 = now;
      var p = Math.min(1, Math.max(0, (now - t0) / dur));
      var e = 1 - Math.pow(1 - p, 3);
      var sec = sa + (s1 - sa) * e;
      var b = document.getElementById('crash-mult');
      if (p < 1) {
        b.textContent = '×' + Math.min(cp, crashMult(sec)).toFixed(2);
        b.className = 'crash-mult rising';
        paintCrash(sec, false, s0);
        R.anim = requestAnimationFrame(frame);
      } else {
        R.anim = 0;
        b.textContent = R.last ? R.last.big : '×' + cp.toFixed(2);
        b.className = 'crash-mult after';
        paintCrash(s1, false, s0);
      }
    }
    R.anim = requestAnimationFrame(frame);
  }
  function stopReveal() { var R = C.crash; if (R.anim) cancelAnimationFrame(R.anim); R.anim = 0; }

  async function startCrash() {
    var R = C.crash;
    var bet = readBet(); if (!bet) return;
    var auto = parseFloat(String(R.auto || '').replace(',', '.'));
    if (R.auto && !(auto >= 1.01)) { A.toast('Автозабор — от ×1.01'); return; }
    stopReveal();
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
      if (!C.busy) setCashNum(floor2(R.bet * crashMult(s)));
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

  // Кнопка «Забрать [число] 🪙»: слово и монета стоят на месте, меняется только число.
  // Число всегда с двумя знаками после запятой и в «коробке» постоянной ширины (цифры одной ширины),
  // поэтому кнопка не дёргается на каждом кадре. Коробка заранее на одну цифру шире и растёт только вверх.
  function cashBtnParts(b) {
    b.replaceChildren(
      el('span', { text: 'Забрать' }),
      el('span', { class: 'crash-num', id: 'crash-num' }),
      el('span', { class: 'crash-coin', text: '🪙' })
    );
    var R = C.crash;
    R.numCh = 0;
    setCashNum(floor2((R.bet || 0) * (R.round ? crashMult(liveSec()) : 1)), b.querySelector('.crash-num'));
    return b;
  }
  function setCashNum(v, node) {
    var n = node || document.getElementById('crash-num');
    if (!n) return;
    var t = Number(v).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var R = C.crash;
    var need = R.numCh ? t.length : t.length + 1;
    if (need > (R.numCh || 0)) { R.numCh = need; n.style.minWidth = need + 'ch'; }
    n.textContent = t;
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
      if (b) { b.disabled = false; cashBtnParts(b); }
    }
  }

  function finishCrash(st) {
    var R = C.crash;
    if (!R.round) return;
    var shownSec = liveSec(); // докуда линия дошла на экране — оттуда и продолжим
    stopCrashLoops();
    var sec = Math.log(Math.max(1, Number(st.crash || st.mult || 1))) / K;
    var won = st.result === 'won';
    if (won) {
      var cashed = Number(st.mult), cp = Number(st.crash);
      // на карточке — где взорвалось, точка на линии — где забрал.
      // Под кнопкой после раунда ничего не пишем: итог виден по линии, балансу и истории.
      R.last = { big: '×' + cp.toFixed(2), cls: 'after', sec: Math.log(Math.max(1, cp)) / K, cashedSec: Math.log(Math.max(1, cashed)) / K };
    } else {
      R.last = { big: '×' + Number(st.crash).toFixed(2), cls: 'lose', sec: sec };
    }
    R.round = null;
    updBal(st.balance);
    draw();
    if (won) revealAfterWin(Number(st.mult), Number(st.crash), shownSec);
    loadHistory(true);
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
    stopCrashLoops();
    stopReveal();   // раунд краша продолжится в базе; при возврате продолжим
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
