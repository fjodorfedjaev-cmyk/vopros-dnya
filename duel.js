/* Дуэли в «Секторе»: вызвать друга на монеты, принять, «Готов», игра одновременно, итог.
   Всё про деньги и итог решает база (sector_duels, функции duel_*), счёт проверяет сервер:
   телефон отправляет запись нажатий в функцию duel-submit, она переигрывает партию тем же ядром (sector-core.js).
   Связь с сайтом — через window.AppAPI (sb, el, toast, баланс, участники). */
(function () {
  'use strict';
  var A = null;
  var D = {
    list: null, listErr: null, form: false, opp: null, stake: '',
    open: null, st: null, offset: null, rtt: 1e9, poll: null, listPoll: null,
    screenEl: null, headEl: null, bodyEl: null, gameHolder: null,
    game: null, myScore: 0, lastSent: 0, result: null, submitting: false, submitErr: null, ended: false
  };

  function el() { return A.el.apply(null, arguments); }
  function one(d) { return Array.isArray(d) ? d[0] : d; }
  async function rpc(name, args) {
    var r = await A.sb().rpc(name, args || {});
    if (r.error) throw r.error;
    return r.data;
  }
  function errText(e) {
    var m = String((e && (e.message || e.error)) || e || '');
    if (/duel_not_enough/.test(m)) return 'Не хватает монет на ставку.';
    if (/duel_exists/.test(m)) return 'С этим человеком уже есть открытая дуэль.';
    if (/duel_gone/.test(m)) return 'Эта дуэль уже неактуальна.';
    if (/duel_bad_stake/.test(m)) return 'Ставка — от 1 до 100 000 монет.';
    if (/duel_bad_opponent/.test(m)) return 'Выбери, кого вызвать.';
    if (/duel_too_many/.test(m)) return 'Открытых комнат может быть не больше 3.';
    if (/failed to fetch|network|load failed/i.test(m)) return 'Нет связи. Попробуй ещё раз.';
    return 'Что-то пошло не так.';
  }
  function setText(node, t) { if (window.Coin && window.Coin.has(t)) window.Coin.fill(node, t); else node.textContent = t; }
  function coins(n) { return n + ' 🪙'; }
  function msgEl() { return el('p', { class: 'msg', role: 'status' }); }
  function showMsg(node, text, err) { node.className = 'msg' + (err ? ' err' : ''); setText(node, text || ''); }
  function oppAv(row, small) { return row.opp_id ? A.avatar(row.opp_name, row.opp_color, small !== false, row.opp_avatar) : A.avatar('?', '#4A4542', small !== false, ''); }
  var RULES = 'Игра одинаковая у обоих. Очки: край сектора — 1, ближе к центру — 2, центр — 3. Промах или пропуск — твоя игра закончилась. Соперник уже закончил, а ты обогнал — победа. Свернул приложение — проигрыш.';

  /* ---------- список дуэлей (под игрой) ---------- */
  function section() {
    var sect = el('section', { class: 'sect duel-sect', id: 'duel-sect' });
    fillList(sect);
    return sect;
  }
  async function loadList() {
    try { D.list = (await rpc('duel_list')) || []; D.listErr = null; } catch (e) { D.listErr = e; }
    var s = document.getElementById('duel-sect');
    if (s && !(D.form && s.contains(document.activeElement))) fillList(s);
  }
  function fillList(sect) {
    sect.replaceChildren();
    var head = el('div', { class: 'duel-head' }, [
      el('h2', { text: 'Дуэли' }),
      el('button', { type: 'button', class: 'btn' + (D.form ? '' : ' primary'), text: D.form ? 'Закрыть' : 'Новая дуэль',
        onclick: function () { D.form = !D.form; fillList(sect); } })
    ]);
    sect.appendChild(head);
    if (D.form) sect.appendChild(challengeForm(sect));
    if (!D.list) {
      sect.appendChild(el('p', { class: 'muted', text: D.listErr ? errText(D.listErr) : 'Загружаю…' }));
      return;
    }
    if (!D.list.length) {
      if (!D.form) sect.appendChild(el('p', { class: 'empty', text: 'Вызови друга или открой комнату для любого: одна и та же игра у обоих, побеждает тот, кто сыграет лучше. Победитель забирает обе ставки.' }));
      return;
    }
    sect.appendChild(el('div', { class: 'duel-list' }, D.list.map(function (d) { return duelRow(d, sect); })));
  }

  function duelRow(d, sect) {
    var line, acts = [], msg = msgEl();
    var incoming = (d.status === 'invited' && !d.i_am_p1) || d.joinable;
    if (d.joinable) {
      line = 'открытая комната · ставка ' + coins(d.stake);
      var jb = el('button', { type: 'button', class: 'btn primary' }); setText(jb, 'Войти · ' + coins(d.stake));
      jb.addEventListener('click', function () { join(d, jb, msg); });
      acts.push(jb);
    } else if (d.status === 'open') {
      line = 'твоя комната · ждём соперника · ставка ' + coins(d.stake);
      acts.push(el('button', { type: 'button', class: 'btn', text: 'Отменить', onclick: function (ev) { cancel(d, ev.currentTarget, msg); } }));
    } else if (incoming) {
      line = 'вызывает тебя · ставка ' + coins(d.stake);
      acts.push(el('button', { type: 'button', class: 'btn primary', text: 'Принять', onclick: function (ev) { respond(d, true, ev.currentTarget, msg); } }));
      acts.push(el('button', { type: 'button', class: 'btn', text: 'Отказаться', onclick: function (ev) { respond(d, false, ev.currentTarget, msg); } }));
    } else if (d.status === 'invited') {
      line = 'ждём ответа · ставка ' + coins(d.stake);
      acts.push(el('button', { type: 'button', class: 'btn', text: 'Отменить', onclick: function (ev) { cancel(d, ev.currentTarget, msg); } }));
    } else if (d.status === 'accepted' || d.status === 'playing') {
      line = (d.status === 'playing' ? 'идёт игра' : d.my_ready ? 'готово — ждём соперника' : 'вызов принят — жми «Готов»') + ' · ставка ' + coins(d.stake);
      acts.push(el('button', { type: 'button', class: 'btn primary', text: 'Открыть', onclick: function () { openDuel(d.id); } }));
    } else {
      var res = d.outcome === 'win' ? 'победа +' + coins(d.stake * 2) : d.outcome === 'lose' ? 'поражение −' + coins(d.stake) : 'ничья — ставки вернулись';
      line = (d.my_score != null && d.opp_score != null ? d.my_score + ' : ' + d.opp_score + ' · ' : '') + res;
    }
    var lineEl = el('span', { class: 'duel-line' }); setText(lineEl, line);
    return el('div', { class: 'duel-row' + (d.outcome ? ' ' + d.outcome : '') + (incoming ? ' incoming' : '') }, [
      oppAv(d, false),
      el('div', { class: 'duel-info' }, [el('span', { class: 'duel-name', text: d.opp_id ? (d.opp_name || 'Без имени') : 'Открытая комната' }), lineEl]),
      acts.length ? el('div', { class: 'duel-acts' }, acts) : null,
      msg
    ]);
  }

  async function respond(d, accept, btn, msg) {
    btn.disabled = true;
    try {
      await rpc('duel_respond', { p_id: d.id, p_accept: accept });
      A.loadPoints();
      if (accept) { openDuel(d.id); return; }
      A.toast('Вызов отклонён');
      await loadList();
    } catch (e) { showMsg(msg, errText(e), true); btn.disabled = false; }
  }
  async function join(d, btn, msg) {
    btn.disabled = true;
    try {
      await rpc('duel_join', { p_id: d.id });
      A.loadPoints();
      openDuel(d.id);
    } catch (e) { showMsg(msg, errText(e), true); btn.disabled = false; await loadList(); }
  }
  async function cancel(d, btn, msg) {
    btn.disabled = true;
    try {
      await rpc('duel_cancel', { p_id: d.id });
      A.loadPoints();
      A.toast('Дуэль отменена — ставка вернулась');
      if (D.open) closeDuel(); else await loadList();
    } catch (e) { showMsg(msg, errText(e), true); btn.disabled = false; }
  }

  // Форма вызова: кого и на сколько
  function challengeForm(sect) {
    var me = A.me();
    var people = (A.members() || []).filter(function (p) { return p.id !== me; });
    var msg = msgEl();
    var go = el('button', { type: 'button', class: 'btn primary duel-go' });
    function stakeVal() { var n = Number(String(D.stake).replace(/\s/g, '')); return Number.isInteger(n) ? n : 0; }
    function sync() {
      var n = stakeVal();
      var okN = n >= 1 && n <= 100000;
      var verb = D.opp === '*' ? 'Открыть комнату' : 'Вызвать';
      setText(go, okN ? verb + ' · ставка ' + coins(n) : verb);
      go.disabled = !D.opp || !okN || n > A.balance();
      if (okN && n > A.balance()) showMsg(msg, 'Не хватает: у тебя ' + coins(Math.floor(A.balance())), true);
      else if (msg.classList.contains('err')) showMsg(msg, '');
    }
    var options = [{ id: '*', display_name: 'Любой — открытая комната', room: true }].concat(people);
    var chips = el('div', { class: 'duel-people', role: 'group', 'aria-label': 'Кого вызвать' }, options.map(function (p) {
      return el('button', {
        type: 'button', class: 'chip duel-chip', 'aria-pressed': String(D.opp === p.id),
        onclick: function () {
          D.opp = p.id;
          chips.querySelectorAll('.duel-chip').forEach(function (b) { b.setAttribute('aria-pressed', String(b === this)); }, this);
          sync();
        }
      }, [p.room ? A.avatar('?', '#4A4542', true, '') : A.avatar(p.display_name, p.color, true, p.avatar), el('span', { text: p.display_name || 'Без имени' })]);
    }));
    var input = el('input', { type: 'text', inputmode: 'numeric', id: 'duel-stake', autocomplete: 'off', placeholder: '0', 'aria-label': 'Ставка' });
    input.value = D.stake;
    input.addEventListener('input', function () {
      var v = input.value.replace(/\D/g, '').slice(0, 6);
      if (v !== input.value) input.value = v;
      D.stake = v; sync();
    });
    var quick = el('div', { class: 'duel-quick' }, [10, 50, 100, 300].map(function (n) {
      return el('button', { type: 'button', class: 'btn small', text: String(n), onclick: function () { D.stake = String(n); input.value = D.stake; sync(); } });
    }));
    go.addEventListener('click', async function () {
      var n = stakeVal();
      if (!D.opp || !n) return;
      go.disabled = true;
      showMsg(msg, 'Отправляю вызов…');
      try {
        var room = D.opp === '*';
        var id = await rpc('duel_create', { p_opponent: room ? null : D.opp, p_stake: n });
        A.loadPoints();
        D.form = false; D.opp = null; D.stake = '';
        A.toast((room ? 'Комната открыта' : 'Вызов отправлен') + ' — ставка ' + coins(n) + ' в банке');
        await loadList();
        if (typeof id === 'number') { /* ждём ответа — дуэль видна в списке */ }
      } catch (e) { showMsg(msg, errText(e), true); go.disabled = false; }
    });
    sync();
    return el('div', { class: 'card duel-form' }, [
      el('p', { class: 'duel-label', text: 'Кого вызвать' }),
      chips,
      el('label', { class: 'duel-label', for: 'duel-stake', text: 'Ставка' }),
      el('div', { class: 'duel-stake' }, [el('span', { class: 'duel-stake-in' }, [input, coinEl()]), quick]),
      el('p', { class: 'muted small', text: 'Ставка сразу уходит в банк. Отказ, отмена или если за сутки никто не придёт — вернётся. Победитель забирает обе ставки.' }),
      go, msg
    ]);
  }
  function coinEl() { var s = el('span', { class: 'duel-coin', 'aria-hidden': 'true' }); setText(s, '🪙'); return s; }

  /* ---------- экран одной дуэли ---------- */
  function isOpen() { return !!D.open; }
  function openDuel(id) {
    if (D.game) { try { D.game.destroy(); } catch (e) { /* уже */ } D.game = null; }
    D.open = id; D.st = null; D.result = null; D.submitErr = null; D.submitting = false; D.ended = false;
    D.myScore = 0; D.offset = null; D.rtt = 1e9; D.screenEl = null; D.sig = '';
    stopListPoll();
    A.rerender();
    window.scrollTo(0, 0);
    startPoll();
  }
  function closeDuel() {
    stopPoll();
    if (D.game) { try { D.game.destroy(); } catch (e) { /* уже */ } D.game = null; }
    D.open = null; D.st = null; D.screenEl = null;
    A.setGameState(null);
    A.rerender();
    loadList();
    startListPoll();
  }

  function screen() {
    if (!D.screenEl) {
      D.headEl = el('div', { class: 'card duel-top' });
      D.bodyEl = el('div', { class: 'duel-body' });
      D.gameHolder = el('div', { class: 'duel-game' });
      D.screenEl = el('section', { class: 'sect duel-screen', 'aria-label': 'Дуэль' }, [D.headEl, D.bodyEl, D.gameHolder]);
      updateScreen();
    }
    return D.screenEl;
  }

  function startPoll() { stopPoll(); tick(); D.poll = setInterval(tick, 1000); }
  function stopPoll() { if (D.poll) { clearInterval(D.poll); D.poll = null; } }
  var ticking = false;
  async function tick() {
    if (ticking || !D.open) return;
    ticking = true;
    var id = D.open;
    try {
      // пока игра идёт — знак «я ещё играю» и текущий счёт
      if (D.game && D.st && D.st.status === 'playing' && !D.ended) {
        await A.sb().rpc('duel_progress', { p_id: id, p_score: D.myScore });
      }
      var t0 = Date.now();
      var st = one(await rpc('duel_state', { p_id: id }));
      var t1 = Date.now();
      if (!st || D.open !== id) return;
      // разница часов телефона и базы: берём самый быстрый ответ (он точнее)
      if (t1 - t0 <= D.rtt) { D.rtt = t1 - t0; D.offset = st.server_ms - (t0 + t1) / 2; }
      var was = D.st && D.st.status;
      D.st = st;
      updateScreen(was);
      if (st.status === 'finished' || st.status === 'declined' || st.status === 'cancelled' || st.status === 'expired') {
        if (!D.game || D.ended) stopPoll();
        if (was !== st.status) A.loadPoints();
      }
    } catch (e) { /* следующая попытка через секунду */ }
    finally { ticking = false; }
  }

  function updateScreen(was) {
    if (!D.screenEl) return;
    var st = D.st;
    D.headEl.replaceChildren();
    if (!st) { D.headEl.appendChild(el('p', { class: 'muted', text: 'Загружаю дуэль…' })); return; }
    var bank = el('span', { class: 'duel-bank' }); setText(bank, 'ставка ' + coins(st.stake) + ' · банк ' + coins(st.stake * 2));
    D.headEl.appendChild(el('div', { class: 'duel-vs' }, st.opp_id ? [
      el('span', { class: 'duel-vs-l', text: 'Дуэль с' }),
      oppAv(st, false),
      el('span', { class: 'duel-name', text: st.opp_name || 'Без имени' })
    ] : [oppAv(st, false), el('span', { class: 'duel-name', text: 'Открытая комната' })]));
    D.headEl.appendChild(bank);

    var playingOrDone = st.status === 'playing' || (st.status === 'finished' && D.game);
    if (playingOrDone) {
      D.bodyEl.replaceChildren();
      if (!D.game && st.seed != null && D.offset != null) mountGame();
      if (D.game && D.ended) D.game.refreshPanel();
      return;
    }
    // перерисовываем, только если что-то поменялось (чтобы кнопка не пропадала из-под пальца)
    var sig = st.status + '|' + st.my_ready + '|' + st.opp_ready;
    if (sig === D.sig && D.bodyEl.childNodes.length) return;
    D.sig = sig;
    D.bodyEl.replaceChildren(lobby(st));
  }

  // До старта: принять / «Готов» / ждём; после — итог (если открыли законченную дуэль из списка)
  function lobby(st) {
    var box = el('div', { class: 'card duel-lobby' }), msg = msgEl();
    var back = el('button', { type: 'button', class: 'btn', text: 'К дуэлям', onclick: closeDuel });
    var rules = el('p', { class: 'muted small duel-rules', text: RULES });
    if (st.status === 'open') {
      box.appendChild(el('p', { class: 'duel-big', text: 'Комната открыта — ждём, пока кто-нибудь зайдёт' }));
      box.appendChild(rules);
      box.appendChild(el('div', { class: 'duel-acts' }, [
        el('button', { type: 'button', class: 'btn', text: 'Закрыть комнату', onclick: function (ev) { cancel({ id: st.id }, ev.currentTarget, msg); } }), back]));
    } else if (st.status === 'invited' && !st.i_am_p1) {
      box.appendChild(el('p', { class: 'duel-big', text: st.opp_name + ' вызывает тебя на дуэль' }));
      var acc = el('button', { type: 'button', class: 'btn primary' }); setText(acc, 'Принять · ставка ' + coins(st.stake));
      acc.addEventListener('click', function () { respond({ id: st.id }, true, acc, msg); });
      box.appendChild(rules);
      box.appendChild(el('div', { class: 'duel-acts' }, [acc,
        el('button', { type: 'button', class: 'btn', text: 'Отказаться', onclick: function (ev) { respond({ id: st.id }, false, ev.currentTarget, msg).then(closeDuel); } })]));
    } else if (st.status === 'invited') {
      box.appendChild(el('p', { class: 'duel-big', text: 'Ждём, пока ' + st.opp_name + ' примет вызов' }));
      box.appendChild(el('div', { class: 'duel-acts' }, [
        el('button', { type: 'button', class: 'btn', text: 'Отменить вызов', onclick: function (ev) { cancel({ id: st.id }, ev.currentTarget, msg); } }), back]));
    } else if (st.status === 'accepted') {
      box.appendChild(el('p', { class: 'duel-big', text: st.my_ready ? 'Готово. Ждём соперника…' : 'Нажмите оба «Готов» — игра начнётся одновременно' }));
      box.appendChild(el('div', { class: 'duel-ready-row' }, [
        el('span', { class: 'duel-ready' + (st.my_ready ? ' on' : ''), text: 'Ты: ' + (st.my_ready ? 'готово' : 'ещё нет') }),
        el('span', { class: 'duel-ready' + (st.opp_ready ? ' on' : ''), text: st.opp_name + ': ' + (st.opp_ready ? 'готово' : 'ещё нет') })
      ]));
      box.appendChild(rules);
      var acts = [];
      if (!st.my_ready) {
        var ready = el('button', { type: 'button', class: 'btn primary duel-ready-btn', text: 'Готов' });
        ready.addEventListener('click', async function () {
          ready.disabled = true;
          try { await rpc('duel_ready', { p_id: st.id }); tick(); }
          catch (e) { showMsg(msg, errText(e), true); ready.disabled = false; }
        });
        acts.push(ready);
      }
      acts.push(el('button', { type: 'button', class: 'btn', text: 'Отменить дуэль', onclick: function (ev) { cancel({ id: st.id }, ev.currentTarget, msg); } }));
      box.appendChild(el('div', { class: 'duel-acts' }, acts));
    } else if (st.status === 'finished') {
      box.appendChild(resultBlock(st));
      box.appendChild(el('div', { class: 'duel-acts' }, [back]));
    } else {
      box.appendChild(el('p', { class: 'duel-big', text: st.status === 'declined' ? 'Вызов отклонён — ставка вернулась' : 'Дуэль отменена — ставки вернулись' }));
      box.appendChild(el('div', { class: 'duel-acts' }, [back]));
    }
    box.appendChild(msg);
    return box;
  }

  function resultBlock(st) {
    var title = st.outcome === 'win' ? 'ПОБЕДА' : st.outcome === 'lose' ? 'ПОРАЖЕНИЕ' : 'НИЧЬЯ';
    var money = st.outcome === 'win' ? '+' + coins(st.stake * 2) : st.outcome === 'lose' ? '−' + coins(st.stake) : 'ставки вернулись';
    var why = '';
    if (st.opp_end === 'forfeit' || st.opp_end === 'quit') why = 'У соперника засчитан выход из игры';
    else if (st.my_end === 'forfeit' || st.my_end === 'quit') why = 'Засчитан выход из игры (приложение свернули или пропала связь)';
    var m = el('p', { class: 'duel-money' }); setText(m, money);
    return el('div', { class: 'duel-result ' + (st.outcome || '') }, [
      el('p', { class: 'duel-title', text: title }),
      el('p', { class: 'duel-score', text: 'Ты ' + (st.my_score != null ? st.my_score : 0) + ' · ' + st.opp_name + ' ' + (st.opp_score != null ? st.opp_score : 0) }),
      why ? el('p', { class: 'muted small', text: why }) : null,
      m
    ]);
  }

  function mountGame() {
    var st = D.st;
    // старт по часам базы: сколько осталось до start_ms на наших часах
    var startAt = performance.now() + (st.start_ms - (Date.now() + D.offset));
    D.game = window.SectorGame.mount(D.gameHolder, {
      onStateChange: function (s) { A.setGameState(s === 'gone' ? null : s); },
      duel: {
        seed: st.seed,
        startAt: startAt,
        title: 'Соперник: ' + st.opp_name + ' · банк ' + (st.stake * 2),
        opponent: function () {
          var s = D.st;
          if (!s) return null;
          var done = !!s.opp_end;
          return { name: s.opp_name, score: done ? (s.opp_score || 0) : (s.opp_progress || 0), done: done, forfeit: s.opp_end === 'quit' || s.opp_end === 'forfeit' };
        },
        onProgress: function (p) {
          D.myScore = p.score;
          var now = Date.now();
          if (now - D.lastSent > 300) { D.lastSent = now; A.sb().rpc('duel_progress', { p_id: st.id, p_score: p.score }).then(function () {}, function () {}); }
        },
        onEnd: function (res) { D.ended = true; D.myScore = res.score; submit(res); },
        overPanel: overPanel
      }
    });
  }

  // Отправить запись нажатий на проверку (с повтором при плохой связи)
  async function submit(res) {
    D.submitting = true; D.submitErr = null;
    if (D.game) D.game.refreshPanel();
    var body = { duel_id: D.open, presses: res.presses, end: res.end, end_t: res.endT };
    for (var i = 0; i < 3; i++) {
      try {
        var r = await A.sb().functions.invoke('duel-submit', { body: body });
        if (r.error) throw r.error;
        D.result = r.data; D.submitErr = null;
        break;
      } catch (e) {
        D.submitErr = e;
        await new Promise(function (ok) { setTimeout(ok, 800 * (i + 1)); });
      }
    }
    D.submitting = false;
    await tick();
    if (D.game) D.game.refreshPanel();
    if (!D.poll && D.st && D.st.status !== 'finished') startPoll();
  }

  // Низ игры после конца: отправка → ждём соперника → итог
  function overPanel(panel, res) {
    var st = D.st;
    if (st && st.status === 'finished') {
      panel.appendChild(resultBlock(st));
      panel.appendChild(el('button', { type: 'button', class: 'btn primary sector-play', text: 'К дуэлям', onclick: closeDuel }));
      stopPoll();
      return;
    }
    if (D.submitting) { panel.appendChild(el('p', { class: 'sector-lead', text: 'Проверяем результат…' })); return; }
    if (D.submitErr && !D.result) {
      panel.appendChild(el('p', { class: 'sector-warn', text: 'Не получилось отправить результат.' }));
      panel.appendChild(el('button', { type: 'button', class: 'btn primary sector-play', text: 'Отправить ещё раз', onclick: function () { submit(res); } }));
      return;
    }
    panel.appendChild(el('p', { class: 'sector-over', text: res.end === 'win' ? 'ПОБЕДА!' : 'ИГРА ОКОНЧЕНА' }));
    panel.appendChild(el('p', { class: 'sector-best', text: 'Твой счёт: ' + ((D.result && D.result.score != null) ? D.result.score : res.score) }));
    if (st && res.end !== 'win') panel.appendChild(el('p', { class: 'sector-opp', text: st.opp_name + (st.opp_end ? ': ' + (st.opp_score || 0) + ' · игра окончена' : ' ещё играет: ' + (st.opp_progress || 0)) }));
    if (res.end === 'win') panel.appendChild(el('p', { class: 'muted small', text: 'Записываем итог…' }));
  }

  /* ---------- вход и выход ---------- */
  function startListPoll() { stopListPoll(); D.listPoll = setInterval(function () { if (!document.hidden && !D.open) loadList(); }, 15000); }
  function stopListPoll() { if (D.listPoll) { clearInterval(D.listPoll); D.listPoll = null; } }
  function enter() {
    A = window.AppAPI;
    if (D.open) { if (!D.poll) startPoll(); return; }
    loadList();
    startListPoll();
  }
  function leave() {
    stopListPoll();
    if (D.open && !(D.game && !D.ended)) { stopPoll(); }
  }

  window.Duels = { section: section, screen: screen, isOpen: isOpen, enter: enter, leave: leave, open: openDuel, init: function () { A = window.AppAPI; } };
})();
