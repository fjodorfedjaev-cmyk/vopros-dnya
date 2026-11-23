/* «Дурак» (китайский дурак): комнаты на 2–5 человек, игра на монеты (ставка от 0).
   Всё решает база (таблицы durak_rooms и durak_players, функции durak_*): раздача, проверка хода, время, выплаты.
   Телефон получает только свой вид (durak_view) — свою руку, чужие открытые карты, верх стопки — и отправляет ходы.
   Связь с сайтом — через window.AppAPI (sb, el, toast, баланс, аватарки). */
(function () {
  'use strict';
  var A = null;
  var K = {
    list: null, listErr: null, form: false, stake: '', listPoll: null,
    open: null, st: null, offset: 0, rtt: 1e9, poll: null, timer: null,
    rootEl: null, sig: '', sel: [], pick: [], busy: false, msg: '', msgErr: false,
    admin: false, test: false,  // админ может открыть тестовую комнату с ботами
    lastI: -1, anim: false, wasTurn: false, dropAt: {}   // какие действия уже показаны анимацией; идёт ли анимация; был ли мой ход
  };

  /* ---------- карты (рисунки и полёты — общие, в playing-cards.js) ---------- */
  // Карта — число 0..51: достоинство = карта / 4 + 2 (11 — валет, 14 — туз), масть = карта % 4.
  var PC = window.PlayingCards;
  var rank = PC.rank;

  function el() { return A.el.apply(null, arguments); }
  function setText(node, t) { if (window.Coin && window.Coin.has(t)) window.Coin.fill(node, t); else node.textContent = t; }
  function coins(n) { return A.fmt(n) + ' 🪙'; }
  async function rpc(name, args) {
    var r = await A.sb().rpc(name, args || {});
    if (r.error) throw r.error;
    return r.data;
  }
  function errText(e) {
    var m = String((e && (e.message || e.error)) || e || '');
    if (/durak_not_enough/.test(m)) return 'Не хватает монет на ставку.';
    if (/durak_busy/.test(m)) return 'Ты уже в другой комнате — сначала доиграй или выйди из неё.';
    if (/durak_full/.test(m)) return 'В комнате уже 5 человек.';
    if (/durak_too_many/.test(m)) return 'Открытых комнат может быть не больше 3.';
    if (/durak_bad_stake/.test(m)) return 'Ставка — от 0 до 100 000 монет.';
    if (/durak_alone/.test(m)) return 'Начать можно, когда в комнате хотя бы двое.';
    if (/durak_not_turn/.test(m)) return 'Сейчас не твой ход.';
    if (/durak_bad_move/.test(m)) return 'Так положить нельзя.';
    if (/durak_can_play/.test(m)) return 'Есть чем ходить — забрать стопку нельзя.';
    if (/durak_gone/.test(m)) return 'Эта комната уже неактуальна.';
    if (/not_admin/.test(m)) return 'Это может только админ.';
    if (/failed to fetch|network|load failed/i.test(m)) return 'Нет связи. Попробуй ещё раз.';
    return 'Что-то пошло не так.';
  }

  // Лицо карты (особые 2, 7, 8, 10 — с оранжевой точкой). opts: small, button, cls, label, pressed, onclick
  function cardEl(c, opts) {
    opts = opts || {};
    var sp = [2, 7, 8, 10].indexOf(rank(c)) >= 0;
    return PC.face(c, Object.assign({}, opts, { cls: (sp ? 'sp' : '') + (opts.cls ? ' ' + opts.cls : '') }));
  }
  // Рубашка. opts: small, button, n (число поверх), cls, label, onclick
  function backEl(opts) { return PC.back(opts); }

  /* ---------- список комнат ---------- */
  async function loadList() {
    var before = JSON.stringify(K.list || null);
    try { K.list = (await rpc('durak_list')) || []; K.listErr = null; } catch (e) { K.listErr = e; }
    if (JSON.stringify(K.list || null) === before && K.rootEl && K.rootEl.childNodes.length) return;   // ничего не поменялось — не трогаем экран
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
        'data-dismiss-trigger': 'dk-form', onclick: function () { K.form = !K.form; paint(true); } })
    ]));
    if (K.form) out.push(createForm());
    var active = (K.list || []).filter(function (r) { return r.status !== 'finished'; });
    var history = (K.list || []).filter(function (r) { return r.status === 'finished' && !r.test; });
    if (!K.list) {
      out.push(el('p', { class: 'muted', text: K.listErr ? errText(K.listErr) : 'Загружаю…' }));
    } else if (!active.length) {
      if (!K.form) out.push(el('p', { class: 'empty', text: 'Комнат пока нет' }));
    } else {
      out.push(el('div', { class: 'duel-list' }, active.map(roomRow)));
    }
    out.push(rulesBlock());
    if (history.length) out.push(fold('histOpen', 'История игр', [el('div', { class: 'duel-list' }, history.map(roomRow))], 'dk-history'));
    return out;
  }

  function avatars(players) {
    return el('span', { class: 'dk-avs' }, (players || []).slice(0, 5).map(function (p) { return A.avatar(p.name, p.color, true, p.avatar); }));
  }

  function roomRow(r) {
    var players = r.players || [];
    var n = players.length;
    var msg = el('p', { class: 'msg', role: 'status' });
    var acts = [], line, title, cls = '';
    var stakeTxt = r.stake ? 'ставка ' + coins(r.stake) : 'без ставки';
    if (r.status === 'finished') {
      var net = Number(r.my_payout || 0) - Number(r.stake || 0);
      var fool = r.my_place === n;
      title = fool ? 'Дурак' : r.my_place + ' место из ' + n;
      line = r.test ? 'тестовая, с ботами' : r.stake ? (net > 0 ? '+' : net < 0 ? '−' : '') + coins(Math.abs(net)) : 'без ставки';
      cls = fool ? ' lose' : r.my_place === 1 ? ' win' : '';
    } else if (r.watch) {
      // идёт чужая игра (или я из неё вышел) — можно наблюдать
      title = 'Идёт игра';
      line = playersText(n) + ' · ' + stakeTxt;
      acts.push(el('button', { type: 'button', class: 'btn', text: 'Наблюдать', onclick: function () { openRoom(r.id); } }));
    } else if (r.mine) {
      title = r.status === 'choose' || r.status === 'play' ? 'Идёт игра' : r.status === 'ready' ? 'Сейчас начнётся' : r.test ? 'Тестовая комната' : 'Твоя комната';
      line = n + ' из 5 · ' + (r.test ? 'с ботами' : stakeTxt);
      cls = ' incoming';
      acts.push(el('button', { type: 'button', class: 'btn primary', text: r.status === 'choose' || r.status === 'play' ? 'Вернуться' : 'Открыть',
        onclick: function () { openRoom(r.id); } }));
    } else {
      title = r.creator_name || 'Комната';
      line = n + ' из 5 · ' + stakeTxt + (r.status === 'ready' ? ' · уже начинают' : '');
      if (r.status === 'open' && n < 5) {
        var jb = el('button', { type: 'button', class: 'btn primary' });
        setText(jb, r.stake ? 'Войти · ' + coins(r.stake) : 'Войти');
        jb.addEventListener('click', function () { join(r.id, jb, msg); });
        acts.push(jb);
      }
      // ещё не началась — можно зайти посмотреть, не входя (тестовые комнаты чужим не видны)
      acts.push(el('button', { type: 'button', class: 'btn', text: 'Наблюдать', onclick: function () { openRoom(r.id); } }));
    }
    var lineEl = el('span', { class: 'duel-line' }); setText(lineEl, line);
    return el('div', { class: 'duel-row' + cls + (acts.length > 1 ? ' two' : '') }, [
      avatars(players),
      el('div', { class: 'duel-info' }, [el('span', { class: 'duel-name', text: title }), lineEl]),
      acts.length ? el('div', { class: 'duel-acts' }, acts) : null,
      msg
    ]);
  }

  // Сколько человек играет: «2 игрока», «5 игроков»
  function playersText(n) { return n + (n % 10 >= 2 && n % 10 <= 4 && (n < 12 || n > 14) ? ' игрока' : ' игроков'); }
  // Наблюдатель: смотрит «из-за спины» первого игрока — он внизу (как соперник: только число карт и карты на столе)
  function watchBox(p, st, oppBox) {
    return el('div', { class: 'dk-watch' }, p ? [oppBox(p, st, 'me')] : []);
  }

  async function join(id, btn, msg) {
    btn.disabled = true;
    try { await rpc('durak_join', { p_room: id }); A.loadPoints(); openRoom(id); }
    catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); btn.disabled = false; loadList(); }
  }

  function createForm() {
    var msg = el('p', { class: 'msg', role: 'status' });
    var go = el('button', { type: 'button', class: 'btn primary duel-go' });
    function val() { var v = String(K.stake).replace(/\s/g, ''); if (v === '') return null; var n = Number(v); return Number.isInteger(n) ? n : null; }
    function sync() {
      var n = val();
      var ok = n !== null && n >= 0 && n <= 100000;
      stakeBox.hidden = K.test;
      if (K.test) { setText(go, 'Открыть тестовую комнату'); go.disabled = false; if (msg.classList.contains('err')) { msg.className = 'msg'; msg.textContent = ''; } return; }
      setText(go, !ok ? 'Открыть комнату' : n ? 'Открыть комнату · ставка ' + coins(n) : 'Открыть комнату · без ставки');
      go.disabled = !ok || n > A.balance();
      if (ok && n > A.balance()) { msg.className = 'msg err'; setText(msg, 'Не хватает: у тебя ' + coins(Math.floor(A.balance()))); }
      else if (msg.classList.contains('err')) { msg.className = 'msg'; msg.textContent = ''; }
    }
    var input = el('input', { type: 'text', inputmode: 'numeric', id: 'dk-stake', autocomplete: 'off', placeholder: '0', 'aria-label': 'Ставка' });
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
    go.addEventListener('click', async function () {
      var n = K.test ? 0 : val();
      if (n === null) return;
      go.disabled = true;
      try {
        var id = await rpc('durak_create', K.test ? { p_stake: 0, p_test: true } : { p_stake: n });
        A.loadPoints();
        K.form = false; K.stake = '';
        openRoom(typeof id === 'number' ? id : Number(id));
      } catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); go.disabled = false; }
    });
    var stakeBox = el('div', { class: 'dk-stake-box' }, [
      el('label', { class: 'duel-label', for: 'dk-stake', text: 'Ставка с каждого' }),
      el('div', { class: 'duel-stake' }, [el('span', { class: 'duel-stake-in' }, [input, coin]), quick])
    ]);
    // Только админу: тестовая комната с ботами — видна только ему, без ставки и уведомлений
    var testRow = null;
    if (K.admin) {
      var tb = el('button', { type: 'button', class: 'chip duel-chip dk-test-chip', 'aria-pressed': String(K.test) }, [el('span', { text: 'Тестовая, с ботами' })]);
      tb.addEventListener('click', function () { K.test = !K.test; tb.setAttribute('aria-pressed', String(K.test)); sync(); });
      testRow = el('div', { class: 'dk-test-row' }, [tb]);
    }
    sync();
    // нажатие мимо формы закрывает её (ставка запоминается)
    if (A.dismissible) A.dismissible('dk-form', function () { if (K.form && !K.busy) { K.form = false; paint(true); } });
    return el('div', { class: 'card duel-form', 'data-dismiss': 'dk-form' }, [testRow, stakeBox, go, msg]);
  }

  function rulesBlock() {
    var items = [
      'Цель — избавиться от всех карт. Последний с картами — дурак.',
      'У каждого 3 закрытые карты на столе, 3 открытые поверх них и 3 в руке. Открытые выбираешь сам из шести.',
      'Клади карту не младше верхней или особую. Несколько одинаковых из руки — можно за раз (со стола — по одной). Потом добираешь из колоды до 3.',
      'Нечем ходить — забираешь всю стопку, а следующий ходит на пустой стол.',
      '2 — на любую карту. 7 — тоже на любую, но после неё только 7 или младше. 8 — невидимка: бить надо карту под ней. 10 — бита.',
      'Все 4 карты одного достоинства в стопке — бита. После биты ходишь ещё раз.',
      'Колода и рука кончились — играешь открытыми со стола, потом закрытыми вслепую. Закрытая не подошла — забираешь стопку вместе с ней.',
      'На ход 30 секунд. Время вышло — стопка уходит тебе. Два раза подряд — вне игры, последнее место.',
      'Банк делят по местам: первый удваивает ставку, каждое следующее место получает меньше, дурак — ничего.',
      '«Выйти» во время игры — поражение: ставка не вернётся.',
      'Если в комнате один человек, через минуту она закрывается, а если игра не началась за 3 минуты — тоже. Ставки возвращаются.'
    ];
    return fold('rulesOpen', 'Правила', [el('ul', { class: 'dk-rules-list' }, items.map(function (t) { return el('li', { text: t }); }))], 'dk-rules');
  }

  /* ---------- комната ---------- */
  function isOpen() { return !!K.open; }
  function openRoom(id) {
    K.open = id; K.st = null; K.sig = ''; K.sel = []; K.pick = []; K.msg = ''; K.rtt = 1e9; K.lastI = -1; K.wasTurn = false; K.quitAsk = false; K.dropAt = {};
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
      var st = await rpc('durak_view', { p_room: id });
      var t1 = Date.now();
      if (!st || K.open !== id) return;
      if (t1 - t0 <= K.rtt) { K.rtt = t1 - t0; K.offset = st.server_ms - (t0 + t1) / 2; }
      var was = K.st;
      // «Ещё раз» из другой комнаты тоже меняет вид (сколько человек уже в новой комнате)
      var changed = !was || was.version !== st.version || was.status !== st.status || JSON.stringify(was.rematch) !== JSON.stringify(st.rematch);
      if (!changed) { K.st = st; return; }
      // сначала анимацией показываем, что произошло (на старом столе), потом рисуем новый
      var fresh = (st.log || []).filter(function (e) { return e.i > K.lastI; });
      if (was && was.status === 'play' && K.lastI >= 0 && fresh.length && fresh.length <= 4 && !document.hidden && !REDUCED
          && K.rootEl && K.rootEl.querySelector('.dk-table')) {
        K.anim = true;
        // пока идёт анимация, старый стол не должен выглядеть как «твой ход»
        var meEl = K.rootEl.querySelector('.dk-me');
        if (meEl) meEl.classList.remove('turn');
        K.rootEl.classList.add('dk-anim');
        try { for (var i = 0; i < fresh.length; i++) await animEntry(fresh[i]); } catch (e2) { /* анимация не важна */ }
        K.rootEl.classList.remove('dk-anim');
        K.anim = false;
      }
      K.lastI = (st.log || []).reduce(function (m, e) { return Math.max(m, e.i || 0); }, Math.max(K.lastI, 0));
      K.st = st;
      if (was && was.status !== st.status && (st.status === 'finished' || st.status === 'cancelled' || st.status === 'choose')) A.loadPoints();
      if (st.status !== 'play' || !st.my || !st.my.turn) K.sel = [];
      if (was && st.status === 'choose') (st.players || []).forEach(function (p) {
        var old = (was.players || []).filter(function (q) { return q.seat === p.seat; })[0];
        if (p.chosen && old && !old.chosen) K.dropAt[p.seat] = Date.now();
      });
      paint();
    } catch (e) {
      if (/durak_gone/.test(String(e && e.message))) { A.toast('Комнаты больше нет'); closeRoom(); }
    } finally { ticking = false; }
  }

  // Сколько секунд осталось до срока этапа (по часам базы)
  function secondsLeft() {
    var st = K.st;
    if (!st || !st.deadline_ms) return null;
    return Math.max(0, Math.ceil((st.deadline_ms - (Date.now() + K.offset)) / 1000));
  }
  function updateTimers() {
    var st = K.st;
    if (!st || !K.rootEl) return;
    var left = secondsLeft();
    var total = st.status === 'choose' ? 60 : 30;
    K.rootEl.querySelectorAll('[data-left]').forEach(function (n) { n.textContent = left == null ? '' : left + ' с'; });
    K.rootEl.querySelectorAll('.dk-bar > i').forEach(function (n) {
      var ms = st.deadline_ms - (Date.now() + K.offset);
      n.style.width = Math.max(0, Math.min(100, ms / (total * 10))) + '%';
    });
    // открытая комната: один — через минуту, иначе — через 3 минуты с открытия (что раньше)
    var alone = st.alone_ms && st.status === 'open' ? Math.max(0, Math.ceil((st.alone_ms - (Date.now() + K.offset)) / 1000)) : null;
    K.rootEl.querySelectorAll('[data-alone]').forEach(function (n) {
      // один в комнате — «если никто не зайдёт»; двое и больше — «если игра не начнётся» (3 минуты с открытия)
      n.textContent = alone == null ? '' : 'Закроется через ' + leftText(alone) + (playersBySeat().length >= 2 ? ', если игра не начнётся' : ', если никто не зайдёт');
    });
  }

  // секунды до закрытия: «2:41», меньше минуты — «45 с»
  function leftText(sec) { return sec >= 60 ? Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + sec % 60 : sec + ' с'; }

  async function act(name, args, okToast) {
    if (K.busy) return;
    K.busy = true; K.msg = '';
    paint(true);
    try {
      await rpc(name, Object.assign({ p_room: K.open }, args || {}));
      if (okToast) A.toast(okToast);
      if (name === 'durak_join') A.loadPoints();   // вошёл из наблюдения — ставка списана
      K.sel = []; K.pick = [];
      if (name === 'durak_leave') { A.loadPoints(); K.busy = false; closeRoom(); return; }
      await tick();
    } catch (e) {
      K.msg = errText(e); K.msgErr = true;
      if (/durak_not_turn|durak_bad_move|durak_can_play/.test(String(e && e.message))) K.sel = [];
      await tick();
    } finally {
      K.busy = false;
      paint(true);
    }
  }

  function playersBySeat() { return (K.st && K.st.players) || []; }
  function playerAt(seat) { var p = playersBySeat(); for (var i = 0; i < p.length; i++) if (p[i].seat === seat) return p[i]; return null; }
  function bank(st) { return st.stake * playersBySeat().length; }

  // Ставка и банк одной строкой (в комнате ожидания)
  function stakeLine(st) {
    var b = el('span', { class: 'duel-bank dk-stake' });
    setText(b, st.test ? 'тестовая комната · с ботами' : st.stake ? 'ставка ' + coins(st.stake) + ' · банк ' + coins(bank(st)) : 'без ставки');
    return b;
  }

  // Над столом: банк и «Выйти». Выход во время игры — поражение, поэтому сначала короткое предупреждение.
  function gameBar(st) {
    var me = st.my || {};
    var myP = playerAt(me.seat) || {};
    var already = myP.place != null || !st.my;   // уже вне игры или наблюдаю — просто к списку комнат
    var b = el('span', { class: 'dk-bank' });
    setText(b, (st.test ? 'тестовая · с ботами' : st.stake ? 'банк ' + coins(bank(st)) : 'без ставки') + (st.my ? '' : ' · наблюдаешь'));
    var quit = el('button', { type: 'button', class: 'dk-quit', text: st.my ? 'Выйти' : 'К комнатам', 'aria-expanded': String(!!K.quitAsk && !already), 'data-dismiss-trigger': 'dk-quit',
      onclick: function () { if (already) { closeRoom(); return; } K.quitAsk = !K.quitAsk; paint(true); } });
    var kids = [b, quit];
    if (K.quitAsk && !already) {
      if (A.dismissible) A.dismissible('dk-quit', function () { if (K.quitAsk) { K.quitAsk = false; paint(true); } });
      kids.push(el('div', { class: 'dk-quit-pop', role: 'dialog', 'aria-label': 'Выйти из игры?', 'data-dismiss': 'dk-quit' }, [
        el('p', { text: 'Выйти из игры? Это засчитается как поражение' + (st.stake ? ': ставка не вернётся.' : '.') }),
        el('div', { class: 'dk-quit-acts' }, [
          el('button', { type: 'button', class: 'btn small', text: 'Остаться', onclick: function () { K.quitAsk = false; paint(true); } }),
          el('button', { type: 'button', class: 'btn small danger', text: 'Выйти', disabled: K.busy,
            onclick: function () { K.quitAsk = false; act('durak_leave', null, 'Вне игры'); } })
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

  // Имя и аватарка игрока: нажал — мини-профиль. Ботов не открываем; в свой ход или пока выбираешь карты — сначала сходи.
  function canPeek() {
    var st = K.st;
    if (st && st.my && st.my.place == null && ((st.status === 'play' && st.turn === st.my.seat) || (st.status === 'choose' && !st.my.chosen))) {
      A.toast('Сначала сходи'); return false;
    }
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
          onclick: function () { act('durak_remove_bot', { p_bot: tag.remove }); } }) : null
      ]);
    }));
  }

  // До раздачи: ждём игроков / «Готов»
  function waitBox(st) {
    var box = el('div', { class: 'card duel-lobby' });
    var n = playersBySeat().length;
    var acts = [];
    if (st.status === 'open' && st.test) {
      box.appendChild(el('p', { class: 'duel-big', text: 'Тестовая комната · ' + n + ' из 5' }));
      box.appendChild(stakeLine(st));
      box.appendChild(seatsList(st, function (p) { return { text: p.bot ? 'бот' : 'ты', on: false, remove: p.bot ? p.id : null }; }));
      if (n < 5) acts.push(el('button', { type: 'button', class: 'btn', text: 'Добавить бота', disabled: K.busy, onclick: function () { act('durak_add_bot'); } }));
      acts.unshift(el('button', { type: 'button', class: 'btn primary', text: 'Начать', disabled: n < 2 || K.busy, onclick: function () { act('durak_start'); } }));
      acts.push(el('button', { type: 'button', class: 'btn', text: 'Закрыть', disabled: K.busy, onclick: function () { act('durak_leave'); } }));
    } else if (st.status === 'open') {
      box.appendChild(el('p', { class: 'duel-big', text: n < 2 ? 'Ждём игроков' : 'В комнате ' + n + ' из 5' }));
      box.appendChild(stakeLine(st));
      if (st.alone_ms) box.appendChild(el('p', { class: 'muted dk-alone', 'data-alone': '1' }));   // отсчёт — в updateTimers
      box.appendChild(seatsList(st, function (p) { return { text: p.creator ? 'создатель' : '', on: false }; }));
      if (st.creator) acts.push(el('button', { type: 'button', class: 'btn primary', text: 'Начать', disabled: n < 2 || K.busy, onclick: function () { act('durak_start'); } }));
      if (!st.my) {
        // наблюдаю: можно войти (если есть место) или вернуться к комнатам
        box.appendChild(el('p', { class: 'muted dk-watching', text: 'Ты наблюдаешь' }));
        if (n < 5) {
          var jb = el('button', { type: 'button', class: 'btn primary', disabled: K.busy, onclick: function () { act('durak_join'); } });
          setText(jb, st.stake ? 'Войти · ' + coins(st.stake) : 'Войти');
          acts.push(jb);
        }
        acts.push(el('button', { type: 'button', class: 'btn', text: 'К комнатам', onclick: closeRoom }));
      } else acts.push(el('button', { type: 'button', class: 'btn', text: st.stake ? 'Выйти — ставка вернётся' : 'Выйти', disabled: K.busy,
        onclick: function () { act('durak_leave', null, st.stake ? 'Ставка вернулась' : null); } }));
    } else {
      var me = st.my || {};
      box.appendChild(el('p', { class: 'duel-big', text: me.ready ? 'Ждём остальных' : 'Игра начинается' }));
      box.appendChild(stakeLine(st));
      box.appendChild(el('div', { class: 'dk-bar', 'aria-hidden': 'true' }, [el('i')]));
      box.appendChild(seatsList(st, function (p) { return { text: p.ready ? 'готово' : 'ждём', on: p.ready }; }));
      if (!st.my) acts.push(el('button', { type: 'button', class: 'btn', text: 'К комнатам', onclick: closeRoom }));
      else {
        if (!me.ready) acts.push(el('button', { type: 'button', class: 'btn primary duel-ready-btn', text: 'Готов', disabled: K.busy, onclick: function () { act('durak_ready'); } }));
        acts.push(el('button', { type: 'button', class: 'btn', text: 'Выйти', disabled: K.busy, onclick: function () { act('durak_leave'); } }));
      }
    }
    box.appendChild(el('div', { class: 'duel-acts' }, acts));
    box.appendChild(msgLine());
    return box;
  }

  /* ---------- стол ---------- */
  // Три места на столе: открытая поверх закрытой. dim — карты на столе «в тени», пока в руке есть карты.
  function tableSlots(p, mine, src, turn, dim, drop) {
    var open = p.open || [];
    var closed = p.closed || [];
    var slots = [];
    for (var i = 0; i < 3; i++) {
      var o = open[i], hasClosed = !!closed[i];
      var kids = [];
      if (hasClosed) {
        var canFlip = mine && turn && src === 'closed' && !K.busy;
        kids.push(backEl({ small: !mine || dim, button: canFlip, cls: canFlip ? 'can' : '', label: canFlip ? 'Открыть закрытую карту ' + (i + 1) : 'Закрытая карта',
          onclick: canFlip ? (function (pos) { return function () { if (!K.anim) act('durak_flip', { p_pos: pos }); }; })(i + 1) : null }));
      }
      if (o != null) {
        var active = mine && turn && src === 'open';
        var playable = active && K.st.my.playable.indexOf(o) >= 0;
        kids.push(cardEl(o, { small: !mine || dim, button: active, cls: 'top' + (drop ? ' drop' : '') + (playable ? ' can' : '') + (K.sel.indexOf(o) >= 0 ? ' sel' : '') + (active && !playable ? ' no' : ''),
          onclick: active ? (function (c) { return function () { tapCard(c); }; })(o) : null }));
      }
      slots.push(el('span', { class: 'dk-slot' + (kids.length ? '' : ' vacant'), 'data-pos': String(i + 1) }, kids));
    }
    return el('div', { class: 'dk-slots' + (mine ? ' mine' : '') + (dim ? ' dim' : '') }, slots);
  }

  function tapCard(c) {
    var my = K.st && K.st.my;
    if (!my || !my.turn || K.busy || K.anim) return;
    if (my.playable.indexOf(c) < 0) { K.msg = 'Эту карту сейчас положить нельзя.'; K.msgErr = true; paint(true); return; }
    K.msg = '';
    var i = K.sel.indexOf(c);
    if (i >= 0) K.sel.splice(i, 1);
    else if (my.src === 'open') K.sel = [c];                          // открытые со стола — только по одной
    else if (K.sel.length && rank(K.sel[0]) !== rank(c)) K.sel = [c];
    else K.sel.push(c);
    paint(true);
  }

  // Рука соперника: веер рубашек (это карты, которыми он сейчас играет), число — прямо на веере
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

  // Соперник: имя, сверху веер (сколько карт в руке), под ним карты на столе —
  // мелкие, пока в руке есть карты; рука кончилась — крупные (на них теперь и играют)
  function oppBox(p, st, spot) {
    var turn = st.status === 'play' && st.turn === p.seat && p.place == null;
    var choosing = st.status === 'choose';
    var tag = p.place != null ? outText(p) : choosing && !p.chosen ? 'выбирает' : '';
    var dim = p.place == null && (p.hand > 0 || choosing);
    return el('div', { class: 'dk-opp at-' + spot + (turn ? ' turn' : '') + (p.place != null ? ' out' : ''), 'data-seat': String(p.seat), style: 'grid-area:' + spot }, [
      who(p, [
        A.avatar(p.name, p.color, true, p.avatar),
        el('span', { class: 'dk-opp-name', text: p.name })
      ], 'dk-opp-head'),
      p.place == null && p.hand > 0 ? fanEl(p.hand) : null,
      tableSlots(p, false, null, false, dim, Date.now() - (K.dropAt[p.seat] || 0) < 1500),
      tag ? el('span', { class: 'dk-opp-tag', text: tag }) : null,
      el('div', { class: 'dk-bar sm' + (turn ? '' : ' off'), 'aria-hidden': 'true' }, [el('i')])   // есть всегда — рамка не прыгает
    ]);
  }

  // Бита лежит вразнобой: сдвиги и углы рубашек (постоянные — при перерисовке не дёргаются)
  var BITA_R = [-28, 14, -6, 37, -41, 22, 3], BITA_X = [-3, 4, 1, -5, 3, -2, 5], BITA_Y = [2, -3, 4, 0, -4, 3, -1];
  // Середина: колода (с числом), стопка, бита (без числа). Пустые места ничем не обозначены.
  function midEl(st) {
    var top = st.pile_top || [];
    var under = Math.min(2, Math.max(0, st.pile_n - top.length));
    var pileKids = [];
    for (var u = 0; u < under; u++) pileKids.push(el('span', { class: 'dk-card blank u' + (u + 1) }));
    top.forEach(function (c, i) {       // восьмёрки сверху лежат со сдвигом — видно карту под ними
      var n = cardEl(c, { cls: i ? 'over' : '' });
      if (i) n.style.transform = 'translate(' + 9 * i + 'px,' + 3 * i + 'px) rotate(' + 7 * i + 'deg)';
      pileKids.push(n);
    });
    var deck = el('div', { class: 'dk-deck' + (st.deck_n ? '' : ' is-empty'), 'aria-label': st.deck_n ? 'Колода: ' + st.deck_n : 'Колода пустая' },
      st.deck_n ? [backEl({ small: true, cls: 'l2' }), backEl({ small: true, cls: 'l1' }), backEl({ small: true, n: st.deck_n, label: 'Колода' })] : []);
    var bitaKids = [], spread = playersBySeat().length >= 4 ? 0.55 : 1;
    for (var b = 0, nb = st.bita ? Math.min(7, 2 + Math.floor(st.bita / 6)) : 0; b < nb; b++) {
      var bk = backEl({ small: true, label: b === nb - 1 ? 'Бита' : null });
      bk.style.transform = 'translate(' + BITA_X[b] * spread + 'px,' + BITA_Y[b] * spread + 'px) rotate(' + Math.round(BITA_R[b] * spread) + 'deg)';
      bitaKids.push(bk);
    }
    var bita = el('div', { class: 'dk-bita' + (st.bita ? '' : ' is-empty'), 'aria-label': 'Бита' }, bitaKids);
    var mid = el('div', { class: 'dk-mid', style: 'grid-area:mid' }, [deck, el('div', { class: 'dk-pile', 'aria-label': 'Стопка' }, pileKids), bita]);
    return mid;
  }

  // Я: «Твой ход», мои карты на столе (в тени, пока есть рука), рука, кнопки
  // Я: рамка меняет размер только от числа карт. В свой ход рамка светится, а над ней — «Твой ход», секунды и кнопка.
  // Строка над рамкой и полоска времени есть всегда (вне своего хода — невидимые), чтобы ничего не прыгало.
  function meBox(st) {
    var me = st.my || {};
    var myP = playerAt(me.seat) || {};
    var turn = !!me.turn;
    var fresh = turn && !K.wasTurn;
    var dim = me.src === 'hand';
    var acts = [];
    if (turn) {
      if (me.can_take) {
        acts.push(el('button', { type: 'button', class: 'btn primary', text: 'Забрать стопку', disabled: K.busy, onclick: function () { if (!K.anim) act('durak_take'); } }));
      } else if (me.src !== 'closed') {
        acts.push(el('button', { type: 'button', class: 'btn primary', text: 'Положить', disabled: !K.sel.length || K.busy,
          onclick: function () { if (!K.anim) act('durak_play', { p_cards: K.sel.slice() }); } }));
      }
    }
    var line = el('div', { class: 'dk-turn-line' + (turn ? ' on' : '') + (fresh ? ' pop' : '') }, [
      el('span', { class: 'dk-turn-lbl' }, [el('span', { class: 'dk-turn-t', text: 'Твой ход' }), el('span', { class: 'dk-turn-left', 'data-left': '1' })]),
      el('div', { class: 'dk-acts' }, acts)
    ]);
    var box = el('div', { class: 'dk-me' + (turn ? ' turn' : '') + (fresh ? ' pop' : '') + (myP.place != null ? ' out' : ''), 'data-seat': String(me.seat) });
    if (myP.place != null) {
      box.appendChild(el('div', { class: 'dk-me-done', text: outText(myP).replace(/^в/, 'В') }));
    } else {
      box.appendChild(el('div', { class: 'dk-bar' + (turn ? '' : ' off'), 'aria-hidden': 'true' }, [el('i')]));
    }
    var slots = tableSlots(myP, true, me.src, turn, dim);
    var hand = me.hand || [];
    if (hand.length) {
      var handEl = el('div', { class: 'dk-hand' + (hand.length > 8 ? ' many' : '') }, hand.map(function (c) {
        var active = turn && me.src === 'hand';
        var playable = active && me.playable.indexOf(c) >= 0;
        return cardEl(c, { button: active, pressed: active ? K.sel.indexOf(c) >= 0 : null,
          cls: (playable ? 'can' : active ? 'no' : '') + (K.sel.indexOf(c) >= 0 ? ' sel' : ''),
          onclick: active ? function () { tapCard(c); } : null });
      }));
      box.appendChild(el('div', { class: 'dk-me-row' }, [handEl, slots]));
    } else {
      box.appendChild(slots);
    }
    if (K.msg) box.appendChild(msgLine());
    K.wasTurn = turn;
    return el('div', { class: 'dk-me-wrap' }, [line, box]);
  }

  // Выбор открытых карт: стол уже виден, моя рамка — на своём месте внизу
  function meChooseBox(st) {
    var me = st.my || {};
    var myP = playerAt(me.seat) || {};
    var picking = !me.chosen;
    var acts = picking ? [el('button', { type: 'button', class: 'btn primary', text: 'Положить',
      disabled: K.pick.length !== 3 || K.busy, onclick: confirmPick })] : [];
    var line = el('div', { class: 'dk-turn-line on' + (picking ? '' : ' wait') }, [
      el('span', { class: 'dk-turn-lbl' }, [el('span', { class: 'dk-turn-t', text: picking ? 'Выбери 3 карты' : 'Ждём остальных' }),
        el('span', { class: 'dk-turn-left', 'data-left': '1' })]),
      el('div', { class: 'dk-acts' }, acts)
    ]);
    var box = el('div', { class: 'dk-me choosing' + (picking ? ' turn' : ''), 'data-seat': String(me.seat) });
    box.appendChild(el('div', { class: 'dk-bar', 'aria-hidden': 'true' }, [el('i')]));
    // мои три закрытые уже лежат на столе; после выбора на них — открытые
    box.appendChild(tableSlots(Object.assign({}, myP, { open: picking ? [] : me.open }), true, null, false, true));
    if (picking) {
      // шесть карт в один ряд; выбранные (на стол, открытыми) приподняты
      box.appendChild(el('div', { class: 'dk-hand many dk-pick' }, (me.pick || []).map(function (c) {
        var on = K.pick.indexOf(c) >= 0;
        return cardEl(c, { button: true, pressed: on, cls: on ? 'sel' : '', onclick: function () {
          var i = K.pick.indexOf(c);
          if (i >= 0) K.pick.splice(i, 1);
          else if (K.pick.length < 3) K.pick.push(c);
          else { K.pick.shift(); K.pick.push(c); }
          paint(true);
        } });
      })));
    } else {
      box.appendChild(el('div', { class: 'dk-hand' }, (me.hand || []).map(function (c) { return cardEl(c); })));
    }
    if (K.msg) box.appendChild(msgLine());
    return el('div', { class: 'dk-me-wrap' }, [line, box]);
  }

  // «Положить» при выборе: три выбранные карты летят из ряда на свои закрытые, потом — в базу
  async function confirmPick() {
    if (K.busy || K.anim || K.pick.length !== 3) return;
    var picks = K.pick.slice(), root = K.rootEl;
    if (!REDUCED && root) {
      K.anim = true;
      try {
        await Promise.all(picks.map(function (c, i) {
          var src = root.querySelector('.dk-pick [data-card="' + c + '"]');
          var dst = root.querySelector('.dk-me .dk-slots.mine .dk-slot[data-pos="' + (i + 1) + '"]');
          var p = fly(cardEl(c), src, dst, { s0: 0.87, s1: 0.61, delay: i * 90, ms: 380, rot: (i - 1) * 4 });
          if (src) src.style.visibility = 'hidden';
          return p.then(function () { if (dst) dst.appendChild(cardEl(c, { small: true, cls: 'top' })); });
        }));
      } catch (e) { /* анимация не важна */ }
      K.anim = false;
    }
    act('durak_choose', { p_cards: picks });
  }

  function playBox(st) {
    var base = st.my ? null : playersBySeat()[0];     // наблюдаю: внизу первый игрок
    var mySeat = st.my ? st.my.seat : base ? base.seat : 0;
    // соперники по часовой стрелке, начиная со следующего после меня: слева → сверху → справа
    var opps = playersBySeat().filter(function (p) { return !p.me && p !== base; }).sort(function (a, b) {
      return ((a.seat - mySeat + 10) % 10) - ((b.seat - mySeat + 10) % 10);
    });
    var spots = { 1: ['top'], 2: ['tl', 'tr'], 3: ['l', 'top', 'r'], 4: ['l', 'tl', 'tr', 'r'] }[opps.length] || [];
    var ring = el('div', { class: 'dk-ring n' + opps.length }, opps.map(function (p, i) { return oppBox(p, st, spots[i]); }).concat([midEl(st)]));
    return el('div', { class: 'dk-table' }, [ring, !st.my ? watchBox(base, st, oppBox) : st.status === 'choose' ? meChooseBox(st) : meBox(st)]);
  }

  /* ---------- анимации ---------- */
  var REDUCED = PC.REDUCED;
  var wait = PC.wait, fly = PC.fly, flyBacks = PC.flyBacks, flash = PC.flash;
  // Переворот закрытой карты на месте: рубашка → лицо
  function flipAt(from, c, s) { return PC.flipAt(from, c, s, { faceEl: function (x) { return cardEl(x, { cls: 'dk-flip-face' }); } }); }
  function seatEl(seat) { return K.rootEl.querySelector('[data-seat="' + seat + '"]'); }

  // Показать одно действие из журнала. Стол на экране — ещё старый, новый нарисуется после.
  async function animEntry(e) {
    var root = K.rootEl;
    var pile = root.querySelector('.dk-pile'), deck = root.querySelector('.dk-deck'), bita = root.querySelector('.dk-bita');
    var box = seatEl(e.seat);
    if (!box || !pile) return;
    var mine = box.classList.contains('dk-me');
    var sm = mine ? 1 : 0.6;                                        // у соперников карты мельче
    var toActor = (mine && root.querySelector('.dk-hand')) || (!mine && box.querySelector('.dk-fan')) || box;  // куда летят карты игроку
    var cards = e.cards || [];
    if (e.kind === 'play' && e.from === 'closed' || e.kind === 'flip_take') {
      var slot = box.querySelector('.dk-slot[data-pos="' + (e.pos || 1) + '"]') || box;
      var show = mine && cards.length;   // лицо карты видит только тот, кто её открыл
      if (show) await flipAt(slot, cards[0], sm);
      else if (slot.firstChild) slot.firstChild.style.visibility = 'hidden';
      var flyer = function () { return show ? cardEl(cards[0]) : backEl({ cls: 'dk-fly-back' }); };
      if (e.kind === 'flip_take') {
        await Promise.all([fly(flyer(), slot, toActor, { s0: sm, s1: 0.6 }), flyBacks(pile, toActor, (e.n || 2) - 1)]);
      } else {
        await fly(flyer(), slot, pile, { s0: show ? sm : 0.6 });
        pile.appendChild(cardEl(cards[0], { cls: 'over landed' }));   // в стопке карту видят все — иначе не побить
      }
    } else if (e.kind === 'play') {
      await Promise.all(cards.map(function (c, i) {
        var src = box.querySelector('[data-card="' + c + '"]') || toActor;
        var p = fly(cardEl(c), src, pile, { s0: src === box ? 0.6 : sm, delay: i * 80 });
        if (src !== toActor && src !== box) src.style.visibility = 'hidden';  // карта ушла из руки — оригинал прячем
        return p;
      }));
      cards.forEach(function (c) { pile.appendChild(cardEl(c, { cls: 'over landed' })); });
    } else if (e.kind === 'take') {
      pile.replaceChildren();
      await flyBacks(pile, toActor, e.n || 1);
    } else {
      return;
    }
    if (e.four && bita) await flyBacks(toActor, bita, 4, { rot: 12 });
    if (e.burn && bita) {
      flash(pile, 'Бита!');
      await wait(250);
      pile.replaceChildren();
      await flyBacks(pile, bita, 4, { rot: 18, s0: 1 });
    }
    if (e.drew && deck) await flyBacks(deck, toActor, e.drew, { s1: mine ? 1 : 0.6 });
    await wait(120);
  }

  function resultBox(st) {
    var players = playersBySeat().slice().sort(function (a, b) { return a.place - b.place; });
    var n = players.length;
    var box = el('div', { class: 'card dk-result' });
    var me = st.my || {};
    var fool = me.place === n;
    box.appendChild(el('p', { class: 'duel-title' + (fool ? ' lose' : me.place === 1 ? ' win' : ''),
      text: !st.my ? 'ИГРА ОКОНЧЕНА' : fool ? 'ДУРАК' : me.place === 1 ? 'ПОБЕДА' : me.place + ' МЕСТО' }));
    box.appendChild(el('div', { class: 'dk-places' }, players.map(function (p) {
      var net = Number(p.payout || 0) - st.stake;
      var money = el('span', { class: 'dk-pl-money' + (net > 0 ? ' plus' : net < 0 ? ' minus' : '') });
      setText(money, st.stake ? (net > 0 ? '+' : net < 0 ? '−' : '') + coins(Math.abs(net)) : '');
      return el('div', { class: 'dk-pl' + (p.me ? ' me' : '') }, [
        el('span', { class: 'dk-pl-n', text: p.place === n ? 'дурак' : p.place + '.' }),
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
      try { var id = await rpc('durak_rematch', { p_room: st.id }); A.loadPoints(); K.busy = false; openRoom(Number(id)); }
      catch (e) { K.busy = false; K.msg = errText(e); K.msgErr = true; paint(true); }
    });
    if (st.my) acts.push(again);
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
    else if (st.status === 'choose' || st.status === 'play') body = playBox(st);
    else if (st.status === 'finished') body = resultBox(st);
    else {
      // закрыта: один в комнате минуту или 3 минуты без игры — так и пишем
      var lastLog = (st.log || [])[(st.log || []).length - 1];
      var why = lastLog && (lastLog.kind === 'alone' || lastLog.kind === 'expired') ? lastLog.kind : null;
      body = el('div', { class: 'card duel-lobby' }, [
        el('p', { class: 'duel-big', text: why ? 'Комната закрыта' : 'Комната закрыта — ставки вернулись' }),
        why === 'alone' ? el('p', { class: 'muted dk-alone', text: 'За минуту никто не зашёл' + (st.stake ? ' — ставка вернулась' : '') }) : null,
        why === 'expired' ? el('p', { class: 'muted dk-alone', text: 'За 3 минуты игра не началась' + (st.stake ? ' — ставки вернулись' : '') }) : null,
        el('div', { class: 'duel-acts' }, [el('button', { type: 'button', class: 'btn', text: 'К комнатам', onclick: closeRoom })])
      ].filter(Boolean));
    }
    return st.status === 'choose' || st.status === 'play' ? [gameBar(st), body] : [body];
  }

  // Перерисовка. force — перерисовать, даже если вид не поменялся (после нажатий).
  function paint(force) {
    if (!K.rootEl) return;
    var sig = K.open ? 'room:' + K.open + ':' + (K.st ? K.st.version + ':' + K.st.status : '-') : 'list';
    if (!force && sig === K.sig && K.rootEl.childNodes.length) return;
    K.sig = sig;
    K.rootEl.replaceChildren.apply(K.rootEl, K.open ? roomScreen() : lobby());
    updateTimers();
  }

  function view() {
    if (!K.rootEl) K.rootEl = el('section', { class: 'sect dk', 'aria-label': 'Дурак' });
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
  window.Durak = { view: withApi(view), enter: enter, leave: leave, isOpen: isOpen, open: withApi(openRoom), init: function () { A = window.AppAPI; } };
})();
