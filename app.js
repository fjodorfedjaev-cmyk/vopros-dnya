/* Вопрос дня: логика сайта.
   Страница рисуется из JavaScript. Данные хранятся в Supabase: вход, профили, вопросы и ответы.
   Весь текст пользователей вставляется через textContent, поэтому в него нельзя подмешать чужой код. */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var APP = CFG.APP_NAME || 'Вопрос дня';
  var root = document.getElementById('app');
  var sb = null;

  var PALETTE = ['#12806F', '#2F6FDE', '#8A4FD6', '#D6457A', '#D9622B', '#B8860B', '#3C8D2F', '#5B6770'];
  var PALETTE_NAMES = ['бирюзовый', 'синий', 'фиолетовый', 'розовый', 'оранжевый', 'золотистый', 'зелёный', 'серый'];
  var CAT = { deep: 'Глубокий', funny: 'Смешной', spicy: 'Провокационный' };
  // Реакции: код в базе, эмодзи на экране, подпись для экранного диктора.
  var REACTIONS = [
    ['laugh', '😂', 'смешно'], ['fire', '🔥', 'огонь'], ['heart', '❤️', 'нравится'], ['wow', '🤯', 'взрыв мозга'],
    ['skull', '💀', 'я умер'], ['clap', '👏', 'браво'], ['cry', '😭', 'плачу'], ['eyes', '👀', 'интересно'],
    ['like', '👍', 'согласен'], ['dislike', '👎', 'не согласен'], ['think', '🤔', 'хм'], ['party', '🎉', 'ура'],
    ['hundred', '💯', 'в точку'], ['love', '😍', 'обожаю'], ['angry', '😡', 'злюсь'], ['sick', '🤢', 'фу'],
    ['shock', '😱', 'шок'], ['cool', '😎', 'круто'], ['pray', '🙏', 'спасибо'], ['clown', '🤡', 'клоун']
  ];
  // Основные обновления приходят мгновенно через Realtime; опрос раз в минуту — запасной вариант.
  var POLL_MS = 60000;
  // Эмодзи для аватарки. null — без эмодзи, тогда показывается первая буква имени.
  var EMOJIS = ['😎', '🤠', '🥸', '🤓', '😈', '👻', '💀', '🤖', '👽', '🐱', '🐶', '🦊', '🐼', '🐸', '🐵', '🦁', '🐙', '🦄', '🍕', '🔥', '⚡', '🌚', '🎧', '🏀'];

  var S = {
    stage: 'loading',        // loading | auth | join | app | fatal
    session: null,
    userId: null,
    email: '',
    authMode: 'login',       // login | register
    profile: null,
    view: 'today',           // today (вопрос) | fill (слово) | horo | archive | profile
    kind: 'question',        // какая игра сейчас на экране: question или fill
    archiveKind: 'question', // какая игра выбрана в архиве
    board: { week: null, all: null }, // рейтинг «Сектора»
    boardPeriod: 'week',
    gameState: null,         // start | play | over, пока открыта вкладка «Игра»
    horoOpen: {},            // какие категории гороскопа раскрыты (сначала все закрыты)
    members: [],             // все участники
    stats: [],               // серии и счётчики по участникам
    group: null,             // общая статистика компании
    openComments: {},        // у каких ответов раскрыты комментарии
    commentDrafts: {},       // недописанные комментарии
    channel: null,           // подписка на мгновенные обновления
    pending: false,
    stale: false,
    fatal: '',
    loadSeq: 0,
    refreshing: false,
    timer: null
  };

  // Данные каждой игры хранятся отдельно. S.today, S.answers и т. д. указывают на данные игры, открытой сейчас (S.kind).
  function blankGame() {
    return { today: null, answers: [], who: [], reactions: [], comments: [], commentReactions: [], editing: false, draft: '', archive: null };
  }
  S.kd = { question: blankGame(), fill: blankGame() };
  ['today', 'answers', 'who', 'reactions', 'comments', 'commentReactions', 'editing', 'draft', 'archive'].forEach(function (k) {
    Object.defineProperty(S, k, {
      get: function () { return S.kd[S.kind][k]; },
      set: function (v) { S.kd[S.kind][k] = v; }
    });
  });
  var GAME_RPC = { question: 'ensure_today_question', fill: 'ensure_today_fill' };

  // Фраза с пропуском: «до ___ после». Ответ подставляется на место пропуска и подсвечивается.
  function fillSentence(prompt, answer, cls, blankId) {
    var parts = String(prompt || '').split('___');
    var mark = el('mark', { class: 'fill-ans' + (answer ? '' : ' empty'), id: blankId || null, text: answer || '______' });
    return el('p', { class: cls || 'ans-body' }, [parts[0] || '', mark, parts.slice(1).join('___')]);
  }
  // Текст ответа: для вопроса как есть, для «Слова» — вставленным во фразу дня.
  function answerBody(text, kind, prompt) {
    return kind === 'fill' ? fillSentence(prompt, text) : el('p', { class: 'ans-body', text: text });
  }

  /* ---------- маленькие помощники ---------- */

  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      });
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function safeColor(c) {
    return /^#[0-9A-Fa-f]{6}$/.test(c || '') ? c : PALETTE[0];
  }

  function avatar(name, color, small, emoji) {
    var first = Array.from(String(name || '?'))[0] || '?';
    var a = el('span', { class: 'avatar' + (small ? ' sm' : '') + (emoji ? ' emoji' : ''), 'aria-hidden': 'true', text: emoji || first.toUpperCase() });
    a.style.setProperty('--c', safeColor(color));
    return a;
  }

  function parseDay(s) {
    var p = String(s).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  var fmtLong = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  var fmtTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
  function dayLabel(day) { return fmtLong.format(parseDay(day)); }
  function timeLabel(iso) { try { return fmtTime.format(new Date(iso)); } catch (e) { return ''; } }

  function describeError(e) {
    var raw = (e && (e.message || e.error_description || e.details)) || String(e || '');
    var m = raw.toLowerCase();
    var text;
    if (m.indexOf('bad_code') >= 0) text = 'Код приглашения не подошёл. Проверь его и попробуй ещё раз.';
    else if (m.indexOf('bad_name') >= 0) text = 'Введи имя, под которым тебя увидят друзья.';
    else if (m.indexOf('not_member') >= 0) text = 'Сначала нужно ввести код приглашения.';
    else if (m.indexOf('invalid login credentials') >= 0) text = 'Почта или пароль не подошли.';
    else if (m.indexOf('already registered') >= 0) text = 'Эта почта уже зарегистрирована. Открой вкладку «Вход».';
    else if (m.indexOf('password should be') >= 0 || m.indexOf('weak') >= 0) text = 'Пароль слишком простой. Нужно хотя бы 8 символов.';
    else if (m.indexOf('valid email') >= 0 || m.indexOf('invalid email') >= 0) text = 'Проверь адрес почты.';
    else if (m.indexOf('email not confirmed') >= 0) text = 'Почта не подтверждена. Владельцу сайта нужно выключить подтверждение почты в Supabase.';
    else if (m.indexOf('rate limit') >= 0 || m.indexOf('too many') >= 0) text = 'Слишком много попыток. Подожди немного и повтори.';
    else if (m.indexOf('signups not allowed') >= 0) text = 'Регистрация выключена в настройках Supabase.';
    else if (m.indexOf('row-level security') >= 0) text = 'Ответить можно только на вопрос за сегодня.';
    else if (m.indexOf('failed to fetch') >= 0 || m.indexOf('networkerror') >= 0 || m.indexOf('load failed') >= 0) text = 'Нет связи с сервером. Проверь интернет.';
    else if (m.indexOf('schema cache') >= 0 || m.indexOf('could not find the') >= 0 || m.indexOf('does not exist') >= 0 || m.indexOf('permission denied') >= 0) text = 'База данных ещё не настроена. Запусти файл schema.sql в Supabase.';
    else text = 'Что-то пошло не так.';
    return { text: text, raw: raw };
  }

  function showMsg(node, kind, text, raw) {
    node.className = 'msg' + (kind ? ' ' + kind : '');
    node.textContent = text || '';
    if (raw && kind === 'err' && raw !== text) node.appendChild(el('small', { text: raw }));
  }
  function showError(node, e) {
    var d = describeError(e);
    showMsg(node, 'err', d.text, d.raw);
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  // Человек печатает в поле внутри этого блока? Тогда блок не перерисовываем, чтобы не сбить текст.
  function typingIn(node) {
    var a = document.activeElement;
    return !!(node && a && node.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'));
  }

  /* Заглавная буква в начале поля и каждой новой строки — только в момент набора.
     Если человек стёр заглавную и напечатал строчную, она так и останется. */
  function isLower(c) { return c !== c.toUpperCase() && c === c.toLowerCase(); }
  function isUpper(c) { return c !== c.toLowerCase() && c === c.toUpperCase(); }
  function atLineStart(v, i) { return v.slice(v.lastIndexOf('\n', i - 1) + 1, i).trim() === ''; }
  function capAt(t, i) {
    var v = t.value, c = v.charAt(i);
    if (!c || !isLower(c) || c.toUpperCase().length !== 1 || !atLineStart(v, i)) return false;
    var s0 = t.selectionStart, e0 = t.selectionEnd;
    t.value = v.slice(0, i) + c.toUpperCase() + v.slice(i + 1);
    try { t.setSelectionRange(s0, e0); } catch (x) { /* ignore */ }
    return true;
  }
  function autoCap(t, ev) {
    var it = (ev && ev.inputType) || '';
    var pv = t._pv, v = t.value;
    if (it.indexOf('delete') === 0) {
      if (pv !== undefined && pv.length - v.length === 1) {
        var k = 0;
        while (k < v.length && pv.charAt(k) === v.charAt(k)) k++;
        if (isUpper(pv.charAt(k)) && atLineStart(pv, k)) t._noCap = true;
      }
      return;
    }
    if (ev && ev.isComposing) return;
    if (it.indexOf('insert') !== 0) return;
    if (t._noCap) { t._noCap = false; return; }
    if (it === 'insertText' && ev.data) capAt(t, t.selectionStart - ev.data.length);
  }

  // Блок занят: человек пишет текст в нём или в нём открыто окно реакций. Пустое поле с курсором не считается.
  function busy(node) {
    var typing = typingIn(node) && document.activeElement.value !== '';
    return typing || !!(openPicker && node && node.querySelector('.picker, .menu'));
  }

  // Перерисовать блок и вернуть курсор в то же поле, если он там был.
  function keepFocus(node, fn) {
    var a = document.activeElement, id = null, s0 = null, e0 = null;
    if (node && a && node.contains(a) && a.id) {
      id = a.id;
      try { s0 = a.selectionStart; e0 = a.selectionEnd; } catch (x) { /* не текстовое поле */ }
    }
    fn();
    if (!id) return;
    var n = document.getElementById(id);
    if (!n) return;
    n.focus();
    try { if (s0 !== null) n.setSelectionRange(s0, e0); } catch (x) { /* ignore */ }
  }

  // Догоняем обновление, отложенное пока человек был занят.
  function flushStale() {
    if (!S.stale) return;
    setTimeout(function () {
      var f = document.getElementById('friends'), a = document.getElementById('answer-sect');
      if (busy(f) || busy(a)) return;
      S.stale = false;
      if (f) keepFocus(f, function () { fillFriends(f); });
      if (a && myAnswer() && !S.editing) keepFocus(a, function () { fillAnswer(a); });
    }, 150);
  }

  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // Иконки для нижней панели (статичная разметка, без пользовательских данных).
  var ICONS = {
    today: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
    archive: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    horo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.4 5.6 6 .6-4.6 4 1.4 5.9L12 16l-5.2 3.1 1.4-5.9-4.6-4 6-.6z"/></svg>',
    fill: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18h6M14 18h6"/><path d="M15.5 4.5l3 3L10 16l-4 1 1-4z"/></svg>',
    game: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 12l4.5-4.5"/><path d="M12 3.5a8.5 8.5 0 0 1 7.4 4.3"/></svg>',
    stats: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20v-8M12 20V5M19 20v-5"/></svg>',
    profile: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.6-4 4.6-6 8-6s6.4 2 8 6"/></svg>',
    // серый контурный смайлик с плюсом — кнопка «поставить реакцию»
    react: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="13" r="7"/><path d="M7.3 14.6c.7.9 1.6 1.4 2.7 1.4s2-.5 2.7-1.4"/><path d="M7.8 11h.01M12.2 11h.01"/><path d="M20 3v5M17.5 5.5h5"/></svg>'
  };
  function icon(name) { var i = el('span', { class: 'ico' }); i.innerHTML = ICONS[name]; return i; }

  // Двойной тап (или двойной клик мышью) по карточке. Кнопки, поля и комментарии не считаются.
  function onDoubleTap(node, fn) {
    var last = 0, lx = 0, ly = 0, fired = 0;
    function ignore(t) { return t && t.closest && t.closest('button, a, input, textarea, form, .picker, .comments, .act-row'); }
    function fire() {
      var now = Date.now();
      if (now - fired < 450) return;
      fired = now;
      try { window.getSelection().removeAllRanges(); } catch (e) { /* ignore */ }
      fn();
    }
    node.addEventListener('dblclick', function (ev) { if (!ignore(ev.target)) { ev.preventDefault(); fire(); } });
    node.addEventListener('pointerup', function (ev) {
      if (ev.pointerType !== 'touch' || ignore(ev.target)) return;
      var now = Date.now();
      if (now - last < 320 && Math.abs(ev.clientX - lx) < 30 && Math.abs(ev.clientY - ly) < 30) { last = 0; fire(); }
      else { last = now; lx = ev.clientX; ly = ev.clientY; }
    });
  }

  // Большое сердце посреди карточки, как в Instagram.
  function heartBurst(node) {
    if (reduceMotion) return;
    var h = el('span', { class: 'burst', 'aria-hidden': 'true', text: '❤️' });
    node.appendChild(h);
    setTimeout(function () { h.remove(); }, 850);
  }

  // Конфетти на холсте: несколько десятков бумажек падают около полутора секунд.
  function confetti(canvas, count) {
    if (reduceMotion || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width = window.innerWidth, H = canvas.height = window.innerHeight;
    var colors = ['#F2782C', '#FFB347', '#F5F2EF', '#FF6A3D', '#FFD54A'];
    var parts = [];
    for (var i = 0; i < count; i++) {
      parts.push({ x: W / 2 + (Math.random() - 0.5) * 120, y: H * 0.35, vx: (Math.random() - 0.5) * 11, vy: -Math.random() * 11 - 4,
        w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, c: colors[i % colors.length] });
    }
    var start = performance.now();
    (function frame(t) {
      var k = (t - start) / 1600;
      ctx.clearRect(0, 0, W, H);
      if (k >= 1 || !canvas.isConnected) return;
      ctx.globalAlpha = Math.max(0, 1 - k * k);
      parts.forEach(function (p) {
        p.vy += 0.32; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      });
      requestAnimationFrame(frame);
    })(start);
  }

  // Экран-празднование после ответа: подтверждение, серия и путь к ответам друзей.
  function showCelebration() {
    var st = myStats();
    var n = st ? st.current_streak : 0;
    var milestone = { 3: 'Три дня подряд!', 7: 'Неделя подряд!', 30: 'Месяц подряд!', 100: 'Сто дней подряд!' }[n];
    var others = S.answers.filter(function (a) { return a.user_id !== S.userId; }).length;
    var canvas = el('canvas', { class: 'confetti', 'aria-hidden': 'true' });
    var btn = el('button', { type: 'button', class: 'btn primary', text: others ? 'Смотреть, что ответили друзья' : 'Готово' });
    var overlay = el('div', { class: 'celebrate' + (milestone ? ' big' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cel-title' }, [
      canvas,
      el('div', { class: 'cel-card' }, [
        el('div', { class: 'cel-emoji', 'aria-hidden': 'true', text: milestone ? '🏆' : '✨' }),
        el('h2', { id: 'cel-title', class: 'cel-title', text: milestone || (S.kind === 'fill' ? 'Вписано!' : 'Ответ принят!') }),
        n ? el('p', { class: 'cel-streak', text: '🔥 Серия: ' + n + ' ' + plural(n, 'день', 'дня', 'дней') + ' подряд' }) : null,
        el('p', { class: 'muted', text: others
          ? 'Ответы друзей открыты: ' + others + ' ' + plural(others, 'ответ', 'ответа', 'ответов') + '.'
          : 'Ты ответил первым. Ответы друзей появятся, как только они ответят.' }),
        btn
      ])
    ]);
    function onKey(ev) { if (ev.key === 'Escape') close(); }
    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      var f = document.getElementById('friends');
      if (f && others) f.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }
    btn.addEventListener('click', close);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay || ev.target === canvas) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    btn.focus();
    confetti(canvas, milestone ? 160 : 80);
  }

  function firstRow(data) { return Array.isArray(data) ? data[0] : data; }
  function mapQ(row) { return { day: row.q_day, id: row.q_id, category: row.q_category, text: row.q_text }; }
  function myAnswer() {
    for (var i = 0; i < S.answers.length; i++) if (S.answers[i].user_id === S.userId) return S.answers[i];
    return null;
  }
  function profileOf(a) { return a.profiles || {}; }

  /* ---------- реакции ---------- */

  function memberName(id) {
    if (id === S.userId) return 'ты';
    for (var i = 0; i < S.members.length; i++) if (S.members[i].id === id) return S.members[i].display_name;
    return 'кто-то';
  }

  // Кто какую реакцию поставил: { laugh: [id, id], fire: [...] }. field — answer_id или comment_id.
  function groupReactions(targetId, list, field) {
    field = field || 'answer_id';
    var g = {};
    list.forEach(function (r) {
      if (r[field] !== targetId) return;
      (g[r.emoji] = g[r.emoji] || []).push(r.user_id);
    });
    return g;
  }

  // Маленькие аватарки тех, кто поставил реакцию: до трёх, остальные — «+N».
  function avatarStack(userIds) {
    var box = el('span', { class: 'astack', 'aria-hidden': 'true' });
    userIds.slice(0, 3).forEach(function (id) {
      var m = id === S.userId && S.profile
        ? { name: S.profile.display_name, color: S.profile.color, avatar: S.profile.avatar }
        : memberOf(id);
      box.appendChild(avatar(m.name, m.color, true, m.avatar));
    });
    if (userIds.length > 3) box.appendChild(el('span', { class: 'more-n', text: '+' + (userIds.length - 3) }));
    return box;
  }

  // Открытое окно выбора реакций (одно на странице). Хранит функцию, которая его закрывает.
  var openPicker = null;
  function closePicker() {
    if (!openPicker) return;
    var close = openPicker;
    openPicker = null;
    close();
  }

  // Реакции под чужим ответом или комментарием: уже поставленные реакции и кнопка 🙂+ с окном выбора.
  // list — общий массив реакций, он меняется на месте. Один человек — одна реакция.
  function reactionBar(targetId, list, kind) {
    var field = kind === 'comment' ? 'comment_id' : 'answer_id';
    var table = kind === 'comment' ? 'comment_reactions' : 'reactions';
    var box = el('div', { class: 'reacts' + (kind === 'comment' ? ' small' : ''), role: 'group', 'aria-label': 'Реакции' });
    var open = false, full = false;
    function myCode() {
      for (var i = 0; i < list.length; i++) if (list[i][field] === targetId && list[i].user_id === S.userId) return list[i].emoji;
      return null;
    }
    function draw() {
      var g = groupReactions(targetId, list, field);
      var my = myCode();
      box.replaceChildren();
      REACTIONS.forEach(function (rc) {
        var users = g[rc[0]] || [];
        if (!users.length) return;
        var mine = my === rc[0];
        var names = users.map(memberName).join(', ');
        box.appendChild(el('button', {
          type: 'button', class: 'react', 'data-code': rc[0], 'aria-pressed': String(mine), title: names,
          'aria-label': rc[2] + ': ' + users.length + ', ' + names + (mine ? '. Нажми, чтобы убрать' : ''),
          onclick: function (ev) { ev.stopPropagation(); closePicker(); set(mine ? null : rc[0]); }
        }, [el('span', { class: 'emo', 'aria-hidden': 'true', text: rc[1] }), avatarStack(users)]));
      });
      var label = my ? 'Сменить реакцию' : 'Поставить реакцию';
      box.appendChild(el('button', {
        type: 'button', class: 'react add', 'aria-haspopup': 'true', 'aria-expanded': String(open), 'aria-label': label, title: label,
        onclick: function (ev) { ev.stopPropagation(); if (open) closePicker(); else openIt(); }
      }, [icon('react')]));
      if (open) {
        // Сначала 6 реакций, которые в компании ставят чаще всего; остальные — по кнопке «ещё».
        var shown = full ? REACTIONS : quickReactions();
        var picks = shown.map(function (rc) {
          return el('button', {
            type: 'button', class: 'pick', 'aria-pressed': String(my === rc[0]), 'aria-label': rc[2], title: rc[2],
            onclick: function (ev) { ev.stopPropagation(); closePicker(); set(my === rc[0] ? null : rc[0]); }
          }, [rc[1]]);
        });
        if (!full) {
          picks.push(el('button', {
            type: 'button', class: 'pick more', 'aria-label': 'Все реакции', title: 'Все реакции', text: '•••',
            onclick: function (ev) { ev.stopPropagation(); full = true; draw(); var f = box.querySelector('.pick'); if (f) f.focus(); }
          }));
        }
        var pop = el('div', { class: 'picker' + (full ? ' full' : ''), role: 'group', 'aria-label': 'Выбери реакцию' }, picks);
        box.appendChild(pop);
        // Если внизу не хватает места (там нижняя панель), открываем окно вверх.
        var nav = document.querySelector('.bottom-nav');
        var navH = nav ? nav.getBoundingClientRect().height : 0;
        var limit = window.innerHeight - navH - 8;
        if (pop.getBoundingClientRect().bottom > limit) pop.classList.add('up');
      }
    }
    function openIt() {
      closePicker();
      open = true; full = false;
      openPicker = function () { open = false; full = false; draw(); flushStale(); };
      draw();
      var f = box.querySelector('.pick'); if (f) f.focus();
    }
    async function set(code) {
      var before = list.filter(function (r) { return r[field] === targetId && r.user_id === S.userId; });
      function dropMine() {
        for (var i = list.length - 1; i >= 0; i--) {
          if (list[i][field] === targetId && list[i].user_id === S.userId) list.splice(i, 1);
        }
      }
      dropMine();
      var row = { user_id: S.userId, emoji: code };
      row[field] = targetId;
      if (code) list.push(row);
      draw();
      if (code) animate(code);
      try {
        var r = code
          ? await sb.from(table).upsert(row, { onConflict: field + ',user_id' })
          : await sb.from(table).delete().eq(field, targetId).eq('user_id', S.userId);
        if (r.error) throw r.error;
      } catch (e) {
        dropMine();
        before.forEach(function (x) { list.push(x); });
        draw();
      }
    }
    // Эмодзи «вылетает» из пилюли, счётчик подпрыгивает, на Android — короткая вибрация.
    function animate(code) {
      try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) { /* не поддерживается */ }
      if (reduceMotion) return;
      var b = box.querySelector('.react[data-code="' + code + '"]');
      var info = REACTIONS.filter(function (rc) { return rc[0] === code; })[0];
      if (!b || !info) return;
      b.classList.add('bump');
    }
    // Быстрая реакция (двойной тап): ставит её, если сейчас стоит другая или никакой.
    box.quick = function (code) { if (myCode() !== code) set(code); else animate(code); };
    draw();
    return box;
  }

  // Шесть реакций для короткого ряда: самые частые в компании, затем популярные по умолчанию.
  function quickReactions() {
    var counts = {};
    S.reactions.concat(S.commentReactions).forEach(function (r) { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
    var order = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })
      .concat(['heart', 'laugh', 'fire', 'skull', 'cry', 'wow']);
    var out = [];
    order.forEach(function (code) {
      if (out.length >= 6 || out.some(function (rc) { return rc[0] === code; })) return;
      var rc = REACTIONS.filter(function (x) { return x[0] === code; })[0];
      if (rc) out.push(rc);
    });
    return out;
  }

  // Реакции на мой комментарий: просто показываем, кнопок нет.
  function reactionSummary(targetId, list, field) {
    var g = groupReactions(targetId, list, field);
    var parts = REACTIONS.filter(function (rc) { return g[rc[0]] && g[rc[0]].length; });
    if (!parts.length) return null;
    return el('div', { class: 'reacts small' }, parts.map(function (rc) {
      var names = g[rc[0]].map(memberName).join(', ');
      return el('span', { class: 'react static', title: names, 'aria-label': rc[2] + ': ' + names }, [
        el('span', { class: 'emo', 'aria-hidden': 'true', text: rc[1] }), avatarStack(g[rc[0]])
      ]);
    }));
  }

  /* ---------- комментарии ---------- */

  function memberOf(id) {
    for (var i = 0; i < S.members.length; i++) if (S.members[i].id === id) return { name: S.members[i].display_name, color: S.members[i].color, avatar: S.members[i].avatar };
    return { name: 'Кто-то', color: PALETTE[7] };
  }

  var CMT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 1 3.4 6.3L4 19.5l1.2-3.6A7.4 7.4 0 0 1 4.5 12z"/></svg>';
  var SEND_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>';

  // Строка под ответом: слева реакции, справа иконка комментариев со счётчиком.
  function actionsRow(bar, cb) {
    return el('div', { class: 'act-row' }, [bar || el('span', { class: 'act-spacer' }), cb.toggle]);
  }

  // Комментарии под ответом. list — общий массив комментариев, он меняется на месте.
  // Возвращает блок комментариев; кнопка-иконка для строки действий лежит в wrap.toggle.
  // ownAnswer — это мой ответ: новый комментарий начать нельзя, можно только ответить на чужой.
  function commentBlock(answerId, list, creacts, ownAnswer) {
    var wrap = el('div', { class: 'comments' });
    S.cmtReply = S.cmtReply || {};
    var toggle = el('button', { type: 'button', class: 'cmt-btn' });
    wrap.toggle = toggle;
    var menuFor = null, confirmFor = null;

    function setOpen(v) {
      S.openComments[answerId] = v;
      if (!v) S.cmtReply[answerId] = false;
      draw();
      if (v) { var i = wrap.querySelector('input'); if (i) i.focus(); }
    }
    toggle.addEventListener('click', function (ev) { ev.stopPropagation(); setOpen(!S.openComments[answerId]); });

    function closeMenu() { menuFor = null; confirmFor = null; draw(); flushStale(); }
    function openMenu(id) {
      closePicker();
      menuFor = id; confirmFor = null;
      openPicker = closeMenu;
      draw();
      var f = wrap.querySelector('.menu button'); if (f) f.focus();
    }

    function draw() {
      var items = list.filter(function (c) { return c.answer_id === answerId; });
      var open = !!S.openComments[answerId];
      toggle.innerHTML = CMT_ICON;
      if (items.length) toggle.appendChild(el('span', { class: 'cmt-n', text: String(items.length) }));
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', items.length ? 'Комментарии: ' + items.length : 'Написать комментарий');
      toggle.setAttribute('title', open ? 'Свернуть комментарии' : (items.length ? 'Комментарии' : 'Написать комментарий'));
      // На своём ответе без комментариев делать нечего — иконку прячем.
      toggle.hidden = !!ownAnswer && !items.length;
      wrap.replaceChildren();
      if (!open) {
        // Превью последнего комментария одной строкой.
        var last = items[items.length - 1];
        if (last) {
          var lm = memberOf(last.user_id);
          wrap.appendChild(el('button', { type: 'button', class: 'cmt-preview', onclick: function (ev) { ev.stopPropagation(); setOpen(true); } }, [
            el('span', { class: 'cmt-pname', text: (last.user_id === S.userId ? 'Ты' : lm.name) + ': ' }),
            el('span', { text: last.body })
          ]));
        }
        return;
      }
      if (items.length) {
        wrap.appendChild(el('ul', { class: 'cmt-list' }, items.map(function (c) {
          var m = memberOf(c.user_id);
          var mine = c.user_id === S.userId;
          var main = el('div', { class: 'cmt-main', tabindex: '0', role: 'button', 'aria-haspopup': 'menu', title: 'Нажми, чтобы открыть действия' }, [
            el('div', { class: 'cmt-head' }, [
              el('span', { class: 'cmt-name', text: mine ? 'Ты' : m.name }),
              el('span', { class: 'cmt-time', text: timeLabel(c.created_at) })
            ]),
            el('p', { class: 'cmt-body', text: c.body })
          ]);
          function tap(ev) {
            if (ev.target.closest('.reacts, .menu, button')) return;
            if (window.getSelection && String(window.getSelection())) return;
            ev.stopPropagation();
            if (menuFor === c.id) closePicker(); else openMenu(c.id);
          }
          main.addEventListener('click', tap);
          main.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); tap(ev); } });
          var anchor = el('div', { class: 'menu-anchor' });
          if (menuFor === c.id) anchor.appendChild(commentMenu(c, m, mine));
          return el('li', { class: 'cmt' }, [
            avatar(m.name, m.color, true, m.avatar),
            el('div', { class: 'cmt-col' }, [
              main,
              anchor,
              mine ? reactionSummary(c.id, creacts, 'comment_id') : reactionBar(c.id, creacts, 'comment')
            ])
          ]);
        })));
      }
      if (ownAnswer && !S.cmtReply[answerId]) return;
      var input = el('input', { type: 'text', id: 'cmt-' + answerId, maxlength: 500, autocomplete: 'off', autocapitalize: 'off', 'data-cap': '1', 'aria-label': 'Комментарий', placeholder: 'Написать комментарий…', enterkeyhint: 'send' });
      input.value = S.commentDrafts[answerId] || '';
      var msg = el('p', { class: 'msg', role: 'status' });
      var btn = el('button', { type: 'submit', class: 'send', 'aria-label': 'Отправить', title: 'Отправить' });
      btn.innerHTML = SEND_ICON;
      function sync() { S.commentDrafts[answerId] = input.value; btn.disabled = !input.value.trim(); }
      input.addEventListener('input', sync);
      sync();
      wrap.appendChild(el('form', {
        class: 'cmt-form',
        onsubmit: async function (ev) {
          ev.preventDefault();
          var t = input.value.trim();
          if (!t) return;
          btn.disabled = true;
          try {
            var r = await sb.from('comments').insert({ answer_id: answerId, user_id: S.userId, body: t }).select('id, answer_id, user_id, body, created_at').single();
            if (r.error) throw r.error;
            if (!list.some(function (c) { return c.id === r.data.id; })) list.push(r.data);
            S.commentDrafts[answerId] = '';
            // Отправил — комментарии сворачиваются, под ответом остаётся превью.
            if (document.activeElement) document.activeElement.blur();
            setOpen(false);
          } catch (e) {
            btn.disabled = false;
            showError(msg, e);
          }
        }
      }, [input, btn]));
      wrap.appendChild(msg);
    }

    function commentMenu(c, m, mine) {
      if (confirmFor === c.id) {
        return el('div', { class: 'menu confirm', role: 'alertdialog', 'aria-label': 'Удалить комментарий?' }, [
          el('p', { class: 'menu-q', text: 'Удалить комментарий?' }),
          el('div', { class: 'row' }, [
            el('button', { type: 'button', class: 'btn danger', text: 'Удалить', onclick: function (ev) { ev.stopPropagation(); closePicker(); remove(c); } }),
            el('button', { type: 'button', class: 'btn', text: 'Отмена', onclick: function (ev) { ev.stopPropagation(); closePicker(); } })
          ])
        ]);
      }
      var items = [
        menuItem('📋', 'Скопировать', async function () { closePicker(); toast((await copyText(c.body)) ? 'Скопировано' : 'Не получилось скопировать'); })
      ];
      if (mine) {
        items.push(menuItem('🗑', 'Удалить', function () { confirmFor = c.id; draw(); var f = wrap.querySelector('.menu button'); if (f) f.focus(); }, 'danger'));
      } else {
        items.push(menuItem('↩️', 'Ответить', function () {
          var tag = '@' + m.name + ' ';
          var cur = S.commentDrafts[answerId] || '';
          if (cur.indexOf(tag) !== 0) S.commentDrafts[answerId] = tag + cur.replace(/^@\S+\s/, '');
          S.cmtReply[answerId] = true;
          closePicker(); // перерисует блок уже с полем ввода
          var i = wrap.querySelector('input');
          if (!i) return;
          i.focus();
          i.setSelectionRange(i.value.length, i.value.length);
        }));
      }
      return el('div', { class: 'menu', role: 'menu', 'aria-label': 'Действия с комментарием' }, [
        el('p', { class: 'menu-meta', text: (mine ? 'Твой комментарий' : m.name) + ' · ' + timeLabel(c.created_at) })
      ].concat(items));
    }

    async function remove(c) {
      var idx = list.indexOf(c);
      if (idx >= 0) list.splice(idx, 1);
      draw();
      try {
        var r = await sb.from('comments').delete().eq('id', c.id);
        if (r.error) throw r.error;
        toast('Комментарий удалён');
      } catch (e) {
        list.push(c);
        list.sort(function (x, y) { return String(x.created_at).localeCompare(String(y.created_at)); });
        draw();
      }
    }
    draw();
    return wrap;
  }

  // Какие реакции получил мой ответ: те же маленькие пилюли «эмодзи + аватарки», без кнопок.
  function receivedReactions(answerId, list) {
    return reactionSummary(answerId, list, 'answer_id');
  }

  /* ---------- знаки зодиака и гороскоп ---------- */

  // Код знака, символ, название, даты. ︎ — показать символ как текст, а не как цветной эмодзи.
  var ZODIAC = [
    ['aries', '♈', 'Овен', '21.03–19.04'], ['taurus', '♉', 'Телец', '20.04–20.05'],
    ['gemini', '♊', 'Близнецы', '21.05–20.06'], ['cancer', '♋', 'Рак', '21.06–22.07'],
    ['leo', '♌', 'Лев', '23.07–22.08'], ['virgo', '♍', 'Дева', '23.08–22.09'],
    ['libra', '♎', 'Весы', '23.09–22.10'], ['scorpio', '♏', 'Скорпион', '23.10–21.11'],
    ['sagittarius', '♐', 'Стрелец', '22.11–21.12'], ['capricorn', '♑', 'Козерог', '22.12–19.01'],
    ['aquarius', '♒', 'Водолей', '20.01–18.02'], ['pisces', '♓', 'Рыбы', '19.02–20.03']
  ];
  function zodiacOf(code) { return ZODIAC.filter(function (z) { return z[0] === code; })[0] || null; }
  function glyph(z) { return z[1] + '︎'; }

  // Упрощённые созвездия: точки в квадрате 100×100, соединённые линиями (собственная стилизация).
  var STARS = {
    aries: [[[14, 58], [38, 44], [62, 40], [84, 52]]],
    taurus: [[[12, 18], [36, 44], [50, 56], [62, 44], [88, 20]], [[50, 56], [46, 74], [40, 88]]],
    gemini: [[[24, 12], [26, 40], [22, 66], [18, 88]], [[64, 12], [66, 40], [70, 66], [76, 88]], [[26, 40], [66, 40]]],
    cancer: [[[50, 14], [50, 46], [22, 82]], [[50, 46], [80, 80]]],
    leo: [[[20, 34], [32, 18], [50, 20], [56, 36], [44, 48], [60, 70], [84, 76], [80, 52], [56, 36]]],
    virgo: [[[14, 20], [30, 34], [46, 30], [56, 48], [48, 70], [30, 86]], [[56, 48], [76, 54], [88, 76]]],
    libra: [[[16, 62], [34, 30], [66, 30], [84, 62]], [[34, 30], [50, 14], [66, 30]], [[16, 62], [24, 82]]],
    scorpio: [[[10, 24], [22, 30], [34, 34], [44, 46], [48, 62], [56, 76], [70, 82], [84, 74], [88, 60]], [[22, 30], [18, 14]]],
    sagittarius: [[[18, 76], [34, 60], [50, 52], [66, 36], [84, 18]], [[50, 52], [56, 72], [40, 84]], [[66, 36], [76, 50]]],
    capricorn: [[[14, 30], [30, 60], [52, 80], [86, 46], [62, 34], [14, 30]]],
    aquarius: [[[10, 38], [24, 30], [38, 40], [52, 30], [66, 40], [80, 30], [92, 40]], [[24, 62], [40, 70], [56, 62], [72, 70]]],
    pisces: [[[12, 18], [24, 34], [36, 52], [52, 70], [70, 60], [88, 66]], [[52, 70], [46, 88]]]
  };

  var SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }
  // Картинка знака: тёмный квадрат, россыпь мелких звёзд и созвездие светящимися линиями.
  function constellation(code, size) {
    var svg = svgEl('svg', { viewBox: '0 0 100 100', width: size, height: size, class: 'const', 'aria-hidden': 'true' });
    var gid = 'g' + code + Math.random().toString(36).slice(2, 7);
    var defs = svgEl('defs', {});
    var grad = svgEl('radialGradient', { id: gid, cx: '50%', cy: '40%', r: '75%' });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#3A2416' }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#121212' }));
    defs.appendChild(grad);
    svg.appendChild(defs);
    svg.appendChild(svgEl('rect', { x: 0, y: 0, width: 100, height: 100, rx: 14, fill: 'url(#' + gid + ')' }));
    // фоновые звёзды — всегда одинаковые для знака
    var h = hash32(code + '|sky');
    for (var i = 0; i < 26; i++) {
      h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
      var x = h % 100; h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
      var y = h % 100; h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
      svg.appendChild(svgEl('circle', { cx: x, cy: y, r: (h % 3 === 0) ? 0.7 : 0.4, fill: '#E8E6E3', opacity: 0.35 + (h % 40) / 100 }));
    }
    (STARS[code] || []).forEach(function (line) {
      var pts = line.map(function (pt) { return pt.join(','); }).join(' ');
      svg.appendChild(svgEl('polyline', { points: pts, fill: 'none', stroke: '#F2782C', 'stroke-opacity': 0.35, 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      svg.appendChild(svgEl('polyline', { points: pts, fill: 'none', stroke: '#FFC08A', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      line.forEach(function (pt) {
        svg.appendChild(svgEl('circle', { cx: pt[0], cy: pt[1], r: 3.4, fill: '#F2782C', opacity: 0.35 }));
        svg.appendChild(svgEl('circle', { cx: pt[0], cy: pt[1], r: 1.8, fill: '#FFF4E8' }));
      });
    });
    return svg;
  }

  // Простой хэш строки (FNV-1a): по знаку и дате всегда получается одно и то же число.
  function hash32(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  var HORO_CATS = [
    ['love', 'Любовь', '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>'],
    ['work', 'Работа и учёба', '<rect x="3.5" y="7.5" width="17" height="12" rx="2.5"/><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3.5 13h17"/>'],
    ['money', 'Финансы', '<rect x="3.5" y="6" width="17" height="13" rx="2.5"/><path d="M3.5 10h12a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2h-1M16.5 12h.01"/><path d="M6 6l9-2.5 1.2 2.5"/>'],
    ['mood', 'Настроение', '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 13.8c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2M9 9.5h.01M15 9.5h.01"/>'],
    ['luck', 'Удача', '<circle cx="9" cy="9" r="3.2"/><circle cx="15" cy="9" r="3.2"/><circle cx="9" cy="15" r="3.2"/><circle cx="15" cy="15" r="3.2"/><path d="M15 17.5l3 3"/>']
  ];
  var DAY_COLORS = [
    ['Оранжевый', '#F2782C'], ['Красный', '#E5484D'], ['Розовый', '#E55BA0'], ['Фиолетовый', '#8E5BE8'],
    ['Синий', '#3E7BFA'], ['Голубой', '#4CC3FF'], ['Бирюзовый', '#1FB8A6'], ['Зелёный', '#3DBA5D'],
    ['Мятный', '#7EE0B5'], ['Жёлтый', '#F5C842'], ['Золотой', '#D4A72C'], ['Белый', '#F2F2F2'],
    ['Серебряный', '#B8BEC6'], ['Бордовый', '#9B2C45'], ['Коричневый', '#8B5E3C'], ['Чёрный', '#0A0A0A']
  ];

  function tallinnDay() {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Tallinn', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    } catch (e) { return new Date().toISOString().slice(0, 10); }
  }

  // Гороскоп знака на день: звёзды, текст для каждой категории, счастливое число и цвет.
  function horoscopeFor(code, day) {
    var texts = window.HOROSCOPE_TEXTS || {};
    var cats = HORO_CATS.map(function (c) {
      var v = hash32(code + '|' + day + '|' + c[0] + '|stars') % 100;
      var stars = v < 5 ? 1 : v < 20 ? 2 : v < 50 ? 3 : v < 80 ? 4 : 5;
      var pool = (texts[c[0]] && texts[c[0]][String(stars)]) || [];
      var text = pool.length ? pool[hash32(code + '|' + day + '|' + c[0] + '|text') % pool.length] : '';
      return { key: c[0], title: c[1], icon: c[2], stars: stars, text: text };
    });
    return {
      cats: cats,
      lucky: hash32(code + '|' + day + '|lucky') % 99 + 1,
      color: DAY_COLORS[hash32(code + '|' + day + '|color') % DAY_COLORS.length]
    };
  }

  function catIcon(path) {
    var i = el('span', { class: 'cat-ico', 'aria-hidden': 'true' });
    i.innerHTML = '<svg viewBox="0 0 24 24">' + path + '</svg>';
    return i;
  }

  function starRow(n) {
    var box = el('span', { class: 'stars', 'aria-label': n + ' из 5' });
    for (var i = 1; i <= 5; i++) box.appendChild(el('span', { class: i <= n ? 'on' : 'off', 'aria-hidden': 'true', text: i <= n ? '★' : '☆' }));
    return box;
  }

  // Выбор знака: 12 кнопок с символом, названием и датами.
  function zodiacPicker(current, onPick) {
    var box = el('div', { class: 'zodiacs', role: 'radiogroup', 'aria-label': 'Знак зодиака' });
    ZODIAC.forEach(function (z, i) {
      box.appendChild(el('button', {
        type: 'button', class: 'zod', role: 'radio', 'data-sign': z[0], 'aria-checked': String(current === z[0]),
        onclick: function () {
          onPick(z[0]);
          Array.prototype.forEach.call(box.children, function (x, j) { x.setAttribute('aria-checked', String(j === i)); });
        }
      }, [el('span', { class: 'zod-g', 'aria-hidden': 'true', text: glyph(z) }), el('span', { class: 'zod-n', text: z[2] })]));
    });
    return box;
  }

  var fmtDayYear = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

  function viewHoroscope() {
    var z = zodiacOf(S.profile.zodiac);
    if (!z) {
      return [el('section', { class: 'card horo-empty' }, [
        el('div', { class: 'horo-empty-art', 'aria-hidden': 'true', text: '✨' }),
        el('h2', { class: 'horo-empty-title', text: 'Укажи свой знак зодиака' }),
        el('p', { class: 'muted', text: 'Гороскоп откроется, как только ты выберешь знак в профиле. Это займёт пару секунд.' }),
        el('button', { type: 'button', class: 'btn primary', text: 'Выбрать знак', onclick: function () {
          go('profile');
          setTimeout(function () { var p = document.getElementById('zodiac-field'); if (p) p.scrollIntoView({ block: 'center' }); }, 50);
        } })
      ])];
    }
    var day = (S.today && S.today.day) || tallinnDay();
    var h = horoscopeFor(z[0], day);
    var list = el('div', { class: 'horo-list' });
    h.cats.forEach(function (c) {
      var open = !!S.horoOpen[c.key];
      var panel = el('div', { class: 'horo-panel', id: 'horo-' + c.key, 'aria-hidden': String(!open) }, [
        el('div', { class: 'horo-panel-in' }, [el('div', { class: 'horo-text', text: c.text })])
      ]);
      var btn = el('button', {
        type: 'button', class: 'horo-row', 'aria-expanded': String(open), 'aria-controls': 'horo-' + c.key,
        onclick: function () {
          var now = btn.getAttribute('aria-expanded') !== 'true';
          S.horoOpen[c.key] = now;
          btn.setAttribute('aria-expanded', String(now));
          panel.setAttribute('aria-hidden', String(!now));
          item.classList.toggle('open', now);
        }
      }, [catIcon(c.icon), el('span', { class: 'horo-title', text: c.title }), starRow(c.stars), el('span', { class: 'chev', 'aria-hidden': 'true' })]);
      var item = el('div', { class: 'horo-item' + (open ? ' open' : '') }, [btn, panel]);
      list.appendChild(item);
    });
    var sw = el('span', { class: 'color-dot', 'aria-hidden': 'true' });
    sw.style.background = h.color[1];
    return [el('section', { class: 'card horo' }, [
      el('div', { class: 'horo-head' }, [
        constellation(z[0], 92),
        el('div', { class: 'horo-head-text' }, [
          el('span', { class: 'horo-date', text: fmtDayYear.format(parseDay(day)).replace(' г.', '') }),
          el('h2', { class: 'horo-sign' }, [el('span', { class: 'horo-glyph', 'aria-hidden': 'true', text: glyph(z) }), el('span', { text: z[2] })]),
          el('span', { class: 'muted', text: 'Твой гороскоп на сегодня' })
        ])
      ]),
      el('hr', { class: 'divider' }),
      list,
      el('hr', { class: 'divider' }),
      el('div', { class: 'tiles two' }, [
        el('div', { class: 'tile' }, [el('span', { class: 'tile-l', text: 'Счастливое число' }), el('span', { class: 'tile-n big', text: String(h.lucky) })]),
        el('div', { class: 'tile' }, [el('span', { class: 'tile-l', text: 'Цвет дня' }), el('span', { class: 'tile-color' }, [sw, el('span', { text: h.color[0] })])])
      ])
    ])];
  }

  /* ---------- загрузка данных ---------- */

  async function loadUserData() {
    var seq = ++S.loadSeq;
    if (!S.session) { S.stage = 'auth'; render(); return; }
    S.stage = 'loading'; render();
    try {
      var p = await sb.from('profiles').select('id, display_name, color, avatar, zodiac').eq('id', S.userId).maybeSingle();
      if (seq !== S.loadSeq) return;
      if (p.error) throw p.error;
      if (!p.data) { S.profile = null; S.stage = 'join'; render(); return; }
      S.profile = p.data;
      S.kind = 'question';
      await loadToday();
      if (seq !== S.loadSeq) return;
      S.stage = 'app'; S.view = 'today'; S.kind = 'question'; render();
      maybeShowInstallHint();
      startPolling();
    } catch (e) {
      if (seq !== S.loadSeq) return;
      S.stage = 'fatal'; S.fatal = e; render();
    }
  }

  async function loadToday() {
    var k = S.kind;
    var r = await sb.rpc(GAME_RPC[k]);
    if (r.error) throw r.error;
    var row = firstRow(r.data);
    if (!row) throw new Error(k === 'fill' ? 'Фраза на сегодня не найдена' : 'Вопрос на сегодня не найден');
    S.kd[k].today = mapQ(row);
    await loadDay(k);
  }

  async function loadDay(kind) {
    var k = kind || S.kind, G = S.kd[k];
    if (!G.today) return;
    var day = G.today.day;
    var res = await Promise.all([
      sb.from('answers').select('id, user_id, body, created_at, updated_at, profiles!answers_user_id_fkey(display_name, color, avatar)').eq('day', day).eq('kind', k).order('created_at', { ascending: true }),
      sb.rpc('who_answered', { p_day: day, p_kind: k }),
      sb.from('profiles').select('id, display_name, color, avatar, zodiac').order('created_at', { ascending: true }),
      sb.rpc('member_stats')
    ]);
    for (var i = 0; i < 3; i++) if (res[i].error) throw res[i].error;
    var answers = res[0].data || [];
    var extra = await Promise.all([loadReactions(answers), loadComments(answers)]);
    G.answers = answers;
    G.who = res[1].data || [];
    S.members = res[2].data || [];
    var creacts = await loadCommentReactions(extra[1]);
    G.reactions = extra[0];
    G.comments = extra[1];
    G.commentReactions = creacts;
    // Статистика не должна ломать главный экран: если не загрузилась, просто не показываем серию.
    S.stats = res[3].error ? [] : (res[3].data || []);
  }

  async function loadComments(answers) {
    var ids = answers.map(function (a) { return a.id; });
    if (!ids.length) return [];
    var r = await sb.from('comments').select('id, answer_id, user_id, body, created_at').in('answer_id', ids).order('created_at', { ascending: true });
    if (r.error) throw r.error;
    return r.data || [];
  }

  async function loadCommentReactions(comments) {
    var ids = comments.map(function (c) { return c.id; });
    if (!ids.length) return [];
    var r = await sb.from('comment_reactions').select('comment_id, user_id, emoji').in('comment_id', ids);
    if (r.error) throw r.error;
    return r.data || [];
  }

  async function loadGroup() {
    var r = await sb.rpc('group_stats');
    S.group = r.error ? null : firstRow(r.data) || null;
  }

  function myStats() {
    for (var i = 0; i < S.stats.length; i++) if (S.stats[i].user_id === S.userId) return S.stats[i];
    return null;
  }

  async function loadReactions(answers) {
    var ids = answers.map(function (a) { return a.id; });
    if (!ids.length) return [];
    var r = await sb.from('reactions').select('answer_id, user_id, emoji').in('answer_id', ids);
    if (r.error) throw r.error;
    return r.data || [];
  }

  async function loadArchive() {
    var k = S.archiveKind;
    var r = await sb.rpc(k === 'fill' ? 'past_fills' : 'past_questions', { p_limit: 30 });
    if (r.error) throw r.error;
    S.kd[k].archive = r.data || [];
  }

  async function loadStats() {
    var r = await sb.rpc('member_stats');
    if (!r.error) S.stats = r.data || [];
  }

  function startPolling() {
    if (!S.timer) S.timer = setInterval(refreshQuietly, POLL_MS);
    startLive();
  }
  function stopPolling() {
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
    stopLive();
  }

  // Мгновенные обновления: база сама сообщает, что появился ответ, реакция или комментарий.
  // Сообщения приходят только о тех записях, которые этому человеку можно видеть.
  var bumpTimer = null;
  function bump() {
    clearTimeout(bumpTimer);
    bumpTimer = setTimeout(refreshQuietly, 400);
  }
  function startLive() {
    if (S.channel || !sb || typeof sb.channel !== 'function') return;
    try {
      S.channel = sb.channel('live-' + S.userId)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'answers' }, bump)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, bump)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, bump)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'comment_reactions' }, bump)
        .subscribe();
    } catch (e) {
      S.channel = null; /* остаётся опрос раз в минуту */
    }
  }
  function stopLive() {
    if (!S.channel) return;
    try { sb.removeChannel(S.channel); } catch (e) { /* уже закрыт */ }
    S.channel = null;
  }

  function updateStreakChip() {
    var c = document.getElementById('streak-chip');
    if (!c) return;
    var st = myStats();
    var n = st ? st.current_streak : 0;
    c.hidden = !n;
    c.textContent = '🔥 ' + n;
    c.setAttribute('title', 'Серия: ' + n + ' ' + plural(n, 'день', 'дня', 'дней') + ' подряд');
  }

  // Тихое обновление: подтягивает новые ответы и смену дня, не трогая поле, в котором человек печатает.
  async function refreshQuietly() {
    if (S.stage !== 'app' || document.hidden) return;
    if (S.view !== 'today' && S.view !== 'fill') return;
    if (S.refreshing) { S.pending = true; return; }
    S.refreshing = true;
    try {
      if (!S.today) return;
      var prevDay = S.today.day;
      var hadMine = !!myAnswer();
      var r = await sb.rpc(GAME_RPC[S.kind]);
      if (r.error) throw r.error;
      var row = firstRow(r.data);
      if (row && row.q_day !== prevDay) {
        S.today = mapQ(row); S.editing = false; S.draft = '';
        await loadDay();
        render();
        return;
      }
      await loadDay();
      updateStreakChip();
      var f = document.getElementById('friends');
      if (f) { if (busy(f)) S.stale = true; else keepFocus(f, function () { fillFriends(f); }); }
      // Свой ответ перерисовываем, только если его не редактируют и не пишут к нему комментарий.
      var a = document.getElementById('answer-sect');
      if (a && myAnswer() && !S.editing) { if (busy(a)) S.stale = true; else keepFocus(a, function () { fillAnswer(a); }); }
      else if (a && !hadMine && myAnswer()) fillAnswer(a);
    } catch (e) {
      /* тихо: следующая попытка при новом событии или через минуту */
    } finally {
      S.refreshing = false;
      if (S.pending) { S.pending = false; bump(); }
    }
  }

  /* ---------- экраны ---------- */

  function shell(children) { return el('div', { class: 'wrap' }, children); }

  function screenLoading() {
    return shell([el('div', { class: 'card narrow' }, [el('p', { class: 'muted', text: 'Загружаю…' })])]);
  }

  function screenFatal() {
    var d = describeError(S.fatal);
    return shell([el('div', { class: 'card narrow' }, [
      el('h1', { text: 'Не получилось загрузить' }),
      el('p', { class: 'lead', text: d.text }),
      d.raw && d.raw !== d.text ? el('p', { class: 'msg' }, [el('small', { text: d.raw })]) : null,
      el('div', { class: 'row' }, [
        el('button', { type: 'button', class: 'btn primary', text: 'Повторить', onclick: function () { boot(); } }),
        S.session ? el('button', { type: 'button', class: 'link quiet', text: 'Выйти', onclick: signOut }) : null
      ])
    ])]);
  }

  function screenAuth() {
    var isReg = S.authMode === 'register';
    var email = el('input', { type: 'email', id: 'email', autocomplete: 'email', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', required: true });
    email.value = S.email;
    email.addEventListener('input', function () { S.email = email.value; });
    var pass = el('input', { type: 'password', id: 'password', autocomplete: isReg ? 'new-password' : 'current-password', required: true, minlength: isReg ? 8 : null });
    var msg = el('p', { class: 'msg', role: 'status' });
    var btn = el('button', { type: 'submit', class: 'btn primary', text: isReg ? 'Зарегистрироваться' : 'Войти' });

    function mode(m) { return function () { S.authMode = m; render(); }; }

    var form = el('form', {
      class: 'card narrow',
      onsubmit: async function (ev) {
        ev.preventDefault();
        var em = email.value.trim();
        S.email = em;
        btn.disabled = true;
        showMsg(msg, '', isReg ? 'Создаю аккаунт…' : 'Вхожу…');
        try {
          var r = isReg
            ? await sb.auth.signUp({ email: em, password: pass.value })
            : await sb.auth.signInWithPassword({ email: em, password: pass.value });
          if (r.error) throw r.error;
          if (!r.data.session) {
            showMsg(msg, 'ok', 'Аккаунт создан, но вход не открылся: в Supabase включено подтверждение почты. Выключи его в настройках (Authentication) и войди снова.');
            btn.disabled = false;
            return;
          }
          if (S.userId !== r.data.session.user.id) {
            S.session = r.data.session; S.userId = r.data.session.user.id;
            await loadUserData();
          }
        } catch (e) {
          showError(msg, e);
          btn.disabled = false;
        }
      }
    }, [
      el('h1', { text: APP }),
      el('p', { class: 'lead', text: 'Один вопрос в день для своих. Ответь сам, и увидишь, что ответили друзья.' }),
      el('div', { class: 'segment', role: 'group', 'aria-label': 'Вход или регистрация' }, [
        el('button', { type: 'button', text: 'Вход', 'aria-pressed': String(!isReg), onclick: mode('login') }),
        el('button', { type: 'button', text: 'Регистрация', 'aria-pressed': String(isReg), onclick: mode('register') })
      ]),
      el('div', { class: 'field' }, [el('label', { for: 'email', text: 'Почта' }), email]),
      el('div', { class: 'field' }, [
        el('label', { for: 'password', text: isReg ? 'Пароль (от 8 символов)' : 'Пароль' }),
        pass
      ]),
      el('div', { class: 'row' }, [btn]),
      msg,
      isReg ? el('p', { class: 'muted', text: 'После регистрации понадобится код приглашения от друга.' }) : null
    ]);
    return shell([form]);
  }

  function swatchPicker(current, onPick) {
    var box = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Цвет' });
    PALETTE.forEach(function (c, i) {
      var b = el('button', {
        type: 'button', class: 'swatch', role: 'radio', 'aria-label': PALETTE_NAMES[i],
        'aria-checked': String(c.toLowerCase() === current.toLowerCase()),
        onclick: function () {
          onPick(c);
          Array.prototype.forEach.call(box.children, function (x, j) { x.setAttribute('aria-checked', String(j === i)); });
        }
      });
      b.style.setProperty('--c', c);
      box.appendChild(b);
    });
    return box;
  }

  function screenJoin() {
    var color = PALETTE[0];
    var zodiac = null;
    var name = el('input', { type: 'text', id: 'name', maxlength: 40, autocomplete: 'nickname', autocapitalize: 'words', required: true });
    var code = el('input', { type: 'text', id: 'code', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', required: true });
    var msg = el('p', { class: 'msg', role: 'status' });
    var btn = el('button', { type: 'submit', class: 'btn primary', text: 'Войти в компанию' });
    var form = el('form', {
      class: 'card narrow',
      onsubmit: async function (ev) {
        ev.preventDefault();
        if (!zodiac) { showMsg(msg, 'err', 'Выбери свой знак зодиака.'); return; }
        btn.disabled = true;
        showMsg(msg, '', 'Проверяю код…');
        try {
          var r = await sb.rpc('join_with_code', { p_code: code.value, p_name: name.value, p_color: color, p_zodiac: zodiac });
          if (r.error) throw r.error;
          await loadUserData();
        } catch (e) {
          showError(msg, e);
          btn.disabled = false;
        }
      }
    }, [
      el('h1', { text: 'Почти готово' }),
      el('p', { class: 'lead', text: 'Введи код приглашения и имя, под которым тебя увидят друзья.' }),
      el('div', { class: 'field' }, [el('label', { for: 'name', text: 'Имя' }), name]),
      el('div', { class: 'field' }, [el('span', { class: 'lbl', text: 'Цвет' }), swatchPicker(color, function (c) { color = c; })]),
      el('div', { class: 'field' }, [el('span', { class: 'lbl', text: 'Знак зодиака' }), zodiacPicker(null, function (zz) { zodiac = zz; })]),
      el('div', { class: 'field' }, [el('label', { for: 'code', text: 'Код приглашения' }), code]),
      el('div', { class: 'row' }, [
        btn,
        el('button', { type: 'button', class: 'link quiet', text: 'Выйти', onclick: signOut })
      ]),
      msg
    ]);
    return shell([form]);
  }

  /* ----- основной экран ----- */

  var TITLES = { today: 'Вопрос дня', fill: 'Слово дня', horo: 'Гороскоп дня', game: 'Сектор', archive: 'Архив', profile: 'Профиль' };
  var TABS = [['today', 'Вопрос'], ['fill', 'Слово'], ['horo', 'Гороскоп'], ['game', 'Игра'], ['profile', 'Профиль']];
  function titleFor(view) {
    if (view === 'archive') return S.archiveKind === 'fill' ? 'Прошлые фразы' : 'Прошлые вопросы';
    return TITLES[view] || APP;
  }

  function header() {
    var tabs = TABS;
    var st = myStats();
    var n = st ? st.current_streak : 0;
    var chip = el('button', {
      type: 'button', id: 'streak-chip', class: 'streak-chip',
      title: 'Серия: ' + n + ' ' + plural(n, 'день', 'дня', 'дней') + ' подряд',
      text: '🔥 ' + n, onclick: function () { go('profile'); }
    });
    chip.hidden = !n;
    return el('header', { class: 'sect' }, [
      el('div', { class: 'top' }, [
        el('h1', { class: 'brand', text: titleFor(S.view) }),
        el('span', { class: 'me' }, [
          chip,
          el('span', { class: 'name', text: S.profile.display_name }),
          avatar(S.profile.display_name, S.profile.color, false, S.profile.avatar)
        ])
      ]),
      el('nav', { class: 'tabs', 'aria-label': 'Разделы' }, tabs.map(function (t) {
        return el('button', {
          type: 'button', class: 'tab', text: t[1], 'aria-current': S.view === t[0] ? 'page' : null,
          onclick: function () { switchTab(t[0]); }
        });
      }))
    ]);
  }

  async function go(view) {
    closePicker();
    S.view = view;
    if (view === 'today' || view === 'fill') {
      S.kind = view === 'fill' ? 'fill' : 'question';
      S.editing = false;
      if (!S.today) {
        render();
        try { await loadToday(); } catch (e) { S.stage = 'fatal'; S.fatal = e; render(); return; }
        if (S.view !== view) return;
      }
    }
    if (view === 'archive') {
      S.kind = S.archiveKind;
      if (!S.archive) {
        render();
        try { await loadArchive(); } catch (e) { S.kd[S.archiveKind].archive = []; }
        if (S.view !== view) return;
      }
    }
    if (view === 'profile') {
      render();
      await Promise.all([loadGroup(), loadStats()]);
      if (S.view !== view) return;
    }
    if (view === 'game') {
      render();
      loadBoard().then(function () { if (S.view === 'game') fillBoard(); });
      return;
    }
    render();
    if (view === 'today' || view === 'fill') refreshQuietly();
  }

  function screenApp() {
    var body;
    if (S.view !== 'game') stopGame();
    if (S.view === 'game') body = viewGame();
    else if (S.view === 'archive') body = viewArchive();
    else if (S.view === 'profile') body = viewProfile();
    else if (S.view === 'horo') body = viewHoroscope();
    else if (!S.today) body = [el('p', { class: 'muted', text: 'Загружаю…' })];
    else body = viewToday();
    var w = shell([header()].concat(body).concat([bottomNav()]));
    w.classList.add('has-bottom-nav');
    if (S.slideDir && !reduceMotion) w.classList.add('slide-' + S.slideDir);
    return w;
  }

  // Переход на вкладку: мягкая анимация и возврат к месту, где эту вкладку листали в прошлый раз.
  S.scroll = {};
  function switchTab(view, dir) {
    if (view === S.view) { window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }); return; }
    S.scroll[S.view] = window.scrollY;
    S.slideDir = dir || 'fade';
    clearTimeout(switchTab.timer);
    switchTab.timer = setTimeout(function () { S.slideDir = null; }, 450);
    go(view).then(function () {
      if (S.view === view) window.scrollTo(0, S.scroll[view] || 0);
    });
  }

  /* ----- смахивание между вкладками на телефоне ----- */
  // Влево — следующая вкладка, вправо — предыдущая. Не срабатывает в полях ввода, в таблице, которую листают вбок,
  // в окне реакций, меню и на празднике.
  function setupSwipe() {
    var sx = 0, sy = 0, t0 = 0, active = false;
    document.addEventListener('touchstart', function (ev) {
      active = false;
      if (S.stage !== 'app' || ev.touches.length !== 1 || window.innerWidth > 640) return;
      var t = ev.target;
      if (t.closest && t.closest('input, textarea, .table-wrap, .picker, .menu, .celebrate, .bottom-nav, .emojis, .zodiacs, .swatches')) return;
      if (openPicker) return;
      if (S.gameState === 'play' || (t.closest && t.closest('.sector-field'))) return; // во время игры вкладки не листаются
      sx = ev.touches[0].clientX; sy = ev.touches[0].clientY; t0 = Date.now(); active = true;
    }, { passive: true });
    document.addEventListener('touchend', function (ev) {
      if (!active) return;
      active = false;
      var p = ev.changedTouches[0];
      var dx = p.clientX - sx, dy = p.clientY - sy;
      if (Date.now() - t0 > 700 || Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
      var sel = window.getSelection ? String(window.getSelection()) : '';
      if (sel) return;
      var i = TABS.map(function (x) { return x[0]; }).indexOf(S.view);
      var next = i + (dx < 0 ? 1 : -1);
      if (i < 0 || next < 0 || next >= TABS.length) return;
      switchTab(TABS[next][0], dx < 0 ? 'left' : 'right');
    }, { passive: true });
  }

  // Нижняя панель на телефоне: до неё легко дотянуться большим пальцем.
  function bottomNav() {
    var items = TABS;
    return el('nav', { class: 'bottom-nav', 'aria-label': 'Разделы' }, items.map(function (t) {
      return el('button', {
        type: 'button', class: 'bn-item', 'aria-current': S.view === t[0] ? 'page' : null,
        onclick: function () { switchTab(t[0]); }
      }, [icon(t[0]), el('span', { class: 'bn-label', text: t[1] })]);
    }));
  }

  /* ----- сегодня ----- */

  function questionCard(q) {
    if (S.kind === 'fill') {
      var mine = myAnswer();
      return el('section', { class: 'card qcard', 'aria-label': 'Фраза дня' }, [
        el('div', { class: 'qhead' }, [
          el('span', { class: 'tag cat-fill', text: 'Впиши слово' }),
          el('span', { class: 'date', text: dayLabel(q.day) })
        ]),
        fillSentence(q.text, mine && !S.editing ? mine.body : (S.draft || ''), 'qtext', 'fill-blank')
      ]);
    }
    return el('section', { class: 'card qcard', 'aria-label': 'Вопрос дня' }, [
      el('div', { class: 'qhead' }, [
        el('span', { class: 'tag cat-' + q.category, text: CAT[q.category] || 'Вопрос' }),
        el('span', { class: 'date', text: dayLabel(q.day) })
      ]),
      el('p', { class: 'qtext q-accent', text: q.text })
    ]);
  }

  // Живой предпросмотр: пока человек печатает, слово появляется прямо во фразе.
  function updateBlank(text) {
    var b = document.getElementById('fill-blank');
    if (!b) return;
    b.textContent = text || '______';
    b.classList.toggle('empty', !text);
  }

  function viewToday() {
    var a = el('section', { class: 'sect', id: 'answer-sect' });
    fillAnswer(a);
    var f = el('section', { class: 'sect', id: 'friends' });
    fillFriends(f);
    // В «Слове» карточка с фразой живёт внутри answer-sect: после ответа она же показывает твой вариант.
    var past = el('div', { class: 'past-link' }, [el('button', {
      type: 'button', class: 'link quiet',
      text: S.kind === 'fill' ? 'Прошлые фразы →' : 'Прошлые вопросы →',
      onclick: function () { openArchive(S.kind); }
    })]);
    return S.kind === 'fill' ? [a, f, past] : [questionCard(S.today), a, f, past];
  }

  function fillAnswer(sect) {
    var mine = myAnswer();
    sect.replaceChildren();
    if (mine && !S.editing) {
      if (S.kind !== 'fill') sect.appendChild(el('h2', { text: 'Твой ответ' }));
      sect.appendChild(myAnswerCard(mine, sect));
      return;
    }
    var isFill = S.kind === 'fill';
    if (isFill) sect.appendChild(questionCard(S.today));
    var max = isFill ? 60 : 1000;
    var ta = isFill
      ? el('input', { type: 'text', id: 'answer', maxlength: 60, autocomplete: 'off', 'aria-label': 'Твоё слово или фраза', placeholder: 'Твоё слово или фраза' })
      : el('textarea', { id: 'answer', maxlength: 1000, rows: 4, 'aria-label': 'Твой ответ', autocapitalize: 'off', 'data-cap': '1', placeholder: 'Напиши, что думаешь' });
    ta.value = S.draft || '';
    var counter = el('span', { class: 'count', text: ta.value.length + ' / ' + max });
    var msg = el('p', { class: 'msg', role: 'status' });
    var btn = el('button', { type: 'submit', class: 'btn primary', text: mine ? 'Сохранить' : (isFill ? 'Вписать' : 'Ответить') });
    ta.addEventListener('input', function () {
      S.draft = ta.value; counter.textContent = ta.value.length + ' / ' + max;
      if (isFill) updateBlank(ta.value.trim());
    });
    var form = el('form', {
      class: 'card stack tight',
      onsubmit: async function (ev) {
        ev.preventDefault();
        var text = ta.value.trim();
        if (!text) { showMsg(msg, 'err', isFill ? 'Впиши хотя бы одно слово.' : 'Напиши хотя бы пару слов.'); return; }
        btn.disabled = true;
        showMsg(msg, '', 'Сохраняю…');
        try {
          var r = await sb.from('answers').upsert(
            { user_id: S.userId, day: S.today.day, kind: S.kind, body: text, updated_at: new Date().toISOString() },
            { onConflict: 'user_id,day,kind' }
          );
          if (r.error) throw r.error;
          var firstToday = !mine;
          var before = myStats();
          var wasToday = !!(before && before.answered_today);
          // Короткое подтверждение на самой кнопке, пока подгружаются ответы друзей.
          showMsg(msg, '', '');
          btn.textContent = '✓ Сохранено';
          btn.classList.add('ok');
          S.draft = ''; S.editing = false;
          await Promise.all([loadDay(), new Promise(function (res) { setTimeout(res, reduceMotion ? 0 : 550); })]);
          updateStreakChip();
          fillAnswer(sect);
          var card = sect.querySelector('.ans.mine');
          if (card && !reduceMotion) card.classList.add('glow');
          var f = document.getElementById('friends');
          if (f) { S.revealNext = firstToday; fillFriends(f); S.revealNext = false; }
          // Большой праздник — только на вехах серии.
          var st = myStats();
          if (firstToday && !wasToday && st && [3, 7, 30, 100].indexOf(st.current_streak) >= 0) showCelebration();
        } catch (e) {
          showError(msg, e);
          btn.disabled = false;
        }
      }
    }, [
      el('div', { class: 'field' }, [ta]),
      el('div', { class: 'row between' }, [
        el('div', { class: 'row' }, [
          btn,
          S.editing ? el('button', { type: 'button', class: 'link quiet', text: 'Отмена', onclick: function () { S.editing = false; S.draft = ''; fillAnswer(sect); if (isFill) { var m = myAnswer(); updateBlank(m ? m.body : ''); } } }) : null
        ]),
        counter
      ]),
      msg
    ]);
    sect.appendChild(el('h2', { text: mine ? (isFill ? 'Изменить вариант' : 'Изменить ответ') : (isFill ? 'Твой вариант' : 'Твой ответ') }));
    var st = myStats();
    if (!mine && st && st.current_streak > 0) {
      var n = st.current_streak;
      sect.appendChild(el('p', { class: 'streak-hint', text: '🔥 Твоя серия: ' + n + ' ' + plural(n, 'день', 'дня', 'дней') + ' подряд. Ответь сегодня, чтобы она не прервалась.' }));
    }
    sect.appendChild(form);
  }

  /* ----- статистика ----- */

  function tile(n, one, few, many) {
    return el('div', { class: 'tile' }, [
      el('span', { class: 'tile-n', text: String(n) }),
      el('span', { class: 'tile-l', text: plural(n, one, few, many) })
    ]);
  }

  function viewStats() {
    var st = myStats();
    var n = st ? st.current_streak : 0;
    var note;
    if (st && st.answered_today) note = 'Сегодня ответ уже засчитан. Завтра серия вырастет, если снова ответишь на вопрос или впишешь слово.';
    else if (n) note = 'Ответь на вопрос или впиши слово, чтобы серия не прервалась.';
    else note = 'Ответь на вопрос дня или впиши слово, чтобы начать серию.';

    var out = [el('section', { class: 'card streak-card' }, [
      el('div', { class: 'streak-big', 'aria-hidden': 'true' }, [el('span', { text: '🔥' }), el('span', { class: 'streak-num', text: String(n) })]),
      el('div', { class: 'streak-text' }, [
        el('p', { class: 'streak-title', text: n ? n + ' ' + plural(n, 'день', 'дня', 'дней') + ' подряд' : 'Серии пока нет' }),
        el('p', { class: 'muted', text: note }),
        st ? el('p', { class: 'count', text: 'рекорд: ' + st.best_streak + ' · ответов: ' + st.total_answers + ' · реакций получено: ' + st.reactions_received }) : null
      ])
    ])];

    if (S.group) {
      out.push(el('section', { class: 'sect' }, [
        el('h2', { text: 'Вся компания' }),
        el('div', { class: 'tiles' }, [
          tile(S.group.days_played, 'день игры', 'дня игры', 'дней игры'),
          tile(S.group.total_answers, 'ответ', 'ответа', 'ответов'),
          tile(S.group.total_reactions, 'реакция', 'реакции', 'реакций'),
          tile(S.group.total_comments, 'комментарий', 'комментария', 'комментариев')
        ])
      ]));
    }

    var rows = S.stats.map(function (s) {
      var me = s.user_id === S.userId;
      return el('tr', { class: me ? 'me-row' : null }, [
        el('th', { scope: 'row' }, [
          el('span', { class: 'who' }, [
            avatar(s.display_name, s.color, true, s.avatar),
            el('span', { class: 'who-name' }, [
              el('span', { text: s.display_name + (me ? ' (ты)' : '') }),
              el('span', { class: 'who-sub', text: s.answered_today ? 'ответил сегодня' : 'ещё не ответил сегодня' })
            ])
          ])
        ]),
        el('td', { text: s.current_streak ? '🔥 ' + s.current_streak : '—' }),
        el('td', { class: 'col-best', text: String(s.best_streak) }),
        el('td', { text: String(s.total_answers) }),
        el('td', { text: String(s.reactions_received) })
      ]);
    });
    out.push(el('section', { class: 'sect' }, [
      el('h2', { text: 'Участники' }),
      el('div', { class: 'card table-wrap' }, [
        el('table', { class: 'board' }, [
          el('thead', null, [el('tr', null, [
            el('th', { scope: 'col', text: 'Кто' }),
            el('th', { scope: 'col', text: 'Серия дней' }),
            el('th', { scope: 'col', class: 'col-best', text: 'Рекорд' }),
            el('th', { scope: 'col', text: 'Ответы' }),
            el('th', { scope: 'col', text: 'Реакции' })
          ])]),
          el('tbody', null, rows)
        ])
      ])
    ]));
    return out;
  }

  /* ----- меню своего ответа: нажимаешь на ответ — появляются действия ----- */

  // Небольшое всплывающее сообщение внизу экрана.
  function toast(text) {
    var old = document.querySelector('.toast');
    if (old) old.remove();
    var t = el('div', { class: 'toast', role: 'status', text: text });
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('out'); }, 1500);
    setTimeout(function () { t.remove(); }, 1900);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Запасной способ: выделить текст в скрытом поле и скопировать.
      var ta = el('textarea', { class: 'sr', 'aria-hidden': 'true' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (x) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  function menuItem(ico, text, fn, cls) {
    return el('button', {
      type: 'button', role: 'menuitem', class: 'menu-item' + (cls ? ' ' + cls : ''),
      onclick: function (ev) { ev.stopPropagation(); fn(ev.currentTarget); }
    }, [el('span', { class: 'mi-ico', 'aria-hidden': 'true', text: ico }), el('span', { text: text })]);
  }

  function myAnswerCard(mine, sect) {
    var mode = null; // null — закрыто, 'menu' — действия, 'confirm' — подтверждение удаления
    var anchor = el('div', { class: 'menu-anchor' });
    var edited = mine.updated_at && Math.abs(new Date(mine.updated_at) - new Date(mine.created_at)) > 5000;

    function draw() {
      anchor.replaceChildren();
      if (mode === 'menu') {
        anchor.appendChild(el('div', { class: 'menu', role: 'menu', 'aria-label': 'Действия с ответом' }, [
          el('p', { class: 'menu-meta', text: 'Отправлен сегодня в ' + timeLabel(mine.created_at) + (edited ? ' · изменён' : '') }),
          menuItem('✏️', 'Изменить', function () {
            closePicker();
            S.editing = true; S.draft = mine.body;
            fillAnswer(sect);
            if (S.kind === 'fill') updateBlank(mine.body);
            var t = sect.querySelector('#answer');
            if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
          }),
          menuItem('📋', 'Скопировать', async function () {
            closePicker();
            toast((await copyText(mine.body)) ? 'Скопировано' : 'Не получилось скопировать');
          }),
          menuItem('🗑', 'Удалить', function () { mode = 'confirm'; draw(); }, 'danger')
        ]));
      } else if (mode === 'confirm') {
        var msg = el('p', { class: 'msg', role: 'status' });
        anchor.appendChild(el('div', { class: 'menu confirm', role: 'alertdialog', 'aria-label': 'Удалить ответ?' }, [
          el('p', { class: 'menu-q', text: 'Удалить ответ? Реакции и комментарии к нему тоже удалятся.' }),
          el('div', { class: 'row' }, [
            el('button', {
              type: 'button', class: 'btn danger', text: 'Удалить',
              onclick: async function (ev) {
                ev.stopPropagation();
                var b = ev.currentTarget;
                b.disabled = true;
                try {
                  var r = await sb.from('answers').delete().eq('id', mine.id).eq('user_id', S.userId);
                  if (r.error) throw r.error;
                  closePicker();
                  S.editing = false; S.draft = '';
                  await loadDay();
                  updateStreakChip();
                  fillAnswer(sect);
                  updateBlank('');
                  var f = document.getElementById('friends');
                  if (f) fillFriends(f);
                  toast('Ответ удалён');
                } catch (e) {
                  showError(msg, e);
                  b.disabled = false;
                }
              }
            }),
            el('button', { type: 'button', class: 'btn', text: 'Отмена', onclick: function (ev) { ev.stopPropagation(); closePicker(); } })
          ]),
          msg
        ]));
      }
      var first = anchor.querySelector('button');
      if (first) first.focus();
    }

    function toggle() {
      if (mode) { closePicker(); return; }
      closePicker();
      mode = 'menu';
      openPicker = function () { mode = null; draw(); flushStale(); };
      draw();
    }

    var mcb = commentBlock(mine.id, S.comments, S.commentReactions, true);
    var isFill = S.kind === 'fill';
    var body = isFill
      ? fillSentence(S.today && S.today.text, mine.body, 'qtext ans-body')
      : answerBody(mine.body, S.kind, S.today && S.today.text);
    body.setAttribute('tabindex', '0');
    body.setAttribute('role', 'button');
    body.setAttribute('aria-haspopup', 'menu');
    body.setAttribute('title', 'Нажми, чтобы изменить, скопировать или удалить');
    var card = isFill
      ? el('div', { class: 'card qcard ans mine tappable fill-top' }, [
          el('div', { class: 'qhead' }, [
            el('span', { class: 'tag cat-fill', text: 'Впиши слово' }),
            el('span', { class: 'date', text: dayLabel(S.today.day) })
          ]),
          body,
          el('p', { class: 'saved-line', text: '✓ Твой ответ сохранён' }),
          anchor,
          actionsRow(receivedReactions(mine.id, S.reactions), mcb),
          mcb
        ])
      : el('div', { class: 'card ans mine tappable' }, [
          body,
          anchor,
          actionsRow(receivedReactions(mine.id, S.reactions), mcb),
          mcb
        ]);
    card.addEventListener('click', function (ev) {
      if (ev.target.closest('button, a, input, textarea, form, .reacts, .comments, .menu, .act-row')) return;
      var sel = window.getSelection ? String(window.getSelection()) : '';
      if (sel) return; // человек выделяет текст — меню не мешаем
      ev.stopPropagation();
      toggle();
    });
    body.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); toggle(); }
    });
    return card;
  }

  function chip(name, color, pending, emoji) {
    return el('span', { class: 'chip' + (pending ? ' pending' : '') }, [avatar(name, color, true, emoji), el('span', { text: name })]);
  }

  function ansCard(a, isMine) {
    var p = profileOf(a);
    var bar = isMine ? receivedReactions(a.id, S.reactions) : reactionBar(a.id, S.reactions);
    var cb = commentBlock(a.id, S.comments, S.commentReactions, isMine);
    var li = el('li', { class: 'card ans' + (isMine ? ' mine' : '') }, [
      el('div', { class: 'ans-head' }, [
        avatar(p.display_name, p.color, false, p.avatar),
        el('span', { class: 'ans-name', text: isMine ? (p.display_name || 'Ты') + ' (ты)' : (p.display_name || 'Без имени') }),
        el('span', { class: 'ans-time', text: timeLabel(a.created_at) })
      ]),
      answerBody(a.body, S.kind, S.today && S.today.text),
      actionsRow(bar, cb),
      cb
    ]);
    if (!isMine) onDoubleTap(li, function () { heartBurst(li); bar.quick('heart'); });
    return li;
  }

  function fillFriends(sect) {
    var mine = myAnswer();
    sect.replaceChildren();
    if (!mine) {
      sect.appendChild(el('h2', { text: S.kind === 'fill' ? 'Варианты друзей' : 'Ответы друзей' }));
      var total = S.members.length;
      var kids = [el('p', { text: S.kind === 'fill' ? '🔒 Варианты друзей откроются, когда впишешь свой.' : '🔒 Ответы друзей откроются, когда ответишь сам.' })];
      if (S.who.length) {
        kids.push(el('p', { class: 'lbl', text: 'Уже ответили · ' + S.who.length + ' из ' + total }));
        kids.push(el('div', { class: 'chips' }, S.who.map(function (w) { return chip(w.display_name, w.color, false, w.avatar); })));
      } else {
        kids.push(el('p', { text: 'Пока никто не ответил. Будь первым 🙌' }));
      }
      sect.appendChild(el('div', { class: 'locked' }, kids));
      return;
    }
    var others = S.answers.filter(function (a) { return a.user_id !== S.userId; });
    sect.appendChild(el('h2', { text: (S.kind === 'fill' ? 'Варианты друзей' : 'Ответы друзей') + (others.length ? ' · ' + others.length : '') }));
    if (others.length) {
      var reveal = S.revealNext && !reduceMotion;
      sect.appendChild(el('ul', { class: 'list' }, others.map(function (a, i) {
        var li = ansCard(a, false);
        if (reveal) { li.classList.add('rise'); li.style.setProperty('--i', i); }
        return li;
      })));
    } else {
      sect.appendChild(el('p', { class: 'empty', text: 'Пока ответил только ты. Позови друзей 👋' }));
    }
    var answered = {};
    S.who.forEach(function (w) { answered[w.user_id] = true; });
    var pending = S.members.filter(function (m) { return !answered[m.id]; });
    if (pending.length) {
      sect.appendChild(el('p', { class: 'lbl', text: 'Ждём ещё' }));
      sect.appendChild(el('div', { class: 'chips' }, pending.map(function (m) { return chip(m.display_name, m.color, true, m.avatar); })));
    }
  }

  /* ----- игра «Сектор» ----- */
  // Игра не влияет на серию дней. Рекорд хранится на телефоне и в базе (для рейтинга).

  function localBestKey() { return 'sector-best:' + (S.userId || 'anon'); }
  function localBest() {
    try { return parseInt(localStorage.getItem(localBestKey()), 10) || 0; } catch (e) { return 0; }
  }
  function saveLocalBest(v) {
    try { if (v > localBest()) localStorage.setItem(localBestKey(), String(v)); } catch (e) { /* без хранилища тоже работает */ }
  }
  function serverBest() {
    var rows = S.board.all || [];
    for (var i = 0; i < rows.length; i++) if (rows[i].user_id === S.userId) return rows[i].best || 0;
    return 0;
  }
  function gameBest() { return Math.max(localBest(), serverBest()); }

  async function loadBoard() {
    var out = await Promise.all(['week', 'all'].map(function (p) { return sb.rpc('game_leaderboard', { p_period: p }); }));
    if (!out[0].error) S.board.week = out[0].data || [];
    if (!out[1].error) S.board.all = out[1].data || [];
  }

  function stopGame() {
    if (S.game) { try { S.game.destroy(); } catch (e) { /* уже остановлена */ } }
    S.game = null; S.gameBox = null; S.gameState = null; S.gameSession = null;
  }

  function startGameSession() {
    // Если база не ответит, игра всё равно идёт — просто результат останется только на телефоне.
    S.gameSession = sb.rpc('game_start').then(function (r) {
      if (r.error) return null;
      return typeof r.data === 'string' ? r.data : (firstRow(r.data) || null);
    }).catch(function () { return null; });
  }

  async function finishGameSession(res) {
    saveLocalBest(res.score);
    var pending = S.gameSession;
    S.gameSession = null;
    var id = pending ? await pending : null;
    if (!id) return { best: gameBest() };
    var r = await sb.rpc('game_finish', { p_session: id, p_score: res.score, p_hits: res.hits, p_perfects: res.perfects });
    if (r.error) return { best: gameBest() };
    var row = firstRow(r.data) || {};
    await loadBoard();
    if (S.view === 'game') fillBoard();
    return { best: Math.max(gameBest(), row.best_all || 0), valid: row.valid };
  }

  function viewGame() {
    if (!S.gameBox && window.SectorGame) {
      S.gameBox = el('section', { class: 'sect game-sect', 'aria-label': 'Игра «Сектор»' });
      S.gameState = 'start';
      S.game = window.SectorGame.mount(S.gameBox, {
        best: gameBest,
        onStart: startGameSession,
        onOver: finishGameSession,
        onStateChange: function (st) { if (st !== 'gone') S.gameState = st; }
      });
    }
    var game = S.gameBox || el('p', { class: 'empty', text: 'Игра не загрузилась. Обнови страницу.' });
    var board = el('section', { class: 'sect', id: 'board' });
    fillBoard(board);
    return [game, board];
  }

  function fillBoard(sect) {
    sect = sect || document.getElementById('board');
    if (!sect) return;
    var period = S.boardPeriod;
    var seg = el('div', { class: 'segment', role: 'group', 'aria-label': 'За какое время' }, [['week', 'Неделя'], ['all', 'Всё время']].map(function (p) {
      return el('button', {
        type: 'button', text: p[1], 'aria-pressed': String(period === p[0]),
        onclick: function () { if (S.boardPeriod !== p[0]) { S.boardPeriod = p[0]; fillBoard(); } }
      });
    }));
    var rows = S.board[period];
    var body;
    if (!rows) body = el('p', { class: 'muted', text: 'Загружаю…' });
    else if (!rows.length) body = el('p', { class: 'empty', text: period === 'week'
      ? 'На этой неделе ещё никто не играл. Стань первым!'
      : 'Рекордов пока нет. Стань первым!' });
    else {
      var mine = null;
      body = el('div', { class: 'card table-wrap' }, [el('table', { class: 'board lb' }, [
        el('thead', null, [el('tr', null, [
          el('th', { scope: 'col', class: 'col-rank', text: '#' }),
          el('th', { scope: 'col', text: 'Кто' }),
          el('th', { scope: 'col', text: 'Очки' }),
          el('th', { scope: 'col', text: 'Perfect' })
        ])]),
        el('tbody', null, rows.map(function (r) {
          var me = r.user_id === S.userId;
          if (me) mine = r;
          var medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : String(r.rank);
          return el('tr', { class: me ? 'me-row' : null }, [
            el('td', { class: 'col-rank', text: medal }),
            el('th', { scope: 'row' }, [el('span', { class: 'who' }, [
              avatar(r.display_name, r.color, true, r.avatar),
              el('span', { class: 'who-name' }, [el('span', { text: r.display_name })])
            ])]),
            el('td', { class: 'lb-score', text: String(r.best) }),
            el('td', { text: String(r.perfects) })
          ]);
        }))
      ])]);
      var note = mine
        ? 'Твоё место: ' + mine.rank + ' из ' + rows.length
        : (period === 'week' ? 'Сыграй, чтобы попасть в рейтинг недели.' : 'Сыграй, чтобы попасть в рейтинг.');
      body = el('div', { class: 'stack tight' }, [body, el('p', { class: 'muted small', text: note })]);
    }
    sect.replaceChildren(
      el('h2', { text: 'Рейтинг' }),
      seg,
      body
    );
  }

  /* ----- архив ----- */

  // Архив открывается ссылкой внизу «Вопроса» или «Слова».
  function openArchive(kind) {
    S.archiveKind = kind;
    S.archiveFrom = kind === 'fill' ? 'fill' : 'today';
    switchTab('archive', 'left');
  }

  function viewArchive() {
    var back = S.archiveFrom || (S.archiveKind === 'fill' ? 'fill' : 'today');
    var seg = el('div', { class: 'back-row' }, [el('button', {
      type: 'button', class: 'link quiet back-link',
      text: '← ' + (back === 'fill' ? 'Слово дня' : 'Вопрос дня'),
      onclick: function () { switchTab(back, 'right'); }
    })]);
    var list = S.kd[S.archiveKind].archive;
    if (!list) return [seg, el('p', { class: 'muted', text: 'Загружаю…' })];
    if (!list.length) return [seg, el('p', { class: 'empty', text: S.archiveKind === 'fill'
      ? 'Здесь будут прошлые фразы и ваши варианты. Первая появится завтра 🌙'
      : 'Здесь будут прошлые вопросы и ответы на них. Первый появится завтра 🌙' })];
    return [seg, el('div', { class: 'list' }, list.map(function (q) { return archiveItem(q, S.archiveKind); }))];
  }

  function archiveItem(q, kind) {
    var body = el('div', { class: 'day-body' });
    var d = el('details', { class: 'day' }, [
      el('summary', null, [
        el('div', { class: 'qhead' }, [
          kind === 'fill'
            ? el('span', { class: 'tag cat-fill', text: 'Впиши слово' })
            : el('span', { class: 'tag cat-' + q.q_category, text: CAT[q.q_category] || 'Вопрос' }),
          el('span', { class: 'date', text: dayLabel(q.q_day) })
        ]),
        kind === 'fill' ? fillSentence(q.q_text, '', 'day-q') : el('span', { class: 'day-q', text: q.q_text })
      ]),
      body
    ]);
    d.addEventListener('toggle', async function () {
      if (!d.open || d.dataset.loaded) return;
      d.dataset.loaded = '1';
      body.replaceChildren(el('p', { class: 'muted', text: 'Загружаю…' }));
      try {
        var r = await sb.from('answers').select('id, user_id, body, created_at, profiles!answers_user_id_fkey(display_name, color, avatar)').eq('day', q.q_day).eq('kind', kind).order('created_at', { ascending: true });
        if (r.error) throw r.error;
        var more = await Promise.all([loadReactions(r.data), loadComments(r.data)]);
        var dayReactions = more[0], dayComments = more[1];
        var dayCR = await loadCommentReactions(dayComments);
        body.replaceChildren();
        if (!r.data.length) body.appendChild(el('p', { class: 'muted', text: 'В этот день никто не ответил.' }));
        r.data.forEach(function (a) {
          var p = profileOf(a);
          var isMine = a.user_id === S.userId;
          var abar = isMine ? receivedReactions(a.id, dayReactions) : reactionBar(a.id, dayReactions);
          var acb = commentBlock(a.id, dayComments, dayCR, isMine);
          var item = el('div', { class: 'ans' }, [
            el('div', { class: 'ans-head' }, [
              avatar(p.display_name, p.color, true, p.avatar),
              el('span', { class: 'ans-name', text: (p.display_name || 'Без имени') + (isMine ? ' (ты)' : '') })
            ]),
            answerBody(a.body, kind, q.q_text),
            actionsRow(abar, acb),
            acb
          ]);
          if (!isMine) onDoubleTap(item, function () { heartBurst(item); abar.quick('heart'); });
          body.appendChild(item);
        });
      } catch (e) {
        d.dataset.loaded = '';
        body.replaceChildren();
        var m = el('p', { class: 'msg' });
        showError(m, e);
        body.appendChild(m);
      }
    });
    return d;
  }

  /* ----- профиль ----- */

  function emojiPicker(current, initial, onPick) {
    var box = el('div', { class: 'emojis', role: 'radiogroup', 'aria-label': 'Аватарка' });
    [null].concat(EMOJIS).forEach(function (e, i) {
      box.appendChild(el('button', {
        type: 'button', class: 'emoji-opt' + (e ? '' : ' letter'), role: 'radio',
        'aria-checked': String((current || null) === e),
        'aria-label': e ? 'эмодзи ' + e : 'без эмодзи, первая буква имени',
        text: e || initial,
        onclick: function () {
          onPick(e);
          Array.prototype.forEach.call(box.children, function (x, j) { x.setAttribute('aria-checked', String(j === i)); });
        }
      }));
    });
    return box;
  }

  function viewProfile() {
    var color = safeColor(S.profile.color);
    var emoji = S.profile.avatar || null;
    var zodiac = S.profile.zodiac || null;
    var initial = (Array.from(String(S.profile.display_name || '?'))[0] || '?').toUpperCase();
    var preview = el('span', { class: 'preview' });
    function drawPreview() { preview.replaceChildren(avatar(S.profile.display_name, color, false, emoji)); }
    drawPreview();
    var name = el('input', { type: 'text', id: 'pname', maxlength: 40, autocapitalize: 'words', autocomplete: 'nickname', required: true });
    name.value = S.profile.display_name;
    var msg = el('p', { class: 'msg', role: 'status' });
    var btn = el('button', { type: 'submit', class: 'btn primary', text: 'Сохранить' });
    var form = el('form', {
      class: 'card stack',
      onsubmit: async function (ev) {
        ev.preventDefault();
        var n = name.value.trim();
        if (!n) { showMsg(msg, 'err', 'Имя не может быть пустым.'); return; }
        btn.disabled = true;
        showMsg(msg, '', 'Сохраняю…');
        try {
          var r = await sb.from('profiles').update({ display_name: n, color: color, avatar: emoji, zodiac: zodiac }).eq('id', S.userId);
          if (r.error) throw r.error;
          S.profile.display_name = n; S.profile.color = color; S.profile.avatar = emoji; S.profile.zodiac = zodiac;
          render();
        } catch (e) {
          showError(msg, e);
          btn.disabled = false;
        }
      }
    }, [
      el('div', { class: 'field' }, [el('label', { for: 'pname', text: 'Имя' }), name]),
      el('div', { class: 'field' }, [
        el('span', { class: 'lbl', text: 'Аватарка' }),
        el('div', { class: 'row' }, [preview, el('span', { class: 'muted small', text: 'Эмодзи или первая буква имени на выбранном цвете' })]),
        emojiPicker(emoji, initial, function (e) { emoji = e; drawPreview(); })
      ]),
      el('div', { class: 'field' }, [el('span', { class: 'lbl', text: 'Цвет' }), swatchPicker(color, function (c) { color = c; drawPreview(); })]),
      el('div', { class: 'field', id: 'zodiac-field' }, [el('span', { class: 'lbl', text: 'Знак зодиака' }), zodiacPicker(zodiac, function (zz) { zodiac = zz; })]),
      el('div', { class: 'row actions' }, [btn]),
      msg
    ]);
    var account = el('div', { class: 'card' }, [
      el('div', { class: 'row between' }, [
        el('span', { class: 'muted', text: (S.session && S.session.user && S.session.user.email) || '' }),
        el('button', { type: 'button', class: 'btn', text: 'Выйти', onclick: signOut })
      ])
    ]);
    var inst = installCard();
    return viewStats().concat(inst ? [inst] : []).concat([el('h2', { class: 'sect-title', text: 'Настройки профиля' }), form, account]);
  }

  /* ---------- выход и запуск ---------- */

  function resetToAuth() {
    stopPolling();
    S.loadSeq++;
    S.session = null; S.userId = null; S.profile = null;
    stopGame(); S.board = { week: null, all: null };
    S.kd = { question: blankGame(), fill: blankGame() }; S.kind = 'question'; S.archiveKind = 'question';
    S.members = []; S.stats = []; S.group = null;
    S.view = 'today'; S.stage = 'auth'; S.authMode = 'login';
    render();
  }

  async function signOut() {
    try { await sb.auth.signOut(); } catch (e) { /* всё равно выходим */ }
    resetToAuth();
  }

  function render() {
    var node;
    if (S.stage === 'auth') node = screenAuth();
    else if (S.stage === 'join') node = screenJoin();
    else if (S.stage === 'app') node = screenApp();
    else if (S.stage === 'fatal') node = screenFatal();
    else node = screenLoading();
    root.replaceChildren(node);
  }

  async function boot() {
    S.stage = 'loading'; render();
    try {
      var r = await sb.auth.getSession();
      if (r.error) throw r.error;
      S.session = r.data.session;
      S.userId = S.session ? S.session.user.id : null;
      await loadUserData();
    } catch (e) {
      S.stage = 'fatal'; S.fatal = e; render();
    }
  }

  /* ----- приложение на экране телефона ----- */
  var installEvt = null; // Android/Chrome даёт событие, по которому можно показать окно установки
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function setupInstall() {
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* сайт работает и без него */ });
    }
    window.addEventListener('beforeinstallprompt', function (ev) {
      ev.preventDefault();
      installEvt = ev;
      if (S.stage === 'app' && S.view === 'profile') render();
    });
    window.addEventListener('appinstalled', function () {
      installEvt = null;
      markHintSeen();
      var h = document.querySelector('.install-hint'); if (h) h.remove();
      toast('Приложение установлено 🎉');
      if (S.stage === 'app' && S.view === 'profile') render();
    });
  }
  // Текст-инструкция, если браузер сам не умеет показывать окно установки.
  function installHowTo() {
    return isIOS()
      ? 'Открой сайт в Safari, нажми «Поделиться» (квадрат со стрелкой) и выбери «На экран «Домой»».'
      : 'В Chrome открой меню ⋮ и выбери «Добавить на главный экран» или «Установить приложение».';
  }
  function runInstall(done) {
    var e = installEvt; if (!e) return false;
    installEvt = null;
    e.prompt();
    e.userChoice.then(done, done);
    return true;
  }

  /* Всплывающая подсказка при входе: «теперь можно установить». Показывается один раз;
     если отложить — остаётся карточка в профиле. */
  var HINT_KEY = 'install-hint-seen';
  function hintSeen() { try { return localStorage.getItem(HINT_KEY) === '1'; } catch (e) { return true; } }
  function markHintSeen() { try { localStorage.setItem(HINT_KEY, '1'); } catch (e) { /* ничего */ } }
  function maybeShowInstallHint() {
    if (maybeShowInstallHint.done || isStandalone() || hintSeen()) return;
    var phone = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || window.innerWidth <= 640;
    if (!phone) return;
    maybeShowInstallHint.done = true;
    setTimeout(function tryShow() {
      if (S.stage !== 'app' || isStandalone()) return;
      if (document.querySelector('.celebrate') || S.gameState === 'play') { setTimeout(tryShow, 4000); return; }
      showInstallHint();
    }, 1500);
  }
  function showInstallHint() {
    var box = el('div', { class: 'install-hint', role: 'dialog', 'aria-label': 'Установить приложение' });
    function close(later) {
      markHintSeen();
      box.classList.add('out');
      setTimeout(function () { box.remove(); }, reduceMotion ? 0 : 220);
      if (later) toast('Установить можно позже в Профиле');
    }
    function main() {
      box.replaceChildren(
        el('div', { class: 'ih-row' }, [
          el('img', { class: 'ih-icon', src: 'icon-192.png', alt: '', width: 48, height: 48 }),
          el('div', { class: 'ih-text' }, [
            el('p', { class: 'ih-title', text: 'Теперь можно установить как приложение' }),
            el('p', { class: 'ih-sub', text: 'Иконка на экране телефона, открывается без браузера. Если не сейчас — это можно сделать позже в Профиле.' })
          ])
        ]),
        el('div', { class: 'ih-actions' }, [
          el('button', { type: 'button', class: 'btn', text: 'Позже', onclick: function () { close(true); } }),
          el('button', {
            type: 'button', class: 'btn primary', text: 'Установить',
            onclick: function () {
              if (runInstall(function () { if (S.view === 'profile') render(); })) { close(false); return; }
              howTo();
            }
          })
        ])
      );
    }
    function howTo() {
      box.replaceChildren(
        el('p', { class: 'ih-title', text: 'Как установить' }),
        el('p', { class: 'ih-sub', text: installHowTo() }),
        el('div', { class: 'ih-actions' }, [el('button', { type: 'button', class: 'btn primary', text: 'Понятно', onclick: function () { close(false); } })])
      );
    }
    main();
    document.body.appendChild(box);
  }

  function installCard() {
    if (isStandalone()) return null; // уже открыто как приложение
    var body;
    if (installEvt) {
      body = [
        el('p', { class: 'muted', text: 'Иконка появится на экране телефона, и сайт будет открываться как отдельное приложение.' }),
        el('div', { class: 'row actions' }, [el('button', {
          type: 'button', class: 'btn primary', text: 'Установить',
          onclick: function () { runInstall(function () { render(); }); }
        })])
      ];
    } else {
      body = [el('p', { class: 'muted', text: installHowTo() })];
    }
    return el('div', { class: 'card stack tight install-card' }, [el('p', { class: 'install-title', text: '📱 Приложение на телефоне' })].concat(body));
  }

  function init() {
    document.title = APP;
    setupInstall();
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      S.stage = 'fatal';
      S.fatal = new Error('Не загрузилась библиотека Supabase. Проверь интернет и обнови страницу.');
      render();
      return;
    }
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_KEY) {
      S.stage = 'fatal';
      S.fatal = new Error('В файле config.js не заполнены SUPABASE_URL и SUPABASE_KEY.');
      render();
      return;
    }
    // cache: 'no-store' — браузер не должен показывать старые ответы сервера, всегда спрашиваем базу заново.
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
      global: {
        fetch: function (url, opts) { return fetch(url, Object.assign({}, opts, { cache: 'no-store' })); }
      }
    });

    // Реакция на вход или выход в другой вкладке. Внутри обработчика нельзя ждать запросы к Supabase, поэтому setTimeout.
    sb.auth.onAuthStateChange(function (event, session) {
      if (event === 'SIGNED_OUT') {
        setTimeout(resetToAuth, 0);
      } else if (event === 'SIGNED_IN' && session && session.user.id !== S.userId) {
        S.session = session; S.userId = session.user.id;
        setTimeout(loadUserData, 0);
      } else if (session) {
        S.session = session;
      }
    });

    document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshQuietly(); });
    setupSwipe();
    // Заглавная буква: работает до обработчиков самих полей (capture), чтобы черновик сохранялся уже исправленным.
    function capField(t) { return t && t.dataset && t.dataset.cap; }
    document.addEventListener('input', function (ev) {
      var t = ev.target;
      if (capField(t)) { autoCap(t, ev); t._pv = t.value; }
    }, true);
    document.addEventListener('focusin', function (ev) {
      var t = ev.target;
      if (capField(t)) { t._pv = t.value; t._noCap = false; }
    });
    document.addEventListener('compositionend', function (ev) {
      var t = ev.target;
      if (!capField(t)) return;
      var data = ev.data || '';
      if (t._noCap) t._noCap = false;
      else if (data && capAt(t, t.selectionStart - data.length)) t.dispatchEvent(new Event('input', { bubbles: true }));
      t._pv = t.value;
    });
    // Если обновление пропустили, пока человек печатал, догоняем, когда он вышел из поля.
    document.addEventListener('focusout', flushStale);
    // Окно реакций закрывается кликом мимо него или клавишей Esc.
    document.addEventListener('click', function () { closePicker(); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closePicker(); });
    boot();
  }

  init();
})();
