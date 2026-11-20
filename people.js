/* Мини-профиль человека: нажал на имя или аватарку где угодно — маленькое окно по центру:
   аватарка, имя, знак зодиака, серия дней, «Сегодня: ответ есть / ещё нет», витрина и «Собрано X из 20».
   Сразу показываем то, что уже есть на телефоне (имя, аватарка, серия), витрину догружаем запросом member_profile.
   Ответы человека не показываем — чтобы не увидеть ответ раньше своего.
   Связь с сайтом — window.AppAPI (el, avatar, sb, memberInfo, zodiac), карточки — window.Cards. */
(function () {
  'use strict';
  var A = null;
  var ov = null;          // открытое окно
  var cache = {};         // профиль по id (на время сессии; при каждом открытии обновляется)
  var FIRE = (window.Icons && window.Icons.FIRE) || '🔥';

  function el() { return A.el.apply(null, arguments); }
  function setText(n, t) { if (window.Coin) window.Coin.fill(n, t); else n.textContent = t; }
  function plural(n, a, b, c) { return A.plural ? A.plural(n, a, b, c) : c; }

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

  // d — ответ базы (или null, пока грузится). Окно маленькое: аватарка, имя, знак, «сегодня», серия и витрина.
  function draw(sheet, uid, info, d, loading, failed) {
    var me = uid === A.me();
    var name = (d && d.name) || info.name || 'Без имени';
    var color = (d && d.color) || info.color, emoji = (d && d.avatar) || info.avatar;
    var zcode = (d && d.zodiac) || info.zodiac;
    var z = zcode && A.zodiac ? A.zodiac(zcode) : null;
    var pick = function (k) { return d && d[k] !== undefined && d[k] !== null ? d[k] : info[k]; };

    var av = A.avatar(name, color, false, emoji);
    av.classList.add('pf-av');
    var today = pick('answered_today'), streak = pick('streak');
    var line = el('p', { class: 'pf-meta' });
    if (z) line.appendChild(el('span', { class: 'pf-zod' }, [z.icon, z.name]));
    if (streak != null) {
      if (z) line.appendChild(el('span', { class: 'pf-dot', 'aria-hidden': 'true', text: '·' }));
      var st = el('span', { class: 'pf-streak' });
      setText(st, FIRE + ' ' + streak + ' ' + plural(streak, 'день', 'дня', 'дней') + ' подряд');
      line.appendChild(st);
    }
    var kids = [
      el('button', { type: 'button', class: 'pf-close kc-close', 'aria-label': 'Закрыть', text: '×', onclick: close }),
      el('div', { class: 'pf-head' }, [
        av,
        el('h2', { class: 'pf-name', text: name }),
        me ? el('span', { class: 'pf-me', text: 'это ты' }) : null,
        line.childNodes.length ? line : null,
        today === undefined ? null : el('span', { class: 'pf-today' + (today ? ' on' : ''), text: today ? 'Сегодня: ответ есть' : 'Сегодня: ответа ещё нет' })
      ])
    ];

    if (!d) {
      kids.push(el('p', { class: failed ? 'msg err' : 'muted pf-wait', text: failed ? 'Витрина не загрузилась. Проверь интернет.' : 'Загружаю витрину…' }));
    } else {
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
      if (failed) kids.push(el('p', { class: 'msg err', text: 'Не получилось обновить. Показано то, что было.' }));
    }
    if (me) {
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
