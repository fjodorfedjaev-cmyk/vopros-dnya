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
    rootEl: null, sig: '', sel: [], pick: [], busy: false, msg: '', msgErr: false
  };

  /* ---------- карты ---------- */
  // Карта — число 0..51: достоинство = карта / 4 + 2 (11 — валет, 14 — туз), масть = карта % 4.
  var SUITS = ['♠', '♥', '♦', '♣'];
  var NAMES = { 11: 'В', 12: 'Д', 13: 'К', 14: 'Т' };
  var VS = '︎'; // чтобы ♥ и ♦ рисовались значком, а не цветным смайликом
  function rank(c) { return Math.floor(c / 4) + 2; }
  function suit(c) { return c % 4; }
  function rankName(r) { return NAMES[r] || String(r); }
  function cardName(c) { return rankName(rank(c)) + SUITS[suit(c)] + VS; }
  function isRed(c) { return suit(c) === 1 || suit(c) === 2; }

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
    if (/failed to fetch|network|load failed/i.test(m)) return 'Нет связи. Попробуй ещё раз.';
    return 'Что-то пошло не так.';
  }

  // Лицо карты. opts: small, button, cls, label
  function cardEl(c, opts) {
    opts = opts || {};
    var r = rank(c);
    var cls = 'dk-card' + (isRed(c) ? ' red' : '') + (opts.small ? ' sm' : '') + ([2, 7, 8, 10].indexOf(r) >= 0 ? ' sp' : '') + (opts.cls ? ' ' + opts.cls : '');
    return el(opts.button ? 'button' : 'span', {
      class: cls, type: opts.button ? 'button' : null, 'aria-label': opts.label || cardName(c),
      'aria-pressed': opts.pressed != null ? String(!!opts.pressed) : null, onclick: opts.onclick || null
    }, [
      el('span', { class: 'dk-r', 'aria-hidden': 'true', text: rankName(r) }),
      el('span', { class: 'dk-s', 'aria-hidden': 'true', text: SUITS[suit(c)] + VS })
    ]);
  }
  // Рубашка. opts: small, button, n (число поверх), cls, label, onclick
  function backEl(opts) {
    opts = opts || {};
    return el(opts.button ? 'button' : 'span', {
      class: 'dk-card back' + (opts.small ? ' sm' : '') + (opts.cls ? ' ' + opts.cls : ''), type: opts.button ? 'button' : null,
      'aria-label': opts.label || 'Закрытая карта', onclick: opts.onclick || null
    }, opts.n != null ? [el('span', { class: 'dk-n', text: String(opts.n) })] : []);
  }

  /* ---------- список комнат ---------- */
  async function loadList() {
    try { K.list = (await rpc('durak_list')) || []; K.listErr = null; } catch (e) { K.listErr = e; }
    if (!K.open && K.rootEl && !(K.form && K.rootEl.contains(document.activeElement))) paint(true);
  }

  function lobby() {
    var out = [];
    out.push(el('div', { class: 'duel-head' }, [
      el('h2', { text: 'Комнаты' }),
      el('button', { type: 'button', class: 'btn' + (K.form ? '' : ' primary'), text: K.form ? 'Закрыть' : 'Новая комната',
        onclick: function () { K.form = !K.form; paint(true); } })
    ]));
    if (K.form) out.push(createForm());
    if (!K.list) {
      out.push(el('p', { class: 'muted', text: K.listErr ? errText(K.listErr) : 'Загружаю…' }));
    } else if (!K.list.length) {
      if (!K.form) out.push(el('p', { class: 'empty', text: 'Открой комнату — друзья увидят её здесь и смогут зайти. Играть можно от двух до пяти человек.' }));
    } else {
      out.push(el('div', { class: 'duel-list' }, K.list.map(roomRow)));
    }
    out.push(rulesBlock());
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
      line = r.stake ? (net > 0 ? '+' : net < 0 ? '−' : '') + coins(Math.abs(net)) : 'без ставки';
      cls = fool ? ' lose' : r.my_place === 1 ? ' win' : '';
    } else if (r.mine) {
      title = r.status === 'choose' || r.status === 'play' ? 'Идёт игра' : r.status === 'ready' ? 'Сейчас начнётся' : 'Твоя комната';
      line = n + ' из 5 · ' + stakeTxt;
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
      var n = val();
      if (n === null) return;
      go.disabled = true;
      try {
        var id = await rpc('durak_create', { p_stake: n });
        A.loadPoints();
        K.form = false; K.stake = '';
        openRoom(typeof id === 'number' ? id : Number(id));
      } catch (e) { msg.className = 'msg err'; msg.textContent = errText(e); go.disabled = false; }
    });
    sync();
    return el('div', { class: 'card duel-form' }, [
      el('label', { class: 'duel-label', for: 'dk-stake', text: 'Ставка с каждого' }),
      el('div', { class: 'duel-stake' }, [el('span', { class: 'duel-stake-in' }, [input, coin]), quick]),
      el('p', { class: 'muted small', text: 'Ставка уходит в банк при входе. Выйти до начала — вернётся. Банк делят по местам: первый удваивает ставку, дурак не получает ничего.' }),
      go, msg
    ]);
  }

  function rulesBlock() {
    var items = [
      'Цель — избавиться от всех карт. Последний с картами — дурак.',
      'У каждого 3 закрытые карты на столе, 3 открытые поверх них и 3 в руке. Открытые выбираешь сам из шести.',
      'Клади карту не младше верхней или особую. Несколько одинаковых — можно за раз. Потом добираешь из колоды до 3.',
      'Нечем ходить — забираешь всю стопку, а следующий ходит на пустой стол.',
      '2 — на любую карту. 7 — после неё только 7 или младше. 8 — невидимка: бить надо карту под ней. 10 — бита.',
      'Все 4 карты одного достоинства в стопке — бита. После биты ходишь ещё раз.',
      'Колода и рука кончились — играешь открытыми со стола, потом закрытыми вслепую. Закрытая не подошла — забираешь стопку вместе с ней.',
      'На ход 30 секунд. Время вышло — стопка уходит тебе. Два раза подряд — вне игры, последнее место.',
      'Банк делят по местам: первый удваивает ставку, каждое следующее место получает меньше, дурак — ничего.'
    ];
    return el('details', { class: 'day dk-rules' }, [
      el('summary', { text: 'Правила' }),
      el('ul', { class: 'dk-rules-list' }, items.map(function (t) { return el('li', { text: t }); }))
    ]);
  }

  /* ---------- комната ---------- */
  function isOpen() { return !!K.open; }
  function openRoom(id) {
    K.open = id; K.st = null; K.sig = ''; K.sel = []; K.pick = []; K.msg = ''; K.rtt = 1e9;
    stopListPoll();
    paint(true);
    window.scrollTo(0, 0);
    startPoll();
  }
  function closeRoom() {
    stopPoll();
    K.open = null; K.st = null; K.sig = '';
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
      K.st = st;
      // «Ещё раз» из другой комнаты тоже меняет вид (сколько человек уже в новой комнате)
      if (!was || was.version !== st.version || was.status !== st.status || JSON.stringify(was.rematch) !== JSON.stringify(st.rematch)) {
        if (was && was.status !== st.status && (st.status === 'finished' || st.status === 'cancelled' || st.status === 'choose')) A.loadPoints();
        if (st.status !== 'play' || !st.my || !st.my.turn) K.sel = [];
        paint();
      }
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
  }

  async function act(name, args, okToast) {
    if (K.busy) return;
    K.busy = true; K.msg = '';
    paint(true);
    try {
      await rpc(name, Object.assign({ p_room: K.open }, args || {}));
      if (okToast) A.toast(okToast);
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

  function head(st) {
    var b = el('span', { class: 'duel-bank' });
    setText(b, st.stake ? 'ставка ' + coins(st.stake) + ' · банк ' + coins(bank(st)) : 'без ставки');
    var back = el('button', { type: 'button', class: 'link quiet dk-back', text: '← Комнаты', onclick: closeRoom });
    return el('div', { class: 'card dk-top' }, [el('div', { class: 'dk-top-row' }, [el('span', { class: 'dk-title', text: 'Дурак' }), back]), b]);
  }

  function msgLine() {
    var m = el('p', { class: 'msg' + (K.msgErr && K.msg ? ' err' : ''), role: 'status' });
    m.textContent = K.msg || '';
    return m;
  }

  function seatsList(st, mark) {
    return el('div', { class: 'dk-seats' }, playersBySeat().map(function (p) {
      var tag = mark(p);
      return el('div', { class: 'dk-seat' + (tag.on ? ' on' : '') }, [
        A.avatar(p.name, p.color, true, p.avatar),
        el('span', { class: 'dk-seat-name', text: p.me ? p.name + ' (ты)' : p.name }),
        tag.text ? el('span', { class: 'dk-seat-tag', text: tag.text }) : null
      ]);
    }));
  }

  // До раздачи: ждём игроков / «Готов»
  function waitBox(st) {
    var box = el('div', { class: 'card duel-lobby' });
    var n = playersBySeat().length;
    var acts = [];
    if (st.status === 'open') {
      box.appendChild(el('p', { class: 'duel-big', text: n < 2 ? 'Ждём игроков' : 'В комнате ' + n + ' из 5' }));
      box.appendChild(seatsList(st, function (p) { return { text: p.creator ? 'создатель' : '', on: false }; }));
      box.appendChild(el('p', { class: 'muted small', text: st.creator
        ? 'Комнату видят все во вкладке «Игры» → «Дурак». Начать можно от двух человек: у остальных будет 30 секунд, чтобы нажать «Готов».'
        : 'Ждём, пока создатель комнаты начнёт игру.' }));
      if (st.creator) acts.push(el('button', { type: 'button', class: 'btn primary', text: 'Начать', disabled: n < 2 || K.busy, onclick: function () { act('durak_start'); } }));
      acts.push(el('button', { type: 'button', class: 'btn', text: st.stake ? 'Выйти — ставка вернётся' : 'Выйти', disabled: K.busy,
        onclick: function () { act('durak_leave', null, st.stake ? 'Ставка вернулась' : null); } }));
    } else {
      var me = st.my || {};
      box.appendChild(el('p', { class: 'duel-big', text: me.ready ? 'Ждём остальных…' : 'Игра начинается — жми «Готов»' }));
      box.appendChild(el('div', { class: 'dk-bar', 'aria-hidden': 'true' }, [el('i')]));
      box.appendChild(seatsList(st, function (p) { return { text: p.ready ? 'готово' : 'ждём', on: p.ready }; }));
      box.appendChild(el('p', { class: 'muted small' }, ['Кто не нажмёт за ', el('span', { 'data-left': '1' }), ', выходит из комнаты (ставка вернётся).']));
      if (!me.ready) acts.push(el('button', { type: 'button', class: 'btn primary duel-ready-btn', text: 'Готов', disabled: K.busy, onclick: function () { act('durak_ready'); } }));
      acts.push(el('button', { type: 'button', class: 'btn', text: 'Выйти', disabled: K.busy, onclick: function () { act('durak_leave'); } }));
    }
    box.appendChild(el('div', { class: 'duel-acts' }, acts));
    box.appendChild(msgLine());
    return box;
  }

  // Выбор трёх открытых карт из шести
  function chooseBox(st) {
    var me = st.my || {};
    var box = el('div', { class: 'card dk-choose' });
    if (me.chosen) {
      box.appendChild(el('p', { class: 'duel-big', text: 'Ждём, пока выберут остальные' }));
      box.appendChild(el('div', { class: 'dk-bar', 'aria-hidden': 'true' }, [el('i')]));
      box.appendChild(seatsList(st, function (p) { return { text: p.chosen ? 'готово' : 'выбирает', on: p.chosen }; }));
      box.appendChild(el('p', { class: 'dk-sub', text: 'Открытые на столе' }));
      box.appendChild(el('div', { class: 'dk-row' }, (me.open || []).map(function (c) { return cardEl(c); })));
      box.appendChild(el('p', { class: 'dk-sub', text: 'В руке' }));
      box.appendChild(el('div', { class: 'dk-row' }, (me.hand || []).map(function (c) { return cardEl(c); })));
      return box;
    }
    box.appendChild(el('p', { class: 'duel-big', text: 'Выбери 3 карты — они лягут открытыми на стол' }));
    box.appendChild(el('p', { class: 'muted small' }, ['Их увидят все. Остальные три останутся в руке. Осталось ', el('span', { 'data-left': '1' }),
      ' — потом открытыми лягут три старшие.']));
    box.appendChild(el('div', { class: 'dk-bar', 'aria-hidden': 'true' }, [el('i')]));
    box.appendChild(el('div', { class: 'dk-row dk-pick' }, (me.pick || []).map(function (c) {
      var on = K.pick.indexOf(c) >= 0;
      return cardEl(c, { button: true, pressed: on, cls: on ? 'sel' : '', onclick: function () {
        var i = K.pick.indexOf(c);
        if (i >= 0) K.pick.splice(i, 1);
        else if (K.pick.length < 3) K.pick.push(c);
        else { K.pick.shift(); K.pick.push(c); }
        paint(true);
      } });
    })));
    box.appendChild(el('button', { type: 'button', class: 'btn primary', disabled: K.pick.length !== 3 || K.busy,
      text: K.pick.length === 3 ? 'Положить открытыми' : 'Выбрано ' + K.pick.length + ' из 3',
      onclick: function () { act('durak_choose', { p_cards: K.pick.slice() }); } }));
    box.appendChild(msgLine());
    return box;
  }

  // Что надо побить — подсказка над стопкой
  function needText(st) {
    if (!st.pile_n) return 'Стол пустой — клади любую';
    var n = st.need;
    var top = st.pile_top || [];
    var under = top.length > 1 || (top.length === 1 && rank(top[0]) === 8 && n !== 8);
    var pre = under ? 'Восьмёрка — невидимка. ' : '';
    if (n === 2) return pre + 'Сверху двойка — клади любую';
    if (n === 7) return pre + 'После семёрки — только 7 или младше';
    if (n === 14) return pre + 'Туза бьют только 2, 8 и 10';
    return pre + 'Бить ' + rankName(n) + ': ' + rankName(n) + ' или старше, либо 2, 8, 10';
  }

  // Строка журнала: что произошло
  function logText(e, st) {
    var p = playerAt(e.seat);
    var me = p && p.me;
    var who = me ? 'Ты' : (p ? p.name : 'Кто-то');
    var cards = (e.cards || []).map(cardName).join(' ');
    var t;
    if (e.kind === 'begin') t = me ? 'Первый ход — твой' : 'Первым ходит ' + who;
    else if (e.kind === 'play') t = who + (e.from === 'closed' ? (me ? ' открываешь закрытую: ' : ' открывает закрытую: ') : ': ') + cards;
    else if (e.kind === 'flip_take') t = who + (me ? ' открываешь ' : ' открывает ') + cards + (me ? ' — не подходит, забираешь стопку' : ' — не подходит, забирает стопку') + ' (' + e.n + ')';
    else if (e.kind === 'take') t = who + (me ? ' забираешь стопку' : ' забирает стопку') + ' (' + e.n + ')' + (e.auto ? ' — время вышло' : '');
    else if (e.kind === 'afk') t = who + (me ? ' пропускаешь' : ' пропускает') + ' второй ход подряд — вне игры, ' + e.out + ' место';
    else t = '';
    if (e.four) t += ' · четыре ' + rankName(e.four) + ' — в биту';
    if (e.burn) t += ' — бита!';
    if (e.out && e.kind !== 'afk') t += (me ? ' · ты без карт — ' : ' · без карт — ') + e.out + ' место';
    return t;
  }

  // Три места на столе: открытая поверх закрытой
  function tableSlots(p, mine, src, turn) {
    var open = p.open || [];
    var closed = p.closed || [];
    var slots = [];
    for (var i = 0; i < 3; i++) {
      var o = open[i], hasClosed = !!closed[i];
      var kids = [];
      if (hasClosed) {
        var canFlip = mine && turn && src === 'closed' && !K.busy;
        kids.push(backEl({ small: !mine, button: canFlip, cls: canFlip ? 'can' : '', label: canFlip ? 'Открыть закрытую карту ' + (i + 1) : 'Закрытая карта',
          onclick: canFlip ? (function (pos) { return function () { act('durak_flip', { p_pos: pos }); }; })(i + 1) : null }));
      }
      if (o != null) {
        var playable = mine && turn && src === 'open' && K.st.my.playable.indexOf(o) >= 0;
        kids.push(cardEl(o, { small: !mine, button: mine && turn && src === 'open', cls: 'top' + (playable ? ' can' : '') + (K.sel.indexOf(o) >= 0 ? ' sel' : '') + (mine && turn && src === 'open' && !playable ? ' no' : ''),
          onclick: mine && turn && src === 'open' ? (function (c) { return function () { tapCard(c); }; })(o) : null }));
      }
      slots.push(el('span', { class: 'dk-slot' + (kids.length ? '' : ' vacant') }, kids));
    }
    return el('div', { class: 'dk-slots' + (mine ? ' mine' : '') }, slots);
  }

  function tapCard(c) {
    var my = K.st && K.st.my;
    if (!my || !my.turn || K.busy) return;
    if (my.playable.indexOf(c) < 0) { K.msg = 'Эту карту сейчас положить нельзя.'; K.msgErr = true; paint(true); return; }
    K.msg = '';
    var i = K.sel.indexOf(c);
    if (i >= 0) K.sel.splice(i, 1);
    else if (K.sel.length && rank(K.sel[0]) !== rank(c)) K.sel = [c];
    else K.sel.push(c);
    paint(true);
  }

  function oppBox(p, st) {
    var turn = st.status === 'play' && st.turn === p.seat && p.place == null;
    var tag = p.place != null ? (p.out === 'afk' ? 'вне игры' : p.place + ' место') : '';
    return el('div', { class: 'dk-opp' + (turn ? ' turn' : '') + (p.place != null ? ' out' : '') }, [
      el('div', { class: 'dk-opp-head' }, [
        A.avatar(p.name, p.color, true, p.avatar),
        el('span', { class: 'dk-opp-name', text: p.name }),
        tag ? el('span', { class: 'dk-seat-tag', text: tag }) : (turn ? el('span', { class: 'dk-seat-tag on', 'data-left': '1' }) : null)
      ]),
      el('div', { class: 'dk-opp-cards' }, [
        p.hand ? backEl({ small: true, n: p.hand, label: 'В руке ' + p.hand }) : el('span', { class: 'dk-card sm ghost', 'aria-label': 'Рука пустая' }),
        tableSlots(p, false)
      ]),
      turn ? el('div', { class: 'dk-bar sm', 'aria-hidden': 'true' }, [el('i')]) : null
    ]);
  }

  function playBox(st) {
    var me = st.my || {};
    var myP = playerAt(me.seat) || {};
    var mySeat = me.seat;
    var players = playersBySeat();
    // соперники — по кругу, начиная со следующего после меня
    var opps = players.filter(function (p) { return !p.me; }).sort(function (a, b) {
      return ((a.seat - mySeat + 10) % 10) - ((b.seat - mySeat + 10) % 10);
    });
    var wrap = el('div', { class: 'dk-table' });
    wrap.appendChild(el('div', { class: 'dk-opps n' + opps.length }, opps.map(function (p) { return oppBox(p, st); })));

    // центр: стопка, подсказка, колода и бита, что произошло
    var top = st.pile_top || [];
    var pile = el('div', { class: 'dk-pile' }, top.length
      ? top.map(function (c, i) { return cardEl(c, { cls: i ? 'over' : '' }); })
      : [el('span', { class: 'dk-card ghost', 'aria-label': 'Стол пустой' })]);
    var log = (st.log || []).slice(-3).reverse();
    wrap.appendChild(el('div', { class: 'card dk-center' }, [
      el('div', { class: 'dk-center-row' }, [
        pile,
        el('div', { class: 'dk-center-info' }, [
          el('span', { class: 'dk-need', text: needText(st) }),
          el('span', { class: 'dk-counts', text: 'в стопке ' + st.pile_n + ' · колода ' + st.deck_n + ' · бита ' + st.bita })
        ])
      ]),
      log.length ? el('div', { class: 'dk-log' }, log.map(function (e, i) { return el('p', { class: i ? 'old' : '', text: logText(e, st) }); })) : null
    ]));

    // я
    var turn = !!me.turn;
    var tp = playerAt(st.turn);
    var status;
    if (myP.place != null) status = myP.out === 'afk' ? 'Ты вне игры — ждём конца партии' : 'Ты без карт — ' + myP.place + ' место. Ждём конца партии';
    else if (turn) status = me.src === 'closed' ? 'Твой ход: открой одну из закрытых' : me.src === 'open' ? 'Твой ход: карты со стола' : 'Твой ход';
    else status = 'Ходит ' + (tp ? tp.name : '…');
    var mine = el('div', { class: 'card dk-me' + (turn ? ' turn' : '') }, [
      el('div', { class: 'dk-me-head' }, [el('span', { class: 'dk-me-status', text: status }), myP.place == null ? el('span', { class: 'dk-left', 'data-left': '1' }) : null]),
      myP.place == null ? el('div', { class: 'dk-bar', 'aria-hidden': 'true' }, [el('i')]) : null,
      tableSlots(myP, true, me.src, turn)
    ]);
    var hand = me.hand || [];
    if (hand.length) {
      mine.appendChild(el('div', { class: 'dk-hand' + (hand.length > 8 ? ' many' : '') }, hand.map(function (c) {
        var playable = turn && me.src === 'hand' && me.playable.indexOf(c) >= 0;
        return cardEl(c, { button: turn && me.src === 'hand', pressed: K.sel.indexOf(c) >= 0,
          cls: (playable ? 'can' : turn ? 'no' : '') + (K.sel.indexOf(c) >= 0 ? ' sel' : ''),
          onclick: turn && me.src === 'hand' ? function () { tapCard(c); } : null });
      })));
    }
    if (turn) {
      var acts = [];
      if (me.src !== 'closed') {
        acts.push(el('button', { type: 'button', class: 'btn primary', disabled: !K.sel.length || K.busy,
          text: K.sel.length ? 'Положить ' + K.sel.map(cardName).join(' ') : 'Выбери карту',
          onclick: function () { act('durak_play', { p_cards: K.sel.slice() }); } }));
      }
      if (me.can_take) acts.push(el('button', { type: 'button', class: 'btn', text: 'Забрать стопку', disabled: K.busy, onclick: function () { act('durak_take'); } }));
      mine.appendChild(el('div', { class: 'dk-acts' }, acts));
    }
    mine.appendChild(msgLine());
    wrap.appendChild(mine);
    return wrap;
  }

  function resultBox(st) {
    var players = playersBySeat().slice().sort(function (a, b) { return a.place - b.place; });
    var n = players.length;
    var box = el('div', { class: 'card dk-result' });
    var me = st.my || {};
    var fool = me.place === n;
    box.appendChild(el('p', { class: 'duel-title' + (fool ? ' lose' : me.place === 1 ? ' win' : ''), text: fool ? 'ДУРАК' : me.place === 1 ? 'ПОБЕДА' : me.place + ' МЕСТО' }));
    box.appendChild(el('div', { class: 'dk-places' }, players.map(function (p) {
      var net = Number(p.payout || 0) - st.stake;
      var money = el('span', { class: 'dk-pl-money' + (net > 0 ? ' plus' : net < 0 ? ' minus' : '') });
      setText(money, st.stake ? (net > 0 ? '+' : net < 0 ? '−' : '') + coins(Math.abs(net)) : '');
      return el('div', { class: 'dk-pl' + (p.me ? ' me' : '') }, [
        el('span', { class: 'dk-pl-n', text: p.place === n ? 'дурак' : p.place + '.' }),
        A.avatar(p.name, p.color, true, p.avatar),
        el('span', { class: 'dk-pl-name', text: p.name + (p.out === 'afk' ? ' · по времени' : '') }),
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
    else if (st.status === 'choose') body = chooseBox(st);
    else if (st.status === 'play') body = playBox(st);
    else if (st.status === 'finished') body = resultBox(st);
    else body = el('div', { class: 'card duel-lobby' }, [
      el('p', { class: 'duel-big', text: 'Комната закрыта — ставки вернулись' }),
      el('div', { class: 'duel-acts' }, [el('button', { type: 'button', class: 'btn', text: 'К комнатам', onclick: closeRoom })])
    ]);
    return [head(st), body];
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
  function enter() {
    A = window.AppAPI;
    if (K.open) { if (!K.poll) startPoll(); return; }
    loadList();
    startListPoll();
  }
  function leave() { stopListPoll(); stopPoll(); }

  function withApi(f) { return function () { if (!A) A = window.AppAPI; return f.apply(null, arguments); }; }
  window.Durak = { view: withApi(view), enter: enter, leave: leave, isOpen: isOpen, open: withApi(openRoom), init: function () { A = window.AppAPI; } };
})();
