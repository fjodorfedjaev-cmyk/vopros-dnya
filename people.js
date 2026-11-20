/* Мини-профиль человека: нажал на имя или аватарку где угодно — окно по центру.
   Сразу показываем то, что уже есть на телефоне (имя, аватарка, серия, ответы, монеты), остальное
   догружается одним запросом member_profile: знак, «с нами с …», «сегодня», витрина, рекорды игр, дуэли, Дурак,
   счёт ваших дуэлей. Ответы человека не показываем — чтобы не увидеть ответ раньше своего.
   Кнопка «Вызвать на дуэль» ведёт в Игры → Сектор с уже выбранным человеком.
   Связь с сайтом — window.AppAPI (el, avatar, sb, memberInfo, zodiac, challenge), карточки — window.Cards. */
(function () {
  'use strict';
  var A = null;
  var ov = null;          // открытое окно
  var cache = {};         // профиль по id (на время сессии; при каждом открытии обновляется)
  var FIRE = (window.Icons && window.Icons.FIRE) || '🔥';

  function el() { return A.el.apply(null, arguments); }
  function setText(n, t) { if (window.Coin) window.Coin.fill(n, t); else n.textContent = t; }
  function num(n) { return Number(n || 0).toLocaleString('ru-RU'); }
  function coins(n) { var c = Math.round(Number(n || 0) * 100); return (Math.floor(c / 100)).toLocaleString('ru-RU'); }
  function plural(n, a, b, c) { return A.plural ? A.plural(n, a, b, c) : c; }
  var fmtDay = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
  var fmtDayYear = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  function joinedText(s) {
    var d = new Date(s);
    if (isNaN(d)) return '';
    return 'с нами с ' + (d.getFullYear() === new Date().getFullYear() ? fmtDay : fmtDayYear).format(d);
  }

  function close() {
    if (!ov) return;
    if (ov._off) ov._off();
    ov.remove();
    ov = null;
    document.body.classList.remove('pf-lock');
  }

  async function open(uid) {
    A = window.AppAPI;
    if (!A || !uid) return;
    close();
    var info = A.memberInfo ? A.memberInfo(uid) : {};
    ov = el('div', { class: 'kc-overlay pf-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Профиль: ' + (info.name || 'участник') });
    var o = ov;
    // Esc закрывает только это окно (а не страницу карточки под ним) — ловим раньше остальных и дальше не пускаем
    function onKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKey, true);
    o._off = function () { document.removeEventListener('keydown', onKey, true); };
    o.addEventListener('click', function (ev) { if (ev.target === o) close(); });
    var sheet = el('div', { class: 'pf' });
    o.appendChild(sheet);
    document.body.appendChild(o);
    document.body.classList.add('pf-lock');
    draw(sheet, uid, info, cache[uid] || null, !cache[uid]);
    var x = sheet.querySelector('.pf-close'); if (x) x.focus({ preventScroll: true });
    try {
      var r = await A.sb().rpc('member_profile', { p_user: uid });
      if (r.error) throw r.error;
      if (ov !== o) return;
      if (r.data) cache[uid] = r.data;
      draw(sheet, uid, info, r.data, false);
    } catch (e) {
      if (ov !== o) return;
      draw(sheet, uid, info, cache[uid] || null, false, true);
    }
  }

  // d — ответ базы (или null, пока грузится); loading — показать «Загружаю…» на месте того, чего ещё нет
  function draw(sheet, uid, info, d, loading, failed) {
    var me = uid === A.me();
    var name = (d && d.name) || info.name || 'Без имени';
    var color = (d && d.color) || info.color, emoji = (d && d.avatar) || info.avatar;
    var zcode = (d && d.zodiac) || info.zodiac;
    var z = zcode && A.zodiac ? A.zodiac(zcode) : null;
    var pick = function (k) { return d && d[k] !== undefined && d[k] !== null ? d[k] : info[k]; };

    var av = A.avatar(name, color, false, emoji);
    av.classList.add('pf-av');
    var meta = [];
    if (z) meta.push(el('span', { class: 'pf-zod' }, [z.icon, z.name]));
    if (d && d.joined) meta.push(el('span', { text: joinedText(d.joined) }));
    var today = pick('answered_today');
    var head = el('div', { class: 'pf-head' }, [
      av,
      el('h2', { class: 'pf-name', text: name }),
      me ? el('span', { class: 'pf-me', text: 'это ты' }) : null,
      meta.length ? el('p', { class: 'pf-meta' }, meta.reduce(function (acc, n, i) { if (i) acc.push(el('span', { class: 'pf-dot', 'aria-hidden': 'true', text: '·' })); acc.push(n); return acc; }, [])) : null,
      today === undefined ? null : el('span', { class: 'pf-today' + (today ? ' on' : ''), text: today ? 'Сегодня: ответ есть' : 'Сегодня: ответа ещё нет' })
    ]);

    function tile(value, label, sub, cls) {
      var v = el('b', { class: 'pf-v' });
      setText(v, value == null ? '…' : value);
      return el('div', { class: 'pf-tile' + (cls ? ' ' + cls : '') }, [v, el('span', { class: 'pf-l', text: label }), sub ? el('small', { text: sub }) : null]);
    }
    var streak = pick('streak'), best = pick('best_streak'), answers = pick('answers'), coinsV = pick('coins'), reacts = pick('reactions');
    var tiles = el('div', { class: 'pf-tiles' }, [
      tile(streak == null ? null : FIRE + ' ' + streak, 'серия дней', best != null ? 'лучшая ' + best : null, 'pf-fire'),
      tile(answers == null ? null : num(answers), plural(answers || 0, 'ответ', 'ответа', 'ответов')),
      tile(coinsV == null ? null : coins(coinsV) + ' 🪙', 'монеты'),
      tile(reacts == null ? null : num(reacts), plural(reacts || 0, 'реакция', 'реакции', 'реакций') + ' на ответы')
    ]);

    var kids = [el('button', { type: 'button', class: 'pf-close kc-close', 'aria-label': 'Закрыть', text: '×', onclick: close }), head, tiles];

    if (!d) {
      kids.push(el('p', { class: failed ? 'msg err' : 'muted pf-wait', text: failed ? 'Остальное не загрузилось. Проверь интернет.' : 'Загружаю…' }));
    } else {
      // витрина
      var shelf = d.shelf || [];
      var slots = [0, 1, 2].map(function (i) {
        var c = shelf[i];
        if (!c) return el('div', { class: 'shelf shelf-empty' }, [el('span', { text: 'пусто' })]);
        var b = el('button', { type: 'button', class: 'shelf', 'aria-label': c.name + ' — крупно', onclick: function () { zoom(sheet, uid, info, d, c); } });
        b.appendChild(window.Cards.face(c, c.serial, 'md'));
        return b;
      });
      kids.push(el('section', { class: 'pf-sect' }, [
        el('div', { class: 'pf-sh' }, [el('h3', { text: 'Витрина' }), el('span', { text: 'Собрано ' + (d.cards || 0) + ' из ' + (d.cards_total || 0) })]),
        el('div', { class: 'shelves pf-shelves' }, slots)
      ]));
      // игры
      var du = d.duels || {}, dk = d.durak || {};
      function row(label, value) { return el('div', { class: 'pf-row' }, [el('span', { text: label }), el('span', { text: value })]); }
      var duelText = (du.won || du.lost || du.draw)
        ? du.won + ' ' + plural(du.won, 'победа', 'победы', 'побед') + ' · ' + du.lost + ' ' + plural(du.lost, 'поражение', 'поражения', 'поражений') + (du.draw ? ' · ' + du.draw + ' ' + plural(du.draw, 'ничья', 'ничьи', 'ничьих') : '')
        : 'пока не было';
      var durakText = dk.games
        ? dk.games + ' ' + plural(dk.games, 'партия', 'партии', 'партий') + ' · ' + (dk.first || 0) + ' ' + plural(dk.first || 0, 'раз', 'раза', 'раз') + ' первым'
        : 'пока не было';
      kids.push(el('section', { class: 'pf-sect' }, [
        el('div', { class: 'pf-sh' }, [el('h3', { text: 'Игры' })]),
        el('div', { class: 'pf-rows' }, [
          row('Сектор', d.sector_best != null ? 'рекорд ' + num(d.sector_best) : 'рекорда пока нет'),
          row('Зигзаг', d.zigzag_best != null ? 'рекорд ' + num(d.zigzag_best) : 'рекорда пока нет'),
          row('Дуэли', duelText),
          row('Дурак', durakText)
        ])
      ]));
      // между вами
      if (!me && d.vs) {
        var total = (d.vs.me || 0) + (d.vs.them || 0) + (d.vs.draw || 0);
        kids.push(el('section', { class: 'pf-vs' }, total ? [
          el('span', { class: 'pf-vs-l', text: 'Ваши дуэли' }),
          el('div', { class: 'pf-vs-score' }, [
            el('span', { class: 'pf-vs-n', text: 'Ты' }), el('b', { text: (d.vs.me || 0) + ' : ' + (d.vs.them || 0) }), el('span', { class: 'pf-vs-n', text: name })
          ]),
          d.vs.draw ? el('small', { text: 'и ' + d.vs.draw + ' ' + plural(d.vs.draw, 'ничья', 'ничьи', 'ничьих') }) : null
        ] : [el('span', { class: 'pf-vs-l', text: 'Дуэлей между вами ещё не было' })]));
      }
    }
    if (failed && d) kids.push(el('p', { class: 'msg err', text: 'Не получилось обновить. Показано то, что было.' }));
    // действия
    if (!me) {
      kids.push(el('div', { class: 'kc-actions' }, [el('button', { type: 'button', class: 'btn primary', text: 'Вызвать на дуэль', onclick: function () {
        close();
        if (A.challenge) A.challenge(uid);
      } })]));
    } else {
      kids.push(el('div', { class: 'kc-actions' }, [el('button', { type: 'button', class: 'btn', text: 'Изменить профиль', onclick: function () {
        close();
        if (A.go) A.go('profile');
      } })]));
    }
    sheet.replaceChildren.apply(sheet, kids.filter(Boolean));
  }

  // Карточка с витрины крупно — в том же окне, «Назад» возвращает профиль
  function zoom(sheet, uid, info, d, c) {
    var R = (window.Cards.RARITY || {})[c.rarity] || { name: '' };
    sheet.replaceChildren(
      el('button', { type: 'button', class: 'pf-close kc-close', 'aria-label': 'Закрыть', text: '×', onclick: close }),
      el('div', { class: 'pf-zoom' }, [window.Cards.face(c, c.serial, 'lg')]),
      el('p', { class: 'kb-info', text: R.name + ' · ' + (c.copies === 1 ? '1/1' : '№' + c.serial + ' из ' + c.copies) }),
      el('div', { class: 'kc-actions' }, [el('button', { type: 'button', class: 'btn', text: 'Назад', onclick: function () { draw(sheet, uid, info, d, false); } })])
    );
  }

  window.People = { open: open, close: close };
})();
