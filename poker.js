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
    open: null, st: null, offset: 0, rtt: 1e9, poll: null, timer: null,
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
  function cardEl(c, opts) { return PC.face(c, opts); }
  function backEl(opts) { return PC.back(opts); }

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
    if (n === null || n < min || n > max) return { n: n, ok: false, err: n === null ? '' : 'От ' + coins(min) + ' до ' + coins(max) };
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
    var line = t.test ? n + ' из 6 · тестовый, с ботами' : n + ' из 6 · вход ' + bl(t.min_buy) + '–' + bl(t.max_buy) + ' 🪙';
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
      var c = checkBuy(K[key], min, max, false);
      setText(go, c.ok ? 'Сесть · ' + coins(c.n) : 'Сесть');
      go.disabled = !c.ok || K.busy;
      msg.className = 'msg' + (c.err ? ' err' : ''); setText(msg, c.err);
    }
    go.addEventListener('click', async function () {
      var c = checkBuy(K[key], min, max, false);
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
      if (K.test) { setText(go, 'Открыть тестовый стол'); go.disabled = false; msg.className = 'msg'; msg.textContent = ''; return; }
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
    if (K.admin) {
      var tb = el('button', { type: 'button', class: 'chip duel-chip dk-test-chip', 'aria-pressed': String(K.test) }, [el('span', { text: 'Тестовый, с ботами' })]);
      tb.addEventListener('click', function () { K.test = !K.test; tb.setAttribute('aria-pressed', String(K.test)); sync(); });
      testRow = el('div', { class: 'dk-test-row' }, [tb]);
    }
    sync();
    if (A.dismissible) A.dismissible('pk-form', function () { if (K.form && !K.busy) { K.form = false; paint(true); } });
    return el('div', { class: 'card duel-form', 'data-dismiss': 'pk-form' }, [
      testRow, el('p', { class: 'duel-label', text: 'Блайнды' }), levels, buyBox, go, msg
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
      'На ход 30 секунд. Время вышло — чек или пас. Два раза подряд — место освобождается, фишки возвращаются.'
    ];
    return fold('rulesOpen', 'Правила', [el('ul', { class: 'dk-rules-list' }, items.map(function (t) { return el('li', { text: t }); }))], 'dk-rules');
  }

  /* ---------- стол ---------- */
  function isOpen() { return !!K.open; }
  function openTable(id) {
    K.open = id; K.st = null; K.sig = ''; K.msg = ''; K.rtt = 1e9; K.lastI = -1; K.wasTurn = false;
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
    K.timer = setInterval(updateTimers, 250);
  }
  function stopPoll() {
    if (K.poll) { clearInterval(K.poll); K.poll = null; }
    if (K.timer) { clearInterval(K.timer); K.timer = null; }
  }
  var ticking = false;
  async function tick() {
    if (ticking || !K.open) return;
    ticking = true;
    var id = K.open;
    try {
      var t0 = Date.now();
      var st = await rpc('poker_view', { p_table: id });
      var t1 = Date.now();
      if (!st || K.open !== id) return;
      if (t1 - t0 <= K.rtt) { K.rtt = t1 - t0; K.offset = st.server_ms - (t0 + t1) / 2; }
      var was = K.st;
      if (was && was.version === st.version && was.status === st.status && !!was.my === !!st.my) { K.st = st; return; }
      // сначала анимацией показываем, что произошло (на старом столе), потом рисуем новый
      var fresh = (st.log || []).filter(function (e) { return e.i > K.lastI; });
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

  function secondsLeft() {
    var st = K.st;
    if (!st || !st.deadline_ms || st.status !== 'play') return null;
    return Math.max(0, Math.ceil((st.deadline_ms - (Date.now() + K.offset)) / 1000));
  }
  function updateTimers() {
    var st = K.st;
    if (!st || !K.rootEl) return;
    var left = secondsLeft();
    K.rootEl.querySelectorAll('[data-left]').forEach(function (n) { n.textContent = left == null ? '' : left + ' с'; });
    K.rootEl.querySelectorAll('.pk-bar.on > i').forEach(function (n) {
      var ms = st.deadline_ms - (Date.now() + K.offset);
      n.style.width = Math.max(0, Math.min(100, ms / 300)) + '%';
    });
  }

  async function act(name, args, done) {
    if (K.busy || (K.anim && name === 'poker_act')) return;   // ход — после анимации; встать и докупить можно сразу
    K.busy = true; K.msg = '';
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
    var lbl = el('span', { class: 'dk-bank pk-blinds' }, [blinds(st.sb, st.bb) + (st.test ? ' · тест' : '')]);
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
        el('p', { text: inHand ? 'Встать из-за стола? Карты сбросятся, остаток фишек вернётся на баланс.' : 'Встать из-за стола? Фишки вернутся на баланс.' }),
        el('div', { class: 'dk-quit-acts' }, [
          el('button', { type: 'button', class: 'btn small', text: 'Остаться', onclick: function () { K.quitAsk = false; paint(true); } }),
          el('button', { type: 'button', class: 'btn small danger', text: 'Встать', disabled: K.busy,
            onclick: function () { act('poker_leave', null, function (r) { if (Number(r) > 0) A.toast('На баланс: ' + coins(r)); }); } })
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
      setText(go, c.ok ? 'Докупить · ' + coins(c.n) : 'Докупить');
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
    setText(s, coins(n));
    return s;
  }
  function betEl(p) {
    var b = el('span', { class: 'pk-bet' + (Number(p.bet) > 0 ? '' : ' none'), 'data-bet': String(p.seat) });
    b.textContent = Number(p.bet) > 0 ? fmt(p.bet) : '';
    return b;
  }
  // Две карты игрока: лицом (свои или открытые на вскрытии), рубашкой (в раздаче) или пусто
  function holeEl(p, big) {
    var kids = [];
    if (p.cards && p.cards.length) kids = p.cards.map(function (c) { return cardEl(c, { small: !big }); });
    else if (p.hidden) kids = [backEl({ small: !big }), backEl({ small: !big })];
    return el('span', { class: 'pk-hole' + (big ? ' big' : '') + (p.folded ? ' folded' : '') + (kids.length ? '' : ' none'), 'data-hole': String(p.seat) }, kids);
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
      el('div', { class: 'dk-opp-head' }, head),
      holeEl(p, false),
      stackEl(p.stack),
      el('span', { class: 'pk-tag' + (win > 0 ? ' win' : p.act === 'allin' ? ' hot' : ''), text: tag }),
      betEl(p),
      el('div', { class: 'pk-bar sm' + (turn ? ' on' : ''), 'aria-hidden': 'true' }, [el('i')])
    ]);
  }

  function midEl(st) {
    var board = st.board || [];
    var slots = [];
    for (var i = 0; i < 5; i++) slots.push(el('span', { class: 'pk-slot', 'data-pos': String(i) }, board[i] != null ? [cardEl(board[i])] : []));
    var line;
    var n = players().length;
    if (st.status === 'play') {
      line = el('span', { class: 'pk-pot', 'aria-label': 'Банк' }); setText(line, Number(st.pot) > 0 ? 'банк ' + coins(st.pot) : '');
    } else if (st.result && st.result.showdown) {
      var names = [];
      (st.result.pots || []).forEach(function (p) { if (p.name && names.indexOf(p.name) < 0) names.push(p.name); });
      line = el('span', { class: 'pk-pot win', text: names.join(' · ') });
    } else if (n < 2 && st.status === 'open') {
      line = el('span', { class: 'pk-pot', text: st.test && st.creator ? 'Добавь бота' : 'Ждём игроков' });
    } else {
      line = el('span', { class: 'pk-pot' });
    }
    return el('div', { class: 'pk-mid', style: 'grid-area:mid' }, [el('div', { class: 'pk-board' }, slots), line]);
  }

  // Я: две карты, фишки, ставка; в свой ход — «Твой ход», секунды и кнопки. Строка и кнопки есть всегда — рамка не прыгает.
  function meBox(st) {
    var my = st.my;
    var p = playerAt(my.seat) || {};
    var turn = !!my.turn;
    var fresh = turn && !K.wasTurn;
    var win = winOf(st, my.seat);
    var line = el('div', { class: 'dk-turn-line' + (turn ? ' on' : '') + (fresh ? ' pop' : '') }, [
      el('span', { class: 'dk-turn-lbl' }, [el('span', { class: 'dk-turn-t', text: 'Твой ход' }), el('span', { class: 'dk-turn-left', 'data-left': '1' })])
    ]);
    var box = el('div', { class: 'dk-me pk-me' + (turn ? ' turn' : '') + (fresh ? ' pop' : '') + (win > 0 ? ' won' : ''), 'data-seat': String(my.seat) });
    var hole = holeEl(Object.assign({}, p, { cards: my.hole, hidden: false, folded: my.folded }), true);
    if (!my.in_hand) hole = el('span', { class: 'pk-hole big none pk-wait', 'data-hole': String(my.seat), text: st.status === 'play' ? 'Со следующей раздачи' : '' });
    var tag = win > 0 ? '+' + fmt(win) : my.in_hand && p.act ? ACTS[p.act] || '' : '';
    var info = el('div', { class: 'pk-me-info' }, [
      el('div', { class: 'pk-me-top' }, [stackEl(my.stack, 'big'), st.button === my.seat && (st.status === 'play' || st.result) ? el('span', { class: 'pk-d', 'aria-label': 'Дилер', text: 'D' }) : null]),
      el('div', { class: 'pk-me-bot' }, [betEl(p), el('span', { class: 'pk-tag' + (win > 0 ? ' win' : p.act === 'allin' ? ' hot' : ''), text: tag })])
    ]);
    box.appendChild(el('div', { class: 'pk-me-row' }, [hole, info]));
    box.appendChild(el('div', { class: 'pk-bar' + (turn ? ' on' : ''), 'aria-hidden': 'true' }, [el('i')]));
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
  function raisePop(st) {
    var my = st.my;
    var min = Number(my.min_to), max = Number(my.max_to), cur = Number(st.cur_bet);
    if (K.raiseTo == null || K.raiseTo < min) K.raiseTo = min;
    if (K.raiseTo > max) K.raiseTo = max;
    var amount = el('span', { class: 'pk-raise-amt' });
    var go = el('button', { type: 'button', class: 'btn primary pk-raise-go' });
    var range = el('input', { type: 'range', min: String(Math.round(min * 100)), max: String(Math.round(max * 100)), step: '1', 'aria-label': 'Сколько поставить' });
    range.value = String(Math.round(K.raiseTo * 100));
    function sync() {
      var v = cents(K.raiseTo);
      setText(amount, coins(v));
      go.textContent = v >= max ? 'Ва-банк ' + fmt(v) : (cur > 0 ? 'Повысить до ' : 'Ставка ') + fmt(v);
    }
    range.addEventListener('input', function () { K.raiseTo = Number(range.value) / 100; sync(); });
    function setTo(v) { K.raiseTo = Math.max(min, Math.min(max, cents(v))); range.value = String(Math.round(K.raiseTo * 100)); sync(); }
    var pot = potTotal(st), call = Number(my.call || 0);
    var quick = el('div', { class: 'pk-raise-quick' }, [
      el('button', { type: 'button', class: 'btn small', text: '½ банка', onclick: function () { setTo(cur + (pot + call) / 2); } }),
      el('button', { type: 'button', class: 'btn small', text: 'Банк', onclick: function () { setTo(cur + pot + call); } }),
      el('button', { type: 'button', class: 'btn small', text: 'Ва-банк', onclick: function () { setTo(max); } })
    ]);
    go.addEventListener('click', function () {
      var v = cents(K.raiseTo);
      if (v >= max) move('allin'); else move('raise', v);
    });
    sync();
    if (A.dismissible) A.dismissible('pk-raise', function () { if (K.raise) { K.raise = false; paint(true); } });
    return el('div', { class: 'pk-raise', role: 'dialog', 'aria-label': 'Сколько поставить', 'data-dismiss': 'pk-raise' }, [
      el('div', { class: 'pk-raise-top' }, [amount, quick]), range, go
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
      setText(m, 'За столом: ' + (net > 0 ? '+' : '−') + coins(Math.abs(net)));
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
    // соперники по часовой стрелке, начиная со следующего после меня: слева → сверху → справа
    var opps = players().filter(function (p) { return !p.me; }).sort(function (a, b) {
      return ((a.seat - mySeat + 12) % 6) - ((b.seat - mySeat + 12) % 6);
    });
    var spots = { 1: ['top'], 2: ['tl', 'tr'], 3: ['l', 'top', 'r'], 4: ['l', 'tl', 'tr', 'r'], 5: ['l', 'tl', 'top', 'tr', 'r'], 6: ['l', 'tl', 'top', 'tr', 'r', 'bot'] }[opps.length] || [];
    var ring = el('div', { class: 'dk-ring pk-ring n' + opps.length }, opps.map(function (p, i) { return oppBox(p, st, spots[i]); }).concat([midEl(st)]));
    return el('div', { class: 'dk-table pk-table' }, [ring, st.my ? meBox(st) : sitBox(st)]);
  }

  /* ---------- анимации ---------- */
  function animated(e) { return e.kind === 'hand' || e.kind === 'street' || e.kind === 'win'; }
  function seatBox(seat) { return K.rootEl.querySelector('[data-seat="' + seat + '"]'); }
  function holeOf(seat) { return K.rootEl.querySelector('[data-hole="' + seat + '"]') || seatBox(seat); }
  function chipEl() { return el('span', { class: 'pk-chip' }); }
  async function animate(fresh, st) {
    var root = K.rootEl;
    var board = root.querySelector('.pk-board'), pot = root.querySelector('.pk-pot') || board;
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
        // раздача: по одной карте по кругу, два раза
        root.querySelectorAll('.pk-hole').forEach(function (h) { h.style.visibility = 'hidden'; });
        var seats = e.seats || [], flights = [];
        for (var r = 0; r < 2; r++) seats.forEach(function (s, i) {
          var to = holeOf(s);
          if (to) flights.push(PC.fly(backEl({ cls: 'dk-fly-back' }), board, to, { s0: 0.5, s1: to.classList.contains('big') ? 1 : 0.6, delay: (r * seats.length + i) * 70, ms: 300 }));
        });
        await Promise.all(flights);
      } else if (e.kind === 'street') {
        if (win && win.shown && fresh.indexOf(win) > k) await reveal();
        // ставки уходят в банк
        var chips = [];
        root.querySelectorAll('.pk-bet:not(.none)').forEach(function (b) { chips.push(PC.fly(chipEl(), b, pot, { ms: 300 })); b.classList.add('none'); b.textContent = ''; });
        await Promise.all(chips);
        var have = board.querySelectorAll('.pk-slot .dk-card').length;
        var flips = (e.cards || []).map(function (c, i) {
          var slot = board.querySelector('.pk-slot[data-pos="' + (have + i) + '"]');
          if (!slot) return Promise.resolve();
          slot.appendChild(el('span', { class: 'dk-card back pk-ghost' }));
          return PC.flipAt(slot, c, 1, { delay: i * 120, ms: 380, hold: 60 }).then(function () { slot.replaceChildren(cardEl(c)); });
        });
        await Promise.all(flips);
        await PC.wait(e.street === 'flop' ? 150 : 250);
      } else if (e.kind === 'win') {
        await reveal();
        var bets = [];
        root.querySelectorAll('.pk-bet:not(.none)').forEach(function (b) { bets.push(PC.fly(chipEl(), b, pot, { ms: 260 })); b.classList.add('none'); });
        await Promise.all(bets);
        var to = [];
        Object.keys(e.win || {}).forEach(function (seat) {
          var box = seatBox(seat);
          for (var j = 0; j < 4; j++) if (box) to.push(PC.fly(chipEl(), pot, box, { delay: j * 60, ms: 380 }));
        });
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
    updateTimers();
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
