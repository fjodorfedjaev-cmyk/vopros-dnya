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
    if (!root) root = el('div', { class: 'coll' });
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
    var slots = [1, 2, 3].map(function (s) {
      var k = (K.my || []).filter(function (x) { return x.slot === s; })[0];
      var c = k && cardById(k.card_id);
      if (!c) {
        return el('button', { type: 'button', class: 'shelf shelf-empty', onclick: function () { A.toast('Открой карточку в коллекции и нажми «На витрину»'); } },
          [el('span', { text: 'Полка ' + s })]);
      }
      var b = el('button', { type: 'button', class: 'shelf', 'aria-label': c.name + ', полка ' + s, onclick: function () { openDetail(c.card_id, k.copy_id); } });
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
        type: 'button', class: 'kt r-' + r, 'aria-label': c.name + (mine.length > 1 ? ', копий: ' + mine.length : ''),
        onclick: function () { openDetail(c.card_id); }
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
      acts.appendChild(el('button', { type: 'button', class: 'btn', text: 'Убрать с витрины (полка ' + sel.slot + ')', onclick: function () { setShelf(sel.slot, null, cardId, sel.copy_id, msg); } }));
    } else {
      acts.appendChild(el('button', { type: 'button', class: 'btn', text: 'На витрину', onclick: askShelf }));
    }
    // Вопрос «На какую полку?»: вместо кнопок — три полки (что на них сейчас) и «Отмена».
    function askShelf() {
      var shelves = [1, 2, 3].map(function (s) {
        var on = (K.my || []).filter(function (x) { return x.slot === s; })[0];
        var oc = on && cardById(on.card_id);
        var pic = el('span', { class: 'kc-slot-pic' + (oc ? ' r-' + oc.rarity : '') });
        if (oc) pic.appendChild(window.Cards.art(oc.code)); else pic.textContent = '+';
        return el('button', {
          type: 'button', class: 'btn kc-slot', 'aria-label': 'Полка ' + s + (oc ? ', сейчас там «' + oc.name + '»' : ', пустая'),
          onclick: function () { setShelf(s, sel.copy_id, cardId, sel.copy_id, msg); }
        }, [pic, el('span', { class: 'kc-slot-n', text: 'Полка ' + s }), el('span', { class: 'kc-slot-c', text: oc ? 'заменить «' + oc.name + '»' : 'пустая' })]);
      });
      acts.replaceChildren(
        el('p', { class: 'kc-ask', text: 'На какую полку?' }),
        el('div', { class: 'kc-slots' }, shelves),
        el('button', { type: 'button', class: 'btn', text: 'Отмена', onclick: function () { openDetail(cardId, sel.copy_id); } })
      );
      try { acts.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' }); } catch (e) { /* ничего */ }
      var f = acts.querySelector('.kc-slot'); if (f) f.focus({ preventScroll: true });
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

  async function setShelf(slot, copyId, cardId, keepCopy, msg) {
    setText(msg, 'Сохраняю…');
    try {
      await rpc('cards_set_showcase', { p_slot: slot, p_copy: copyId });
      await load();
      draw();
      A.toast(copyId ? 'Поставлено на витрину' : 'Убрано с витрины');
      openDetail(cardId, keepCopy);
    } catch (e) { setText(msg, errText(e)); }
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
