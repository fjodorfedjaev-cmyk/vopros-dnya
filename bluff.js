/* «Верю — не верю»: комнаты на 3–6 человек, игра на монеты (ставка от 0).
   Всё решает база (таблицы bluff_rooms и bluff_players, функции bluff_*): раздача, проверка «верю / не верю», время, выплаты.
   Телефон получает только свой вид (bluff_view) — свою руку, сколько у кого карт, сколько в стопке, названный номинал,
   карты, открытые при проверке, — и отправляет ходы. Связь с сайтом — через window.AppAPI. */
(function () {
  'use strict';
  var A = null;
  function savedInt(key, lo, hi, def) { try { var v = parseInt(localStorage.getItem(key), 10); return v >= lo && v <= hi ? v : def; } catch (e) { return def; } }
  var K = {
    list: null, listErr: null, form: false, stake: '', low: savedInt('bf-low', 2, 14, 6), jokers: savedInt('bf-jokers', 0, 4, 0), listPoll: null,
    open: null, st: null, offset: 0, rtt: 1e9, poll: null, timer: null,
    rootEl: null, sig: '', sel: [], rank: null, busy: false, msg: '', msgErr: false,
    admin: false, test: false,           // админ может открыть тестовую комнату с ботами
    lastI: -1, anim: false, wasTurn: false, quitAsk: false
  };

  var PC = window.PlayingCards;
  // Номиналы во множественном числе — так называют круг: «Дамы», «Тузы»
  var MANY = { 2: 'Двойки', 3: 'Тройки', 4: 'Четвёрки', 5: 'Пятёрки', 6: 'Шестёрки', 7: 'Семёрки', 8: 'Восьмёрки', 9: 'Девятки',
               10: 'Десятки', 11: 'Валеты', 12: 'Дамы', 13: 'Короли', 14: 'Тузы' };

  function el() { return A.el.apply(null, arguments); }
  function setText(node, t) { if (window.Coin && window.Coin.has(t)) window.Coin.fill(node, t); else node.textContent = t; }
  function coins(n) { return A.fmt(n) + ' 🪙'; }
  function plural(n, a, b, c) { return A.plural ? A.plural(n, a, b, c) : c; }
  function cardsWord(n) { return n + ' ' + plural(n, 'карта', 'карты', 'карт'); }
  function deckN(low, jokers) { return (15 - low) * 4 + jokers; }
  // «полная колода» / «от 6» и джокеры
  function deckText(low, jokers) {
    return (low === 2 ? 'полная колода' : 'от ' + PC.rankName(low)) + (jokers ? ' + ' + jokers + ' ' + plural(jokers, 'джокер', 'джокера', 'джокеров') : '');
  }
  async function rpc(name, args) {
    var r = await A.sb().rpc(name, args || {});
    if (r.error) throw r.error;
    return r.data;
  }
  function errText(e) {
    var m = String((e && (e.message || e.error)) || e || '');
    if (/bluff_not_enough/.test(m)) return 'Не хватает монет на ставку.';
    if (/bluff_busy/.test(m)) return 'Ты уже в другой комнате — сначала доиграй или выйди из неё.';
    if (/bluff_full/.test(m)) return 'В комнате уже нет мест.';
    if (/bluff_too_many/.test(m)) return 'Открытых комнат может быть не больше 3.';
    if (/bluff_bad_stake/.test(m)) return 'Ставка — от 0 до 100 000 монет.';
    if (/bluff_bad_deck/.test(m)) return 'Такой колоды нет.';
    if (/bluff_few/.test(m)) return 'Начать можно, когда в комнате хотя бы трое.';
    if (/bluff_not_turn/.test(m)) return 'Сейчас не твой ход.';
    if (/bluff_bad_rank/.test(m)) return 'Выбери номинал.';
    if (/bluff_bad_move/.test(m)) return 'Так сходить нельзя.';
    if (/bluff_gone/.test(m)) return 'Эта комната уже неактуальна.';
    if (/not_admin/.test(m)) return 'Это может только админ.';
    if (/failed to fetch|network|load failed/i.test(m)) return 'Нет связи. Попробуй ещё раз.';
    return 'Что-то пошло не так.';
  }
  function cardEl(c, opts) { return PC.face(c, opts); }
  function backEl(opts) { return PC.back(opts); }

  /* ---------- список комнат ---------- */
  async function loadList() {
    var before = JSON.stringify(K.list || null);
    try { K.list = (await rpc('bluff_list')) || []; K.listErr = null; } catch (e) { K.listErr = e; }
    if (JSON.stringify(K.list || null) === before && K.rootEl && K.rootEl.childNodes.length) return;
    if (!K.open && K.rootEl && !(K.form && K.rootEl.contains(document.activeElement))) paint(true);
  }
  // Раскрывающийся блок («Правила», «История игр»): помнит, открыт ли он
  function fold(key, title, body, cls) {
    var d = el('details', { class: 'day dk-fold ' + (cls || '') }, [el('summary', { text: title })].concat(body));
    d.open = !!K[key];
    d.addEventListener('toggle', function () { K[key] = d.open; });
    return d;
  }

  function lobby() {
    var out = [];
    out.push(el('div', { class: 'duel-head' }, [
      el('h2', { text: 'Комнаты' }),
      el('button', { type: 'button', class: 'btn' + (K.form ? '' : ' primary'), text: K.form ? 'Закрыть' : 'Новая комната',
        'data-dismiss-trigger': 'bf-form', onclick: function () { K.form = !K.form; paint(true); } })
    ]));
    if (K.form) out.push(createForm());
    var active = (K.list || []).filter(function (r) { return r.status !== 'finished'; });
    var history = (K.list || []).filter(function (r) { return r.status === 'finished' && !r.test; });
    if (!K.list) out.push(el('p', { class: 'muted', text: K.listErr ? errText(K.listErr) : 'Загружаю…' }));
    else if (!active.length) { if (!K.form) out.push(el('p', { class: 'empty', text: 'Комнат пока нет' })); }
    else out.push(el('div', { class: 'duel-list' }, active.map(roomRow)));
    out.push(rulesBlock());
    if (history.length) out.push(fold('histOpen', 'История игр', [el('div', { class: 'duel-list' }, history.map(roomRow))], 'dk-history'));
    return out;
  }

  function avatars(players) {
    return el('span', { class: 'dk-avs' }, (players || []).slice(0, 6).map(function (p) { return A.avatar(p.name, p.color, true, p.avatar); }));
  }

  function roomRow(r) {
    var players = r.players || [];
    var n = players.length;
    var msg = el('p', { class: 'msg', role: 'status' });
    var acts = [], line, title, cls = '';
    var info = deckText(r.low, r.jokers) + ' · ' + (r.stake ? 'ставка ' + coins(r.stake) : 'без ставки');
    if (r.status === 'finished') {
      var net = Number(r.my_payout || 0) - Number(r.stake || 0);
      var lastOne = r.my_place === n;
      title = lastOne ? 'Последнее место' : r.my_place + ' место из ' + n;
      line = r.test ? 'тестовая, с ботами' : r.stake ? (net > 0 ? '+' : net < 0 ? '−' : '') + coins(Math.abs(net)) : 'без ставки';
      cls = lastOne ? ' lose' : r.my_place === 1 ? ' win' : '';
    } else if (r.mine) {
      title = r.status === 'play' ? 'Идёт игра' : r.status === 'ready' ? 'Сейчас начнётся' : r.test ? 'Тестовая комната' : 'Твоя комната';
      line = n + ' из ' + r.max_seats + ' · ' + (r.test ? 'с ботами · ' + deckText(r.low, r.jokers) : info);
      cls = ' incoming';
      acts.push(el('button', { type: 'button', class: 'btn primary', text: r.status === 'play' ? 'Вернуться' : 'Открыть', onclick: function () { openRoom(r.id); } }));
    } else {
      title = r.creator_name || 'Комната';
      line = n + ' из ' + r.max_seats + ' · ' + info + (r.status === 'ready' ? ' · уже начинают' : '');
      if (r.status === 'open' && n < r.max_seats) {
        var jb = el('button', { type: 'button', class: 'btn primary' });
        setText(jb, r.stake ? 'Войти · ' + coins(r.stake) : 'Войти');
        jb.addEventListener('click', function () { join(r.id, jb, msg); });
        acts.push(jb);
      }
    }
    var lineEl = el('span', { class: 'duel-line' }); setText(lineEl, line);
    return el('div', { class: 'duel-row' + cls }, [
      avatars(players),
      el('div', { class: 'duel-info' }, [el('span', { class: 'duel-name', text: title }), lineEl]),
      acts.length ? el('div', { class: 'duel-acts' }, acts) : null,
      msg
    ]);
  }

  async function join(id, btn, msg) {
    btn.disabled = true;
    try { await rpc('bluff_join', { p_room: id }); A.loadPoints(); openRoom(id); }
    catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); btn.disabled = false; loadList(); }
  }

  // Новая комната: ставка, колода «от … до туза», джокеры (выбор колоды запоминается)
  function createForm() {
    var msg = el('p', { class: 'msg', role: 'status' });
    var go = el('button', { type: 'button', class: 'btn primary duel-go' });
    var sum = el('p', { class: 'muted bf-deck-sum' });
    function val() { var v = String(K.stake).replace(/\s/g, ''); if (v === '') return null; var n = Number(v); return Number.isInteger(n) ? n : null; }
    function sync() {
      var n = val();
      var ok = n !== null && n >= 0 && n <= 100000;
      var dn = deckN(K.low, K.jokers);
      sum.textContent = (K.low === 2 ? 'Полная колода' : 'От ' + PC.rankName(K.low) + ' до туза') + ': ' + cardsWord(dn - K.jokers)
        + (K.jokers ? ' + ' + K.jokers + ' ' + plural(K.jokers, 'джокер', 'джокера', 'джокеров') : '') + ' · мест до ' + Math.min(6, dn);
      lowRow.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.dataset.v) === K.low)); });
      jkRow.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.dataset.v) === K.jokers)); });
      stakeBox.hidden = K.test;
      if (K.test) { setText(go, 'Открыть тестовую комнату'); go.disabled = false; if (msg.classList.contains('err')) { msg.className = 'msg'; msg.textContent = ''; } return; }
      setText(go, !ok ? 'Открыть комнату' : n ? 'Открыть комнату · ставка ' + coins(n) : 'Открыть комнату · без ставки');
      go.disabled = !ok || n > A.balance();
      if (ok && n > A.balance()) { msg.className = 'msg err'; setText(msg, 'Не хватает: у тебя ' + coins(Math.floor(A.balance()))); }
      else if (msg.classList.contains('err')) { msg.className = 'msg'; msg.textContent = ''; }
    }
    var input = el('input', { type: 'text', inputmode: 'numeric', id: 'bf-stake', autocomplete: 'off', placeholder: '0', 'aria-label': 'Ставка' });
    input.value = K.stake;
    input.addEventListener('input', function () {
      var v = input.value.replace(/\D/g, '').slice(0, 6);
      if (v !== input.value) input.value = v;
      K.stake = v; sync();
    });
    var quick = el('div', { class: 'duel-quick' }, [0, 10, 50, 100, 300].map(function (n) {
      return el('button', { type: 'button', class: 'btn small', text: String(n), onclick: function () { K.stake = String(n); input.value = K.stake; sync(); } });
    }));
    var coin = el('span', { class: 'duel-coin', 'aria-hidden': 'true' }); setText(coin, '🪙');
    var stakeBox = el('div', { class: 'dk-stake-box' }, [
      el('label', { class: 'duel-label', for: 'bf-stake', text: 'Ставка с каждого' }),
      el('div', { class: 'duel-stake' }, [el('span', { class: 'duel-stake-in' }, [input, coin]), quick])
    ]);
    var ranks = []; for (var r = 2; r <= 14; r++) ranks.push(r);
    var lowRow = el('div', { class: 'bf-chips', role: 'group', 'aria-label': 'Колода: с какой карты' }, ranks.map(function (x) {
      return el('button', { type: 'button', class: 'bf-chip', 'data-v': String(x), 'aria-label': 'от ' + PC.rankName(x), text: PC.rankName(x),
        onclick: function () { K.low = x; try { localStorage.setItem('bf-low', String(x)); } catch (e) { /* ничего */ } sync(); } });
    }));
    var jkRow = el('div', { class: 'bf-chips', role: 'group', 'aria-label': 'Джокеры' }, [0, 1, 2, 3, 4].map(function (x) {
      return el('button', { type: 'button', class: 'bf-chip', 'data-v': String(x), text: String(x),
        onclick: function () { K.jokers = x; try { localStorage.setItem('bf-jokers', String(x)); } catch (e) { /* ничего */ } sync(); } });
    }));
    go.addEventListener('click', async function () {
      var n = K.test ? 0 : val();
      if (n === null) return;
      go.disabled = true;
      try {
        var id = await rpc('bluff_create', { p_stake: n, p_low: K.low, p_jokers: K.jokers, p_test: !!K.test });
        A.loadPoints();
        K.form = false; K.stake = '';
        openRoom(typeof id === 'number' ? id : Number(id));
      } catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); go.disabled = false; }
    });
    var testRow = null;
    if (K.admin) {
      var tb = el('button', { type: 'button', class: 'chip duel-chip dk-test-chip', 'aria-pressed': String(K.test) }, [el('span', { text: 'Тестовая, с ботами' })]);
      tb.addEventListener('click', function () { K.test = !K.test; tb.setAttribute('aria-pressed', String(K.test)); sync(); });
      testRow = el('div', { class: 'dk-test-row' }, [tb]);
    }
    var deckBox = el('div', { class: 'bf-deck-box' }, [
      el('span', { class: 'duel-label', text: 'Колода: с какой карты до туза' }), lowRow,
      el('span', { class: 'duel-label', text: 'Джокеры' }), jkRow, sum
    ]);
    sync();
    if (A.dismissible) A.dismissible('bf-form', function () { if (K.form && !K.busy) { K.form = false; paint(true); } });
    return el('div', { class: 'card duel-form', 'data-dismiss': 'bf-form' }, [testRow, stakeBox, deckBox, go, msg]);
  }

  function rulesBlock() {
    var items = [
      'Цель — избавиться от всех карт. Последний с картами проигрывает.',
      'Все карты раздаются. Четыре карты одного номинала на руках сразу уходят в биту.',
      'Начало круга: положи рубашкой вверх сколько угодно карт и назови номинал — можно соврать.',
      'Следующий: «Доложить» — кладёт свои карты к тому же номиналу; «Не верю» или «Верю» — открываются последние положенные карты.',
      '«Не верю», а там враньё — всю стопку забирает тот, кто соврал, а новый круг начинаешь ты. Там правда — стопку забираешь ты и пропускаешь ход.',
      '«Верю», а там правда — стопка уходит в биту, новый круг начинаешь ты. Там враньё — стопку забираешь ты и пропускаешь ход.',
      'Джокер — любая карта: положить его всегда правда.',
      'Последние карты положены и через «Не верю» не разоблачены — ты без карт и занимаешь место.',
      'На ход 30 секунд. Не успел — база кладёт за тебя одну карту. Два раза подряд — вне игры, последнее место.',
      'Банк делят по местам: первый удваивает ставку, каждое следующее место получает меньше, последний — ничего.',
      '«Выйти» во время игры — поражение: ставка не вернётся.',
      'Если в комнате один человек, через минуту она закрывается — ставка возвращается.'
    ];
    return fold('rulesOpen', 'Правила', [el('ul', { class: 'dk-rules-list' }, items.map(function (t) { return el('li', { text: t }); }))], 'dk-rules');
  }

  /* ---------- комната ---------- */
  function isOpen() { return !!K.open; }
  function openRoom(id) {
    K.open = id; K.st = null; K.sig = ''; K.sel = []; K.rank = null; K.msg = ''; K.rtt = 1e9; K.lastI = -1; K.wasTurn = false; K.quitAsk = false;
    stopListPoll();
    paint(true);
    window.scrollTo(0, 0);
    startPoll();
  }
  function closeRoom() {
    stopPoll();
    K.open = null; K.st = null; K.sig = ''; K.quitAsk = false;
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
      var st = await rpc('bluff_view', { p_room: id });
      var t1 = Date.now();
      if (!st || K.open !== id) return;
      if (t1 - t0 <= K.rtt) { K.rtt = t1 - t0; K.offset = st.server_ms - (t0 + t1) / 2; }
      var was = K.st;
      var changed = !was || was.version !== st.version || was.status !== st.status || JSON.stringify(was.rematch) !== JSON.stringify(st.rematch);
      if (!changed) { K.st = st; return; }
      // сначала анимацией показываем, что произошло (на старом столе), потом рисуем новый
      var fresh = (st.log || []).filter(function (e) { return e.i > K.lastI; });
      if (was && was.status === 'play' && K.lastI >= 0 && fresh.length && fresh.length <= 6 && !document.hidden && !REDUCED
          && K.rootEl && K.rootEl.querySelector('.bf-table')) {
        K.anim = true;
        var meEl = K.rootEl.querySelector('.dk-me');
        if (meEl) meEl.classList.remove('turn');
        K.rootEl.classList.add('dk-anim');
        try { for (var i = 0; i < fresh.length; i++) await animEntry(fresh[i], was); } catch (e2) { /* анимация не важна */ }
        K.rootEl.classList.remove('dk-anim');
        K.anim = false;
      }
      K.lastI = (st.log || []).reduce(function (m, e) { return Math.max(m, e.i || 0); }, Math.max(K.lastI, 0));
      K.st = st;
      if (was && was.status !== st.status && (st.status === 'finished' || st.status === 'cancelled' || st.status === 'play')) A.loadPoints();
      // карты, которых больше нет в руке, из выбора убираем; не мой ход — выбор сбрасываем
      var hand = (st.my && st.my.hand) || [];
      K.sel = st.status === 'play' && st.my && st.my.turn ? K.sel.filter(function (c) { return hand.indexOf(c) >= 0; }) : [];
      if (!st.my || !st.my.new_round) K.rank = null;
      var turnNow = !K.wasTurn && st.status === 'play' && st.my && st.my.turn;
      paint();
      if (turnNow) showMe();
    } catch (e) {
      if (/bluff_gone/.test(String(e && e.message))) { A.toast('Комнаты больше нет'); closeRoom(); }
    } finally { ticking = false; }
  }

  // Начался мой ход, а рамка с картами ушла под нижнее меню — плавно подвинуть страницу, чтобы её было видно целиком
  function showMe() {
    var me = K.rootEl && K.rootEl.querySelector('.dk-me');
    if (!me) return;
    var nav = document.querySelector('.bottom-nav');
    var bottom = nav ? nav.getBoundingClientRect().top : window.innerHeight;
    var over = me.getBoundingClientRect().bottom + 8 - bottom;
    if (over > 0) window.scrollBy({ top: over, behavior: REDUCED ? 'auto' : 'smooth' });
  }

  function secondsLeft() {
    var st = K.st;
    if (!st || !st.deadline_ms) return null;
    return Math.max(0, Math.ceil((st.deadline_ms - (Date.now() + K.offset)) / 1000));
  }
  function updateTimers() {
    var st = K.st;
    if (!st || !K.rootEl) return;
    var left = secondsLeft();
    K.rootEl.querySelectorAll('[data-left]').forEach(function (n) { n.textContent = left == null ? '' : left + ' с'; });
    K.rootEl.querySelectorAll('.dk-bar > i').forEach(function (n) {
      n.style.width = Math.max(0, Math.min(100, (st.deadline_ms - (Date.now() + K.offset)) / 300)) + '%';
    });
    var alone = st.alone_ms && st.status === 'open' ? Math.max(0, Math.ceil((st.alone_ms - (Date.now() + K.offset)) / 1000)) : null;
    K.rootEl.querySelectorAll('[data-alone]').forEach(function (n) {
      n.textContent = alone == null ? '' : 'Закроется через ' + alone + ' с, если никто не зайдёт';
    });
  }

  async function act(name, args, okToast) {
    if (K.busy) return;
    K.busy = true; K.msg = '';
    paint(true);
    try {
      await rpc(name, Object.assign({ p_room: K.open }, args || {}));
      if (okToast) A.toast(okToast);
      K.sel = []; K.rank = null;
      if (name === 'bluff_leave') { A.loadPoints(); K.busy = false; closeRoom(); return; }
      await tick();
    } catch (e) {
      K.msg = errText(e); K.msgErr = true;
      if (/bluff_not_turn|bluff_bad_move/.test(String(e && e.message))) K.sel = [];
      await tick();
    } finally {
      K.busy = false;
      paint(true);
    }
  }

  function playersBySeat() { return (K.st && K.st.players) || []; }
  function playerAt(seat) { var p = playersBySeat(); for (var i = 0; i < p.length; i++) if (p[i].seat === seat) return p[i]; return null; }
  function bank(st) { return st.stake * playersBySeat().length; }
  function stakeLine(st) {
    var b = el('span', { class: 'duel-bank dk-stake' });
    setText(b, (st.test ? 'тестовая комната · с ботами' : st.stake ? 'ставка ' + coins(st.stake) + ' · банк ' + coins(bank(st)) : 'без ставки')
      + ' · ' + deckText(st.low, st.jokers));
    return b;
  }

  // Над столом: банк и «Выйти» (выход во время игры — поражение, поэтому сначала предупреждение)
  function gameBar(st) {
    var me = st.my || {};
    var myP = playerAt(me.seat) || {};
    var already = myP.place != null || !st.my;
    var b = el('span', { class: 'dk-bank' });
    setText(b, (st.test ? 'тестовая · с ботами' : st.stake ? 'банк ' + coins(bank(st)) : 'без ставки') + ' · ' + deckText(st.low, st.jokers));
    var quit = el('button', { type: 'button', class: 'dk-quit', text: 'Выйти', 'aria-expanded': String(!!K.quitAsk && !already), 'data-dismiss-trigger': 'bf-quit',
      onclick: function () { if (already) { closeRoom(); return; } K.quitAsk = !K.quitAsk; paint(true); } });
    var kids = [b, quit];
    if (K.quitAsk && !already) {
      if (A.dismissible) A.dismissible('bf-quit', function () { if (K.quitAsk) { K.quitAsk = false; paint(true); } });
      kids.push(el('div', { class: 'dk-quit-pop', role: 'dialog', 'aria-label': 'Выйти из игры?', 'data-dismiss': 'bf-quit' }, [
        el('p', { text: 'Выйти из игры? Это засчитается как поражение' + (st.stake ? ': ставка не вернётся.' : '.') }),
        el('div', { class: 'dk-quit-acts' }, [
          el('button', { type: 'button', class: 'btn small', text: 'Остаться', onclick: function () { K.quitAsk = false; paint(true); } }),
          el('button', { type: 'button', class: 'btn small danger', text: 'Выйти', disabled: K.busy,
            onclick: function () { K.quitAsk = false; act('bluff_leave', null, 'Вне игры'); } })
        ])
      ]));
    }
    return el('div', { class: 'dk-gamebar' }, kids);
  }

  function msgLine() {
    var m = el('p', { class: 'msg' + (K.msgErr && K.msg ? ' err' : ''), role: 'status' });
    m.textContent = K.msg || '';
    return m;
  }

  // Имя и аватарка: нажал — мини-профиль. Ботов не открываем; в свой ход — сначала сходи.
  function canPeek() {
    var st = K.st;
    if (st && st.my && st.my.place == null && st.status === 'play' && st.turn === st.my.seat) { A.toast('Сначала сходи'); return false; }
    return true;
  }
  function who(p, kids, cls) {
    if (p.bot || !p.id || !A.person) return el('span', { class: cls || null }, kids);
    return A.person(p.id, kids, { cls: cls, label: 'Профиль: ' + p.name, guard: canPeek });
  }

  function seatsList(st, mark) {
    return el('div', { class: 'dk-seats' }, playersBySeat().map(function (p) {
      var tag = mark(p);
      return el('div', { class: 'dk-seat' + (tag.on ? ' on' : '') }, [
        who(p, [A.avatar(p.name, p.color, true, p.avatar), el('span', { class: 'dk-seat-name', text: p.me ? p.name + ' (ты)' : p.name })], 'dk-who'),
        tag.text ? el('span', { class: 'dk-seat-tag', text: tag.text }) : null,
        tag.remove ? el('button', { type: 'button', class: 'x dk-seat-x', 'aria-label': 'Убрать ' + p.name, text: '×', disabled: K.busy,
          onclick: function () { act('bluff_remove_bot', { p_bot: tag.remove }); } }) : null
      ]);
    }));
  }

  // До раздачи: ждём игроков / «Готово»
  function waitBox(st) {
    var box = el('div', { class: 'card duel-lobby' });
    var n = playersBySeat().length, max = st.max_seats || 6;
    var acts = [];
    if (st.status === 'open' && st.test) {
      box.appendChild(el('p', { class: 'duel-big', text: 'Тестовая комната · ' + n + ' из ' + max }));
      box.appendChild(stakeLine(st));
      box.appendChild(seatsList(st, function (p) { return { text: p.bot ? 'бот' : 'ты', on: false, remove: p.bot ? p.id : null }; }));
      acts.push(el('button', { type: 'button', class: 'btn primary', text: 'Начать', disabled: n < 3 || K.busy, onclick: function () { act('bluff_start'); } }));
      if (n < max) acts.push(el('button', { type: 'button', class: 'btn', text: 'Добавить бота', disabled: K.busy, onclick: function () { act('bluff_add_bot'); } }));
      acts.push(el('button', { type: 'button', class: 'btn', text: 'Закрыть', disabled: K.busy, onclick: function () { act('bluff_leave'); } }));
    } else if (st.status === 'open') {
      box.appendChild(el('p', { class: 'duel-big', text: n < 3 ? 'Ждём игроков' : 'В комнате ' + n + ' из ' + max }));
      box.appendChild(stakeLine(st));
      if (st.alone_ms) box.appendChild(el('p', { class: 'muted dk-alone', 'data-alone': '1' }));
      box.appendChild(seatsList(st, function (p) { return { text: p.creator ? 'создатель' : '', on: false }; }));
      if (n < 3) box.appendChild(el('p', { class: 'muted bf-need', text: 'Играют от 3 человек' }));
      if (st.creator) acts.push(el('button', { type: 'button', class: 'btn primary', text: 'Начать', disabled: n < 3 || K.busy, onclick: function () { act('bluff_start'); } }));
      acts.push(el('button', { type: 'button', class: 'btn', text: st.stake ? 'Выйти — ставка вернётся' : 'Выйти', disabled: K.busy,
        onclick: function () { act('bluff_leave', null, st.stake ? 'Ставка вернулась' : null); } }));
    } else {
      var me = st.my || {};
      box.appendChild(el('p', { class: 'duel-big', text: me.ready ? 'Ждём остальных' : 'Игра начинается' }));
      box.appendChild(stakeLine(st));
      box.appendChild(el('div', { class: 'dk-bar', 'aria-hidden': 'true' }, [el('i')]));
      box.appendChild(seatsList(st, function (p) { return { text: p.ready ? 'готово' : 'ждём', on: p.ready }; }));
      if (!me.ready) acts.push(el('button', { type: 'button', class: 'btn primary duel-ready-btn', text: 'Готово', disabled: K.busy, onclick: function () { act('bluff_ready'); } }));
      acts.push(el('button', { type: 'button', class: 'btn', text: 'Выйти', disabled: K.busy, onclick: function () { act('bluff_leave'); } }));
    }
    box.appendChild(el('div', { class: 'duel-acts' }, acts));
    box.appendChild(msgLine());
    return box;
  }

  /* ---------- стол ---------- */
  // Веер рубашек с числом карт в руке
  function fanEl(n) {
    var k = Math.min(n, 5);
    var pic = el('span', { class: 'dk-fan-pic', 'aria-hidden': 'true' });
    for (var i = 0; i < k; i++) {
      var b = el('i');
      b.style.transform = 'rotate(' + ((i - (k - 1) / 2) * 13) + 'deg)';
      pic.appendChild(b);
    }
    return el('span', { class: 'dk-fan', role: 'img', 'aria-label': 'Карт в руке: ' + n }, [pic, el('b', { text: String(n) })]);
  }
  function outText(p) { return p.out === 'afk' || p.out === 'left' ? 'вне игры' : p.place + ' место'; }

  // Соперник: имя, веер (сколько карт), подпись (положил N карт / место), полоска времени
  function oppBox(p, st, spot) {
    var turn = st.status === 'play' && st.turn === p.seat && p.place == null;
    var last = st.claim != null && st.last_seat === p.seat;
    var tag = p.place != null ? outText(p) : last ? 'ход: ' + cardsWord(st.last_n) : '';
    return el('div', { class: 'dk-opp bf-opp at-' + spot + (turn ? ' turn' : '') + (p.place != null ? ' out' : '') + (last ? ' last' : ''),
      'data-seat': String(p.seat), style: 'grid-area:' + spot }, [
      who(p, [A.avatar(p.name, p.color, true, p.avatar), el('span', { class: 'dk-opp-name', text: p.name })], 'dk-opp-head'),
      p.place == null ? fanEl(p.n) : null,
      el('span', { class: 'dk-opp-tag' + (tag ? '' : ' none'), text: tag || '·' }),
      el('div', { class: 'dk-bar sm' + (turn ? '' : ' off'), 'aria-hidden': 'true' }, [el('i')])
    ]);
  }

  var BITA_R = [-28, 14, -6, 37, -41, 22, 3], BITA_X = [-3, 4, 1, -5, 3, -2, 5], BITA_Y = [2, -3, 4, 0, -4, 3, -1];
  // Середина: названный номинал (крупно) и кто сколько положил; бита слева, стопка справа (рубашки, сверху — последние)
  function midEl(st) {
    var claim;
    if (st.claim != null) {
      var lp = playerAt(st.last_seat) || {};
      claim = el('div', { class: 'bf-claim' }, [
        el('b', { text: MANY[st.claim] }),
        el('span', { text: (lp.me ? 'ты' : lp.name || '') + ' · ' + cardsWord(st.last_n) })
      ]);
    } else {
      var tp = playerAt(st.turn) || {};
      claim = el('div', { class: 'bf-claim new' }, [
        el('b', { text: 'Новый круг' }),
        el('span', { text: tp.me ? 'называешь ты' : (tp.name ? 'называет ' + tp.name : '') })
      ]);
    }
    var bitaKids = [];
    for (var b = 0, nb = st.bita ? Math.min(7, 2 + Math.floor(st.bita / 6)) : 0; b < nb; b++) {
      var bk = backEl({ small: true, label: b === nb - 1 ? 'Бита' : null });
      bk.style.transform = 'translate(' + BITA_X[b] + 'px,' + BITA_Y[b] + 'px) rotate(' + BITA_R[b] + 'deg)';
      bitaKids.push(bk);
    }
    var bita = el('div', { class: 'dk-bita bf-bita' + (st.bita ? '' : ' is-empty'), 'aria-label': 'Бита: ' + st.bita }, bitaKids);
    // стопка: под низом — сколько-то рубашек, сверху веером — последние положенные (до 4)
    var pileKids = [], under = Math.min(3, Math.max(0, st.pile_n - st.last_n)), top = Math.min(4, st.last_n || 0);
    for (var u = 0; u < under; u++) { var ub = backEl({ cls: 'u' }); ub.style.transform = 'rotate(' + [-8, 5, -2][u] + 'deg)'; pileKids.push(ub); }
    for (var t = 0; t < top; t++) { var tb = backEl({ cls: 'top' }); tb.style.transform = 'translate(' + (t - (top - 1) / 2) * 9 + 'px,' + (-2 - t) + 'px) rotate(' + (t - (top - 1) / 2) * 9 + 'deg)'; pileKids.push(tb); }
    if (st.pile_n) pileKids.push(el('span', { class: 'bf-pile-n', text: String(st.pile_n) }));
    var pile = el('div', { class: 'bf-pile' + (st.pile_n ? '' : ' is-empty'), 'aria-label': 'Стопка: ' + cardsWord(st.pile_n || 0) }, pileKids);
    return el('div', { class: 'dk-mid bf-mid', style: 'grid-area:mid' }, [claim, el('div', { class: 'bf-mid-row' }, [bita, pile])]);
  }

  // Номинал, который предлагается по выбранным картам (если все обычные карты в выборе одного номинала)
  function guessRank() {
    var rs = K.sel.filter(function (c) { return !PC.isJoker(c); }).map(PC.rank);
    if (!rs.length) return null;
    return rs.every(function (r) { return r === rs[0]; }) ? rs[0] : null;
  }
  function tapCard(c) {
    var my = K.st && K.st.my;
    if (!my || !my.turn || K.busy || K.anim) return;
    var i = K.sel.indexOf(c);
    if (i >= 0) K.sel.splice(i, 1); else K.sel.push(c);
    K.msg = '';
    paint(true);
  }

  // Рука: карты по номиналу; много карт — два ряда, карты чуть заходят друг на друга
  function handEl(hand, active) {
    var k = hand.length <= 10 ? 1 : Math.max(2, Math.ceil(hand.length / 12)), per = Math.ceil(hand.length / k), rows = [];
    for (var i = 0; i < hand.length; i += per) rows.push(hand.slice(i, i + per));
    return el('div', { class: 'bf-hand' + (rows.length > 1 ? ' rows' : '') }, rows.map(function (row) {
      return el('div', { class: 'bf-hrow', style: '--k:' + row.length }, row.map(function (c) {
        var on = K.sel.indexOf(c) >= 0;
        return cardEl(c, { button: active, pressed: active ? on : null, cls: on ? 'sel' : '', onclick: active ? function () { tapCard(c); } : null });
      }));
    }));
  }

  // Я: «Твой ход» и секунды над рамкой; рука; в начале круга — номиналы; кнопки (ряд есть всегда — рамка не прыгает)
  function meBox(st) {
    var me = st.my || {};
    var myP = playerAt(me.seat) || {};
    var turn = !!me.turn;
    var fresh = turn && !K.wasTurn;
    var n = K.sel.length;
    var acts = [], hint = '';
    var rank = K.rank != null ? K.rank : guessRank();
    if (turn && me.new_round) {
      acts.push(el('button', { type: 'button', class: 'btn primary bf-put', disabled: !n || rank == null || K.busy,
        text: !n ? 'Выбери карты' : rank == null ? 'Выбери номинал' : 'Положить ' + n + ' · ' + MANY[rank].toLowerCase(),
        onclick: function () { if (!K.anim) act('bluff_put', { p_cards: K.sel.slice(), p_rank: rank }); } }));
    } else if (turn && me.can_call) {
      acts.push(el('button', { type: 'button', class: 'btn bf-add', disabled: !n || K.busy,
        text: n ? 'Доложить ' + n : 'Доложить',
        onclick: function () { if (!K.anim) act('bluff_put', { p_cards: K.sel.slice() }); } }));
      acts.push(el('button', { type: 'button', class: 'btn bf-trust', text: 'Верю', disabled: K.busy, onclick: function () { if (!K.anim) act('bluff_call', { p_kind: 'trust' }); } }));
      acts.push(el('button', { type: 'button', class: 'btn primary bf-doubt', text: 'Не верю', disabled: K.busy, onclick: function () { if (!K.anim) act('bluff_call', { p_kind: 'doubt' }); } }));
    } else if (st.status === 'play' && myP.place == null) {
      var tp = playerAt(st.turn) || {};
      hint = st.claim != null && st.last_seat === me.seat ? (tp.name || '') + ' решает: верить ли тебе' : 'Ходит ' + (tp.name || '');
    }
    var line = el('div', { class: 'dk-turn-line' + (turn ? ' on' : '') + (fresh ? ' pop' : '') }, [
      el('span', { class: 'dk-turn-lbl' }, [el('span', { class: 'dk-turn-t', text: turn && me.new_round ? 'Твой ход · новый круг' : 'Твой ход' }),
        el('span', { class: 'dk-turn-left', 'data-left': '1' })])
    ]);
    var box = el('div', { class: 'dk-me bf-me' + (turn ? ' turn' : '') + (fresh ? ' pop' : '') + (myP.place != null ? ' out' : ''), 'data-seat': String(me.seat) });
    if (myP.place != null) {
      box.appendChild(el('div', { class: 'dk-me-done', text: outText(myP).replace(/^в/, 'В') }));
    } else {
      box.appendChild(el('div', { class: 'dk-bar' + (turn ? '' : ' off'), 'aria-hidden': 'true' }, [el('i')]));
      var hand = me.hand || [];
      if (hand.length) box.appendChild(handEl(hand, turn));
      else box.appendChild(el('p', { class: 'muted bf-empty-hand', text: 'Карт больше нет — ждём, поверят ли тебе' }));
      if (turn && me.new_round) {
        var ranks = []; for (var r = st.low; r <= 14; r++) ranks.push(r);
        box.appendChild(el('div', { class: 'bf-ranks', style: '--c:' + (ranks.length <= 9 ? ranks.length : Math.ceil(ranks.length / 2)),
          role: 'radiogroup', 'aria-label': 'Какой номинал называешь' }, ranks.map(function (x) {
          return el('button', { type: 'button', class: 'bf-chip', role: 'radio', 'aria-checked': String(rank === x), 'aria-label': MANY[x], text: PC.rankName(x),
            onclick: function () { K.rank = x; paint(true); } });
        })));
      }
      box.appendChild(el('div', { class: 'bf-acts' }, acts.length ? acts : [el('span', { class: 'bf-hint', text: hint || '' })]));
    }
    if (K.msg) box.appendChild(msgLine());
    K.wasTurn = turn;
    return el('div', { class: 'dk-me-wrap' }, [line, box]);
  }

  function playBox(st) {
    var mySeat = st.my ? st.my.seat : 0;
    var opps = playersBySeat().filter(function (p) { return !p.me; }).sort(function (a, b) {
      return ((a.seat - mySeat + 12) % 12) - ((b.seat - mySeat + 12) % 12);
    });
    var spots = { 1: ['top'], 2: ['tl', 'tr'], 3: ['l', 'top', 'r'], 4: ['l', 'tl', 'tr', 'r'], 5: ['l', 'tl', 'top', 'tr', 'r'] }[opps.length] || [];
    var ring = el('div', { class: 'dk-ring bf-ring n' + opps.length }, opps.map(function (p, i) { return oppBox(p, st, spots[i]); }).concat([midEl(st)]));
    return el('div', { class: 'dk-table bf-table' }, [ring, st.my ? meBox(st) : null]);
  }

  /* ---------- анимации ---------- */
  var REDUCED = PC.REDUCED;
  var wait = PC.wait, fly = PC.fly, flyBacks = PC.flyBacks, flash = PC.flash;
  function seatEl(seat) { return K.rootEl.querySelector('[data-seat="' + seat + '"]'); }
  function handOf(seat) {
    var box = seatEl(seat);
    if (!box) return null;
    return box.classList.contains('dk-me') ? (box.querySelector('.bf-hand') || box) : (box.querySelector('.dk-fan') || box);
  }
  // Открытые при проверке карты — над стопкой, на мгновение, с надписью «Правда» или «Враньё»
  async function showReveal(pile, e) {
    var cards = e.cards || [];
    var row = el('div', { class: 'bf-reveal' + (e.truth ? ' truth' : ' lie') }, [
      el('div', { class: 'bf-reveal-cards' }, cards.slice(0, 8).map(function (c) { return cardEl(c); })),
      el('b', { class: 'bf-verdict', text: e.truth ? 'Правда!' : 'Враньё!' })
    ]);
    PC.placeAt(row, pile, 1);
    row.style.transform = '';
    row.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1.05)', offset: 0.6 }, { opacity: 1, transform: 'scale(1)' }],
      { duration: 360, easing: 'ease-out', fill: 'forwards' });
    await wait(1300);
    row.remove();
  }
  async function animEntry(e, was) {
    var root = K.rootEl;
    var pile = root.querySelector('.bf-pile'), bita = root.querySelector('.bf-bita');
    if (!pile) return;
    var box = e.seat != null ? seatEl(e.seat) : null;
    if (e.kind === 'put') {
      var src = handOf(e.seat);
      if (!src) return;
      var mine = box && box.classList.contains('dk-me');
      await flyBacks(src, pile, e.n || 1, { s0: mine ? 0.9 : 0.6, s1: 0.8 });
      if (e.new) flash(pile, MANY[e.rank]);
    } else if (e.kind === 'reveal') {
      var whoBox = seatEl(e.seat);
      if (whoBox) flash(whoBox, e.call === 'doubt' ? 'Не верю!' : 'Верю!');
      await wait(450);
      await showReveal(pile, e);
      pile.replaceChildren();
      if (e.taker != null) await flyBacks(pile, handOf(e.taker) || pile, Math.min(e.n || 1, 5), { s0: 0.8, s1: 0.6 });
      else if (bita) await flyBacks(pile, bita, Math.min(e.n || 1, 5), { s0: 0.8, s1: 0.6, rot: 18 });
    } else if (e.kind === 'four') {
      var from = handOf(e.seat);
      if (!from || !bita) return;
      flash(from, (e.ranks || []).length === 1 ? 'Четыре ' + PC.rankName(e.ranks[0]) + ' — в биту' : 'Четвёрки — в биту');
      await Promise.all((e.cards || []).map(function (c, i) { return fly(cardEl(c), from, bita, { s0: 0.7, s1: 0.5, delay: i * 70, rot: 12 }); }));
    } else if (e.kind === 'out' && box) {
      flash(box, e.place === 1 ? 'Первое место!' : 'Без карт!');
      await wait(500);
    } else if ((e.kind === 'afk' || e.kind === 'left') && box) {
      flash(box, 'Вне игры');
      await wait(400);
    } else {
      return;
    }
    await wait(100);
  }

  function resultBox(st) {
    var players = playersBySeat().slice().sort(function (a, b) { return a.place - b.place; });
    var n = players.length;
    var box = el('div', { class: 'card dk-result' });
    var me = st.my || {};
    var lastOne = me.place === n;
    box.appendChild(el('p', { class: 'duel-title' + (lastOne ? ' lose' : me.place === 1 ? ' win' : ''), text: lastOne ? 'ПРОИГРЫШ' : me.place === 1 ? 'ПОБЕДА' : me.place + ' МЕСТО' }));
    box.appendChild(el('div', { class: 'dk-places' }, players.map(function (p) {
      var net = Number(p.payout || 0) - st.stake;
      var money = el('span', { class: 'dk-pl-money' + (net > 0 ? ' plus' : net < 0 ? ' minus' : '') });
      setText(money, st.stake ? (net > 0 ? '+' : net < 0 ? '−' : '') + coins(Math.abs(net)) : '');
      return el('div', { class: 'dk-pl' + (p.me ? ' me' : '') }, [
        el('span', { class: 'dk-pl-n', text: p.place === n ? 'посл.' : p.place + '.' }),
        who(p, [A.avatar(p.name, p.color, true, p.avatar),
          el('span', { class: 'dk-pl-name', text: p.name + (p.out === 'afk' ? ' · по времени' : p.out === 'left' ? ' · выход' : '') })], 'dk-who'),
        money
      ]);
    })));
    var acts = [];
    var rm = st.rematch;
    var again = el('button', { type: 'button', class: 'btn primary', disabled: K.busy,
      text: rm && rm.in ? 'Открыть новую комнату' : rm ? 'Ещё раз · уже ' + rm.n + ' в комнате' : 'Ещё раз' });
    again.addEventListener('click', async function () {
      if (rm && rm.in) { openRoom(rm.id); return; }
      if (K.busy) return;
      K.busy = true; again.disabled = true;
      try { var id = await rpc('bluff_rematch', { p_room: st.id }); A.loadPoints(); K.busy = false; openRoom(Number(id)); }
      catch (e) { K.busy = false; K.msg = errText(e); K.msgErr = true; paint(true); }
    });
    acts.push(again);
    acts.push(el('button', { type: 'button', class: 'btn', text: 'К комнатам', onclick: closeRoom }));
    box.appendChild(el('div', { class: 'duel-acts' }, acts));
    box.appendChild(msgLine());
    return box;
  }

  function roomScreen() {
    var st = K.st;
    if (!st) return [el('p', { class: 'muted', text: 'Загружаю комнату…' })];
    var body;
    if (st.status === 'open' || st.status === 'ready') body = waitBox(st);
    else if (st.status === 'play') body = playBox(st);
    else if (st.status === 'finished') body = resultBox(st);
    else {
      var lastLog = (st.log || [])[(st.log || []).length - 1];
      var alone = lastLog && lastLog.kind === 'alone';
      body = el('div', { class: 'card duel-lobby' }, [
        el('p', { class: 'duel-big', text: alone ? 'Комната закрыта' : 'Комната закрыта — ставки вернулись' }),
        alone ? el('p', { class: 'muted dk-alone', text: 'За минуту никто не зашёл' + (st.stake ? ' — ставка вернулась' : '') }) : null,
        el('div', { class: 'duel-acts' }, [el('button', { type: 'button', class: 'btn', text: 'К комнатам', onclick: closeRoom })])
      ].filter(Boolean));
    }
    return st.status === 'play' ? [gameBar(st), body] : [body];
  }

  function paint(force) {
    if (!K.rootEl) return;
    var sig = K.open ? 'room:' + K.open + ':' + (K.st ? K.st.version + ':' + K.st.status : '-') : 'list';
    if (!force && sig === K.sig && K.rootEl.childNodes.length) return;
    K.sig = sig;
    K.rootEl.replaceChildren.apply(K.rootEl, K.open ? roomScreen() : lobby());
    updateTimers();
  }

  function view() {
    if (!K.rootEl) K.rootEl = el('section', { class: 'sect dk bf', 'aria-label': 'Верю — не верю' });
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
  function enter() {
    A = window.AppAPI;
    askAdmin();
    if (K.open) { if (!K.poll) startPoll(); return; }
    loadList();
    startListPoll();
  }
  function leave() { stopListPoll(); stopPoll(); }

  function withApi(f) { return function () { if (!A) A = window.AppAPI; return f.apply(null, arguments); }; }
  window.Bluff = { view: withApi(view), enter: enter, leave: leave, isOpen: isOpen, open: withApi(openRoom), init: function () { A = window.AppAPI; } };
})();
