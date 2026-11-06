/* Вкладка «Коллекция»: колода, открытие карточки по нажатиям, коллекция, витрина, переплавка.
   Что выпало — решает база (функция cards_open) в момент оплаты. Нажатия при открытии ничего не меняют,
   они только красиво раскрывают уже выпавшую карточку. Даже если закрыть приложение посередине,
   карточка уже лежит в коллекции.
   Связь с сайтом — через window.AppAPI (sb, el, toast, баланс), рисунки — window.Cards. */
(function () {
  'use strict';
  var A = null;                 // AppAPI, появляется после запуска сайта
  var root = null;              // корневой элемент вкладки (живёт между перерисовками)
  var SERIES = 1;               // серия «Начало»
  var K = { catalog: null, my: null, deck: null, err: null, busy: false, msg: '' };
  var ov = null;                // открытое окно поверх страницы (карточка крупно, открытие, витрина друга)
  var reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function el() { return A.el.apply(null, arguments); }
  function R(r) { return window.Cards.RARITY[r] || window.Cards.RARITY.common; }
  function bal() { return A.balance(); }
  function one(d) { return Array.isArray(d) ? d[0] : d; }
  // текст с 🪙 → текст с нашей монетой
  function setText(n, t) { if (window.Coin) window.Coin.fill(n, t); else n.textContent = t; }
  async function rpc(name, args) {
    var r = await A.sb().rpc(name, args || {});
    if (r.error) throw r.error;
    return r.data;
  }
  function errText(e) {
    var m = String((e && (e.message || e.details)) || e || '');
    if (/cards_price_changed/.test(m)) return 'Цена изменилась, пока ты смотрел. Глянь новую и нажми ещё раз.';
    if (/cards_not_enough/.test(m)) return 'Не хватает монет.';
    if (/cards_deck_empty/.test(m)) return 'Колода закончилась.';
    if (/cards_last_copy/.test(m)) return 'Это последняя копия в игре — её не переплавить.';
    if (/cards_no_melt/.test(m)) return 'Легендарную не переплавить.';
    if (/cards_in_showcase/.test(m)) return 'Сначала убери карточку с витрины.';
    if (/cards_not_yours/.test(m)) return 'Эта карточка уже не твоя.';
    if (/not_member/.test(m)) return 'Сначала войди по коду приглашения.';
    if (/does not exist|could not find|schema cache/i.test(m)) return 'Коллекция ещё не готова: база не обновлена.';
    return 'Не получилось. Проверь интернет и попробуй ещё раз.';
  }

  /* ---------- данные ---------- */
  function cardById(id) { return (K.catalog || []).filter(function (c) { return c.card_id === id; })[0] || null; }
  function myCopies(cardId) { return (K.my || []).filter(function (k) { return k.card_id === cardId; }).sort(function (a, b) { return a.serial - b.serial; }); }
  async function load() {
    var res = await Promise.all([rpc('cards_catalog', { p_series: SERIES }), rpc('cards_my'), rpc('cards_deck', { p_series: SERIES })]);
    K.catalog = res[0] || [];
    K.my = res[1] || [];
    K.deck = one(res[2]) || null;
  }
  async function reload() {
    try { await load(); K.err = null; } catch (e) { K.err = e; }
    draw();
  }

  /* ---------- вкладка ---------- */
  function view() {
    if (!root) { root = el('div', { class: 'coll' }); bindDrag(root); }
    draw();
    return root;
  }
  async function enter() {
    A = window.AppAPI;
    await reload();
  }
  function leave() { closeOverlay(); }

  function draw() {
    if (!root) return;
    root.replaceChildren();
    if (!K.catalog) {
      if (K.err) { var m = el('p', { class: 'msg err', role: 'alert' }); setText(m, errText(K.err)); root.appendChild(m); }
      else root.appendChild(el('p', { class: 'muted', text: 'Загружаю…' }));
      return;
    }
    root.appendChild(deckCard());
    root.appendChild(showcaseSect());
    window.Cards.ORDER.forEach(function (r) { root.appendChild(groupSect(r)); });
  }

  // Колода: прогресс коллекции, какие редкости ещё есть, кнопка «Открыть карточку».
  function deckCard() {
    var d = K.deck || {};
    var total = K.catalog.length;
    var got = {}; (K.my || []).forEach(function (k) { got[k.card_id] = true; });
    var n = Object.keys(got).length;
    var price = d.price;
    var left = { common: d.left_common, uncommon: d.left_uncommon, rare: d.left_rare, epic: d.left_epic, legendary: d.left_legendary };
    var dots = window.Cards.ORDER.map(function (r) {
      var on = left[r] > 0;
      return el('span', { class: 'kd-dot r-' + r + (on ? '' : ' off'), title: R(r).name + (on ? ': есть в колоде' : ': в колоде уже нет') });
    });
    var btn = el('button', { type: 'button', class: 'btn primary coll-open' });
    if (price) setText(btn, 'Открыть карточку · ' + price + ' 🪙'); else btn.textContent = 'Колода закончилась';
    btn.disabled = !price || K.busy || bal() < price;
    btn.addEventListener('click', openCard);
    var msg = el('p', { class: 'msg', role: 'status', id: 'coll-msg' });
    if (K.msg) setText(msg, K.msg);
    else if (price && bal() < price) setText(msg, 'Не хватает: у тебя ' + A.fmt(Math.floor(bal())) + ' 🪙, нужно ' + price + '.');
    return el('section', { class: 'card coll-deck' }, [
      el('div', { class: 'coll-row' }, [
        el('span', { class: 'coll-got', text: 'Собрано ' + n + ' из ' + total }),
        el('span', { class: 'coll-series', text: 'Серия «' + (d.series_name || 'Начало') + '»' })
      ]),
      el('div', { class: 'coll-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(n), 'aria-label': 'Собрано карточек' },
        [el('span', { style: 'width:' + (total ? Math.round(n / total * 100) : 0) + '%' })]),
      el('div', { class: 'coll-row' }, [
        el('span', { class: 'kd-dots', 'aria-label': 'Какие редкости ещё есть в колоде' }, dots),
        el('span', { class: 'coll-left', text: 'в колоде ' + (d.deck_left || 0) + ' из ' + (d.deck_total || 0) })
      ]),
      btn,
      msg
    ]);
  }

  // Витрина: 3 полки. Карточку туда ставят из окна карточки («На витрину»).
  function showcaseSect() {
    var on = shelved();
    var slots = [0, 1, 2].map(function (i) {
      var k = on[i];
      var c = k && cardById(k.card_id);
      if (!c) {
        return el('button', { type: 'button', class: 'shelf shelf-empty', 'data-drop': String(i), onclick: function () { if (!justDragged()) A.toast('Зажми карточку в коллекции и перетащи сюда'); } },
          [el('span', { text: 'пусто' })]);
      }
      var b = el('button', {
        type: 'button', class: 'shelf', 'aria-label': c.name + ' на витрине', 'data-drop': String(i), 'data-drag': 'shelf:' + k.copy_id,
        onclick: function () { if (!justDragged()) openDetail(c.card_id, k.copy_id); }
      });
      b.appendChild(window.Cards.face(c, k.serial, 'md'));
      return b;
    });
    return el('section', { class: 'sect' }, [el('h2', { text: 'Витрина' }), el('div', { class: 'shelves' }, slots)]);
  }

  // Одна редкость: заголовок со счётчиком и сетка. Нет карточки — «?» и название (видно, что искать).
  function groupSect(r) {
    var cards = K.catalog.filter(function (c) { return c.rarity === r; });
    var have = cards.filter(function (c) { return myCopies(c.card_id).length; }).length;
    var tiles = cards.map(function (c) {
      var mine = myCopies(c.card_id);
      if (!mine.length) {
        return el('div', { class: 'kt kt-miss' }, [el('span', { class: 'kt-pic', 'aria-hidden': 'true', text: '?' }), el('span', { class: 'kt-name', text: c.name })]);
      }
      var pic = el('span', { class: 'kt-pic' });
      pic.appendChild(window.Cards.art(c.code));
      if (mine.length > 1) pic.appendChild(el('span', { class: 'kt-count', text: '×' + mine.length }));
      return el('button', {
        type: 'button', class: 'kt r-' + r, 'aria-label': c.name + (mine.length > 1 ? ', копий: ' + mine.length : ''), 'data-drag': 'grid:' + c.card_id,
        onclick: function () { if (!justDragged()) openDetail(c.card_id); }
      }, [pic, el('span', { class: 'kt-name', text: c.name })]);
    });
    return el('section', { class: 'sect coll-group' }, [
      el('div', { class: 'coll-gh' }, [
        el('h2', null, [el('span', { class: 'kd-dot r-' + r, 'aria-hidden': 'true' }), R(r).plural]),
        el('span', { class: 'coll-left', text: have + ' / ' + cards.length })
      ]),
      el('div', { class: 'coll-grid' }, tiles)
    ]);
  }

  /* ---------- окно поверх страницы ---------- */
  function closeOverlay() {
    if (!ov) return;
    if (ov._cleanup) ov._cleanup();
    ov.remove();
    ov = null;
    document.body.classList.remove('kc-lock');
  }
  function overlay(cls, label) {
    closeOverlay();
    ov = el('div', { class: cls, role: 'dialog', 'aria-modal': 'true', 'aria-label': label });
    document.body.appendChild(ov);
    document.body.classList.add('kc-lock');
    return ov;
  }
  function onKey(fn) {
    function h(ev) { if (ev.key === 'Escape') fn(); }
    document.addEventListener('keydown', h);
    return function () { document.removeEventListener('keydown', h); };
  }

  // Карточка крупно: номер копии, выбор копии (если их несколько), витрина, переплавка.
  function openDetail(cardId, copyId) {
    var c = cardById(cardId);
    var copies = myCopies(cardId);
    if (!c || !copies.length) { closeOverlay(); return; }
    var sel = copies.filter(function (k) { return k.copy_id === copyId; })[0] || copies[0];
    var o = overlay('kc-overlay', c.name);
    o._cleanup = onKey(closeOverlay);
    o.addEventListener('click', function (ev) { if (ev.target === o) closeOverlay(); });

    var sheet = el('div', { class: 'kc-sheet' });
    var msg = el('p', { class: 'msg', role: 'status' });
    sheet.appendChild(el('button', { type: 'button', class: 'kc-close', 'aria-label': 'Закрыть', text: '×', onclick: closeOverlay }));
    sheet.appendChild(window.Cards.face(c, sel.serial, 'lg'));

    if (copies.length > 1) {
      sheet.appendChild(el('div', { class: 'kc-copies', role: 'group', 'aria-label': 'Твои копии' }, copies.map(function (k) {
        return el('button', {
          type: 'button', class: 'kc-chip', 'aria-pressed': String(k.copy_id === sel.copy_id), text: '№' + k.serial,
          onclick: function () { if (k.copy_id !== sel.copy_id) openDetail(cardId, k.copy_id); }
        });
      })));
    }

    var acts = el('div', { class: 'kc-actions' });
    // витрина
    if (sel.slot) {
      acts.appendChild(el('button', { type: 'button', class: 'btn', text: 'Убрать с витрины', onclick: function () { shelfRemove(cardId, sel, msg); } }));
    } else {
      acts.appendChild(el('button', { type: 'button', class: 'btn', text: 'На витрину', onclick: function () { shelfAdd(cardId, sel, msg); } }));
    }
    // переплавка: в два нажатия, чтобы не промахнуться
    if (c.melt_value) {
      if (sel.can_melt) {
        var melt = el('button', { type: 'button', class: 'btn' });
        setText(melt, 'Переплавить за ' + c.melt_value + ' 🪙');
        var armed = false, t = null;
        melt.addEventListener('click', function () {
          if (!armed) {
            armed = true; melt.classList.add('danger'); setText(melt, 'Точно? Копия №' + sel.serial + ' исчезнет');
            t = setTimeout(function () { armed = false; melt.classList.remove('danger'); setText(melt, 'Переплавить за ' + c.melt_value + ' 🪙'); }, 3000);
            return;
          }
          clearTimeout(t);
          doMelt(c, sel, melt, msg);
        });
        acts.appendChild(melt);
      } else {
        acts.appendChild(el('p', { class: 'kc-note', text: sel.slot ? 'Чтобы переплавить, сначала убери с витрины.' : 'Последняя копия в игре — её не переплавить.' }));
      }
    } else {
      acts.appendChild(el('p', { class: 'kc-note', text: 'Легендарную не переплавить.' }));
    }
    sheet.appendChild(acts);
    sheet.appendChild(msg);
    o.appendChild(sheet);
    var first = sheet.querySelector('.kc-close'); if (first) first.focus();
  }

  // Витрина всегда «плотная»: карточки стоят слева направо без пустых мест.
  function shelved() {
    return (K.my || []).filter(function (x) { return x.slot; }).sort(function (a, b) { return a.slot - b.slot; });
  }
  // Новая — на первую свободную полку слева. Полная витрина — просим сначала убрать одну.
  async function shelfAdd(cardId, sel, msg) {
    var on = shelved();
    if (on.length >= 3) { setText(msg, 'Витрина полная: сначала убери одну карточку.'); return; }
    await shelfSave(cardId, sel, msg, 'Поставлено на витрину', async function () {
      await packShelves(on);   // на всякий случай убираем дыры, если они были
      await rpc('cards_set_showcase', { p_slot: on.length + 1, p_copy: sel.copy_id });
    });
  }
  // Убрали — те, что стояли правее, сдвигаются влево.
  async function shelfRemove(cardId, sel, msg) {
    var rest = shelved().filter(function (x) { return x.copy_id !== sel.copy_id; });
    await shelfSave(cardId, sel, msg, 'Убрано с витрины', async function () {
      await rpc('cards_set_showcase', { p_slot: sel.slot, p_copy: null });
      await packShelves(rest);
    });
  }
  // Ставит карточки по порядку на полки 1, 2, 3 (двигает только те, что стоят не на своём месте).
  async function packShelves(list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].slot !== i + 1) await rpc('cards_set_showcase', { p_slot: i + 1, p_copy: list[i].copy_id });
    }
  }
  async function shelfSave(cardId, sel, msg, done, work) {
    setText(msg, 'Сохраняю…');
    try {
      await work();
      await load();
      draw();
      closeOverlay();
      A.toast(done);
    } catch (e) {
      setText(msg, errText(e));
      try { await load(); draw(); } catch (e2) { /* ничего */ }
    }
  }

  async function doMelt(c, sel, btn, msg) {
    btn.disabled = true;
    setText(msg, 'Переплавляю…');
    try {
      var r = one(await rpc('cards_melt', { p_copy: sel.copy_id }));
      if (r) A.setBalance(Number(r.balance));
      await load();
      draw();
      A.toast('+' + c.melt_value + ' 🪙 за «' + c.name + '»');
      if (myCopies(c.card_id).length) openDetail(c.card_id); else closeOverlay();
    } catch (e) { setText(msg, errText(e)); btn.disabled = false; }
  }


  /* ---------- перетаскивание: зажми карточку ---------- */
  // Зажал карточку (≈0,4 с, не двигая палец) — она «поднимается» и едет за пальцем.
  // С витрины — можно поменять местами с другой полкой. Из коллекции — сверху появляются три полки:
  // на пустую карточка встаёт, на занятую — заменяет ту, что там стоит.
  // Обычное нажатие открывает карточку, а движение пальцем без задержки — это прокрутка страницы.
  var LONG = 380, SLOP = 9;
  var drag = null;
  var noClickUntil = 0;
  function justDragged() { return Date.now() < noClickUntil; }

  function bindDrag(node) {
    node.addEventListener('touchstart', function (ev) { if (ev.touches.length === 1) start(ev, ev.touches[0]); }, { passive: true });
    // не пассивный: пока карточка «поднята», страница не должна прокручиваться
    node.addEventListener('touchmove', function (ev) { if (drag) move(ev, ev.touches[0]); }, { passive: false });
    node.addEventListener('touchend', function (ev) { if (drag) end(ev); });
    node.addEventListener('touchcancel', function () { cancel(); });
    node.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      start(ev, ev);
      if (!drag) return;
      function mm(e) { move(e, e); }
      function mu(e) { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); end(e); }
      document.addEventListener('mousemove', mm);
      document.addEventListener('mouseup', mu);
    });
    // долгое нажатие не должно открывать системное меню
    node.addEventListener('contextmenu', function (ev) { if (ev.target.closest && ev.target.closest('[data-drag]')) ev.preventDefault(); });
  }

  function start(ev, p) {
    cancel();
    var t = ev.target.closest && ev.target.closest('[data-drag]');
    if (!t || K.busy) return;
    var parts = t.getAttribute('data-drag').split(':');
    drag = { kind: parts[0], id: Number(parts[1]), node: t, x0: p.clientX, y0: p.clientY, x: p.clientX, y: p.clientY, active: false, over: null };
    drag.timer = setTimeout(lift, LONG);
  }
  function move(ev, p) {
    if (!drag) return;
    drag.x = p.clientX; drag.y = p.clientY;
    if (!drag.active) {
      if (Math.abs(drag.x - drag.x0) > SLOP || Math.abs(drag.y - drag.y0) > SLOP) cancel(); // это прокрутка
      return;
    }
    if (ev.cancelable) ev.preventDefault();
    place();
    var hit = document.elementFromPoint(drag.x, drag.y);
    var over = hit && hit.closest ? hit.closest('[data-drop]') : null;
    if (over !== drag.over) {
      if (drag.over) drag.over.classList.remove('drop-over');
      if (over) over.classList.add('drop-over');
      drag.over = over;
    }
  }
  function end(ev) {
    if (!drag) return;
    var d = drag;
    if (!d.active) { cancel(); return; } // короткое нажатие — обычный клик
    if (ev.cancelable) ev.preventDefault();
    if (ev.stopPropagation) ev.stopPropagation(); // чтобы не сработало перелистывание вкладок
    noClickUntil = Date.now() + 450;
    var target = d.over ? Number(d.over.getAttribute('data-drop')) : null;
    cancel();
    if (target !== null && !isNaN(target)) dropTo(d, target);
  }
  function cancel() {
    if (!drag) return;
    clearTimeout(drag.timer);
    if (drag.ghost) drag.ghost.remove();
    if (drag.bar) drag.bar.remove();
    if (drag.over) drag.over.classList.remove('drop-over');
    if (drag.node) drag.node.classList.remove('kc-lifting');
    document.body.classList.remove('kc-dragging');
    drag = null;
  }

  // Карточка «поднялась»: тень под пальцем, а для карточки из коллекции — полки сверху экрана.
  function lift() {
    if (!drag) return;
    var c = drag.kind === 'shelf' ? cardOfCopy(drag.id) : cardById(drag.id);
    if (!c) { cancel(); return; }
    drag.active = true;
    drag.node.classList.add('kc-lifting');
    document.body.classList.add('kc-dragging');
    var pic = el('span', { class: 'kt-pic r-' + c.rarity });
    pic.appendChild(window.Cards.art(c.code));
    drag.ghost = el('div', { class: 'kc-ghost', 'aria-hidden': 'true' }, [pic]);
    document.body.appendChild(drag.ghost);
    place();
    if (drag.kind === 'grid') {
      var on = shelved();
      drag.bar = el('div', { class: 'kc-dropbar', 'aria-hidden': 'true' }, [0, 1, 2].map(function (i) {
        var k = on[i], oc = k && cardById(k.card_id);
        var t = el('div', { class: 'kc-drop' + (oc ? ' r-' + oc.rarity : ''), 'data-drop': String(i) });
        if (oc) t.appendChild(window.Cards.art(oc.code)); else t.textContent = '+';
        return t;
      }));
      document.body.appendChild(drag.bar);
    }
  }
  function place() {
    if (drag && drag.ghost) drag.ghost.style.transform = 'translate(' + drag.x + 'px,' + drag.y + 'px) translate(-50%, -62%) rotate(-3deg)';
  }
  function cardOfCopy(copyId) {
    var k = (K.my || []).filter(function (x) { return x.copy_id === copyId; })[0];
    return k ? cardById(k.card_id) : null;
  }

  // Что делать, когда карточку отпустили над полкой номер t (0, 1, 2).
  async function dropTo(d, t) {
    var on = shelved();
    var order = on.map(function (k) { return k.copy_id; });
    var copyId = null, msg = '';
    if (d.kind === 'shelf') {
      copyId = d.id;
    } else {
      // если какая-то копия этой карточки уже на витрине — просто двигаем её
      var mine = myCopies(d.id);
      var shelf = mine.filter(function (k) { return k.slot; })[0];
      copyId = shelf ? shelf.copy_id : (mine[0] && mine[0].copy_id);
    }
    if (!copyId) return;
    var from = order.indexOf(copyId);
    if (from >= 0) {
      if (t === from) return;
      if (t < order.length) { order[from] = order[t]; order[t] = copyId; msg = 'Поменял местами'; }
      else { order.splice(from, 1); order.push(copyId); msg = 'Передвинул'; }
    } else if (t < order.length) {
      order[t] = copyId; msg = 'Поставлено на витрину';     // заменяет ту, что стояла
    } else {
      order.push(copyId); msg = 'Поставлено на витрину';    // на первую свободную слева
    }
    K.busy = true;
    try {
      // пишем полки по порядку; убранная (при замене) уходит с витрины сама
      for (var i = 0; i < order.length; i++) {
        var was = on.filter(function (k) { return k.copy_id === order[i]; })[0];
        if (!was || was.slot !== i + 1) await rpc('cards_set_showcase', { p_slot: i + 1, p_copy: order[i] });
      }
      A.toast(msg);
    } catch (e) {
      A.toast(errText(e));
    }
    K.busy = false;
    await reload();
  }

  /* ---------- открытие карточки ---------- */
  // Сначала платим (база выбирает карточку), потом раскрываем по нажатиям:
  // рубашка → серый фон → (если редкость выше) зелёный → синий → фиолетовый → золотой → переворот.
  async function openCard() {
    if (K.busy || !K.deck || !K.deck.price) return;
    var price = K.deck.price;
    if (bal() < price) { K.msg = 'Не хватает монет.'; draw(); return; }
    K.busy = true; K.msg = '';
    var had = {}; (K.my || []).forEach(function (k) { had[k.card_id] = true; });

    var o = overlay('kr', 'Открытие карточки');
    var layers = [1, 2, 3, 4, 5].map(function (i) { return el('div', { class: 'kr-l kr-l' + i, 'aria-hidden': 'true' }); });
    layers.forEach(function (l) { o.appendChild(l); });
    var flip = el('div', { class: 'kr-flip' });
    var backFace = el('div', { class: 'kr-face kr-back' }, [window.Cards.back('lg')]);
    var frontFace = el('div', { class: 'kr-face kr-front' });
    flip.appendChild(backFace); flip.appendChild(frontFace);
    var stage = el('button', { type: 'button', class: 'kr-stage kr-wait', 'aria-label': 'Открыть' }, [flip]);
    var result = el('div', { class: 'kr-result' });
    o.appendChild(stage); o.appendChild(result);
    stage.focus();

    var res = null, level = 0, rank = 0, done = false;
    function setLevel(l) {
      layers.forEach(function (x, i) { x.classList.toggle('on', i + 1 === l); });
      var r = window.Cards.ORDER[l - 1];
      o.style.setProperty('--glow', l ? R(r).color : 'transparent');
    }
    function shake() {
      if (reduce) return;
      stage.classList.remove('kr-shake'); void stage.offsetWidth; stage.classList.add('kr-shake');
    }
    function step() {
      if (!res || done) return;
      if (level < rank) { level++; setLevel(level); shake(); return; }
      reveal();
    }
    function reveal() {
      if (done) return;
      done = true;
      level = rank; setLevel(rank);
      var card = { code: res.code, name: res.name, rarity: res.rarity, copies: res.copies };
      frontFace.appendChild(window.Cards.face(card, res.serial, 'lg'));
      flip.classList.add('flipped');
      stage.setAttribute('aria-label', res.name);
      if (res.rarity === 'legendary' && !reduce) sparkle(o);
      setTimeout(function () { showResult(card); }, reduce ? 0 : 650);
    }
    function showResult(card) {
      var isNew = !had[res.card_id];
      var cat = cardById(res.card_id);
      var sub = isNew ? R(res.rarity).name + ' · ' + (res.copies === 1 ? 'единственная в игре' : '№' + res.serial + ' из ' + res.copies)
        : 'Повтор' + (cat && cat.melt_value ? ' — можно переплавить за ' + cat.melt_value + ' 🪙' : '');
      var title = el('p', { class: 'kr-title', text: isNew ? 'Новая карточка!' : card.name });
      var subEl = el('p', { class: 'kr-sub' }); setText(subEl, sub);
      var again = el('button', { type: 'button', class: 'btn primary' });
      var next = res.next_price;
      if (next) setText(again, 'Открыть ещё · ' + next + ' 🪙'); else again.textContent = 'Колода закончилась';
      again.disabled = !next || bal() < next;
      again.addEventListener('click', function () { finish(true); });
      var ok = el('button', { type: 'button', class: 'btn', text: 'Готово', onclick: function () { finish(false); } });
      result.replaceChildren(title, subEl, el('div', { class: 'kr-btns' }, [again, ok]));
      result.classList.add('on');
      ok.focus();
    }
    async function finish(more) {
      closeOverlay();
      K.busy = false;
      await reload();
      if (more) openCard();
    }

    o.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('button');
      if (b && b !== stage) return; // свои кнопки («Готово», «Открыть ещё») работают сами
      step();
    });
    o._cleanup = onKey(function () { if (done) finish(false); });

    try {
      res = one(await rpc('cards_open', { p_series: SERIES, p_price: price }));
      if (!res) throw new Error('empty');
      A.setBalance(Number(res.balance));
      rank = R(res.rarity).rank;
      stage.classList.remove('kr-wait');
    } catch (e) {
      closeOverlay();
      K.busy = false;
      K.msg = errText(e);
      await reload();
      return;
    }
    // если человек ушёл с вкладки посередине — карточка всё равно уже его
    o._cleanup = (function (prev) { return function () { prev(); K.busy = false; }; })(o._cleanup);
  }

  function sparkle(o) {
    for (var i = 0; i < 14; i++) {
      var s = el('span', { class: 'kr-spark', 'aria-hidden': 'true' });
      s.style.left = (10 + Math.random() * 80) + '%';
      s.style.top = (12 + Math.random() * 60) + '%';
      s.style.animationDelay = (Math.random() * 0.5).toFixed(2) + 's';
      o.appendChild(s);
    }
  }

  /* ---------- витрина друга (из таблицы «Участники») ---------- */
  async function showFriend(userId, name) {
    A = window.AppAPI;
    var o = overlay('kc-overlay', 'Витрина: ' + name);
    o._cleanup = onKey(closeOverlay);
    o.addEventListener('click', function (ev) { if (ev.target === o) closeOverlay(); });
    var sheet = el('div', { class: 'kc-sheet kc-friend' }, [
      el('button', { type: 'button', class: 'kc-close', 'aria-label': 'Закрыть', text: '×', onclick: closeOverlay }),
      el('h2', { class: 'kc-friend-name', text: name }),
      el('p', { class: 'muted', text: 'Загружаю…' })
    ]);
    o.appendChild(sheet);
    try {
      var res = await Promise.all([K.catalog ? K.catalog : rpc('cards_catalog', { p_series: SERIES }), rpc('cards_showcases'), rpc('cards_members')]);
      if (!K.catalog) K.catalog = res[0] || [];
      if (ov !== o) return;
      var shelf = (res[1] || []).filter(function (x) { return x.user_id === userId; });
      var stat = (res[2] || []).filter(function (x) { return x.user_id === userId; })[0];
      var got = stat ? stat.distinct_cards : 0;
      sheet.replaceChild(el('p', { class: 'muted', text: 'Собрано ' + got + ' из ' + K.catalog.length }), sheet.lastChild);
      if (!shelf.length) { sheet.appendChild(el('p', { class: 'kc-note', text: 'Витрина пока пустая.' })); return; }
      sheet.appendChild(el('div', { class: 'shelves' }, shelf.map(function (x) {
        var c = cardById(x.card_id);
        var wrap = el('div', { class: 'shelf' });
        if (c) wrap.appendChild(window.Cards.face(c, x.serial, 'md'));
        return wrap;
      })));
    } catch (e) {
      if (ov === o) sheet.replaceChild(el('p', { class: 'msg err', text: errText(e) }), sheet.lastChild);
    }
  }

  window.Collection = {
    view: function () { A = window.AppAPI; return view(); },
    enter: enter, leave: leave, showFriend: showFriend,
    _state: function () { return K; }
  };
})();
