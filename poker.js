/* «Покер» (техасский холдем без лимита): столы на 2–6 человек, фишки = монеты.
   Всё решает база (таблицы poker_tables и poker_seats, функции poker_*): раздача, проверка хода, банки, время.
   Телефон получает только свой вид (poker_view) — свои карты, общие карты, сколько у кого фишек — и отправляет ходы.
   Рисунки карт и полёты — общие с «Дураком» (playing-cards.js). Связь с сайтом — через window.AppAPI. */
(function () {
  'use strict';
  var A = null;
  var PC = window.PlayingCards;
  // Уровни блайндов — как в базе (poker_level). Вход за стол — от 40 до 100 больших блайндов.
  var LEVELS = [[1, 0.01, 0.02], [2, 0.05, 0.10], [3, 0.25, 0.50], [4, 1, 2], [5, 5, 10], [6, 25, 50]];
  var K = {
    list: null, listErr: null, form: false, level: 1, buy: '', test: false, listPoll: null,
    sitFor: null, sitBuy: '',
    open: null, st: null, poll: null,
    rootEl: null, sig: '', busy: false, msg: '', msgErr: false, admin: false,
    lastI: -1, anim: false, wasTurn: false,
    quitAsk: false, topAsk: false, topBuy: '', raise: false, raiseTo: null
  };
  try { var lv = parseInt(localStorage.getItem('poker-level'), 10); if (lv >= 1 && lv <= 6) K.level = lv; } catch (e) { /* ничего */ }

  function el() { return A.el.apply(null, arguments); }
  function setText(node, t) { if (window.Coin && window.Coin.has(t)) window.Coin.fill(node, t); else node.textContent = t; }
  function cents(n) { return Math.round(Number(n || 0) * 100) / 100; }
  function fmt(n) { return A.fmt(n); }
  function coins(n) { return fmt(n) + ' 🪙'; }
  // За столом с ботами игра на ненастоящие фишки — суммы без монетки
  function play() { return !!(K.open && K.st && K.st.test); }
  function money(n) { return play() ? fmt(n) : coins(n); }
  // блайнды меньше 1 — всегда с двумя знаками: 0,05 / 0,10
  function bl(n) { n = Number(n); return n < 1 ? n.toFixed(2).replace('.', ',') : fmt(n); }
  function blinds(sb, bb) { return bl(sb) + ' / ' + bl(bb); }
  function levelOf(n) { for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i][0] === n) return LEVELS[i]; return LEVELS[0]; }
  // «12,5» → 12.5; пусто или не число — null; больше двух знаков после запятой — null
  function parseAmt(v) {
    var s = String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.');
    if (s === '' || !/^\d+(\.\d{0,2})?$/.test(s)) return null;
    return cents(Number(s));
  }
  function amtText(n) { return String(cents(n)).replace('.', ','); }
  async function rpc(name, args) {
    var r = await A.sb().rpc(name, args || {});
    if (r.error) throw r.error;
    return r.data;
  }
  function errText(e) {
    var m = String((e && (e.message || e.error)) || e || '');
    if (/poker_not_enough/.test(m)) return 'Не хватает монет.';
    if (/poker_busy/.test(m)) return 'Ты уже сидишь за другим столом — сначала встань из-за него.';
    if (/poker_full/.test(m)) return 'За столом уже 6 человек.';
    if (/poker_too_many/.test(m)) return 'Открытых столов может быть не больше 3.';
    if (/poker_bad_buyin/.test(m)) return 'Такую сумму взять нельзя.';
    if (/poker_bad_level/.test(m)) return 'Таких блайндов нет.';
    if (/poker_not_turn/.test(m)) return 'Сейчас не твой ход.';
    if (/poker_small_raise/.test(m)) return 'Слишком маленькое повышение.';
    if (/poker_bad_move/.test(m)) return 'Так сходить нельзя.';
    if (/poker_in_hand/.test(m)) return 'Докупить можно после раздачи.';
    if (/poker_gone/.test(m)) return 'Этот стол уже неактуален.';
    if (/not_admin/.test(m)) return 'Это может только админ.';
    if (/failed to fetch|network|load failed/i.test(m)) return 'Нет связи. Попробуй ещё раз.';
    return 'Что-то пошло не так.';
  }
  // Карта лучшей комбинации — с подсветкой (какие карты подсветить, решает comboMarks при каждой перерисовке стола)
  function cardEl(c, opts) {
    if (HIT[c]) opts = Object.assign({}, opts, { cls: ((opts && opts.cls) ? opts.cls + ' ' : '') + 'pk-hit' });
    return PC.face(c, opts);
  }
  function backEl(opts) { return PC.back(opts); }

  /* ---------- лучшая комбинация ---------- */
  // combo:start — так же, как считает база (poker_eval): из 2–7 карт берём лучшую комбинацию.
  // Отдаём название и карты, из которых она сложена (без «довесков»): у пары — 2 карты, у двух пар — 4, у стрита — 5 и т. д.
  var COMBO = ['Старшая карта', 'Пара', 'Две пары', 'Тройка', 'Стрит', 'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш'];
  function bestHand(list) {
    var cards = (list || []).filter(function (c) { return c != null; });
    if (!cards.length) return null;
    function R(c) { return Math.floor(c / 4) + 2; }
    // от старших к младшим; при равенстве порядок сохраняется (сначала свои карты, потом общие)
    var sorted = cards.map(function (c, i) { return [c, i]; })
      .sort(function (a, b) { return R(b[0]) - R(a[0]) || a[1] - b[1]; }).map(function (x) { return x[0]; });
    var byRank = {}, bySuit = [[], [], [], []], ranks = [];
    sorted.forEach(function (c) {
      if (!byRank[R(c)]) { byRank[R(c)] = []; ranks.push(R(c)); }
      byRank[R(c)].push(c);
      bySuit[c % 4].push(c);
    });
    function made(cat, used) { return { cat: cat, name: cat === 8 && R(used[0]) === 14 ? 'Роял-флеш' : COMBO[cat], cards: used }; }
    // пять карт подряд (туз бывает и единицей: Т-2-3-4-5) — самый старший такой ряд
    function straight(from) {
      var one = {};
      from.forEach(function (c) { if (!one[R(c)]) one[R(c)] = c; });
      for (var top = 14; top >= 5; top--) {
        var row = [];
        for (var r = top; r > top - 5; r--) { var c = one[r === 1 ? 14 : r]; if (c == null) break; row.push(c); }
        if (row.length === 5) return row;
      }
      return null;
    }
    var flush = null;
    bySuit.forEach(function (s) { if (s.length >= 5) flush = s; });
    var sf = flush && straight(flush);
    if (sf) return made(8, sf);
    var groups = ranks.map(function (r) { return byRank[r]; });
    var quads = groups.filter(function (g) { return g.length === 4; });
    var trips = groups.filter(function (g) { return g.length === 3; });
    var pairs = groups.filter(function (g) { return g.length === 2; });
    if (quads.length) return made(7, quads[0]);
    if (trips.length && (trips.length > 1 || pairs.length)) {
      var two = trips[1] && (!pairs.length || R(trips[1][0]) > R(pairs[0][0])) ? trips[1].slice(0, 2) : pairs[0];
      return made(6, trips[0].concat(two));
    }
    if (flush) return made(5, flush.slice(0, 5));
    var st = straight(sorted);
    if (st) return made(4, st);
    if (trips.length) return made(3, trips[0]);
    if (pairs.length >= 2) return made(2, pairs[0].concat(pairs[1]));
    if (pairs.length) return made(1, pairs[0]);
    return made(0, [sorted[0]]);
  }
  // combo:end

  // Что подсветить на столе. В раздаче — мою лучшую комбинацию (мои 2 карты + открытые общие);
  // на вскрытии — комбинацию победителя основного банка. mine — моя комбинация (название пишется в моей рамке).
  var HIT = {};
  function comboMarks(st) {
    var hit = {}, mine = null, my = st.my, board = st.board || [];
    var live = st.status === 'play' || !!st.result;
    if (my && live && my.in_hand && !my.folded && my.hole && my.hole.length) mine = bestHand(my.hole.concat(board));
    var seats = [];
    if (st.status === 'open' && st.result && st.result.showdown) seats = ((st.result.pots || [])[0] || {}).seats || [];
    else if (mine) seats = [my.seat];
    seats.forEach(function (s) {
      var hole = my && my.seat === s ? my.hole : (playerAt(s) || {}).cards;
      var h = hole && hole.length ? bestHand(hole.concat(board)) : null;
      if (h) h.cards.forEach(function (c) { hit[c] = true; });
    });
    return { hit: hit, mine: mine };
  }

  /* ---------- поле суммы (вход за стол, докупка) ---------- */
  // key — где в K хранится текст; min/max — границы; quick — [[надпись, сумма]]; onSync — после каждого изменения
  function amountField(key, id, min, max, quick, onSync) {
    var input = el('input', { type: 'text', inputmode: 'decimal', id: id, autocomplete: 'off', 'aria-label': 'Сумма' });
    input.value = K[key];
    input.addEventListener('input', function () {
      var v = input.value.replace(/[^\d.,]/g, '').slice(0, 10);
      if (v !== input.value) input.value = v;
      K[key] = v; onSync();
    });
    var coin = el('span', { class: 'duel-coin', 'aria-hidden': 'true' }); setText(coin, '🪙');
    var q = el('div', { class: 'duel-quick' }, quick.map(function (x) {
      return el('button', { type: 'button', class: 'btn small', text: x[0], onclick: function () { K[key] = amtText(x[1]); input.value = K[key]; onSync(); } });
    }));
    return el('div', { class: 'duel-stake' }, [el('span', { class: 'duel-stake-in pk-amt' }, [input, coin]), q]);
  }
  // Сумма по умолчанию: 100 ББ, но не больше баланса
  function defaultBuy(min, max) {
    var bal = Math.floor(A.balance() * 100) / 100;
    return amtText(bal >= max ? max : bal >= min ? bal : max);
  }
  // Проверка суммы: { n, ok, err }
  function checkBuy(text, min, max, test) {
    var n = parseAmt(text);
    if (n === null || n < min || n > max) return { n: n, ok: false, err: n === null ? '' : 'От ' + money(min) + ' до ' + money(max) };
    if (!test && n > A.balance()) return { n: n, ok: false, err: 'Не хватает: у тебя ' + coins(Math.floor(A.balance() * 100) / 100) };
    return { n: n, ok: true, err: '' };
  }

  /* ---------- список столов ---------- */
  async function loadList() {
    var before = JSON.stringify(K.list || null);
    try { K.list = (await rpc('poker_list')) || { tables: [], history: [] }; K.listErr = null; } catch (e) { K.listErr = e; }
    if (JSON.stringify(K.list || null) === before && K.rootEl && K.rootEl.childNodes.length) return;
    if (!K.open && K.rootEl && !(K.rootEl.contains(document.activeElement) && document.activeElement.tagName === 'INPUT')) paint(true);
  }
  function fold(key, title, body, cls) {
    var d = el('details', { class: 'day dk-fold ' + (cls || '') }, [el('summary', { text: title })].concat(body));
    d.open = !!K[key];
    d.addEventListener('toggle', function () { K[key] = d.open; });
    return d;
  }

  function lobby() {
    var out = [];
    out.push(el('div', { class: 'duel-head' }, [
      el('h2', { text: 'Столы' }),
      el('button', { type: 'button', class: 'btn' + (K.form ? '' : ' primary'), text: K.form ? 'Закрыть' : 'Новый стол',
        'data-dismiss-trigger': 'pk-form', onclick: function () { K.form = !K.form; K.sitFor = null; if (K.form && !K.buy) resetBuy(); paint(true); } })
    ]));
    if (K.form) out.push(createForm());
    var tables = (K.list && K.list.tables) || [];
    var history = (K.list && K.list.history) || [];
    if (!K.list) {
      out.push(el('p', { class: 'muted', text: K.listErr ? errText(K.listErr) : 'Загружаю…' }));
    } else if (!tables.length) {
      if (!K.form) out.push(el('p', { class: 'empty', text: 'Столов пока нет' }));
    } else {
      out.push(el('div', { class: 'duel-list' }, tables.map(tableRow)));
    }
    out.push(rulesBlock());
    if (history.length) out.push(fold('histOpen', 'История игр', [el('div', { class: 'duel-list' }, history.map(histRow))], 'dk-history'));
    return out;
  }

  function avatars(players) {
    return el('span', { class: 'dk-avs' }, (players || []).slice(0, 6).map(function (p) { return A.avatar(p.name, p.color, true, p.avatar); }));
  }

  function tableRow(t) {
    var players = t.players || [];
    var n = players.length;
    var msg = el('p', { class: 'msg', role: 'status' });
    var acts = [], cls = '';
    var title = 'Блайнды ' + blinds(t.sb, t.bb);
    var line = t.test ? n + ' из 6 · с ботами, на фишки' : n + ' из 6 · вход ' + bl(t.min_buy) + '–' + bl(t.max_buy) + ' 🪙';
    if (t.mine) {
      cls = ' incoming';
      acts.push(el('button', { type: 'button', class: 'btn primary', text: 'Вернуться', onclick: function () { openTable(t.id); } }));
    } else if (n < 6) {
      var open = K.sitFor === t.id;
      acts.push(el('button', { type: 'button', class: 'btn' + (open ? '' : ' primary'), text: open ? 'Закрыть' : 'Сесть', 'data-dismiss-trigger': 'pk-sit',
        onclick: function () {
          K.form = false;
          if (K.sitFor === t.id) { K.sitFor = null; } else { K.sitFor = t.id; K.sitBuy = defaultBuy(t.min_buy, t.max_buy); }
          paint(true);
        } }));
    }
    var lineEl = el('span', { class: 'duel-line' }); setText(lineEl, line);
    var row = el('div', { class: 'duel-row' + cls }, [
      avatars(players),
      el('div', { class: 'duel-info' }, [el('span', { class: 'duel-name', text: title }), lineEl]),
      acts.length ? el('div', { class: 'duel-acts' }, acts) : null,
      msg
    ]);
    if (K.sitFor === t.id && !t.mine) row.appendChild(sitForm(t.id, t.min_buy, t.max_buy, 'sitBuy', 'pk-sit', function () { K.sitFor = null; }));
    return row;
  }

  // Сесть за стол: сумма от 40 до 100 ББ
  function sitForm(id, min, max, key, dkey, onClose) {
    var msg = el('p', { class: 'msg', role: 'status' });
    var go = el('button', { type: 'button', class: 'btn primary duel-go' });
    function sync() {
      var c = checkBuy(K[key], min, max, play());
      setText(go, c.ok ? 'Сесть · ' + money(c.n) : 'Сесть');
      go.disabled = !c.ok || K.busy;
      msg.className = 'msg' + (c.err ? ' err' : ''); setText(msg, c.err);
    }
    go.addEventListener('click', async function () {
      var c = checkBuy(K[key], min, max, play());
      if (!c.ok) return;
      go.disabled = true;
      try { await rpc('poker_sit', { p_table: id, p_buyin: c.n }); A.loadPoints(); onClose(); openTable(id); }
      catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); go.disabled = false; loadList(); }
    });
    var field = amountField(key, 'pk-buy-' + id, min, max, [['Мин', min], ['Макс', max]], sync);
    sync();
    if (A.dismissible) A.dismissible(dkey, function () { if (!K.busy) { onClose(); paint(true); } });
    return el('div', { class: 'pk-sit', 'data-dismiss': dkey }, [
      el('label', { class: 'duel-label', for: 'pk-buy-' + id, text: 'Сколько взять за стол' }), field, go, msg
    ]);
  }

  function resetBuy() { var l = levelOf(K.level); K.buy = defaultBuy(40 * l[2], 100 * l[2]); }

  function createForm() {
    var msg = el('p', { class: 'msg', role: 'status' });
    var go = el('button', { type: 'button', class: 'btn primary duel-go' });
    var l = levelOf(K.level), min = cents(40 * l[2]), max = cents(100 * l[2]);
    function sync() {
      buyBox.hidden = K.test;
      note.hidden = !K.test;
      if (K.test) { setText(go, 'Открыть стол с ботами'); go.disabled = false; msg.className = 'msg'; msg.textContent = ''; return; }
      var c = checkBuy(K.buy, min, max, false);
      setText(go, c.ok ? 'Открыть стол · ' + coins(c.n) : 'Открыть стол');
      go.disabled = !c.ok;
      msg.className = 'msg' + (c.err ? ' err' : ''); setText(msg, c.err);
    }
    var levels = el('div', { class: 'pk-levels', role: 'group', 'aria-label': 'Блайнды' }, LEVELS.map(function (x) {
      return el('button', { type: 'button', class: 'chip duel-chip pk-level', 'aria-pressed': String(K.level === x[0]), text: blinds(x[1], x[2]),
        onclick: function () {
          if (K.level === x[0]) return;
          K.level = x[0]; try { localStorage.setItem('poker-level', String(x[0])); } catch (e) { /* ничего */ }
          resetBuy(); paint(true);
        } });
    }));
    go.addEventListener('click', async function () {
      var c = checkBuy(K.buy, min, max, K.test);
      if (!K.test && !c.ok) return;
      go.disabled = true;
      try {
        var id = await rpc('poker_create', K.test ? { p_level: K.level, p_buyin: null, p_test: true } : { p_level: K.level, p_buyin: c.n });
        A.loadPoints();
        K.form = false; K.buy = '';
        openTable(Number(id));
      } catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); go.disabled = false; }
    });
    var buyBox = el('div', { class: 'dk-stake-box' }, [
      el('label', { class: 'duel-label', for: 'pk-buy', text: 'Сколько взять за стол' }),
      amountField('buy', 'pk-buy', min, max, [['Мин', min], ['Макс', max]], sync)
    ]);
    var testRow = null;
    var note = el('p', { class: 'duel-label pk-note', text: 'Фишки ненастоящие и не кончаются — монеты не тратятся.' });
    if (K.admin) {
      var tb = el('button', { type: 'button', class: 'chip duel-chip dk-test-chip', 'aria-pressed': String(K.test) }, [el('span', { text: 'С ботами, на фишки' })]);
      tb.addEventListener('click', function () { K.test = !K.test; tb.setAttribute('aria-pressed', String(K.test)); sync(); });
      testRow = el('div', { class: 'dk-test-row' }, [tb]);
    }
    sync();
    if (A.dismissible) A.dismissible('pk-form', function () { if (K.form && !K.busy) { K.form = false; paint(true); } });
    return el('div', { class: 'card duel-form', 'data-dismiss': 'pk-form' }, [
      testRow, note, el('p', { class: 'duel-label', text: 'Блайнды' }), levels, buyBox, go, msg
    ]);
  }

  function histRow(h) {
    var net = Number(h.net || 0);
    var money = el('span', { class: 'duel-line pk-net' + (net > 0 ? ' plus' : net < 0 ? ' minus' : '') });
    setText(money, (net > 0 ? '+' : net < 0 ? '−' : '') + coins(Math.abs(net)));
    var n = h.hands || 0;
    return el('div', { class: 'duel-row' + (net > 0 ? ' win' : net < 0 ? ' lose' : '') }, [
      el('span', { class: 'pk-hist-ico', 'aria-hidden': 'true', text: '♠︎' }),
      el('div', { class: 'duel-info' }, [
        el('span', { class: 'duel-name', text: 'Блайнды ' + blinds(h.sb, h.bb) }),
        el('span', { class: 'duel-line', text: n + ' ' + A.plural(n, 'раздача', 'раздачи', 'раздач') + (h.left_kind === 'bust' ? ' · фишки кончились' : h.left_kind === 'afk' ? ' · по времени' : '') })
      ]),
      money
    ]);
  }

  function rulesBlock() {
    var items = [
      'У каждого 2 свои закрытые карты. В центре по очереди открываются 5 общих: сначала 3, потом ещё 1 и ещё 1.',
      'Из своих 2 и общих 5 собирается лучшая пятёрка. У кого она сильнее — тот забирает банк.',
      'Комбинации от слабой к сильной: старшая карта, пара, две пары, тройка, стрит (5 подряд), флеш (5 одной масти), фулл-хаус (тройка и пара), каре (4 одинаковые), стрит-флеш.',
      'Перед раздачей двое после дилера (D) ставят обязательные ставки — малый и большой блайнд. Дилер сдвигается каждую раздачу.',
      'Четыре круга ставок: до общих карт, после трёх, после четвёртой и после пятой. В свой ход: пас, чек (если ставок нет), уравнять, поставить или повысить.',
      'Повысить можно минимум на столько же, на сколько повысили до тебя. Ва-банк — поставить всё.',
      'Если у кого-то ва-банк меньше чужой ставки, этот игрок может выиграть только ту часть банка, которую уравнял.',
      'Равные комбинации — банк делится.',
      'За стол садишься с суммой от 40 до 100 больших блайндов — это твои фишки. Встаёшь — остаток сразу на баланс. Комиссии нет.',
      'Время на ход не ограничено — стол ждёт. Если в раздаче сутки никто не ходит, она отменяется: поставленное возвращается, стол закрывается.'
    ];
    return fold('rulesOpen', 'Правила', [el('ul', { class: 'dk-rules-list' }, items.map(function (t) { return el('li', { text: t }); }))], 'dk-rules');
  }

  /* ---------- стол ---------- */
  function isOpen() { return !!K.open; }
  function openTable(id) {
    K.open = id; K.st = null; K.sig = ''; K.msg = ''; K.lastI = -1; K.wasTurn = false;
    K.quitAsk = false; K.topAsk = false; K.raise = false; K.raiseTo = null; K.sitFor = null;
    stopListPoll();
    paint(true);
    window.scrollTo(0, 0);
    startPoll();
  }
  function closeTable() {
    stopPoll();
    K.open = null; K.st = null; K.sig = ''; K.quitAsk = false; K.topAsk = false; K.raise = false;
    paint(true);
    loadList();
    startListPoll();
  }
  function startPoll() {
    stopPoll(); tick();
    K.poll = setInterval(function () { if (!document.hidden) tick(); }, 1000);
  }
  function stopPoll() {
    if (K.poll) { clearInterval(K.poll); K.poll = null; }
  }
  var ticking = false;
  async function tick() {
    if (ticking || !K.open) return;
    ticking = true;
    var id = K.open;
    try {
      var st = await rpc('poker_view', { p_table: id });
      if (!st || K.open !== id) return;
      var was = K.st;
      if (was && was.version === st.version && was.status === st.status && !!was.my === !!st.my) { K.st = st; return; }
      // сначала анимацией показываем, что произошло (на старом столе), потом рисуем новый
      var fresh = (st.log || []).filter(function (e) { return e.i > K.lastI; });
      // за столом с ботами фишки кончились — выдали ещё
      if (was && st.my) fresh.forEach(function (e) { if (e.kind === 'rebuy' && e.seat === st.my.seat) A.toast('Фишки кончились — выдали ещё ' + fmt(e.amount)); });
      if (was && K.lastI >= 0 && fresh.length && fresh.length <= 10 && !document.hidden && !PC.REDUCED
          && K.rootEl && K.rootEl.querySelector('.pk-table') && fresh.some(animated)) {
        K.anim = true;
        K.rootEl.classList.add('dk-anim');
        try { await animate(fresh, st); } catch (e2) { /* анимация не важна */ }
        K.rootEl.classList.remove('dk-anim');
        K.anim = false;
      }
      K.lastI = (st.log || []).reduce(function (m, e) { return Math.max(m, e.i || 0); }, Math.max(K.lastI, 0));
      var myWas = was && was.my, myNow = st.my;
      K.st = st;
      // монеты на балансе меняются, когда садишься, встаёшь или вылетаешь
      if (!was || !!myWas !== !!myNow || (myWas && myNow && myWas.buyin !== myNow.buyin)) A.loadPoints();
      if (!myNow || !myNow.turn) { K.raise = false; K.raiseTo = null; }
      if (myNow && !myNow.can_topup) K.topAsk = false;
      paint();
    } catch (e) {
      if (/poker_gone/.test(String(e && e.message))) { A.toast('Стола больше нет'); closeTable(); }
    } finally { ticking = false; }
  }

  async function act(name, args, done) {
    if (K.busy || (K.anim && name === 'poker_act')) return;   // ход — после анимации; встать и докупить можно сразу
    K.busy = true; K.msg = '';
    if (name === 'poker_act') K.raise = false;   // окошко «Повысить» закрывается сразу — видно, как фишки едут на стол
    paint(true);
    try {
      var r = await rpc(name, Object.assign({ p_table: K.open }, args || {}));
      K.raise = false; K.raiseTo = null; K.quitAsk = false; K.topAsk = false;
      if (done) done(r);
      if (name === 'poker_leave') { A.loadPoints(); K.busy = false; closeTable(); return; }
      if (name === 'poker_topup' || name === 'poker_sit') A.loadPoints();
      await tick();
    } catch (e) {
      K.msg = errText(e); K.msgErr = true;
      await tick();
    } finally {
      K.busy = false;
      paint(true);
    }
  }
  function move(kind, to) { act('poker_act', { p_kind: kind, p_to: to == null ? null : to }); }

  function players() { return (K.st && K.st.players) || []; }
  function playerAt(seat) { var p = players(); for (var i = 0; i < p.length; i++) if (p[i].seat === seat) return p[i]; return null; }
  function potTotal(st) { return cents(Number(st.pot || 0) + players().reduce(function (s, p) { return s + Number(p.bet || 0); }, 0)); }
  var ACTS = { fold: 'пас', check: 'чек', call: 'колл', bet: 'ставка', raise: 'рейз', allin: 'ва-банк', sb: 'МБ', bb: 'ББ' };

  // Над столом: блайнды, «Докупить», «Выйти» (с коротким предупреждением)
  function gameBar(st) {
    var my = st.my;
    var lbl = el('span', { class: 'dk-bank pk-blinds' }, [blinds(st.sb, st.bb) + (st.test ? ' · с ботами' : '')]);
    var right = [];
    if (st.test && st.creator && my && players().length < 6 && st.status !== 'closed') {
      right.push(el('button', { type: 'button', class: 'dk-quit', text: '+ бот', disabled: K.busy, onclick: function () { act('poker_add_bot'); } }));
    }
    if (my && my.can_topup && Number(my.topup_max) > 0) {
      right.push(el('button', { type: 'button', class: 'dk-quit', text: 'Докупить', 'aria-expanded': String(!!K.topAsk), 'data-dismiss-trigger': 'pk-top',
        onclick: function () { K.topAsk = !K.topAsk; K.quitAsk = false; if (K.topAsk) K.topBuy = amtText(my.topup_max); paint(true); } }));
    }
    right.push(el('button', { type: 'button', class: 'dk-quit', text: my ? 'Выйти' : 'К столам', 'aria-expanded': String(!!K.quitAsk), 'data-dismiss-trigger': 'pk-quit',
      onclick: function () { if (!my) { closeTable(); return; } K.quitAsk = !K.quitAsk; K.topAsk = false; paint(true); } }));
    var kids = [lbl, el('div', { class: 'pk-bar-acts' }, right)];
    if (K.quitAsk && my) {
      if (A.dismissible) A.dismissible('pk-quit', function () { if (K.quitAsk) { K.quitAsk = false; paint(true); } });
      var inHand = st.status === 'play' && my.in_hand && !my.folded;
      kids.push(el('div', { class: 'dk-quit-pop', role: 'dialog', 'aria-label': 'Встать из-за стола?', 'data-dismiss': 'pk-quit' }, [
        el('p', { text: st.test ? (inHand ? 'Встать из-за стола? Карты сбросятся, стол с ботами закроется.' : 'Встать из-за стола? Стол с ботами закроется.')
          : inHand ? 'Встать из-за стола? Карты сбросятся, остаток фишек вернётся на баланс.' : 'Встать из-за стола? Фишки вернутся на баланс.' }),
        el('div', { class: 'dk-quit-acts' }, [
          el('button', { type: 'button', class: 'btn small', text: 'Остаться', onclick: function () { K.quitAsk = false; paint(true); } }),
          el('button', { type: 'button', class: 'btn small danger', text: 'Встать', disabled: K.busy,
            onclick: function () { act('poker_leave', null, function (r) { if (Number(r) > 0 && !st.test) A.toast('На баланс: ' + coins(r)); }); } })
        ])
      ]));
    }
    if (K.topAsk && my) kids.push(topupPop(st));
    return el('div', { class: 'dk-gamebar' }, kids);
  }

  function topupPop(st) {
    var my = st.my, max = cents(my.topup_max), min = 0.01;
    var msg = el('p', { class: 'msg', role: 'status' });
    var go = el('button', { type: 'button', class: 'btn small primary' });
    function sync() {
      var c = checkBuy(K.topBuy, min, max, st.test);
      setText(go, c.ok ? 'Докупить · ' + money(c.n) : 'Докупить');
      go.disabled = !c.ok || K.busy;
      msg.className = 'msg' + (c.err ? ' err' : ''); setText(msg, c.err);
    }
    go.addEventListener('click', function () {
      var c = checkBuy(K.topBuy, min, max, st.test);
      if (c.ok) act('poker_topup', { p_amount: c.n });
    });
    var field = amountField('topBuy', 'pk-top', min, max, [['До 100 ББ', max]], sync);
    sync();
    if (A.dismissible) A.dismissible('pk-top', function () { if (K.topAsk) { K.topAsk = false; paint(true); } });
    return el('div', { class: 'dk-quit-pop pk-top-pop', role: 'dialog', 'aria-label': 'Докупить фишки', 'data-dismiss': 'pk-top' }, [
      field, el('div', { class: 'dk-quit-acts' }, [go]), msg
    ]);
  }

  function msgLine() {
    var m = el('p', { class: 'msg' + (K.msgErr && K.msg ? ' err' : ''), role: 'status' });
    m.textContent = K.msg || '';
    return m;
  }

  function winOf(st, seat) {
    var w = st.status === 'open' && st.result && st.result.win;
    return w && w[String(seat)] != null ? Number(w[String(seat)]) : 0;
  }
  function stackEl(n, cls) {
    var s = el('span', { class: 'pk-stack' + (cls ? ' ' + cls : '') });
    setText(s, money(n));
    return s;
  }
  // Ставка игрока: подпись суммы (сами фишки сразу уезжают в банк). Место есть всегда, пустое — невидимое.
  function betEl(p) {
    var b = el('span', { class: 'pk-bet', 'data-bet': String(p.seat) });
    setBet(b, p.bet);
    return b;
  }
  function setBet(b, n) {
    if (!b) return;
    var on = Number(n) > 0;
    b.classList.toggle('none', !on);
    b.textContent = on ? fmt(n) : '';
  }
  // Колода на столе (слева): из неё летят карты в руки и на стол
  function deckEl() {
    return el('span', { class: 'pk-deck', 'aria-hidden': 'true' }, [backEl({ cls: 'l2' }), backEl({ cls: 'l1' }), backEl()]);
  }
  // Бита (справа): сброшенные карты рубашками вразнобой — после паса, сожжённые перед каждой улицей, в конце раздачи
  var BITA = [[-14, 0, 2], [9, 3, -1], [-4, -2, 1], [17, 2, 3], [-9, -1, -2], [5, 1, 0], [-19, -3, 2], [12, 2, -3]];   // поворот, сдвиг x, y
  function bitaEl(n) { var b = el('span', { class: 'pk-bita' }); fillBita(b, n); return b; }
  function fillBita(b, n) {
    if (!b) return;
    b.setAttribute('data-n', String(n));
    b.setAttribute('aria-label', n ? 'Бита: ' + n + ' ' + A.plural(n, 'карта', 'карты', 'карт') : 'Бита');
    var kids = [];
    for (var i = 0; i < Math.min(n, BITA.length); i++) {
      var c = backEl();
      c.style.transform = 'translate(' + BITA[i][1] + 'px,' + BITA[i][2] + 'px) rotate(' + BITA[i][0] + 'deg)';
      kids.push(c);
    }
    b.replaceChildren.apply(b, kids);
  }
  // Сколько карт в бите по столу: сожжённые (флоп — 1, тёрн — 2, ривер — 3) и по 2 у каждого спасовавшего
  function bitaCount(st) {
    var n = (st.board || []).length;
    var folded = players().filter(function (p) { return p.in_hand && p.folded; }).length;
    return (n >= 3 ? n - 2 : 0) + folded * 2;
  }
  // Банк — куча фишек: каждая ставка добавляет фишки. Фишек ≈ 2,6·√(банк в ББ), от 1 до 40,
  // стопки по 5 и меньше, до 8 стопок в два ряда (передний ряд чуть ниже и сдвинут) — большой банк выглядит массивно
  function pileEl(n, bb) {
    var x = Math.max(0, Number(n) / (Number(bb) || 1));
    var k = Math.max(1, Math.min(40, Math.round(2.6 * Math.sqrt(x))));
    var cnt = Math.min(8, Math.ceil(k / 5)), hs = [];
    for (var i = 0; i < cnt; i++) hs.push(Math.floor(k / cnt) + (i < k % cnt ? 1 : 0));
    function col(h, tone) {
      var chips = [];
      for (var j = 0; j < h; j++) chips.push(el('i', { class: 'pk-chip c' + (tone % 4 + 1) }));
      return el('span', { class: 'pk-pile-col' }, chips);
    }
    var rows = [el('span', { class: 'pk-pile-row' }, hs.slice(0, 4).map(function (h, t) { return col(h, t); }))];
    if (hs.length > 4) rows.push(el('span', { class: 'pk-pile-row front' }, hs.slice(4).map(function (h, t) { return col(h, t + 2); })));
    return el('span', { class: 'pk-pile', 'aria-hidden': 'true', 'data-chips': String(k) }, rows);
  }
  function fillPot(pot, n, bb) {
    if (!pot) return;
    pot.classList.remove('win', 'wait');
    var on = Number(n) > 0;
    pot.replaceChildren.apply(pot, on ? [pileEl(n, bb), el('span', { class: 'pk-pot-n', text: fmt(n) })] : []);
    if (on) pot.setAttribute('aria-label', 'Банк ' + fmt(n)); else pot.removeAttribute('aria-label');
  }
  // Две карты игрока: лицом (свои или открытые на вскрытии), рубашкой (в раздаче) или пусто
  function holeEl(p, big) {
    var kids = [];
    if (p.cards && p.cards.length) kids = p.cards.map(function (c) { return cardEl(c, { small: !big }); });
    else if (p.hidden) kids = [backEl({ small: !big }), backEl({ small: !big })];
    return el('span', { class: 'pk-hole' + (big ? ' big' : '') + (p.folded ? ' folded' : '') + (kids.length ? '' : ' none'), 'data-hole': String(p.seat) }, kids);
  }

  // Имя и аватарка игрока: нажал — мини-профиль. Ботов не открываем; в свой ход — сначала сходи.
  function canPeek() {
    var st = K.st;
    if (st && st.status === 'play' && st.my && st.turn === st.my.seat) { A.toast('Сначала сходи'); return false; }
    return true;
  }

  function oppBox(p, st, spot) {
    var turn = st.status === 'play' && st.turn === p.seat;
    var win = winOf(st, p.seat);
    var tag = win > 0 ? '+' + fmt(win) : p.in_hand && p.act ? ACTS[p.act] || '' : !p.in_hand && st.status === 'play' ? 'ждёт' : '';
    var head = [A.avatar(p.name, p.color, true, p.avatar), el('span', { class: 'dk-opp-name', text: p.name })];
    if (st.button === p.seat && (st.status === 'play' || st.result)) head.push(el('span', { class: 'pk-d', 'aria-label': 'Дилер', text: 'D' }));
    var x = p.bot && st.test && st.creator ? el('button', { type: 'button', class: 'x pk-x', 'aria-label': 'Убрать ' + p.name, text: '×', disabled: K.busy,
      onclick: function () { act('poker_remove_bot', { p_bot: p.id }); } }) : null;
    return el('div', { class: 'pk-opp at-' + spot + (turn ? ' turn' : '') + (p.in_hand && p.folded ? ' folded' : '') + (win > 0 ? ' won' : ''),
      'data-seat': String(p.seat), style: 'grid-area:' + spot }, [
      x,
      !p.bot && p.id && A.person ? A.person(p.id, head, { cls: 'dk-opp-head', label: 'Профиль: ' + p.name, guard: canPeek }) : el('div', { class: 'dk-opp-head' }, head),
      holeEl(p, false),
      stackEl(p.stack),
      el('span', { class: 'pk-tag' + (win > 0 ? ' win' : p.act === 'allin' ? ' hot' : ''), text: tag }),
      betEl(p)
    ]);
  }

  // Середина стола: над общими картами — колода слева, банк кучей фишек посередине (на вскрытии вместо банка — выигравшая комбинация),
  // бита справа; ряд шириной с общие карты
  function midEl(st) {
    var board = st.board || [];
    var slots = [];
    for (var i = 0; i < 5; i++) slots.push(el('span', { class: 'pk-slot', 'data-pos': String(i) }, board[i] != null ? [cardEl(board[i])] : []));
    var n = players().length;
    var pot = el('span', { class: 'pk-pot' });
    if (st.status === 'play') {
      fillPot(pot, potTotal(st), st.bb);                       // в куче — и банк, и ставки этого круга
    } else if (st.result && st.result.showdown) {
      var names = [];
      (st.result.pots || []).forEach(function (p) { if (p.name && names.indexOf(p.name) < 0) names.push(p.name); });
      pot.classList.add('win'); pot.textContent = names.join(' · ');
    } else if (n < 2 && st.status === 'open') {
      pot.classList.add('wait'); pot.textContent = st.test && st.creator ? 'Добавь бота' : 'Ждём игроков';
    }
    var top = el('div', { class: 'pk-mid-top' }, [deckEl(), pot, bitaEl(st.status === 'play' || st.result ? bitaCount(st) : 0)]);
    return el('div', { class: 'pk-mid', style: 'grid-area:mid' }, [el('div', { class: 'pk-felt' }, [top, el('div', { class: 'pk-board' }, slots)])]);
  }

  // Я: две карты, фишки, комбинация, ставка; в свой ход — «Твой ход» и кнопки (время на ход не ограничено). Строка и кнопки есть всегда — рамка не прыгает.
  function meBox(st) {
    var my = st.my;
    var p = playerAt(my.seat) || {};
    var turn = !!my.turn;
    var fresh = turn && !K.wasTurn;
    var win = winOf(st, my.seat);
    var line = el('div', { class: 'dk-turn-line' + (turn ? ' on' : '') + (fresh ? ' pop' : '') }, [
      el('span', { class: 'dk-turn-lbl' }, [el('span', { class: 'dk-turn-t', text: 'Твой ход' })])
    ]);
    var box = el('div', { class: 'dk-me pk-me' + (turn ? ' turn' : '') + (fresh ? ' pop' : '') + (win > 0 ? ' won' : ''), 'data-seat': String(my.seat) });
    // спасовал — карты ушли в биту, в рамке пусто
    var hole = holeEl(Object.assign({}, p, { cards: my.folded ? [] : my.hole, hidden: false, folded: my.folded }), true);
    if (!my.in_hand) hole = el('span', { class: 'pk-hole big none pk-wait', 'data-hole': String(my.seat), text: st.status === 'play' ? 'Со следующей раздачи' : '' });
    var tag = win > 0 ? '+' + fmt(win) : my.in_hand && p.act ? ACTS[p.act] || '' : '';
    // строка с названием моей комбинации есть всегда (пустая, если карт нет) — рамка не прыгает
    var combo = my.in_hand && K.combo ? K.combo.name : '';
    var info = el('div', { class: 'pk-me-info' }, [
      el('div', { class: 'pk-me-top' }, [stackEl(my.stack, 'big'), st.button === my.seat && (st.status === 'play' || st.result) ? el('span', { class: 'pk-d', 'aria-label': 'Дилер', text: 'D' }) : null]),
      // на вскрытии проиграл — моё название серое, оранжевым подсвечен победитель
      el('div', { class: 'pk-combo' + (st.result && st.result.showdown && win <= 0 ? ' off' : ''), text: combo }),
      el('div', { class: 'pk-me-bot' }, [betEl(p), el('span', { class: 'pk-tag' + (win > 0 ? ' win' : p.act === 'allin' ? ' hot' : ''), text: tag })])
    ]);
    box.appendChild(el('div', { class: 'pk-me-row' }, [hole, info]));
    box.appendChild(actionsEl(st, turn));
    if (K.raise && turn) box.appendChild(raisePop(st));
    if (K.msg) box.appendChild(msgLine());
    K.wasTurn = turn;
    return el('div', { class: 'dk-me-wrap' }, [line, box]);
  }

  function actionsEl(st, turn) {
    var my = st.my;
    var call = Number(my.call || 0);
    var dis = !turn || K.busy;
    var b1 = el('button', { type: 'button', class: 'btn', text: 'Пас', disabled: dis, onclick: function () { move('fold'); } });
    var b2;
    if (my.can_check) b2 = el('button', { type: 'button', class: 'btn', text: 'Чек', disabled: dis, onclick: function () { move('check'); } });
    else {
      b2 = el('button', { type: 'button', class: 'btn two', disabled: dis, onclick: function () { move('call'); } },
        [el('span', { text: call >= Number(my.stack) ? 'Ва-банк' : 'Уравнять' }), el('small', { text: fmt(call) })]);
    }
    var b3;
    if (my.can_raise) {
      var allinOnly = Number(my.min_to) >= Number(my.max_to);
      b3 = el('button', { type: 'button', class: 'btn primary', disabled: dis, 'aria-expanded': String(!!K.raise), 'data-dismiss-trigger': 'pk-raise',
        text: allinOnly ? 'Ва-банк' : Number(st.cur_bet) > 0 ? 'Повысить' : 'Ставка',
        onclick: function () {
          if (allinOnly) { move('allin'); return; }
          K.raise = !K.raise; if (K.raise && K.raiseTo == null) K.raiseTo = Number(my.min_to); paint(true);
        } });
    } else {
      b3 = el('button', { type: 'button', class: 'btn primary', text: 'Повысить', disabled: true });
    }
    return el('div', { class: 'pk-acts' + (turn ? ' on' : '') }, [b1, b2, b3]);
  }

  // Повышение: ползунок от минимума до всех фишек, быстрые кнопки, подтверждение. Всплывает над кнопками и ничего не сдвигает.
  // Окошко «Повысить»: сумму можно набрать на клавиатуре, подвинуть ползунком, кнопками «−» / «+» (на 1 ББ) или быстрыми кнопками
  function raisePop(st) {
    var my = st.my;
    var min = Number(my.min_to), max = Number(my.max_to), cur = Number(st.cur_bet), bb = Number(st.bb) || 0.02;
    if (K.raiseTo == null || K.raiseTo < min) K.raiseTo = min;
    if (K.raiseTo > max) K.raiseTo = max;
    var input = el('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'done', class: 'pk-raise-in', 'aria-label': 'Сколько поставить' });
    var coin = null;
    if (!play()) { coin = el('span', { class: 'duel-coin', 'aria-hidden': 'true' }); setText(coin, '🪙'); }
    var go = el('button', { type: 'button', class: 'btn primary pk-raise-go' });
    var range = el('input', { type: 'range', min: String(Math.round(min * 100)), max: String(Math.round(max * 100)), step: '1', 'aria-label': 'Сколько поставить, ползунок' });
    function setTo(v) { K.raiseTo = Math.max(min, Math.min(max, cents(v))); sync(); }
    var minus = el('button', { type: 'button', class: 'btn small pk-step', text: '−', 'aria-label': 'Меньше на ' + fmt(bb), onclick: function () { setTo(cents(K.raiseTo) - bb); } });
    var plus = el('button', { type: 'button', class: 'btn small pk-step', text: '+', 'aria-label': 'Больше на ' + fmt(bb), onclick: function () { setTo(cents(K.raiseTo) + bb); } });
    // fromInput — набирают сами: поле не трогаем
    function sync(fromInput) {
      var v = cents(K.raiseTo);
      if (!fromInput) input.value = amtText(v);
      input.classList.remove('bad');
      range.value = String(Math.round(v * 100));
      go.disabled = false;
      go.textContent = v >= max ? 'Ва-банк ' + fmt(v) : (cur > 0 ? 'Повысить до ' : 'Ставка ') + fmt(v);
      minus.disabled = v <= min; plus.disabled = v >= max;
    }
    input.addEventListener('focus', function () { input.select(); });
    input.addEventListener('input', function () {
      var t = input.value.replace(/[^\d.,]/g, '').slice(0, 10);
      if (t !== input.value) input.value = t;
      var v = parseAmt(t);
      if (v != null && v >= min && v <= max) { K.raiseTo = v; sync(true); return; }
      // пусто, не число или вне границ — подсказка вместо кнопки
      input.classList.add('bad');
      go.disabled = true;
      go.textContent = 'От ' + fmt(min) + ' до ' + fmt(max);
    });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (!go.disabled) { input.blur(); go.click(); } } });
    range.addEventListener('input', function () { K.raiseTo = Number(range.value) / 100; sync(); });
    var pot = potTotal(st), call = Number(my.call || 0);
    var quick = el('div', { class: 'pk-raise-quick' }, [
      el('button', { type: 'button', class: 'btn small', text: '½ банка', onclick: function () { setTo(cur + (pot + call) / 2); } }),
      el('button', { type: 'button', class: 'btn small', text: 'Банк', onclick: function () { setTo(cur + pot + call); } }),
      el('button', { type: 'button', class: 'btn small', text: 'Ва-банк', onclick: function () { setTo(max); } })
    ]);
    go.addEventListener('click', function () {
      if (go.disabled) return;
      var v = cents(K.raiseTo);
      if (v >= max) move('allin'); else move('raise', v);
    });
    sync();
    if (A.dismissible) A.dismissible('pk-raise', function () { if (K.raise) { K.raise = false; paint(true); } });
    return el('div', { class: 'pk-raise', role: 'dialog', 'aria-label': 'Сколько поставить', 'data-dismiss': 'pk-raise' }, [
      el('div', { class: 'pk-raise-top' }, [minus, el('span', { class: 'duel-stake-in pk-raise-field' }, [input, coin]), plus]),
      quick, range, go
    ]);
  }

  // Не за столом: почему (фишки кончились / время вышло), «Сесть за стол» или «К столам»
  function sitBox(st) {
    var box = el('div', { class: 'card duel-lobby pk-out' });
    var g = st.gone;
    if (st.status === 'closed') box.appendChild(el('p', { class: 'duel-big', text: 'Стол закрыт' }));
    else if (g && g.kind === 'bust') box.appendChild(el('p', { class: 'duel-big', text: 'Фишки закончились' }));
    else if (g && g.kind === 'afk') box.appendChild(el('p', { class: 'duel-big', text: 'Время на ход вышло два раза подряд — фишки вернулись на баланс' }));
    if (g && g.kind !== 'bust' && Number(g.net) !== 0) {
      var net = Number(g.net);
      var m = el('span', { class: 'pk-net' + (net > 0 ? ' plus' : ' minus') });
      setText(m, 'За столом: ' + (net > 0 ? '+' : '−') + money(Math.abs(net)));
      box.appendChild(m);
    }
    var canSit = st.status !== 'closed' && players().length < 6 && (!st.test || st.creator);
    if (canSit) {
      if (!K.sitBuy) K.sitBuy = defaultBuy(Number(st.min_buy), Number(st.max_buy));
      box.appendChild(sitForm(st.id, Number(st.min_buy), Number(st.max_buy), 'sitBuy', 'pk-sit-t', function () {}));
    }
    box.appendChild(el('div', { class: 'duel-acts' }, [el('button', { type: 'button', class: 'btn', text: 'К столам', onclick: closeTable })]));
    return box;
  }

  function tableEl(st) {
    var mySeat = st.my ? st.my.seat : -1;
    var marks = comboMarks(st);
    HIT = marks.hit; K.combo = marks.mine;
    // соперники по часовой стрелке, начиная со следующего после меня: слева → сверху → справа
    var opps = players().filter(function (p) { return !p.me; }).sort(function (a, b) {
      return ((a.seat - mySeat + 12) % 6) - ((b.seat - mySeat + 12) % 6);
    });
    var spots = { 1: ['top'], 2: ['tl', 'tr'], 3: ['l', 'top', 'r'], 4: ['l', 'tl', 'tr', 'r'], 5: ['l', 'tl', 'top', 'tr', 'r'], 6: ['l', 'tl', 'top', 'tr', 'r', 'bot'] }[opps.length] || [];
    var ring = el('div', { class: 'dk-ring pk-ring n' + opps.length }, opps.map(function (p, i) { return oppBox(p, st, spots[i]); }).concat([midEl(st)]));
    return el('div', { class: 'dk-table pk-table' }, [ring, st.my ? meBox(st) : sitBox(st)]);
  }

  /* ---------- анимации ---------- */
  // Что показываем анимацией: раздачу, ставки (фишки едут из стопки игрока в банк), пас (карты — в биту), новые общие карты, выигрыш
  function animated(e) {
    return e.kind === 'hand' || e.kind === 'street' || e.kind === 'win' || (e.kind === 'act' && (Number(e.pay) > 0 || e.act === 'fold'));
  }
  function seatBox(seat) { return K.rootEl.querySelector('[data-seat="' + seat + '"]'); }
  function holeOf(seat) { return K.rootEl.querySelector('[data-hole="' + seat + '"]') || seatBox(seat); }
  function stackOf(seat) { var b = seatBox(seat); return b && (b.querySelector('.pk-stack') || b); }
  function betOf(seat) { return K.rootEl.querySelector('[data-bet="' + seat + '"]'); }
  function chipEl(i) { return el('span', { class: 'pk-chip' + (i ? ' c' + (i % 4 + 1) : '') }); }
  async function animate(fresh, st) {
    var root = K.rootEl;
    var board = root.querySelector('.pk-board'), pot = root.querySelector('.pk-pot') || board;
    var deck = root.querySelector('.pk-deck') || board, bita = root.querySelector('.pk-bita') || board;
    var bb = Number(st.bb) || 0.02;
    var DW = 26;                                                  // ширина карты в колоде и в бите
    var s0 = DW / 46;                                             // летящая рубашка — 46 px, в колоде меньше
    // что сейчас на столе (старый стол); по ходу анимации считаем банк и карты в бите
    var old = K.st || {};
    var inPot = old.status === 'play' ? potTotal(old) : 0;
    var inBita = Number(bita.getAttribute && bita.getAttribute('data-n')) || 0;
    function heap() { return pot.querySelector('.pk-pile') || pot; }
    function chipsFor(pay) { var x = Number(pay) / bb; return x < 2 ? 1 : x < 6 ? 2 : x < 15 ? 3 : x < 40 ? 4 : 5; }
    // фишки из стопки игрока — сразу в кучу банка; у игрока остаётся подпись ставки
    function chipsToPot(seat, pay, bet) {
      var from = stackOf(seat), all = [], to = heap();
      for (var j = 0; j < (from ? chipsFor(pay) : 0); j++) all.push(PC.fly(chipEl(j), from, to, { delay: j * 60, ms: 340 }));
      return Promise.all(all).then(function () { inPot = cents(inPot + Number(pay)); fillPot(pot, inPot, bb); setBet(betOf(seat), bet); });
    }
    // карты со стола — в биту (летят копии, сами карты прячем)
    function toBita(cards, gap) {
      var all = [];
      cards.forEach(function (c) {
        var w = c.getBoundingClientRect().width;
        if (!w || c.style.visibility === 'hidden') return;
        var base = c.classList.contains('sm') ? 28 : 46;
        var node = c.cloneNode(true);
        node.classList.remove('pk-hit'); node.removeAttribute('style');
        var r = BITA[(inBita + all.length) % BITA.length][0];
        all.push(PC.fly(node, c, bita, { s0: w / base, s1: DW / base, rot: r, delay: all.length * (gap || 35), ms: 300 }));
        c.style.visibility = 'hidden';
      });
      var n = all.length;
      return Promise.all(all).then(function () { inBita += n; fillBita(bita, inBita); });
    }
    // колода «тасуется»: верхние карты расходятся в стороны и сходятся
    function riffle() {
      var cs = deck.querySelectorAll ? deck.querySelectorAll('.dk-card') : [];
      if (cs.length < 3) return Promise.resolve();
      var o = { duration: 230, iterations: 2, easing: 'ease-in-out' };
      cs[2].animate([{ transform: 'translate(0,0)' }, { transform: 'translate(9px,-1px) rotate(6deg)' }, { transform: 'translate(0,0)' }], o);
      return cs[1].animate([{ transform: 'translate(-2px,-2px)' }, { transform: 'translate(-11px,-3px) rotate(-6deg)' }, { transform: 'translate(-2px,-2px)' }], o)
        .finished.catch(function () {});
    }
    // все ва-банк: карты открываются до того, как выложат общие
    var win = fresh.filter(function (e) { return e.kind === 'win'; })[0];
    var revealed = false;
    async function reveal() {
      if (revealed || !win || !win.shown) return;
      revealed = true;
      var all = [];
      Object.keys(win.shown).forEach(function (seat) {
        var h = root.querySelector('[data-hole="' + seat + '"]');
        if (!h || !h.querySelector('.back')) return;
        var backs = h.querySelectorAll('.back');
        win.shown[seat].forEach(function (c, i) {
          if (!backs[i]) return;
          all.push(PC.flipAt(backs[i], c, h.classList.contains('big') ? 1 : 0.6, { ms: 360, hold: 40 }).then(function () {
            backs[i].replaceWith(cardEl(c, { small: !h.classList.contains('big') }));
          }));
        });
      });
      await Promise.all(all);
    }
    for (var k = 0; k < fresh.length; k++) {
      var e = fresh[k];
      if (e.kind === 'hand') {
        // 1. прошлая раздача: подписи и подсветку убираем, все карты со стола — в биту
        root.querySelectorAll('.pk-hit').forEach(function (c) { c.classList.remove('pk-hit'); });
        root.querySelectorAll('.pk-combo, .pk-tag').forEach(function (c) { c.textContent = ''; });
        root.querySelectorAll('.won').forEach(function (c) { c.classList.remove('won'); });
        root.querySelectorAll('.pk-bet').forEach(function (b) { setBet(b, 0); });
        fillPot(pot, 0, bb); inPot = 0;
        var left = [].slice.call(board.querySelectorAll('.pk-slot .dk-card')).concat([].slice.call(root.querySelectorAll('.pk-hole .dk-card')));
        await toBita(left, 30);
        board.querySelectorAll('.pk-slot').forEach(function (sl) { sl.replaceChildren(); });
        // 2. бита возвращается в колоду, колода тасуется
        var back = [];
        for (var j = 0; j < Math.min(inBita, 4); j++) back.push(PC.fly(backEl({ cls: 'dk-fly-back' }), bita, deck, { s0: s0, s1: s0, delay: j * 50, ms: 280 }));
        if (inBita) { inBita = 0; fillBita(bita, 0); }
        await Promise.all(back);
        await riffle();
        // 3. раздача из колоды: по одной карте по кругу, два раза
        root.querySelectorAll('.pk-hole').forEach(function (h) { h.style.visibility = 'hidden'; });
        var seats = e.seats || [], flights = [];
        for (var r = 0; r < 2; r++) seats.forEach(function (s, i) {
          var to = holeOf(s);
          if (to) flights.push(PC.fly(backEl({ cls: 'dk-fly-back' }), deck, to, { s0: s0, s1: to.classList.contains('big') ? 1.1 : 0.55, delay: (r * seats.length + i) * 70, ms: 300 }));
        });
        await Promise.all(flights);
        // 4. блайнды — фишки в банк
        await Promise.all([chipsToPot(e.sb, st.sb, st.sb), chipsToPot(e.bb, st.bb, st.bb)]);
      } else if (e.kind === 'act') {
        if (e.act === 'fold') {
          // пас: карты игрока — в биту
          var h = root.querySelector('[data-hole="' + e.seat + '"]');
          if (h) await toBita([].slice.call(h.querySelectorAll('.dk-card')), 60);
        } else {
          // ставка, уравнять, повысить, ва-банк: фишки из стопки игрока — в банк
          await chipsToPot(e.seat, e.pay, e.bet);
        }
      } else if (e.kind === 'street') {
        if (win && win.shown && fresh.indexOf(win) > k) await reveal();
        // круг ставок окончен: фишки уже в банке, подписи ставок убираем
        root.querySelectorAll('.pk-bet').forEach(function (b) { setBet(b, 0); });
        // одна карта сжигается — из колоды в биту
        await PC.fly(backEl({ cls: 'dk-fly-back' }), deck, bita, { s0: s0, s1: s0, rot: BITA[inBita % BITA.length][0], ms: 260 });
        inBita += 1; fillBita(bita, inBita);
        // новые общие карты летят из колоды и переворачиваются на месте
        var have = board.querySelectorAll('.pk-slot .dk-card').length;
        var flips = (e.cards || []).map(function (c, i) {
          var slot = board.querySelector('.pk-slot[data-pos="' + (have + i) + '"]');
          if (!slot) return Promise.resolve();
          var s1 = slot.offsetWidth ? slot.offsetWidth / 46 : 1;
          return PC.fly(backEl({ cls: 'dk-fly-back' }), deck, slot, { s0: s0, s1: s1, delay: i * 110, ms: 300 }).then(function () {
            slot.appendChild(el('span', { class: 'dk-card back pk-ghost' }));
            return PC.flipAt(slot, c, s1, { ms: 340, hold: 60 });
          }).then(function () { slot.replaceChildren(cardEl(c)); });
        });
        await Promise.all(flips);
        await PC.wait(e.street === 'flop' ? 150 : 250);
      } else if (e.kind === 'win') {
        await reveal();
        root.querySelectorAll('.pk-bet').forEach(function (b) { setBet(b, 0); });
        // банк — победителю: фишки из кучи к его фишкам
        var from = heap(), to = [];
        Object.keys(e.win || {}).forEach(function (seat) {
          var box = stackOf(seat);
          for (var j = 0; j < Math.min(6, chipsFor(inPot) + 1); j++) if (box) to.push(PC.fly(chipEl(j), from, box, { delay: j * 55, ms: 380 }));
        });
        fillPot(pot, 0, bb);
        await Promise.all(to);
      }
    }
  }

  function tableScreen() {
    var st = K.st;
    if (!st) return [el('p', { class: 'muted', text: 'Загружаю стол…' })];
    return [gameBar(st), tableEl(st)];
  }

  function paint(force) {
    if (!K.rootEl) return;
    if (K.anim && !force) return;
    var sig = K.open ? 'table:' + K.open + ':' + (K.st ? K.st.version + ':' + K.st.status + ':' + !!K.st.my : '-') : 'list';
    if (!force && sig === K.sig && K.rootEl.childNodes.length) return;
    // не перерисовывать, пока вводят сумму (иначе пропадёт набранное)
    if (!force && K.rootEl.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'range') return;
    K.sig = sig;
    K.rootEl.replaceChildren.apply(K.rootEl, K.open ? tableScreen() : lobby());
  }

  function view() {
    if (!K.rootEl) K.rootEl = el('section', { class: 'sect dk pk', 'aria-label': 'Покер' });
    paint(true);
    return [K.rootEl];
  }

  /* ---------- вход и выход ---------- */
  function startListPoll() { stopListPoll(); K.listPoll = setInterval(function () { if (!document.hidden && !K.open) loadList(); }, 5000); }
  function stopListPoll() { if (K.listPoll) { clearInterval(K.listPoll); K.listPoll = null; } }
  var adminAsked = false;
  function askAdmin() {
    if (adminAsked) return;
    adminAsked = true;
    A.sb().rpc('is_admin').then(function (r) { K.admin = !r.error && r.data === true; if (K.admin && K.form && !K.open) paint(true); }, function () {});
  }
  // Если сижу за столом — сразу открыть его (после перезагрузки страницы)
  async function enter() {
    A = window.AppAPI;
    askAdmin();
    if (K.open) { if (!K.poll) startPoll(); return; }
    await loadList();
    var mine = ((K.list && K.list.tables) || []).filter(function (t) { return t.mine; })[0];
    if (mine && !K.open) { openTable(mine.id); return; }
    startListPoll();
  }
  function leave() { stopListPoll(); stopPoll(); }

  function withApi(f) { return function () { if (!A) A = window.AppAPI; return f.apply(null, arguments); }; }
  window.Poker = { view: withApi(view), enter: enter, leave: leave, isOpen: isOpen, open: withApi(openTable), init: function () { A = window.AppAPI; } };
})();
