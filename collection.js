/* Вкладка «Коллекция»: блок открытия, альбом (фильтры, «Новая»), витрина, панель карточки снизу, открытие по нажатиям,
   переплавка, лавка. Витрина ещё показывается в Профиле (profileShelf).
   Что выпало — решает база (функция cards_open) в момент оплаты. Нажатия при открытии ничего не меняют,
   они только красиво раскрывают уже выпавшую карточку. Даже если закрыть приложение посередине,
   карточка уже лежит в коллекции.
   Лавка: карточки друг другу за монеты — «Рынок» (одна строка на карточку, страница карточки), «Продать», «Мои сделки».
   Заявка на покупку: «куплю любой номер не дороже N», монеты откладываются; выставили не дороже — продано сразу.
   Продавец получает цену минус 10% (не меньше 0,01) — это сгорает.
   Все деньги считает база (market_sell / market_buy / market_bid …), сайт только показывает расчёт заранее.
   Паки (23.11): колода серии опустела — база дарит паки тем, кто открывал карточки (1 карточка — 1 пак, не больше 3).
   Подарок забирают в блоке открытия («Забрать»), паки лежат в альбоме — плиткой после легендарной (как новая редкость);
   открыть пак — cards_pack_open (что выпадет,
   решает база в момент открытия), продать — в Лавке, как карточку (пак — «карточка» серии с редкостью 'pack').
   Покупка паков (23.11): две недели после конца серии пак можно купить за 600 (cards_pack_buy, без ограничения).
   Первую неделю — на месте колоды, вторую — полосой над блоком коллекции; таймер до конца продажи (часы — по базе).
   Режим проверки паков (только админ): Коллекция показывается так, будто колода уже опустела, — подарок, «Забрать»,
   «Мои паки», открытие. Всё происходит только на телефоне (K.pv), в базу ничего не пишется; «Выйти» — всё как было.
   Связь с сайтом — через window.AppAPI (sb, el, toast, баланс), рисунки — window.Cards. */
(function () {
  'use strict';
  var A = null;                 // AppAPI, появляется после запуска сайта
  var root = null;              // корневой элемент вкладки (живёт между перерисовками)
  var SERIES = 1;               // серия «Начало»
  var K = { catalog: null, my: null, deck: null, gift: null, sale: null, clockOff: 0, salePhase: 0, admin: false, pv: null, lots: null, lotsErr: null, bids: null, hist: null, histErr: null, err: null, busy: false, msg: '',
            mode: savedMode(), filter: savedFilter(), seen: null, loadedAt: 0,
            mkTab: saved('mk-tab', ['market', 'sell', 'deals'], 'market'),
            mkSortRar: saved('mk-sort-rar', ['desc', 'asc'], ''), mkSortPrice: saved('mk-sort-price', ['desc', 'asc'], ''), mkPop: null,
            mkSeries: saved('mk-series', ['all', '1'], 'all') === 'all' ? 'all' : 1,
            dealsTab: 'sell', sellDup: false };
  // выбор, запомненный на этом телефоне (если нет или чужое значение — по умолчанию)
  function saved(key, allowed, def) { try { var v = localStorage.getItem(key); return allowed.indexOf(v) >= 0 ? v : def; } catch (e) { return def; } }
  function savedMode() { try { return localStorage.getItem('coll-mode') === 'market' ? 'market' : 'coll'; } catch (e) { return 'coll'; } }
  // фильтр альбома: все / полученные / не получены (запоминается на этом телефоне)
  function savedFilter() { try { var f = localStorage.getItem('coll-filter'); return f === 'got' || f === 'miss' ? f : 'all'; } catch (e) { return 'all'; } }
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
    if (/cards_price_changed/.test(m)) return 'Цена только что изменилась. Глянь новую и нажми ещё раз.';
    if (/cards_not_enough/.test(m)) return 'Не хватает монет.';
    if (/cards_deck_empty/.test(m)) return 'Колода закончилась.';
    if (/cards_last_copy/.test(m)) return 'Это последняя копия в игре — её не переплавить.';
    if (/cards_no_melt/.test(m)) return 'Легендарную не переплавить.';
    if (/cards_in_showcase/.test(m)) return 'Сначала убери карточку с витрины.';
    if (/cards_not_yours/.test(m)) return 'Эта карточка уже не твоя.';
    if (/market_price_changed/.test(m)) return 'Цену только что поменяли. Глянь новую и нажми ещё раз.';
    if (/market_not_enough/.test(m)) return 'Не хватает монет.';
    if (/market_gone/.test(m)) return 'Эту карточку уже купили или сняли с продажи.';
    if (/market_own/.test(m)) return 'Свою карточку купить нельзя.';
    if (/market_bad_price/.test(m)) return 'Цена — от 0,02 до 99 999,99.';
    if (/market_bid_gone/.test(m)) return 'Этой заявки уже нет: её исполнили или отменили.';
    if (/market_bids_limit/.test(m)) return 'Не больше 20 заявок сразу. Отмени какую-нибудь в «Моих сделках».';
    if (/market_no_card/.test(m)) return 'Такой карточки нет.';
    if (/cards_pack_shelf/.test(m)) return 'Пак нельзя поставить на витрину.';
    if (/cards_not_pack/.test(m)) return 'Это не пак.';
    if (/cards_pack_sale_over/.test(m)) return 'Продажа паков закончилась.';
    if (/not_member/.test(m)) return 'Сначала войди по коду приглашения.';
    if (/does not exist|could not find|schema cache/i.test(m)) return 'Коллекция ещё не готова: база не обновлена.';
    return 'Не получилось. Проверь интернет и попробуй ещё раз.';
  }

  /* ---------- данные ---------- */
  function cardById(id) { return (K.catalog || []).filter(function (c) { return c.card_id === id; })[0] || null; }
  function myCopies(cardId) { return myAll().filter(function (k) { return k.card_id === cardId; }).sort(function (a, b) { return a.serial - b.serial; }); }
  function myLots() { return (K.lots || []).filter(function (l) { return l.mine; }); }
  // Есть ли у меня эта карточка: в коллекции или в моих лотах
  function haveCard(cardId) { return myCopies(cardId).length > 0 || myLots().some(function (l) { return l.card_id === cardId; }); }
  // Пак — тоже строка каталога (редкость 'pack'), но в альбом и «Собрано X из 20» он не входит
  function isPack(c) { return !!c && c.rarity === 'pack'; }
  function albumCards() { return (K.catalog || []).filter(function (c) { return !isPack(c); }); }
  function packCard() { return (K.catalog || []).filter(isPack)[0] || null; }
  function myPacks() { var p = packCard(); return p ? myCopies(p.card_id) : []; }
  function ownedIds() { var got = {}; myAll().forEach(function (k) { if (!isPack(cardById(k.card_id))) got[k.card_id] = true; }); return got; }
  // Серия закончилась (колода пуста) — паки уже есть. До этого пака в Лавке не видно.
  function packsOn() { var p = packCard(); return !!(K.deck && K.deck.deck_total && !K.deck.deck_left) || (p && (allLots(p.card_id).length > 0 || bidsOf(p.card_id).length > 0)); }
  function packWord(n) { return plural(n, 'пак', 'пака', 'паков'); }
  /* ---------- режим проверки паков (только админ, ничего не сохраняется) ---------- */
  // K.pv = { gift: сколько паков в подарке, packs: ненастоящие паки, cards: карточки из них, seq: счётчик }.
  // У ненастоящих копий id отрицательные — так их не перепутать с настоящими, и в базу они не уходят.
  function myAll() { return K.pv ? (K.my || []).concat(K.pv.packs, K.pv.cards) : (K.my || []); }
  function isFake(copyId) { return copyId < 0; }
  function deckView() {
    if (!K.pv) return K.deck;
    var d = K.deck || {};
    return { series_name: d.series_name || 'Начало', price: null, deck_left: 0, deck_total: d.deck_total || 85,
             left_common: 0, left_uncommon: 0, left_rare: 0, left_epic: 0, left_legendary: 0 };
  }
  function giftView() {
    if (!K.pv) return K.gift || [];
    return K.pv.gift ? [{ series_id: SERIES, series_name: deckView().series_name, packs: K.pv.gift }] : [];
  }
  function pvStart(gift) {
    K.pv = { gift: gift, packs: [], cards: [], seq: 0, sale: null };
    pvSale(1);
    closeOverlay();
    if (K.mode !== 'coll') setMode('coll'); else draw();
    window.scrollTo(0, 0);
  }
  function pvStop() { K.pv = null; closeOverlay(); draw(); window.scrollTo(0, 0); A.toast('Режим проверки выключен — всё как было'); }
  // Продажа в проверке: 1 — первая неделя (на месте колоды), 2 — вторая (полоса сверху), 0 — закончилась
  function pvSale(week) {
    var day = 864e5, now = Date.now();
    if (!week) K.pv.sale = null;
    else if (week === 1) K.pv.sale = { series_id: SERIES, price: 600, moves_at: new Date(now + 7 * day - 1000).toISOString(), ends_at: new Date(now + 14 * day - 1000).toISOString() };
    else K.pv.sale = { series_id: SERIES, price: 600, moves_at: new Date(now - 1000).toISOString(), ends_at: new Date(now + 7 * day - 1000).toISOString() };
  }
  function pvBuy() {
    var pc = packCard(), id = -(++K.pv.seq);
    K.pv.packs.push({ copy_id: id, card_id: pc.card_id, serial: K.pv.seq, obtained_at: new Date().toISOString(), slot: null, can_melt: false });
  }
  // «Забрать» в проверке: паки появляются только на телефоне
  function pvClaim() {
    var n = K.pv.gift, pc = packCard();
    for (var i = 0; i < n; i++) {
      var id = -(++K.pv.seq);
      K.pv.packs.push({ copy_id: id, card_id: pc.card_id, serial: K.pv.seq, obtained_at: new Date().toISOString(), slot: null, can_melt: false });
    }
    K.pv.gift = 0;
    return n;
  }
  // Открыть пак в проверке: та же жеребьёвка, что в базе, — одна из 85 исходных копий, номер сверх тиража
  function pvOpen(copyId) {
    var cards = albumCards(), pool = [];
    cards.forEach(function (c) { for (var i = 0; i < c.copies; i++) pool.push(c); });
    var c = pool[Math.floor(Math.random() * pool.length)];
    var extra = K.pv.cards.filter(function (k) { return k.card_id === c.card_id; }).length;
    var serial = c.copies + extra + 1;
    var id = -(++K.pv.seq);
    K.pv.packs = K.pv.packs.filter(function (k) { return k.copy_id !== copyId; });
    K.pv.cards.push({ copy_id: id, card_id: c.card_id, serial: serial, obtained_at: new Date().toISOString(), slot: null, can_melt: false });
    return { copy_id: id, card_id: c.card_id, code: c.code, name: c.name, rarity: c.rarity, serial: serial, copies: c.copies, packs_left: K.pv.packs.length };
  }
  // Плашка сверху в режиме проверки: что это, «Выйти», начать заново с подарком 0–3 паков
  function pvBar() {
    return el('section', { class: 'kpv', role: 'note' }, [
      el('div', { class: 'kpv-head' }, [
        el('span', { class: 'kpv-t' }, [el('b', { text: 'Режим проверки паков' }), el('span', { text: 'видно только тебе, ничего не сохраняется' })]),
        el('button', { type: 'button', class: 'btn kpv-exit', text: 'Выйти', onclick: pvStop })
      ]),
      el('div', { class: 'kpv-row' }, [el('span', { text: 'Заново, подарок:' })].concat([0, 1, 2, 3].map(function (n) {
        return el('button', { type: 'button', class: 'kpv-chip', text: String(n), 'aria-label': 'Начать заново: подарок ' + n + ' ' + packWord(n), onclick: function () { pvStart(n); } });
      }))),
      el('div', { class: 'kpv-row' }, [el('span', { text: 'Продажа паков:' })].concat([[1, '1-я неделя'], [2, '2-я неделя'], [0, 'конец']].map(function (x) {
        var on = x[0] === 0 ? !K.pv.sale : K.pv.sale && saleWeek(K.pv.sale) === x[0];
        return el('button', { type: 'button', class: 'kpv-chip' + (on ? ' on' : ''), text: x[1], 'aria-pressed': String(!!on), onclick: function () { pvSale(x[0]); draw(); } });
      })))
    ]);
  }
  // Ссылка внизу Коллекции — только у админа
  function pvLink() {
    if (!K.admin || K.pv || !packCard()) return null;
    return el('button', { type: 'button', class: 'link kpv-link', text: 'Проверить паки (видно только тебе)', onclick: function () { pvStart(3); } });
  }

  async function load() {
    var res = await Promise.all([
      rpc('cards_catalog', { p_series: SERIES }), rpc('cards_my'), rpc('cards_deck', { p_series: SERIES }),
      rpc('market_lots').catch(function (e) { K.lotsErr = e; return null; }), // лавка не загрузилась — коллекция всё равно работает
      rpc('market_bids').catch(function () { return null; }),
      rpc('cards_pack_gift').catch(function () { return null; }),           // подарок-паки (пусто — нет)
      K.admin ? true : rpc('is_admin').catch(function () { return false; }),  // админу — режим проверки паков
      rpc('cards_pack_sale', { p_series: SERIES }).catch(function () { return null; })   // продажа паков (пусто — не идёт)
    ]);
    K.catalog = res[0] || [];
    K.my = res[1] || [];
    K.deck = one(res[2]) || null;
    K.loadedAt = Date.now();
    if (res[3]) { K.lots = res[3]; K.lotsErr = null; }
    K.bids = res[4] || [];
    K.gift = res[5] || [];
    K.admin = res[6] === true;
    K.sale = one(res[7]) || null;
    if (K.sale && K.sale.now_at) K.clockOff = Date.parse(K.sale.now_at) - Date.now();   // часы телефона могут спешить
    if (K.mode === 'market' && K.mkTab === 'deals' && K.hist) refreshHist();   // история — только когда её смотрят
  }

  /* ---------- «Новая»: какие копии уже видели (помнит этот телефон) ---------- */
  // В первый раз всё, что уже есть, считается увиденным. Новая копия (открыл или купил) — с меткой «Новая»,
  // пока не нажмёшь на карточку в альбоме.
  function seenKey() { return 'cards-seen:' + ((A && A.me && A.me()) || 'anon'); }
  function saveSeen() { try { localStorage.setItem(seenKey(), JSON.stringify(Object.keys(K.seen).map(Number).filter(function (n) { return n > 0; }))); } catch (e) { /* без хранилища — просто без меток */ } }
  function seenSet() {
    if (K.seen) return K.seen;
    var raw = null;
    try { raw = localStorage.getItem(seenKey()); } catch (e) { raw = null; }
    K.seen = {};
    if (raw === null) { (K.my || []).forEach(function (k) { K.seen[k.copy_id] = 1; }); saveSeen(); }
    else { try { JSON.parse(raw).forEach(function (id) { K.seen[id] = 1; }); } catch (e) { /* испорчено — начнём заново */ } }
    return K.seen;
  }
  function isNewCard(cardId) { var s = seenSet(); return myCopies(cardId).some(function (k) { return !s[k.copy_id]; }); }
  function markSeen(cardId) {
    var s = seenSet(), changed = false;
    myCopies(cardId).forEach(function (k) { if (!s[k.copy_id]) { s[k.copy_id] = 1; changed = true; } });
    if (changed) saveSeen();
    return changed;
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
    syncPoll();
  }
  function leave() { closeOverlay(); stopPoll(); stopTick(); }

  // Переключатель «Коллекция / Лавка». Выбор запоминается на этом телефоне. Цифры у «Лавки» нет.
  function modeSwitch() {
    return el('div', { class: 'segment coll-switch', role: 'group', 'aria-label': 'Коллекция или лавка' }, [['coll', 'Коллекция'], ['market', 'Лавка']].map(function (x) {
      return el('button', {
        type: 'button', 'aria-pressed': String(K.mode === x[0]),
        onclick: function () { setMode(x[0]); }
      }, [x[1]]);
    }));
  }
  function setMode(m) {
    m = m === 'market' ? 'market' : 'coll';
    if (K.mode === m) return;
    K.mode = m;
    try { localStorage.setItem('coll-mode', m); } catch (e) { /* без хранилища тоже работает */ }
    draw();
    if (m === 'market' && root && root.isConnected) refreshLots();
    syncPoll();
  }

  // Пока открыта лавка — раз в 20 секунд тихо проверяем, что появилось и что купили.
  var pollT = null;
  function syncPoll() {
    var want = K.mode === 'market' && root && root.isConnected;
    if (want && !pollT) pollT = setInterval(function () { if (!document.hidden && !K.busy) refreshLots(); }, 20000);
    if (!want) stopPoll();
  }
  function stopPoll() { if (pollT) { clearInterval(pollT); pollT = null; } }
  async function refreshLots() {
    var before = myLots().map(function (l) { return l.listing_id; }).concat(myBids().map(function (b) { return 'b' + b.bid_id; }));
    var lots, bids;
    try { var r = await Promise.all([rpc('market_lots'), rpc('market_bids')]); lots = r[0] || []; bids = r[1] || []; } catch (e) { return; }
    if (JSON.stringify(lots) === JSON.stringify(K.lots) && JSON.stringify(bids) === JSON.stringify(K.bids)) return;
    K.lots = lots; K.lotsErr = null; K.bids = bids;
    // мой лот или моя заявка исчезли сами — значит, сделка прошла: обновим баланс, коллекцию и историю
    var now = myLots().map(function (l) { return l.listing_id; }).concat(myBids().map(function (b) { return 'b' + b.bid_id; }));
    if (before.some(function (id) { return now.indexOf(id) < 0; })) {
      if (A.loadPoints) { try { await A.loadPoints(); } catch (e) { /* ничего */ } }
      try { K.my = (await rpc('cards_my')) || K.my; } catch (e) { /* ничего */ }
      if (K.hist) refreshHist();
    }
    if (!K.busy) draw();
  }
  // История сделок (для «Мои сделки → История»)
  var histBusy = false;
  async function refreshHist() {
    if (histBusy) return;
    histBusy = true;
    try { K.hist = (await rpc('market_history')) || []; K.histErr = null; } catch (e) { K.histErr = e; }
    histBusy = false;
    if (!K.busy && K.mode === 'market' && K.mkTab === 'deals') draw();
  }

  function draw() {
    if (!root) return;
    root.replaceChildren();
    if (!K.catalog) {
      if (K.err) { var m = el('p', { class: 'msg err', role: 'alert' }); setText(m, errText(K.err)); root.appendChild(m); }
      else root.appendChild(el('p', { class: 'muted', text: 'Загружаю…' }));
      return;
    }
    root.appendChild(modeSwitch());
    if (K.pv) root.appendChild(pvBar());
    if (K.mode === 'market') { marketView().forEach(function (n) { root.appendChild(n); }); syncTick(); return; }
    seenSet();
    var sale = saleView();
    K.salePhase = salePhase(sale);
    if (K.salePhase === 2) root.appendChild(saleStrip(sale));
    root.appendChild(heroCard());
    root.appendChild(albumSect());
    root.appendChild(showcaseSect());
    var pl = pvLink();
    if (pl) root.appendChild(pl);
    syncTick();
    keepLoops(root);
  }

  // Экран перерисовывается после любой кнопки (фильтр, «Забрать»…), и новые карточки начинали бы движение сначала:
  // рубашка с «?» в блоке открытия подпрыгивала заново, свечение и рисунки на витрине — тоже. Поэтому у бесконечных
  // анимаций ставим общее начало — момент открытия страницы: новая карточка продолжает ровно с того места, где была старая.
  // Разовые анимации (появление, «вздрагивание») не трогаем.
  function keepLoops(node, later) {
    if (reduce || !node.getAnimations) return;
    if (!node.isConnected) { if (!later) requestAnimationFrame(function () { keepLoops(node, true); }); return; }   // ещё не на экране
    try {
      node.getAnimations({ subtree: true }).forEach(function (a) {
        var t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
        if (t && t.iterations === Infinity && a.startTime !== 0) a.startTime = 0;
      });
    } catch (e) { /* старый браузер — просто начнётся заново, как раньше */ }
  }

  // Блок открытия: серия, рубашка с подсветкой, «1 случайная карточка», кнопка с ценой, сколько осталось, шансы.
  function heroCard() {
    var d = deckView() || {};
    var price = d.price;
    if (!price && d.deck_total) {
      var g = giftView()[0];
      if (g) return giftCard(g, d);
      if (K.salePhase === 1) return buyCard(saleView());   // первая неделя — покупка на месте колоды
      return soonCard(d);
    }
    var short = price ? Math.max(0, cents(price) - cents(bal())) / 100 : 0;
    var btn = el('button', { type: 'button', class: 'btn primary ko-open' });
    if (!price) btn.textContent = 'Колода закончилась';
    else setText(btn, 'Открыть за ' + price + ' 🪙');   // не хватает монет — та же цена, кнопка просто неактивна
    btn.disabled = !price || K.busy || short > 0;
    btn.addEventListener('click', openCard);
    var msg = el('p', { class: 'msg', role: 'status', id: 'coll-msg' });
    if (K.msg) setText(msg, K.msg);
    return el('section', { class: 'card ko' }, [
      el('h2', { class: 'ko-title', text: 'Серия «' + (d.series_name || 'Начало') + '»' }),
      el('div', { class: 'ko-pack' + (price ? '' : ' empty'), 'aria-hidden': 'true' }, [window.Cards.back('md')]),
      el('p', { class: 'ko-sub', text: price ? '1 случайная карточка' : 'Все карточки серии уже открыты' }),
      btn,
      el('p', { class: 'ko-meta', text: 'Осталось в колоде: ' + (d.deck_left || 0) + ' из ' + (d.deck_total || 0) }),
      price ? el('button', { type: 'button', class: 'link ko-odds', text: 'Что может выпасть', onclick: openOdds }) : null,
      msg
    ]);
  }

  // Колода опустела, а у меня подарок: паки (по одному за каждую открытую карточку, не больше 3) — «Забрать»
  function giftCard(g, d) {
    var n = g.packs;
    var fan = el('div', { class: 'ko-fan n' + Math.min(3, n), 'aria-hidden': 'true' }, Array.apply(null, Array(Math.min(3, n))).map(function () { return window.Cards.pack('md'); }));
    var btn = el('button', { type: 'button', class: 'btn primary ko-open', text: 'Забрать' });
    btn.disabled = K.busy;
    var msg = el('p', { class: 'msg', role: 'status', id: 'coll-msg' });
    if (K.msg) setText(msg, K.msg);
    btn.addEventListener('click', function () { claimGift(g, btn, fan, msg); });
    return el('section', { class: 'card ko ko-gift' }, [
      el('h2', { class: 'ko-title', text: 'Серия «' + g.series_name + '» закончилась' }),
      el('p', { class: 'ko-sub', text: 'Все ' + (d.deck_total || 85) + ' карточек разошлись. Подарок за участие:' }),
      fan,
      el('p', { class: 'ko-gift-n', text: n + ' ' + packWord(n) }),
      btn,
      msg
    ]);
  }
  async function claimGift(g, btn, fan, msg) {
    if (K.busy) return;
    K.busy = true; btn.disabled = true; K.msg = '';
    setText(msg, '');
    try {
      var n = K.pv ? pvClaim() : Number(one(await rpc('cards_pack_claim', { p_series: g.series_id }))) || 0;
      fan.classList.add('go');                       // паки «уезжают» вниз — в альбом
      await new Promise(function (r) { setTimeout(r, reduce ? 0 : 520); });
      K.busy = false;
      if (K.filter === 'miss') { K.filter = 'all'; store('coll-filter', 'all'); }   // иначе плитки пака не видно
      await reload();
      showPackTile();
      if (n) A.toast(n + ' ' + packWord(n) + ' — в альбоме');
    } catch (e) {
      K.busy = false; btn.disabled = false;
      setText(msg, errText(e));
    }
  }
  // Колода опустела, подарка нет (или уже забран): на месте старой коллекции — следующая. Пока её нет — «Скоро».
  function soonCard(d) {
    var name = d.series_name || 'Начало';
    return el('section', { class: 'card ko ko-soon' }, [
      el('h2', { class: 'ko-title', text: 'Скоро новая коллекция' }),
      el('div', { class: 'ko-next', 'aria-hidden': 'true' }, [el('span', { text: '?' })]),
      el('p', { class: 'ko-meta', text: 'Карточки и паки «' + name + '» — в Лавке' })
    ]);
  }
  /* ---------- покупка паков: 2 недели после конца серии ---------- */
  function saleView() { return K.pv ? K.pv.sale : K.sale; }
  function nowMs() { return Date.now() + (K.pv ? 0 : K.clockOff); }
  function saleWeek(sale) { return nowMs() < Date.parse(sale.moves_at) ? 1 : 2; }
  // 0 — продажи нет, 1 — первая неделя, 2 — вторая
  function salePhase(sale) {
    if (!sale) return 0;
    var now = nowMs();
    if (now >= Date.parse(sale.ends_at)) return 0;
    return now < Date.parse(sale.moves_at) ? 1 : 2;
  }
  // «13 д 22:15:08», меньше суток — «22:15:08»
  function leftText(ms) {
    var t = Math.max(0, Math.floor(ms / 1000));
    var d = Math.floor(t / 86400), h = Math.floor(t % 86400 / 3600), m = Math.floor(t % 3600 / 60), sec = t % 60;
    var hms = [h, m, sec].map(function (x) { return (x < 10 ? '0' : '') + x; }).join(':');
    return d ? d + ' д ' + hms : hms;
  }
  function timer(sale) { return el('span', { class: 'ko-left', 'data-ends': sale.ends_at, text: leftText(Date.parse(sale.ends_at) - nowMs()) }); }
  // Таймер: раз в секунду обновляем все «Осталось …»; неделя сменилась или продажа кончилась — перерисовываем
  var tickT = null;
  function syncTick() {
    var want = !!saleView() && root && root.isConnected;
    if (want && !tickT) tickT = setInterval(tick, 1000);
    if (!want) stopTick();
  }
  function stopTick() { if (tickT) { clearInterval(tickT); tickT = null; } }
  function tick() {
    if (!root || !root.isConnected) { stopTick(); return; }
    var sale = saleView();
    if (!sale) { stopTick(); return; }
    var ph = salePhase(sale);
    if (K.mode === 'coll' && ph !== K.salePhase && !K.busy && !ov) {
      if (ph === 0 && !K.pv) reload(); else draw();
      return;
    }
    var now = nowMs();
    root.querySelectorAll('[data-ends]').forEach(function (n) { n.textContent = leftText(Date.parse(n.getAttribute('data-ends')) - now); });
  }
  function canBuy(sale) { return K.pv || cents(bal()) >= sale.price * 100; }   // в проверке монеты не тратятся
  // Первая неделя: на месте колоды — пак, «Купить за 600», «Осталось 13 д 22:15:08», «Что может выпасть»
  function buyCard(sale) {
    var btn = el('button', { type: 'button', class: 'btn primary ko-open' });
    setText(btn, 'Купить за ' + sale.price + ' 🪙');   // не хватает монет — та же цена, кнопка неактивна
    btn.disabled = K.busy || !canBuy(sale);
    var msg = el('p', { class: 'msg', role: 'status', id: 'coll-msg' });
    if (K.msg) setText(msg, K.msg);
    btn.addEventListener('click', function () { buyPack(sale, btn, msg); });
    return el('section', { class: 'card ko ko-buy' }, [
      el('h2', { class: 'ko-title', text: 'Пак «' + seriesName() + '»' }),
      el('div', { class: 'ko-fan n1', 'aria-hidden': 'true' }, [window.Cards.pack('md')]),
      btn,
      el('p', { class: 'ko-meta ko-timer' }, ['Осталось ', timer(sale)]),
      el('button', { type: 'button', class: 'link ko-odds', text: 'Что может выпасть', onclick: openPackOdds }),
      msg
    ]);
  }
  // Вторая неделя: полоса над блоком коллекции — маленький пак, «ещё 6 д 03:12:44», «Купить · 600»
  function saleStrip(sale) {
    var btn = el('button', { type: 'button', class: 'btn primary kps-buy' });
    setText(btn, 'Купить · ' + sale.price + ' 🪙');
    btn.disabled = K.busy || !canBuy(sale);
    var msg = el('p', { class: 'msg', role: 'status' });
    btn.addEventListener('click', function () { buyPack(sale, btn, msg); });
    return el('section', { class: 'card kps' }, [
      el('div', { class: 'kps-row' }, [
        el('button', { type: 'button', class: 'kps-pic', 'aria-label': 'Что может выпасть', onclick: openPackOdds }, [window.Cards.pack('xs')]),
        el('span', { class: 'kps-t' }, [el('b', { text: 'Пак «' + seriesName() + '»' }), el('span', {}, ['ещё ', timer(sale)])]),
        btn
      ]),
      msg
    ]);
  }
  async function buyPack(sale, btn, msg) {
    if (K.busy) return;
    var had = myPacks().length;
    K.busy = true; btn.disabled = true; K.msg = '';
    setText(msg, '');
    try {
      if (K.pv) pvBuy();
      else {
        var r = one(await rpc('cards_pack_buy', { p_series: sale.series_id, p_price: sale.price }));
        if (r) A.setBalance(Number(r.balance));
      }
      K.busy = false;
      if (K.filter === 'miss') { K.filter = 'all'; store('coll-filter', 'all'); }
      await reload();
      if (!had) showPackTile();   // первый пак — показываем, где он лежит
      A.toast(K.pv ? 'Пак куплен (проверка — монеты не тратятся)' : 'Пак куплен · −' + sale.price + ' 🪙');
    } catch (e) {
      K.busy = false;
      var t = errText(e);
      try { await reload(); } catch (e2) { /* ничего */ }
      var m = root && (root.querySelector('.kps .msg') || document.getElementById('coll-msg'));
      if (m) setText(m, t); else A.toast(t);
    }
  }
  // «Что может выпасть» для покупки: шансы как в полной колоде
  function openPackOdds() {
    var sheet = bottomSheet('Что может выпасть');
    sheet.appendChild(el('h2', { class: 'kb-title', text: 'Что может выпасть' }));
    var odds = packOdds(); odds.classList.add('kx-compact');
    sheet.appendChild(odds);
  }

  // После «Забрать»: страница плавно едет к плитке пака в альбоме, плитка подсвечивается — вот где теперь паки
  function showPackTile() {
    var t = root && root.querySelector('.ka-tile.r-pack');
    if (!t) return;
    try { t.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' }); } catch (e) { t.scrollIntoView(); }
    t.classList.add('ka-arrive');
    setTimeout(function () { t.classList.remove('ka-arrive'); }, 4200);
  }

  function markPacksSeen() {
    var s = seenSet(), changed = false;
    myPacks().forEach(function (k) { if (!s[k.copy_id]) { s[k.copy_id] = 1; changed = true; } });
    if (changed) saveSeen();
    return changed;
  }
  // Шансы пака — как в полной колоде: доля копий каждой редкости среди всех 85
  function packOdds() {
    var cards = albumCards();
    var total = cards.reduce(function (t, c) { return t + c.copies; }, 0);
    return el('div', { class: 'kx-list' }, window.Cards.ORDER.map(function (r) {
      var of = cards.filter(function (c) { return c.rarity === r; });
      var n = of.reduce(function (t, c) { return t + c.copies; }, 0);
      return el('div', { class: 'kx-row' }, [
        el('span', { class: 'kd-dot r-' + r, 'aria-hidden': 'true' }),
        el('span', { class: 'kx-info' }, [el('span', { class: 'kx-name', text: R(r).name }), el('span', { class: 'kx-cards', text: of.map(function (c) { return c.name; }).join(', ') })]),
        el('span', { class: 'kx-left', text: n + ' из ' + total }),
        el('span', { class: 'kx-pct', text: pct(n, total) })
      ]);
    }));
  }
  // Окно пака: пак крупно, сколько у меня, шансы, «Открыть пак», «Продать в Лавке»
  function openPackSheet(note) {
    var pc = packCard(), mine = myPacks();
    if (!pc || !mine.length) { closeOverlay(); return; }
    if (markPacksSeen()) draw();
    var sheet = bottomSheet('Пак «' + seriesName() + '»');
    var msg = el('p', { class: 'msg', role: 'status' });
    if (note) setText(msg, note);
    sheet.appendChild(window.Cards.pack('lg'));
    sheet.appendChild(el('p', { class: 'kb-info' }, [el('span', { class: 'kd-dot r-pack', 'aria-hidden': 'true' }), 'Пак «' + seriesName() + '» · у тебя ' + mine.length]));
    var odds = packOdds(); odds.classList.add('kx-compact');
    sheet.appendChild(odds);
    sheet.appendChild(el('div', { class: 'kc-actions' }, [
      el('button', { type: 'button', class: 'btn primary', text: 'Открыть пак', onclick: function () { openPack(); } }),
      el('button', { type: 'button', class: 'btn', text: 'Продать в Лавке', onclick: function () {
        if (K.pv) { A.toast('В режиме проверки Лавка выключена'); return; }
        openSell(pc.card_id, mine[0], function () { openPackSheet(); });
      } })
    ]));
    sheet.appendChild(msg);
  }

  // «Что может выпасть»: карточка выпадает случайно из оставшихся в колоде копий,
  // поэтому шанс редкости = сколько её копий осталось / сколько всего осталось.
  function pct(n, t) { var p = t ? n / t * 100 : 0; return (p > 0 && p < 10 ? p.toFixed(1).replace('.', ',') : String(Math.round(p))) + '%'; }
  function openOdds() {
    var d = K.deck || {};
    var total = d.deck_left || 0;
    var sheet = bottomSheet('Что может выпасть');
    sheet.appendChild(el('h2', { class: 'kb-title', text: 'Что может выпасть' }));
    sheet.appendChild(el('div', { class: 'kx-list' }, window.Cards.ORDER.map(function (r) {
      var n = d['left_' + r] || 0;
      var names = (K.catalog || []).filter(function (c) { return c.rarity === r; }).map(function (c) { return c.name; }).join(', ');
      return el('div', { class: 'kx-row' + (n ? '' : ' off') }, [
        el('span', { class: 'kd-dot r-' + r, 'aria-hidden': 'true' }),
        el('span', { class: 'kx-info' }, [el('span', { class: 'kx-name', text: R(r).name }), el('span', { class: 'kx-cards', text: names })]),
        el('span', { class: 'kx-left', text: n ? 'осталось ' + n : 'нет' }),
        el('span', { class: 'kx-pct', text: n ? pct(n, total) : '—' })
      ]);
    })));
    sheet.appendChild(el('p', { class: 'kb-note', text: 'Карточка выпадает случайно из тех, что ещё остались в колоде: чем больше копий осталось, тем выше шанс. '
      + 'Цена открытия — по самой редкой карточке в колоде: золотая 300, фиолетовая 250, синяя 200, зелёная 150, только серые 100.' }));
  }

  // Витрина: 3 полки, компактно, ниже альбома. Карточку ставят из панели карточки («На витрину») или перетаскиванием.
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
    return el('section', { class: 'sect kw' }, [
      el('div', { class: 'ka-head' }, [el('h2', { text: 'Моя витрина' }), on.length < 3 ? el('span', { class: 'kw-hint', text: 'зажми карточку и перетащи' }) : null]),
      el('div', { class: 'shelves' }, slots)
    ]);
  }

  // Альбом: «Мой альбом 10 / 20», полоска, фильтры, сетка в 3 колонки (от обычных к легендарной).
  var FILTERS = [['all', 'Все'], ['got', 'Полученные'], ['miss', 'Не получены']];
  function albumSect() {
    var cards = albumCards().sort(function (a, b) { return (R(a.rarity).rank - R(b.rarity).rank) || (a.sort - b.sort); });
    var total = cards.length;
    var n = cards.filter(function (c) { return myCopies(c.card_id).length; }).length;
    var pc = packCard();
    if (pc && myPacks().length) cards.push(pc);   // пак — как новая редкость после легендарной, только пока паки есть
    var shown = cards.filter(function (c) { return K.filter === 'all' || (K.filter === 'got') === (myCopies(c.card_id).length > 0); });
    var filters = el('div', { class: 'ka-filters', role: 'group', 'aria-label': 'Какие карточки показать' }, FILTERS.map(function (f) {
      return el('button', { type: 'button', class: 'ka-filter', 'aria-pressed': String(K.filter === f[0]), text: f[1], onclick: function () {
        if (K.filter === f[0]) return;
        K.filter = f[0];
        try { localStorage.setItem('coll-filter', f[0]); } catch (e) { /* без хранилища тоже работает */ }
        draw();
      } });
    }));
    var grid = el('div', { class: 'ka-grid' }, shown.length ? shown.map(tile)
      : [el('p', { class: 'empty ka-empty', text: K.filter === 'got' ? 'Пока ни одной — открой первую' : 'Все карточки собраны' })]);
    return el('section', { class: 'sect ka' }, [
      el('div', { class: 'ka-head' }, [el('h2', { text: 'Мой альбом' }), el('span', { class: 'ka-count', text: n + ' / ' + total })]),
      el('div', { class: 'coll-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(n), 'aria-label': 'Собрано карточек' },
        [el('span', { style: 'width:' + (total ? Math.round(n / total * 100) : 0) + '%' })]),
      filters,
      grid
    ]);
  }
  // Плитка: сверху редкость, рисунок, название внутри. Нет карточки — тёмный силуэт рисунка.
  // Есть повторы — «×2», новая — метка «Новая». Нажатие — панель снизу, зажать — перетащить на витрину.
  function tile(c) {
    var mine = myCopies(c.card_id);
    if (isPack(c)) return packTile(c, mine);
    var kids = [
      el('span', { class: 'ka-rar' }, [el('span', { class: 'kd-dot r-' + c.rarity, 'aria-hidden': 'true' }), R(c.rarity).name]),
      el('span', { class: 'ka-art', 'aria-hidden': 'true' }, [window.Cards.art(c.code)]),
      el('span', { class: 'ka-name', text: c.name })
    ];
    if (!mine.length) {
      return el('div', { class: 'ka-tile miss r-' + c.rarity, role: 'img', 'aria-label': c.name + ', ' + R(c.rarity).name.toLowerCase() + ' — не получена' }, kids);
    }
    var fresh = isNewCard(c.card_id);
    if (mine.length > 1) kids.push(el('span', { class: 'ka-badge', text: '×' + mine.length }));
    if (fresh) kids.push(el('span', { class: 'ka-new', text: 'Новая' }));
    return el('button', {
      type: 'button', class: 'ka-tile r-' + c.rarity, 'data-drag': 'grid:' + c.card_id,
      'aria-label': c.name + ', ' + R(c.rarity).name.toLowerCase() + (mine.length > 1 ? ', копий: ' + mine.length : '') + (fresh ? ', новая' : ''),
      onclick: function () { if (!justDragged()) openDetail(c.card_id); }
    }, kids);
  }

  // Плитка пака в альбоме: «Пак», рисунок упаковки, «×3», «Новые». Нажатие — окно пака (открыть, продать).
  // На витрину пак не ставится, поэтому перетаскивания у плитки нет.
  function packTile(c, mine) {
    var s = seenSet();
    var fresh = mine.some(function (k) { return !s[k.copy_id]; });
    var kids = [
      el('span', { class: 'ka-rar' }, [el('span', { class: 'kd-dot r-pack', 'aria-hidden': 'true' }), R('pack').name]),
      el('span', { class: 'ka-art', 'aria-hidden': 'true' }, [window.Cards.art('pack')]),
      el('span', { class: 'ka-name', text: c.name })
    ];
    if (mine.length > 1) kids.push(el('span', { class: 'ka-badge', text: '×' + mine.length }));
    if (fresh) kids.push(el('span', { class: 'ka-new', text: mine.length > 1 ? 'Новые' : 'Новый' }));
    return el('button', {
      type: 'button', class: 'ka-tile r-pack',
      'aria-label': 'Пак «' + seriesName() + '», у тебя ' + mine.length + (fresh ? ', новые' : '') + '. Открыть или продать',
      onclick: function () { openPackSheet(); }
    }, kids);
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
  // Панель снизу (карточка, шансы): закрывается крестиком, нажатием мимо и Esc
  function bottomSheet(label) {
    var o = overlay('kc-overlay kc-bottom', label);
    o._cleanup = onKey(closeOverlay);
    o.addEventListener('click', function (ev) { if (ev.target === o) closeOverlay(); });
    var sheet = el('div', { class: 'kc-sheet kb-sheet' }, [
      el('span', { class: 'kb-grip', 'aria-hidden': 'true' }),
      el('button', { type: 'button', class: 'kb-close', 'aria-label': 'Закрыть', text: '×', onclick: closeOverlay })
    ]);
    o.appendChild(sheet);
    return sheet;
  }

  // Панель снизу: карточка крупно, редкость и сколько копий, выбор копии, витрина, продажа, переплавка.
  // note — сообщение сразу при открытии (например, «Витрина полная»).
  function openDetail(cardId, copyId, note) {
    if (isPack(cardById(cardId))) { openPackSheet(note); return; }
    var c = cardById(cardId);
    var copies = myCopies(cardId);
    if (!c || !copies.length) { closeOverlay(); return; }
    var sel = copies.filter(function (k) { return k.copy_id === copyId; })[0] || copies[0];
    if (markSeen(cardId)) draw();   // метка «Новая» снимается
    var sheet = bottomSheet(c.name);
    var msg = el('p', { class: 'msg', role: 'status' });
    if (note) setText(msg, note);
    sheet.appendChild(window.Cards.face(c, sel.serial, 'lg'));
    sheet.appendChild(el('p', { class: 'kb-info' }, [
      el('span', { class: 'kd-dot r-' + c.rarity, 'aria-hidden': 'true' }),
      R(c.rarity).name + ' · ' + (c.copies === 1 ? 'единственная в тираже' : 'у тебя ' + copies.length + ' из ' + c.copies + ' копий')
    ]));
    if (sel.serial > c.copies) sheet.appendChild(el('p', { class: 'kc-note', text: 'Эта копия — из пака, сверх тиража.' }));

    if (copies.length > 1) {
      sheet.appendChild(el('div', { class: 'kc-copies', role: 'group', 'aria-label': 'Твои копии' }, copies.map(function (k) {
        return el('button', {
          type: 'button', class: 'kc-chip', 'aria-pressed': String(k.copy_id === sel.copy_id), text: '№' + k.serial,
          onclick: function () { if (k.copy_id !== sel.copy_id) openDetail(cardId, k.copy_id); }
        });
      })));
    }

    var acts = el('div', { class: 'kc-actions' });
    if (isFake(sel.copy_id)) {
      acts.appendChild(el('p', { class: 'kc-note', text: 'Эта копия — из режима проверки: после выхода её не будет. Витрина, Лавка и переплавка у неё выключены.' }));
      sheet.appendChild(acts);
      sheet.appendChild(msg);
      return;
    }
    // витрина
    if (sel.slot) {
      acts.appendChild(el('button', { type: 'button', class: 'btn', text: 'Убрать с витрины', onclick: function () { shelfRemove(cardId, sel, msg); } }));
    } else {
      acts.appendChild(el('button', { type: 'button', class: 'btn', text: 'На витрину', onclick: function () { shelfAdd(cardId, sel, msg); } }));
    }
    // продажа и переплавка — только не с витрины (как и раньше: сначала убрать)
    if (sel.slot) {
      acts.appendChild(el('p', { class: 'kc-note', text: 'Чтобы продать или переплавить, сначала убери с витрины.' }));
    } else {
      acts.appendChild(el('button', { type: 'button', class: 'btn', text: 'Продать в Лавке', onclick: function () { openSell(cardId, sel); } }));
    }
    // переплавка: первое нажатие — предупреждение, подтвердить — зажать кнопку на 5 секунд
    if (sel.slot) {
      // подсказка уже выше
    } else if (c.melt_value) {
      if (sel.can_melt) {
        acts.appendChild(meltHold(c, sel, msg));
      } else {
        acts.appendChild(el('p', { class: 'kc-note', text: 'Последняя копия в игре — её не переплавить.' }));
      }
    } else {
      acts.appendChild(el('p', { class: 'kc-note', text: 'Легендарную не переплавить.' }));
    }
    sheet.appendChild(acts);
    sheet.appendChild(msg);
    var first = sheet.querySelector('.kb-close'); if (first) first.focus();
  }

  // Витрина всегда «плотная»: карточки стоят слева направо без пустых мест.
  function shelved() {
    return (K.my || []).filter(function (x) { return x.slot; }).sort(function (a, b) { return a.slot - b.slot; });
  }
  // Новая — на первую свободную полку слева. Полная витрина — просим сначала убрать одну.
  // Две копии одной карточки (№2 и №5) могут стоять на витрине рядом.
  async function shelfAdd(cardId, sel, msg) {
    var on = shelved();
    if (on.length >= 3) { setText(msg, 'Витрина полная: сначала убери одну карточку.'); return; }
    await shelfSave(cardId, sel, msg, 'Поставлено на витрину', async function () {
      await packShelves(on);   // на всякий случай убираем дыры, если они были
      await writeShelves(planShelves(sel.copy_id, on.length));
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

  // Кнопка «Переплавить» с защитой от случайного нажатия.
  // 1) Первое нажатие — над кнопкой всплывает красное предупреждение, что копия уникальная и пропадёт навсегда.
  // 2) Подтвердить — зажать кнопку и держать 5 секунд: полоска заполняется, идёт обратный отсчёт.
  //    Отпустили раньше (или просто нажали) — подсказка «держи 5 секунд», ничего не происходит.
  // 3) 10 секунд ничего не трогали или нажали в любое другое место — кнопка возвращается в обычный вид.
  // Сама переплавка (и защита от двойного списания) — по-прежнему в базе (cards_melt).
  var HOLD_MS = 5000, ARM_IDLE_MS = 10000;
  function meltHold(c, sel, msg) {
    var box = el('div', { class: 'kc-melt' });
    var warn = el('p', { class: 'kc-warn', role: 'alert' });
    var warnText = el('span');
    var hint = el('span', { class: 'kc-warn-hint' });   // «держи 5 секунд» — тоже в всплывающем окошке, чтобы ничего не прыгало
    warn.appendChild(warnText); warn.appendChild(hint);
    var bar = el('span', { class: 'kc-hold-bar', 'aria-hidden': 'true' });
    var label = el('span', { class: 'kc-hold-label' });
    var btn = el('button', { type: 'button', class: 'btn kc-hold' }, [bar, label]);
    box.appendChild(btn);
    var idleText = 'Переплавить за ' + c.melt_value + ' 🪙';
    var armText = 'Зажми и держи 5 секунд';
    setText(label, idleText);

    var armed = false, holding = false, t0 = 0, raf = 0, idle = null, done = false;
    function alive() { return btn.isConnected; }   // окно закрыли — ничего не делаем
    function restartIdle() { clearTimeout(idle); idle = setTimeout(disarm, ARM_IDLE_MS); }
    // Нажатие мимо кнопки и предупреждения (по карточке, по другой кнопке, по пустому месту) — предупреждение пропадает.
    // Ловим click, а не касание: прокрутка панели пальцем предупреждение не убирает.
    function onElsewhere(ev) {
      if (!alive()) { document.removeEventListener('click', onElsewhere, true); return; }
      if (box.contains(ev.target)) return;
      disarm();
    }
    function arm() {
      armed = true;
      document.addEventListener('click', onElsewhere, true);
      btn.classList.add('danger');
      setText(hint, '');
      setText(warnText, 'Точно? Копия №' + sel.serial + ' «' + c.name + '» уникальная — после переплавки она пропадёт навсегда.');
      box.appendChild(warn);          // всплывает над кнопкой и ничего не сдвигает
      setText(label, armText);
      setText(msg, '');
      restartIdle();
    }
    function disarm() {
      if (holding || done) return;
      armed = false;
      clearTimeout(idle);
      document.removeEventListener('click', onElsewhere, true);
      btn.classList.remove('danger');
      if (warn.parentNode) warn.parentNode.removeChild(warn);
      setText(label, idleText);
    }
    function setBar(f) { bar.style.transform = 'scaleX(' + f + ')'; }
    function startHold() {
      if (!armed || holding || done || btn.disabled) return;
      holding = true;
      t0 = performance.now();
      clearTimeout(idle);
      btn.classList.add('holding');
      setText(msg, '');
      setText(hint, '');
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) { /* не важно */ } }
      raf = requestAnimationFrame(step);
    }
    function step(now) {
      if (!holding) return;
      if (!alive()) { holding = false; return; }
      var f = Math.min(1, (now - t0) / HOLD_MS);
      setBar(f);
      label.textContent = 'Держи… ' + Math.max(1, Math.ceil((HOLD_MS - (now - t0)) / 1000));
      if (f >= 1) { finish(); return; }
      raf = requestAnimationFrame(step);
    }
    // отпустили: раньше 5 секунд — подсказка; quiet — без подсказки (палец увели с кнопки)
    function endHold(quiet) {
      if (!holding) return;
      var held = performance.now() - t0;
      holding = false;
      cancelAnimationFrame(raf);
      btn.classList.remove('holding');
      setBar(0);
      setText(label, armText);
      if (!quiet) {
        setText(hint, held < 600
          ? 'Одного нажатия мало — зажми и держи 5 секунд.'
          : 'Не хватило — держи все 5 секунд, пока полоска не заполнится.');
        btn.classList.remove('nudge'); void btn.offsetWidth; btn.classList.add('nudge');
      }
      restartIdle();
    }
    function finish() {
      holding = false; done = true;
      btn.classList.remove('holding');
      if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) { /* не важно */ } }
      doMelt(c, sel, btn, msg).then(function () {
        if (!alive()) return;            // получилось — окно уже перерисовано
        done = false; setBar(0); disarm();  // не получилось — ошибка в msg, кнопка снова обычная
      });
    }

    // Первое нажатие (палец, мышь, Enter/пробел) — предупреждение. Дальше click ничего не делает.
    btn.addEventListener('click', function (ev) { if (!armed) arm(); else ev.preventDefault(); });
    // Удержание пальцем или мышью
    btn.addEventListener('pointerdown', function (ev) {
      if (!armed || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
      ev.preventDefault();
      try { btn.setPointerCapture(ev.pointerId); } catch (e) { /* не важно */ }
      startHold();
    });
    btn.addEventListener('pointerup', function () { endHold(false); });
    btn.addEventListener('pointercancel', function () { endHold(true); });
    btn.addEventListener('lostpointercapture', function () { endHold(false); });
    // палец увели далеко от кнопки — значит передумали
    btn.addEventListener('pointermove', function (ev) {
      if (!holding) return;
      var r = btn.getBoundingClientRect(), pad = 32;
      if (ev.clientX < r.left - pad || ev.clientX > r.right + pad || ev.clientY < r.top - pad || ev.clientY > r.bottom + pad) endHold(true);
    });
    // Удержание с клавиатуры: Enter или пробел
    btn.addEventListener('keydown', function (ev) {
      if (!armed || (ev.key !== 'Enter' && ev.key !== ' ')) return;
      ev.preventDefault();
      if (!ev.repeat) startHold();
    });
    btn.addEventListener('keyup', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { if (armed) ev.preventDefault(); endHold(false); }
    });
    btn.addEventListener('blur', function () { endHold(true); });
    // долгое нажатие на телефоне не должно открывать меню или выделять текст
    btn.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    return box;
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

  /* ---------- лавка: расчёты ---------- */
  // Все суммы считаем в копейках (сотых), целыми числами: так не бывает ошибок вроде 0,1 + 0,2 = 0,30000000004.
  // Комиссия — 10%, округлённые до сотых, но не меньше 0,01. Ровно так же считает база (market_fee).
  var MIN_P = 2, MAX_P = 9999999;                 // цена: 0,02 … 99 999,99
  function feeC(pc) { return Math.max(1, Math.round(pc / 10)); }
  function netC(pc) { return pc - feeC(pc); }     // сколько получит продавец
  var MAX_N = netC(MAX_P);                        // 89 999,99
  // Обратный расчёт: самая маленькая цена, при которой продавцу придёт ровно nc.
  // «Получишь» растёт с ценой шагами по 0 или 0,01, поэтому такая цена всегда есть.
  function priceForNet(nc) {
    var p = Math.max(MIN_P, Math.floor(nc * 10 / 9) - 2);
    while (netC(p) < nc) p++;
    return p;
  }
  function cents(v) { return Math.round(Number(v || 0) * 100); }
  // 155 → «155», 139,5 → «139,50», 99999,99 → «99 999,99»
  function money(v) {
    var c = cents(v);
    return (c / 100).toLocaleString('ru-RU', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 });
  }
  // Текст из поля → копейки (null — поле пустое или недописано)
  function parseC(s) {
    var m = /^(\d*)(?:[.,](\d{0,2}))?$/.exec(String(s || '').replace(/\s/g, ''));
    if (!m || (!m[1] && !m[2])) return null;
    return Number(m[1] || 0) * 100 + Number(((m[2] || '') + '00').slice(0, 2));
  }
  function inText(c) { return c % 100 ? (c / 100).toFixed(2).replace('.', ',') : String(c / 100); }

  // Два связанных поля: «Продать за» и «Получишь с вычетом комиссии». Заполнил любое — второе считается само.
  // onChange(pc) получает цену в копейках или null, если цена пока не подходит.
  function priceBox(initC, onChange) {
    var pc = initC || null, err = '';
    function field(id) {
      var i = el('input', { type: 'text', id: id, inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'done', placeholder: '0', 'aria-describedby': 'mk-hint' });
      i._ok = '';
      return i;
    }
    var pIn = field('mk-p'), nIn = field('mk-n');
    if (pc) { pIn.value = pIn._ok = inText(pc); nIn.value = nIn._ok = inText(netC(pc)); }
    var hint = el('p', { class: 'mk-hint', id: 'mk-hint', role: 'status' });
    function coin() { var s = el('span', { class: 'mk-coin', 'aria-hidden': 'true' }); setText(s, '🪙'); return s; }
    function row(inp, title, sub) {
      return el('div', { class: 'mk-row' }, [
        el('label', { for: inp.id }, [title, el('small', { text: sub })]),
        el('span', { class: 'mk-in' }, [inp, coin()])
      ]);
    }
    // в поле можно только цифры и запятую (до 5 цифр и 2 знаков после запятой); лишнее не вводится
    function guard(inp) {
      if (/^\d{0,5}([.,]\d{0,2})?$/.test(inp.value.replace(/\s/g, ''))) { inp._ok = inp.value; return true; }
      inp.value = inp._ok;
      return false;
    }
    function show() {
      var good = pc != null && pc >= MIN_P && pc <= MAX_P && !err;
      // под полями — только ошибка (например, цена меньше 0,02); без ошибки строки нет
      hint.classList.toggle('err', !!err);
      hint.hidden = !err;
      hint.textContent = err;
      onChange(good ? pc : null);
    }
    pIn.addEventListener('input', function () {
      if (!guard(pIn)) return;
      var c = parseC(pIn.value);
      err = '';
      if (!c) { pc = null; nIn.value = nIn._ok = ''; }                       // пусто или «0» — ещё печатают
      else if (c < MIN_P) { pc = null; nIn.value = nIn._ok = ''; err = 'Минимальная цена — 0,02.'; }
      else { pc = c; nIn.value = nIn._ok = inText(netC(c)); }
      show();
    });
    nIn.addEventListener('input', function () {
      if (!guard(nIn)) return;
      var c = parseC(nIn.value);
      err = '';
      if (!c) { pc = null; pIn.value = pIn._ok = ''; }
      else if (c > MAX_N) { pc = null; pIn.value = pIn._ok = ''; err = 'Получить можно не больше ' + money(MAX_N / 100) + '.'; }
      else { pc = priceForNet(c); pIn.value = pIn._ok = inText(pc); }
      show();
    });
    var node = el('div', { class: 'mk-form' }, [
      row(pIn, 'Продать за', 'столько заплатит покупатель'),
      row(nIn, 'Получишь', 'с вычетом комиссии (10%)'),
      hint
    ]);
    show();
    return { node: node, inputs: [pIn, nIn], focus: function () { try { pIn.focus({ preventScroll: true }); } catch (e) { pIn.focus(); } } };
  }

  // Окно поверх страницы с крестиком (общая часть для окон лавки)
  function sheetOverlay(label) {
    var o = overlay('kc-overlay', label);
    o._cleanup = onKey(closeOverlay);
    o.addEventListener('click', function (ev) { if (ev.target === o) closeOverlay(); });
    var sheet = el('div', { class: 'kc-sheet' });
    sheet.appendChild(el('button', { type: 'button', class: 'kc-close', 'aria-label': 'Закрыть', text: '×', onclick: closeOverlay }));
    o.appendChild(sheet);
    return sheet;
  }
  function copyNo(c, serial) { return window.Cards.no(c, serial); }
  // Тост о покупке: новая карточка, куплена карточка или куплен пак
  function boughtText(c, serial, price, isNew) {
    if (isPack(c)) return 'Куплен пак №' + serial + ' · −' + money(price) + ' 🪙';
    return (isNew ? 'Новая карточка! «' : 'Куплено: «') + c.name + '» №' + serial + ' · −' + money(price) + ' 🪙';
  }
  // кнопка денег — в два нажатия, как переплавка
  function twoTap(btn, label, armedLabel, act) {
    var armed = false, t = null;
    setText(btn, label);
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      if (!armed) {
        armed = true; setText(btn, armedLabel);
        t = setTimeout(function () { armed = false; setText(btn, label); }, 3000);
        return;
      }
      clearTimeout(t); armed = false; setText(btn, label);
      act();
    });
  }

  /* ---------- лавка: данные ---------- */
  // Лоты (market_lots) идут от дешёвых к дорогим, заявки (market_bids) — от дорогих к дешёвым.
  function otherLots(cardId) { return (K.lots || []).filter(function (l) { return l.card_id === cardId && !l.mine; }); }
  function allLots(cardId) { return (K.lots || []).filter(function (l) { return l.card_id === cardId; }); }   // и свои тоже
  function bidsOf(cardId) { return (K.bids || []).filter(function (b) { return b.card_id === cardId; }); }
  function bestBid(cardId) { return bidsOf(cardId).filter(function (b) { return !b.mine; })[0] || null; }
  function myBids() { return (K.bids || []).filter(function (b) { return b.mine; }); }
  function reservedC() { return myBids().reduce(function (s, b) { return s + cents(b.price); }, 0); }
  function freeCopies(cardId) { return myCopies(cardId).filter(function (k) { return !k.slot; }); } // с витрины не продаём
  function coinText(v, pre) { var s = el('span'); setText(s, (pre || '') + money(v) + ' 🪙'); return s; }
  function seriesName() { return (K.deck && K.deck.series_name) || 'Начало'; }
  function byRarity(a, b) { return (R(a.rarity).rank - R(b.rarity).rank) || (a.sort - b.sort); }
  function store(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* без хранилища тоже работает */ } }
  function pic(c, cls) { var p = el('span', { class: 'kt-pic mk-pic r-' + c.rarity + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' }); p.appendChild(window.Cards.art(c.code)); return p; }
  // Шапка панелей лавки: рисунок, название, «Начало · Редкая», сколько у тебя
  function cardHead(c) {
    var have = myCopies(c.card_id).length;
    return el('div', { class: 'mk-chead' }, [
      pic(c, 'mk-pic-lg'),
      el('div', { class: 'mk-chead-t' }, [
        el('h2', { class: 'kb-title', text: c.name }),
        el('span', { class: 'mk-sub' }, isPack(c) ? [seriesName() + ' · 1 случайная карточка'] : [seriesName() + ' · ', el('span', { class: 'mk-rar-t r-' + c.rarity, text: R(c.rarity).name })]),
        have ? el('span', { class: 'mk-tag', text: 'У тебя: ' + have }) : null
      ])
    ]);
  }
  // Поле цены за одну карточку (для заявки). onChange(копейки или null).
  function priceField(initC, label, sub, onChange) {
    var inp = el('input', { type: 'text', id: 'mk-bid', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'done', placeholder: '0', 'aria-describedby': 'mk-bid-hint' });
    inp._ok = '';
    if (initC) inp.value = inp._ok = inText(initC);
    var hint = el('p', { class: 'mk-hint err', id: 'mk-bid-hint', role: 'status', hidden: true });
    var coin = el('span', { class: 'mk-coin', 'aria-hidden': 'true' }); setText(coin, '🪙');
    function show() {
      var c = parseC(inp.value), err = '';
      if (c && c < MIN_P) err = 'Минимальная цена — 0,02.';
      hint.hidden = !err; hint.textContent = err;
      onChange(c && !err && c <= MAX_P ? c : null);
    }
    inp.addEventListener('input', function () {
      if (/^\d{0,5}([.,]\d{0,2})?$/.test(inp.value.replace(/\s/g, ''))) inp._ok = inp.value; else inp.value = inp._ok;
      show();
    });
    var node = el('div', { class: 'mk-form' }, [
      el('div', { class: 'mk-row' }, [el('label', { for: 'mk-bid' }, [label, el('small', { text: sub })]), el('span', { class: 'mk-in' }, [inp, coin])]),
      hint
    ]);
    setTimeout(show, 0);
    return { node: node, input: inp };
  }
  function noFocusOnPhone() { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }

  /* ---------- лавка: выставить свою карточку ---------- */
  // back — куда вернуться по «Назад» (из лавки — к списку, из коллекции — к окну карточки, со страницы рынка — туда).
  // keepC — цена, уже вписанная до смены копии. Если есть чужая заявка не ниже цены — продастся сразу, по цене заявки.
  function openSell(cardId, sel, back, keepC) {
    var c = cardById(cardId);
    if (!c) return;
    var free = freeCopies(cardId);
    if (!sel || sel.slot) sel = free[0];
    if (!sel) { if (back) back(); return; }
    var sheet = bottomSheet('Продать: ' + c.name);
    var msg = el('p', { class: 'msg', role: 'status' });
    var pc = keepC || null;
    var bb = bestBid(cardId), cheap = otherLots(cardId)[0] || null;
    var go = el('button', { type: 'button', class: 'btn primary' });
    function label() {
      var now = pc && bb && pc <= cents(bb.price);
      if (now) setText(go, 'Продать сразу за ' + money(bb.price) + ' 🪙');
      else if (pc) setText(go, 'Выставить за ' + money(pc / 100) + ' 🪙');
      else go.textContent = 'Выставить на продажу';
      go.disabled = !pc || K.busy;
    }
    var box = priceBox(pc, function (v) { pc = v; label(); });
    box.inputs.forEach(function (i) { i.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && pc) { ev.preventDefault(); doList(c, sel, pc, go, msg, false); } }); });
    go.addEventListener('click', function () { doList(c, sel, pc, go, msg, false); });
    label();
    sheet.appendChild(cardHead(c));
    if (isPack(c)) {
      sheet.appendChild(el('p', { class: 'kb-info', text: 'Паков у тебя: ' + free.length }));
    } else if (free.length > 1) {
      sheet.appendChild(el('div', { class: 'kc-copies', role: 'group', 'aria-label': 'Какую копию продать' }, free.map(function (k) {
        return el('button', {
          type: 'button', class: 'kc-chip', 'aria-pressed': String(k.copy_id === sel.copy_id), text: '№' + k.serial,
          onclick: function () { if (k.copy_id !== sel.copy_id) openSell(cardId, k, back, pc); }
        });
      })));
    } else {
      sheet.appendChild(el('p', { class: 'kb-info', text: 'Копия ' + copyNo(c, sel.serial) }));
    }
    sheet.appendChild(el('div', { class: 'mk-tiles' }, [
      el('div', { class: 'mk-tile' }, [el('span', { text: 'Продают от' }), cheap ? coinText(cheap.price) : el('b', { text: '—' })]),
      el('div', { class: 'mk-tile' }, [el('span', { text: 'Лучшая заявка' }), bb ? coinText(bb.price) : el('b', { text: '—' })])
    ]));
    sheet.appendChild(box.node);
    var acts = el('div', { class: 'kc-actions' }, [go]);
    if (bb) {
      var now = el('button', { type: 'button', class: 'btn' });
      twoTap(now, 'Продать сразу за ' + money(bb.price) + ' 🪙 · получишь ' + money(netC(cents(bb.price)) / 100),
        (isPack(c) ? 'Точно? Продать пак за ' : 'Точно? Продать №' + sel.serial + ' за ') + money(bb.price) + ' 🪙', function () { doList(c, sel, cents(bb.price), now, msg, true); });
      acts.appendChild(now);
    }
    acts.appendChild(el('button', { type: 'button', class: 'btn kr-ghost mk-back', text: 'Назад', onclick: function () { if (back) back(); else openDetail(cardId, sel.copy_id); } }));
    sheet.appendChild(acts);
    sheet.appendChild(msg);
    if (myCopies(cardId).length === 1) sheet.appendChild(el('p', { class: 'kc-note', text: isPack(c) ? 'Это твой последний пак.' : 'Это твоя единственная «' + c.name + '».' }));
    // на компьютере сразу ставим курсор в поле; на телефоне — нет, чтобы клавиатура не закрыла карточку
    if (!noFocusOnPhone()) box.focus();
  }
  // now = «Продать сразу»: только в заявку не ниже цены, иначе база откажет и лот не создаст
  async function doList(c, sel, pc, btn, msg, now) {
    if (!pc || K.busy) return;
    K.busy = true; btn.disabled = true;
    setText(msg, now ? 'Продаю…' : 'Выставляю…');
    try {
      var r = one(await rpc('market_sell', { p_copy: sel.copy_id, p_price: pc / 100, p_now: !!now }));
      if (r && r.balance != null) A.setBalance(Number(r.balance));
      K.busy = false;
      await load(); draw(); closeOverlay();
      if (r && r.sold) A.toast('Продано по заявке: «' + c.name + '» №' + sel.serial + ' · +' + money(r.net) + ' 🪙');
      else A.toast('«' + c.name + '» в лавке за ' + money(pc / 100) + ' 🪙');
    } catch (e) {
      K.busy = false;
      var t = /market_bid_gone/.test(String(e && e.message)) ? 'Такой заявки уже нет — глянь новую цену.' : errText(e);
      try { await load(); draw(); } catch (e2) { /* ничего */ }
      if (ov) openSell(c.card_id, sel, null, null);
      var m = ov && ov.querySelector('.msg'); if (m) setText(m, t);
    }
  }

  /* ---------- лавка: вкладка ---------- */
  var MK_TABS = [['market', 'Рынок'], ['sell', 'Продать'], ['deals', 'Мои сделки']];
  function marketView() {
    if (K.pv) return [el('p', { class: 'kc-note mk-empty', text: 'В режиме проверки Лавка выключена — в ней настоящие монеты. Выйди из проверки, чтобы торговать.' })];
    if (!K.lots) {
      if (K.lotsErr) { var m = el('p', { class: 'msg err', role: 'alert' }); setText(m, errText(K.lotsErr)); return [m]; }
      return [el('p', { class: 'muted', text: 'Загружаю лавку…' })];
    }
    var nDeals = myLots().length + myBids().length;
    var tabs = el('div', { class: 'segment three mk-tabs', role: 'group', 'aria-label': 'Разделы лавки' }, MK_TABS.map(function (x) {
      var badge = x[0] === 'deals' && nDeals;
      return el('button', {
        type: 'button', 'aria-pressed': String(K.mkTab === x[0]), 'aria-label': badge ? 'Мои сделки, активных: ' + nDeals : null,
        onclick: function () { setMkTab(x[0]); }
      }, [x[1], badge ? el('span', { class: 'seg-badge', 'aria-hidden': 'true', text: String(nDeals) }) : null]);
    }));
    var body = K.mkTab === 'sell' ? sellView() : K.mkTab === 'deals' ? dealsView() : catalogView();
    return [tabs].concat(body);
  }
  function setMkTab(t) {
    if (K.mkTab === t) return;
    K.mkTab = t; store('mk-tab', t);
    draw();
    if (t === 'deals') refreshHist();
  }

  /* ---------- «Рынок»: каталог — мини-квадратики (как маркет в Standoff 2) ---------- */
  // Плитка: рисунок на фоне цвета редкости, полоска с названием, сколько в продаже (число) и самая низкая цена.
  // Над плитками три кнопки (21.11): «Коллекция ▾» — фильтр с небольшим окошком под кнопкой (закрывается нажатием мимо);
  // «Цена» и «Редкость» — сортировки: нажатие переключает выкл → ↓ → ↑ → выкл. Включены обе — сначала по редкости, внутри по цене. Без сортировок: сверху то, что в продаже (свежие лоты первыми),
  // дальше — по порядку альбома.
  var MK_NEXT = { '': 'desc', desc: 'asc', asc: '' };
  var MK_SORTS = {
    mkSortRar: { key: 'mk-sort-rar', label: 'Редкость', desc: 'Сначала редкие', asc: 'Сначала обычные', off: 'Редкость: без сортировки' },
    mkSortPrice: { key: 'mk-sort-price', label: 'Цена', desc: 'Сначала дорогие', asc: 'Сначала дешёвые', off: 'Цена: без сортировки' }
  };
  // Коллекции (серии) карточек. Пока одна — «Начало»; следующие добавятся сюда сами из каталога.
  function seriesList() {
    var n = albumCards().length;
    return [{ id: SERIES, name: seriesName(), cards: n }];
  }
  function marketCards() {
    var minOf = function (c) { var l = allLots(c.card_id)[0]; return l ? cents(l.price) : null; };
    // когда выставлен самый свежий лот этой карточки (0 — не продаётся)
    var freshOf = function (c) { return allLots(c.card_id).reduce(function (t, l) { return Math.max(t, Date.parse(l.listed_at) || 1); }, 0); };
    var rank = function (c) { return R(c.rarity).rank; };
    var cards = K.catalog.filter(function (c) {
      if (K.mkSeries !== 'all' && SERIES !== K.mkSeries) return false;      // пока все карточки — из «Начала»
      if (isPack(c) && !packsOn()) return false;                            // пак — в Лавке, только когда серия закончилась
      return true;
    });
    var info = {};
    cards.forEach(function (c) { info[c.card_id] = { min: minOf(c), fresh: freshOf(c) }; });
    return cards.sort(function (a, b) {
      var ia = info[a.card_id], ib = info[b.card_id];
      if (K.mkSortRar) {
        var d = rank(b) - rank(a);
        if (d) return K.mkSortRar === 'desc' ? d : -d;                        // сначала редкие / сначала обычные
      }
      if (K.mkSortPrice) {
        if ((ia.min == null) !== (ib.min == null)) return ia.min == null ? 1 : -1;   // без продажи — всегда в конце
        if (ia.min != null && ia.min !== ib.min) return K.mkSortPrice === 'desc' ? ib.min - ia.min : ia.min - ib.min;
      }
      // по умолчанию: в продаже — сверху, свежие лоты первыми; остальные — по порядку альбома
      if ((ia.fresh > 0) !== (ib.fresh > 0)) return ia.fresh > 0 ? -1 : 1;
      if (ia.fresh !== ib.fresh) return ib.fresh - ia.fresh;
      return byRarity(a, b);
    });
  }
  // Кнопка-сортировка: нажатие — следующее состояние, на кнопке стрелка, коротко всплывает, что выбрано
  function sortChip(k) {
    var m = MK_SORTS[k], st = K[k] || '';
    return el('button', {
      type: 'button', class: 'mk-chip mk-sorter' + (st ? ' on' : ''),
      'aria-label': m.label + ': ' + (st ? m[st].toLowerCase() : 'без сортировки') + '. Нажми, чтобы переключить',
      onclick: function () {
        var next = MK_NEXT[st];
        K[k] = next; store(m.key, next); K.mkPop = null; draw();
        if (A && A.toast) A.toast(next ? m[next] : m.off);
      }
    }, [el('span', { text: m.label }), el('span', { class: 'mk-chip-ic', 'aria-hidden': 'true', text: st === 'desc' ? '↓' : st === 'asc' ? '↑' : '⇅' })]);
  }
  // Кнопка «Коллекция» с окошком под ней (нажал ещё раз или мимо — окошко закрылось; выбрал — тоже)
  function seriesChip() {
    var open = K.mkPop === 'series', on = K.mkSeries !== 'all';
    var btn = el('button', {
      type: 'button', class: 'mk-chip mk-popbtn' + (on ? ' on' : '') + (open ? ' open' : ''),
      'data-dismiss-trigger': 'mk-pop', 'aria-haspopup': 'true', 'aria-expanded': String(open),
      onclick: function () { K.mkPop = open ? null : 'series'; draw(); }
    }, [el('span', { text: on ? '«' + seriesName() + '»' : 'Коллекция' }), el('span', { class: 'mk-chip-ic', 'aria-hidden': 'true', text: '▾' })]);
    var rows = [{ v: 'all', t: 'Все коллекции' }].concat(seriesList().map(function (x) {
      return { v: x.id, t: '«' + x.name + '»', sub: x.cards + ' ' + plural(x.cards, 'карточка', 'карточки', 'карточек'),
               icon: el('span', { class: 'mk-ser-ic', 'aria-hidden': 'true' }, [window.Cards.art('back')]) };
    })).map(function (x) {
      return el('button', { type: 'button', class: 'mk-pop-row', role: 'radio', 'aria-checked': String(K.mkSeries === x.v), onclick: function () {
        K.mkSeries = x.v; store('mk-series', String(x.v)); K.mkPop = null; draw();
      } }, [el('span', { class: 'mk-radio', 'aria-hidden': 'true' }), x.icon || null, el('span', { class: 'mk-pop-t', text: x.t }), x.sub ? el('small', { text: x.sub }) : null]);
    });
    return el('span', { class: 'mk-popwrap' }, [btn,
      open ? el('div', { class: 'mk-pop', 'data-dismiss': 'mk-pop', role: 'radiogroup', 'aria-label': 'Коллекция' }, rows) : null]);
  }
  function catalogView() {
    if (A && A.dismissible) A.dismissible('mk-pop', function () { if (K.mkPop) { K.mkPop = null; draw(); } });
    var cards = marketCards();
    var forSale = (K.lots || []).length;
    return [el('section', { class: 'sect mk-cat' }, [
      el('div', { class: 'mk-ctrl' }, [
        seriesChip(),
        sortChip('mkSortPrice'),
        sortChip('mkSortRar')
      ]),
      forSale ? null : el('p', { class: 'kc-note mk-none', text: 'В продаже пока ничего нет — можно создать заявку.' }),
      cards.length ? el('div', { class: 'mk-grid' }, cards.map(catTile)) : el('p', { class: 'kc-note mk-empty', text: 'Под эти фильтры ничего нет.' })
    ])];
  }
  function plural(n, a, b, c) { return A.plural ? A.plural(n, a, b, c) : c; }

  // Плитка каталога: рисунок, название в полоске цвета редкости, сколько в продаже (число) и самая низкая цена (или «0» и «—»).
  // Считаются все лоты, и свои тоже (свой купить нельзя — это видно на странице карточки).
  function catTile(c) {
    var lots = allLots(c.card_id);
    var art = el('span', { class: 'mk-tl-art', 'aria-hidden': 'true' }, [window.Cards.art(c.code)]);
    var price = el('span', { class: 'mk-tl-price' });
    if (lots.length) setText(price, money(lots[0].price) + ' 🪙'); else price.textContent = '—';
    return el('button', {
      type: 'button', class: 'mk-tl r-' + c.rarity,
      'aria-label': c.name + ', ' + R(c.rarity).name.toLowerCase() + ', ' + (lots.length ? 'в продаже ' + lots.length + ', самая низкая цена ' + money(lots[0].price) + ' монет' : 'в продаже 0'),
      onclick: function () { openMarketCard(c.card_id); }
    }, [
      art,
      el('span', { class: 'mk-tl-name', text: c.name }),
      el('span', { class: 'mk-tl-foot' + (lots.length ? '' : ' none') }, [el('span', { class: 'mk-tl-n', text: String(lots.length) }), price])
    ]);
  }

  /* ---------- страница карточки на рынке ---------- */
  // Сверху: «Купить от» и «Лучшая заявка». Дальше предложения продавцов (выбираешь номер), купить,
  // создать заявку; свои заявки на эту карточку; продать свою (сразу в заявку или выставить).
  function openMarketCard(cardId, note, pickId) {
    var c = cardById(cardId);
    if (!c) return;
    var every = allLots(cardId), lots = otherLots(cardId);
    var bids = bidsOf(cardId), bb = bestBid(cardId), mineB = bids.filter(function (b) { return b.mine; });
    var free = freeCopies(cardId);
    var sheet = bottomSheet(c.name + ' — лавка');
    sheet.classList.add('mk-sheet');
    var msg = el('p', { class: 'msg', role: 'status' });
    if (note) setText(msg, note);
    sheet.appendChild(cardHead(c));
    sheet.appendChild(el('div', { class: 'mk-tiles' }, [
      el('div', { class: 'mk-tile' }, [el('span', { text: 'В продаже от' }), every.length ? coinText(every[0].price) : el('b', { text: '—' }),
        every.length && every[0].mine ? el('small', { text: 'твой лот' }) : null]),
      el('div', { class: 'mk-tile' }, [el('span', { text: 'Лучшая заявка' }), bids.length ? coinText(bids[0].price) : el('b', { text: '—' }),
        bids.length && bids[0].mine ? el('small', { text: 'твоя' }) : null])
    ]));

    var sel = lots.filter(function (l) { return l.listing_id === pickId; })[0] || lots[0] || null;
    var buy = el('button', { type: 'button', class: 'btn primary' });
    function setBuy() {
      if (!sel) return;
      var price = Number(sel.price), short = cents(price) - cents(bal());
      buy.replaceWith(buy = el('button', { type: 'button', class: 'btn primary' }));
      if (short > 0) {   // не хватает монет — на кнопке та же цена, она просто неактивна
        setText(buy, 'Купить №' + sel.serial + ' за ' + money(price) + ' 🪙');
        buy.disabled = true;
      } else {
        var s = sel;
        twoTap(buy, 'Купить №' + s.serial + ' за ' + money(price) + ' 🪙', 'Точно? Купить №' + s.serial + ' за ' + money(price) + ' 🪙', function () { doBuy(s, c, buy, msg); });
      }
    }
    if (every.length) {
      var offers = el('div', { class: 'mk-offers', role: 'radiogroup', 'aria-label': 'Предложения продавцов' });
      every.forEach(function (l) {
        if (l.mine) {   // свой лот: купить нельзя — нажал, и можно изменить цену или снять
          var me = el('button', { type: 'button', class: 'mk-offer mk-offer-me', 'aria-label': '№' + l.serial + ', ' + money(l.price) + ' монет, твой лот — изменить или снять',
            onclick: function () { openMyLot(l, function () { openMarketCard(cardId); }); } }, [
            el('span', { class: 'mk-offer-no', text: copyNo(c, l.serial) }),
            el('span', { class: 'mk-who mk-mine', text: 'твой лот · изменить' }),
            coinText(l.price)
          ]);
          me.lastChild.classList.add('mk-price');
          offers.appendChild(me);
          return;
        }
        // строка — выбор номера; имя продавца внутри — отдельная кнопка: открывает его мини-профиль
        function choose() {
          sel = l;
          offers.querySelectorAll('.mk-offer[role="radio"]').forEach(function (n) { n.setAttribute('aria-checked', String(n === row)); });
          setBuy();
        }
        var whoKids = [A.avatar ? A.avatar(l.seller_name, l.seller_color, true, l.seller_avatar) : null, el('span', { class: 'mk-who-name', text: l.seller_name || 'Без имени' })];
        var row = el('div', {
          class: 'mk-offer', role: 'radio', tabindex: '0', 'aria-checked': String(l === sel),
          'aria-label': '№' + l.serial + ', ' + money(l.price) + ' монет, продаёт ' + (l.seller_name || 'кто-то'),
          onclick: choose, onkeydown: function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choose(); } }
        }, [
          el('span', { class: 'mk-radio', 'aria-hidden': 'true' }),
          el('span', { class: 'mk-offer-no', text: copyNo(c, l.serial) }),
          l.seller_id && A.person ? A.person(l.seller_id, whoKids, { cls: 'mk-who', label: 'Профиль: ' + (l.seller_name || 'продавец') }) : el('span', { class: 'mk-who' }, whoKids),
          coinText(l.price)
        ]);
        row.lastChild.classList.add('mk-price');
        offers.appendChild(row);
      });
      sheet.appendChild(el('div', { class: 'mk-block' }, [el('h3', { class: 'mk-h', text: 'Предложения продавцов' }), offers]));
      if (!lots.length) sheet.appendChild(el('p', { class: 'kc-note mk-own-note', text: (every.length > 1 ? 'Это твои лоты' : 'Это твой лот') + ' — свою карточку купить нельзя. Других предложений пока нет.' }));
    } else {
      sheet.appendChild(el('p', { class: 'kc-note', text: 'Сейчас никто не продаёт. Создай заявку — купится автоматически, когда кто-то выставит.' }));
    }

    var acts = el('div', { class: 'kc-actions' });
    if (sel) { acts.appendChild(buy); setBuy(); }
    acts.appendChild(el('button', { type: 'button', class: sel ? 'btn' : 'btn primary', text: 'Создать заявку', onclick: function () { openBidForm(cardId, null); } }));
    sheet.appendChild(acts);

    var top = bids.slice(0, 5);
    if (bids.length) {
      sheet.appendChild(el('div', { class: 'mk-block' }, [
        el('h3', { class: 'mk-h', text: 'Заявки покупателей' + (bids.length > top.length ? ' · всего ' + bids.length : '') }),
        el('div', { class: 'mk-bids' }, top.map(function (b) {
          return b.mine
            ? el('button', { type: 'button', class: 'mk-bid mk-bid-me', onclick: function () { openBidForm(cardId, b); } }, [el('span', { text: 'твоя · изменить' }), coinText(b.price, 'до ')])
            : el('div', { class: 'mk-bid' }, [el('span', { text: 'любой номер' }), coinText(b.price, 'до ')]);
        }))
      ]));
    }
    if (mineB.length > top.length) {
      // свои заявки, не попавшие в пятёрку лучших
      sheet.appendChild(el('div', { class: 'mk-bids' }, mineB.filter(function (b) { return top.indexOf(b) < 0; }).map(function (b) {
        return el('button', { type: 'button', class: 'mk-bid mk-bid-me', onclick: function () { openBidForm(cardId, b); } }, [el('span', { text: 'твоя · изменить' }), coinText(b.price, 'до ')]);
      })));
    }

    if (myCopies(cardId).length) {
      var own = el('div', { class: 'kc-actions mk-own' });
      if (free.length && bb) {
        own.appendChild(el('button', { type: 'button', class: 'btn', onclick: function () { openSell(cardId, free[0], function () { openMarketCard(cardId); }); } },
          [coinText(bb.price, 'Продать свою сразу за ')]));
      }
      own.appendChild(el('button', {
        type: 'button', class: 'link mk-link', text: free.length ? 'Выставить свою на продажу' : 'Твоя карточка на витрине — чтобы продать, сначала убери её',
        disabled: !free.length,
        onclick: function () { if (free.length) openSell(cardId, free[0], function () { openMarketCard(cardId); }); }
      }));
      sheet.appendChild(own);
    }
    sheet.appendChild(msg);
  }

  async function doBuy(l, c, btn, msg) {
    if (K.busy) return;
    K.busy = true; btn.disabled = true;
    setText(msg, 'Покупаю…');
    var isNew = !haveCard(c.card_id);
    try {
      var r = one(await rpc('market_buy', { p_listing: l.listing_id, p_price: l.price }));
      if (r) A.setBalance(Number(r.balance));
      K.busy = false;
      await load(); draw(); closeOverlay();
      A.toast(boughtText(c, l.serial, l.price, isNew));
    } catch (e) {
      K.busy = false;
      var t = errText(e);
      try { await load(); draw(); } catch (e2) { /* ничего */ }
      if (ov) openMarketCard(c.card_id, t, l.listing_id);   // например, цену поменяли — показываем новую
    }
  }

  /* ---------- заявка на покупку: создать или изменить ---------- */
  function openBidForm(cardId, bid) {
    var c = cardById(cardId);
    if (!c) return;
    var sheet = bottomSheet((bid ? 'Твоя заявка: ' : 'Заявка на покупку: ') + c.name);
    sheet.classList.add('mk-sheet');
    var msg = el('p', { class: 'msg', role: 'status' });
    var was = bid ? cents(bid.price) : 0;
    var pc = bid ? was : null;
    var cheap = otherLots(cardId)[0] || null;
    var go = el('button', { type: 'button', class: 'btn primary' });
    var holdV = el('span'), leftV = el('span');
    var info = el('p', { class: 'kc-note mk-cross', hidden: true });
    var armed = false, armT = null;
    function avail() { return cents(bal()) + was; }       // сколько можно отложить (своя заявка уже отложена)
    function update() {
      armed = false; clearTimeout(armT);
      var cross = pc && cheap && pc >= cents(cheap.price);
      var need = cross ? cents(cheap.price) : (pc || 0);
      setText(holdV, cross ? '—' : money((pc || 0) / 100) + ' 🪙');
      setText(leftV, money((avail() - need) / 100) + ' 🪙');
      leftV.classList.toggle('mk-neg', avail() - need < 0);
      info.hidden = !cross;
      if (cross) setText(info, 'Уже продаётся дешевле: №' + cheap.serial + ' за ' + money(cheap.price) + ' 🪙 — купится сразу, по этой цене.');
      if (!pc) go.textContent = bid ? 'Сохранить заявку' : 'Создать заявку';
      else if (cross) setText(go, 'Купить сразу за ' + money(cheap.price) + ' 🪙');
      else if (bid) setText(go, 'Сохранить · до ' + money(pc / 100) + ' 🪙');
      else setText(go, 'Создать заявку на ' + money(pc / 100) + ' 🪙');
      go.disabled = !pc || K.busy || avail() - need < 0 || (bid && pc === was);
    }
    var field = priceField(was || null, 'Цена за 1 карточку', 'не выше этой суммы', function (v) { pc = v; update(); });
    go.addEventListener('click', function () {
      var cross = pc && cheap && pc >= cents(cheap.price);
      if (cross && !armed) {   // покупка сразу — в два нажатия, как другие покупки
        armed = true; setText(go, 'Точно? Купить за ' + money(cheap.price) + ' 🪙');
        armT = setTimeout(update, 3000);
        return;
      }
      doBid(c, bid, pc, go, msg);
    });
    field.input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); if (!go.disabled) go.click(); } });
    sheet.appendChild(cardHead(c));
    sheet.appendChild(field.node);
    sheet.appendChild(el('p', { class: 'kc-note mk-any', text: 'Любой номер этой карточки.' }));
    sheet.appendChild(el('div', { class: 'mk-meta' }, [
      metaRow(bid ? 'Будет отложено' : 'Отложится', holdV),
      metaRow('Останется доступно', leftV)
    ]));
    sheet.appendChild(info);
    var acts = el('div', { class: 'kc-actions' }, [go]);
    if (bid) {
      var off = el('button', { type: 'button', class: 'btn', text: 'Отменить заявку', onclick: function () { doBidCancel(c, bid, off, msg); } });
      acts.appendChild(off);
    }
    sheet.appendChild(acts);
    sheet.appendChild(el('p', { class: 'kb-note', text: 'Монеты откладываются, пока заявка висит. Купится автоматически, когда кто-то выставит эту карточку по цене не выше твоей. Отменить можно в «Моих сделках».' }));
    sheet.appendChild(msg);
    update();
    if (!noFocusOnPhone()) { try { field.input.focus({ preventScroll: true }); } catch (e) { field.input.focus(); } }
  }
  async function doBid(c, bid, pc, btn, msg) {
    if (!pc || K.busy) return;
    K.busy = true; btn.disabled = true;
    setText(msg, 'Сохраняю…');
    var isNew = !haveCard(c.card_id);
    try {
      var r = one(bid ? await rpc('market_bid_reprice', { p_bid: bid.bid_id, p_price: pc / 100 })
                      : await rpc('market_bid', { p_card: c.card_id, p_price: pc / 100 }));
      if (r && r.balance != null) A.setBalance(Number(r.balance));
      K.busy = false;
      await load(); draw(); closeOverlay();
      if (r && r.kind === 'bought') A.toast(boughtText(c, r.serial, r.price, isNew));
      else A.toast((bid ? 'Заявка изменена: ' : 'Заявка: ') + '«' + c.name + '» до ' + money(pc / 100) + ' 🪙');
    } catch (e) {
      K.busy = false;
      setText(msg, errText(e)); btn.disabled = false;
      try { await load(); draw(); } catch (e2) { /* ничего */ }
    }
  }
  async function doBidCancel(c, bid, btn, msg) {
    if (K.busy) return;
    K.busy = true; btn.disabled = true;
    setText(msg, 'Отменяю…');
    try {
      var b = await rpc('market_bid_cancel', { p_bid: bid.bid_id });
      if (b != null) A.setBalance(Number(one(b)));
      K.busy = false;
      await load(); draw(); closeOverlay();
      A.toast('Заявка отменена · ' + money(bid.price) + ' 🪙 снова доступны');
    } catch (e) {
      K.busy = false;
      setText(msg, errText(e)); btn.disabled = false;
      try { await load(); draw(); } catch (e2) { /* ничего */ }
    }
  }

  /* ---------- «Продать»: свои карточки ---------- */
  function sellView() {
    var cards = K.catalog.slice().sort(byRarity).filter(function (c) {
      var n = myCopies(c.card_id).length;
      return K.sellDup ? n > 1 : n > 0;
    });
    var toggle = el('div', { class: 'ka-filters', role: 'group', 'aria-label': 'Какие показать' }, [['all', 'Все мои'], ['dup', 'Только повторы']].map(function (f) {
      return el('button', { type: 'button', class: 'ka-filter', 'aria-pressed': String((f[0] === 'dup') === !!K.sellDup), text: f[1], onclick: function () {
        K.sellDup = f[0] === 'dup'; draw();
      } });
    }));
    var body;
    if (!cards.length) {
      body = el('p', { class: 'kc-note mk-empty', text: K.sellDup ? 'Повторов пока нет.' : 'В коллекции пока нет карточек. Открой первую во вкладке «Коллекция».' });
    } else {
      body = el('div', { class: 'coll-grid mk-pick-grid' }, cards.map(function (c) {
        var free = freeCopies(c.card_id), n = myCopies(c.card_id).length, bb = bestBid(c.card_id);
        var p = el('span', { class: 'kt-pic r-' + c.rarity }, [window.Cards.art(c.code)]);
        if (n > 1) p.appendChild(el('span', { class: 'kt-count', text: '×' + n }));
        if (!free.length) p.appendChild(el('span', { class: 'kt-tag', text: 'на витрине' }));
        else if (bb) { var t = el('span', { class: 'kt-tag mk-bidtag' }); setText(t, money(bb.price) + ' 🪙'); p.appendChild(t); }
        return el('button', {
          type: 'button', class: 'kt r-' + c.rarity + (free.length ? '' : ' kt-away'),
          'aria-label': c.name + (n > 1 ? ', копий: ' + n : '') + (free.length ? '' : ', на витрине') + (bb ? ', есть заявка за ' + money(bb.price) : ''),
          onclick: function () {
            if (!free.length) { A.toast('Эта карточка на витрине. Сначала убери её оттуда в коллекции.'); return; }
            openSell(c.card_id, free[0], closeOverlay);
          }
        }, [p, el('span', { class: 'kt-name', text: c.name })]);
      }));
    }
    return [el('section', { class: 'sect mk-sellv' }, [
      toggle,
      el('p', { class: 'mk-sum', text: 'Нажми на карточку — выбери номер и цену. Цена на карточке — лучшая заявка: продашь сразу.' }),
      body
    ])];
  }

  /* ---------- «Мои сделки»: продаю, покупаю, история ---------- */
  var DEAL_TABS = [['sell', 'Продаю'], ['buy', 'Покупаю'], ['hist', 'История']];
  function dealsView() {
    var lots = myLots(), bids = myBids();
    var head = el('p', { class: 'mk-sum mk-bal' });
    setText(head, 'Доступно: ' + money(bal()) + ' 🪙 · В заявках: ' + money(reservedC() / 100) + ' 🪙');
    var seg = el('div', { class: 'segment three mk-dtabs', role: 'group', 'aria-label': 'Мои сделки' }, DEAL_TABS.map(function (x) {
      var n = x[0] === 'sell' ? lots.length : x[0] === 'buy' ? bids.length : 0;
      return el('button', { type: 'button', 'aria-pressed': String(K.dealsTab === x[0]), onclick: function () {
        if (K.dealsTab === x[0]) return;
        K.dealsTab = x[0]; draw();
        if (x[0] === 'hist') refreshHist();
      } }, [x[1], n ? el('span', { class: 'seg-badge', 'aria-hidden': 'true', text: String(n) }) : null]);
    }));
    var body;
    if (K.dealsTab === 'buy') {
      body = bids.length ? el('div', { class: 'mk-list' }, bids.map(bidRow))
        : el('p', { class: 'kc-note mk-empty', text: 'Заявок нет. Создать — на странице карточки во вкладке «Рынок».' });
    } else if (K.dealsTab === 'hist') {
      if (!K.hist && !K.histErr && !histBusy) setTimeout(refreshHist, 0);
      if (!K.hist) body = el('p', { class: 'muted', text: K.histErr ? 'Историю не получилось загрузить.' : 'Загружаю…' });
      else body = K.hist.length ? el('div', { class: 'mk-list' }, K.hist.map(histRow)) : el('p', { class: 'kc-note mk-empty', text: 'Сделок пока не было.' });
    } else {
      body = lots.length ? el('div', { class: 'mk-list' }, lots.map(lotRow))
        : el('p', { class: 'kc-note mk-empty', text: 'Ничего не продаёшь. Выставить — во вкладке «Продать».' });
    }
    return [el('section', { class: 'sect mk-deals' }, [head, seg, body])];
  }
  // Строка моего лота: рисунок, название и номер, цена — нажал, и можно изменить цену или снять
  function lotRow(l) {
    var c = cardById(l.card_id);
    if (!c) return null;
    var bb = bestBid(c.card_id);
    var price = coinText(l.price); price.classList.add('mk-price');
    return el('button', {
      type: 'button', class: 'mk-lot',
      'aria-label': c.name + ', ' + copyNo(c, l.serial) + ', ' + money(l.price) + ' монет, твой лот',
      onclick: function () { openMyLot(l); }
    }, [
      pic(c),
      el('span', { class: 'mk-info' }, [
        el('span', { class: 'mk-name', text: c.name }),
        el('span', { class: 'mk-no', text: R(c.rarity).name + ' · ' + copyNo(c, l.serial) }),
        el('span', { class: 'mk-who', text: bb ? 'есть заявка за ' + money(bb.price) : 'нажми, чтобы изменить или снять' })
      ]),
      price
    ]);
  }
  // Строка моей заявки: «до 100», дешевле всех в продаже — нажал, и можно изменить или отменить
  function bidRow(b) {
    var c = cardById(b.card_id);
    if (!c) return null;
    var cheap = otherLots(c.card_id)[0];
    var price = coinText(b.price, 'до '); price.classList.add('mk-price');
    return el('button', {
      type: 'button', class: 'mk-lot',
      'aria-label': c.name + ', заявка до ' + money(b.price) + ' монет',
      onclick: function () { openBidForm(c.card_id, b); }
    }, [
      pic(c),
      el('span', { class: 'mk-info' }, [
        el('span', { class: 'mk-name', text: c.name }),
        el('span', { class: 'mk-no', text: 'Любой номер · отложено' }),
        el('span', { class: 'mk-who', text: cheap ? 'в продаже от ' + money(cheap.price) : 'в продаже нет · ждём продавца' })
      ]),
      price
    ]);
  }
  function dateText(s) {
    var d = new Date(s);
    if (isNaN(d)) return '';
    return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  // Строка истории: продал / купил, с кем, по заявке ли, сколько монет
  function histRow(h) {
    var c = cardById(h.card_id);
    if (!c) return null;
    var sold = h.side === 'sold';
    var sum = coinText(sold ? h.net : h.price, sold ? '+' : '−');
    sum.classList.add('mk-price', sold ? 'mk-plus' : 'mk-minus');
    return el('div', { class: 'mk-lot mk-hist' }, [
      pic(c),
      el('span', { class: 'mk-info' }, [
        el('span', { class: 'mk-name', text: c.name + ' ' + copyNo(c, h.serial) }),
        el('span', { class: 'mk-no', text: (sold ? 'Продано' : 'Куплено') + (h.via_bid ? ' по заявке' : '') + ' · ' + dateText(h.at) }),
        el('span', { class: 'mk-who', text: (sold ? 'покупатель: ' : 'продавец: ') + (h.other_name || 'кто-то') })
      ]),
      sum
    ]);
  }

  function metaRow(name, value) {
    var v = typeof value === 'string' ? el('span', { text: value }) : value;
    return el('div', { class: 'mk-meta-row' }, [el('span', { text: name }), v]);
  }

  /* ---------- лавка: мой лот — изменить цену или снять ---------- */
  function openMyLot(l, back) {
    var c = cardById(l.card_id);
    if (!c) return;
    var sheet = bottomSheet(c.name + ' — твой лот');
    var msg = el('p', { class: 'msg', role: 'status' });
    var was = cents(l.price), pc = was;
    var bb = bestBid(c.card_id);
    var save = el('button', { type: 'button', class: 'btn primary' });
    function label() {
      if (pc && pc !== was && bb && pc <= cents(bb.price)) setText(save, 'Продать по заявке за ' + money(bb.price) + ' 🪙');
      else if (pc && pc !== was) setText(save, 'Сохранить цену · ' + money(pc / 100) + ' 🪙');
      else save.textContent = 'Сохранить цену';
      save.disabled = !pc || pc === was || K.busy;
    }
    var box = priceBox(was, function (v) { pc = v; label(); });
    label();
    save.addEventListener('click', function () { doReprice(l, c, pc, save, msg); });
    var off = el('button', { type: 'button', class: 'btn', text: 'Снять с продажи', onclick: function () { doCancel(l, c, off, msg); } });
    sheet.appendChild(cardHead(c));
    sheet.appendChild(el('p', { class: 'kb-info', text: 'Твой лот: ' + copyNo(c, l.serial) + (bb ? ' · лучшая заявка ' + money(bb.price) : '') }));
    sheet.appendChild(box.node);
    var acts = el('div', { class: 'kc-actions' }, [save, off]);
    if (back) acts.appendChild(el('button', { type: 'button', class: 'btn kr-ghost mk-back', text: 'Назад', onclick: back }));
    sheet.appendChild(acts);
    sheet.appendChild(el('p', { class: 'kc-note', text: 'Снятая карточка сразу вернётся в коллекцию.' }));
    sheet.appendChild(msg);
  }
  async function doReprice(l, c, pc, btn, msg) {
    if (!pc || K.busy) return;
    K.busy = true; btn.disabled = true;
    setText(msg, 'Сохраняю…');
    try {
      await rpc('market_reprice', { p_listing: l.listing_id, p_price: pc / 100 });
      K.busy = false;
      await load(); draw(); closeOverlay();
      // лот исчез — значит, нашлась заявка и он продан по её цене
      var still = (K.lots || []).some(function (x) { return x.listing_id === l.listing_id; });
      if (still) A.toast('Новая цена: ' + money(pc / 100) + ' 🪙');
      else { if (A.loadPoints) { try { await A.loadPoints(); } catch (e) { /* ничего */ } } A.toast('Продано по заявке: «' + c.name + '» №' + l.serial); }
    } catch (e) {
      K.busy = false;
      setText(msg, errText(e)); btn.disabled = false;
      try { await load(); draw(); } catch (e2) { /* ничего */ }
    }
  }
  async function doCancel(l, c, btn, msg) {
    if (K.busy) return;
    K.busy = true; btn.disabled = true;
    setText(msg, 'Снимаю…');
    try {
      await rpc('market_cancel', { p_listing: l.listing_id });
      K.busy = false;
      await load(); draw(); closeOverlay();
      A.toast('«' + c.name + '» снова в коллекции');
    } catch (e) {
      K.busy = false;
      setText(msg, errText(e)); btn.disabled = false;
      try { await load(); draw(); } catch (e2) { /* ничего */ }
    }
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
    if (drag.phase === 'pick') { pickMove(); return; }
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
    var target = d.phase === 'move' && d.over ? Number(d.over.getAttribute('data-drop')) : null;
    cancel(); // отпустил на ряду копий или мимо полок — ничего не происходит
    if (target !== null && !isNaN(target)) dropTo(d, target);
  }
  function cancel() {
    if (!drag) return;
    clearTimeout(drag.timer);
    if (drag.ghost) drag.ghost.remove();
    if (drag.bar) drag.bar.remove();
    if (drag.picker) drag.picker.remove();
    if (drag.over) drag.over.classList.remove('drop-over');
    if (drag.node) drag.node.classList.remove('kc-lifting');
    document.body.classList.remove('kc-dragging');
    drag = null;
  }

  // Зажал. С витрины — сразу «поднимаем» эту копию. Из коллекции: одна копия — тоже сразу,
  // несколько — сначала ряд копий над пальцем (№2, №5…): ведёшь палец на нужную, потом дальше — на полки.
  function lift() {
    if (!drag) return;
    drag.active = true;
    document.body.classList.add('kc-dragging');
    drag.node.classList.add('kc-lifting');
    if (drag.kind === 'shelf') { carry(drag.id); return; }
    var copies = myCopies(drag.id);
    if (!copies.length) { cancel(); return; }
    if (copies.length === 1) { carry(copies[0].copy_id); return; }
    showPicker(copies);
  }

  function showPicker(copies) {
    var c = cardById(drag.id);
    drag.phase = 'pick';
    drag.copies = copies;
    drag.pick = -1;
    drag.entered = false;
    drag.picker = el('div', { class: 'kc-picker', 'aria-hidden': 'true' }, copies.map(function (k, i) {
      var pic = el('span', { class: 'kt-pic r-' + c.rarity });
      pic.appendChild(window.Cards.art(c.code));
      return el('div', { class: 'kc-pick', 'data-pick': String(i) }, [pic, el('span', { class: 'kc-pick-no', text: '№' + k.serial + (k.slot ? ' ★' : '') })]);
    }));
    document.body.appendChild(drag.picker);
    // над пальцем; если не помещается сверху — под пальцем
    var r = drag.picker.getBoundingClientRect();
    var vw = document.documentElement.clientWidth;
    var left = Math.min(Math.max(8, drag.x - r.width / 2), vw - r.width - 8);
    var top = drag.y - r.height - 34;
    if (top < 8) top = drag.y + 34;
    drag.picker.style.left = left + 'px';
    drag.picker.style.top = top + 'px';
  }
  function pickMove() {
    var hit = document.elementFromPoint(drag.x, drag.y);
    var p = hit && hit.closest ? hit.closest('.kc-pick') : null;
    if (p) {
      var i = Number(p.getAttribute('data-pick'));
      if (i !== drag.pick) {
        drag.picker.querySelectorAll('.kc-pick').forEach(function (n) { n.classList.toggle('on', n === p); });
        drag.pick = i;
      }
      drag.entered = true;
      return;
    }
    var r = drag.picker.getBoundingClientRect(), m = 16;
    var inside = drag.x > r.left - m && drag.x < r.right + m && drag.y > r.top - m && drag.y < r.bottom + m;
    var far = Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > 56;
    // выбрал копию и повёл палец дальше — копия «поднимается», появляются полки
    if ((drag.entered && !inside) || (!drag.entered && far && !inside)) {
      var k = drag.copies[drag.pick >= 0 ? drag.pick : 0];
      drag.picker.remove(); drag.picker = null;
      carry(k.copy_id);
    }
  }

  // Копия едет за пальцем; для карточки из коллекции сверху — три полки.
  function carry(copyId) {
    var k = (K.my || []).filter(function (x) { return x.copy_id === copyId; })[0];
    var c = k && cardById(k.card_id);
    if (!c) { cancel(); return; }
    drag.phase = 'move';
    drag.copyId = copyId;
    var pic = el('span', { class: 'kt-pic r-' + c.rarity });
    pic.appendChild(window.Cards.art(c.code));
    if (myCopies(c.card_id).length > 1) pic.appendChild(el('span', { class: 'kt-count', text: '№' + k.serial }));
    drag.ghost = el('div', { class: 'kc-ghost', 'aria-hidden': 'true' }, [pic]);
    document.body.appendChild(drag.ghost);
    place();
    if (drag.kind === 'grid') {
      var on = shelved();
      drag.bar = el('div', { class: 'kc-dropbar', 'aria-hidden': 'true' }, [0, 1, 2].map(function (i) {
        var s = on[i], oc = s && cardById(s.card_id);
        var t = el('div', { class: 'kc-drop' + (oc ? ' r-' + oc.rarity : ''), 'data-drop': String(i) });
        if (oc) {
          t.appendChild(window.Cards.art(oc.code));
          t.appendChild(el('span', { class: 'kt-count', text: '№' + s.serial }));   // номер копии на полке
        } else t.textContent = '+';
        return t;
      }));
      document.body.appendChild(drag.bar);
    }
  }
  function place() {
    if (drag && drag.ghost) drag.ghost.style.transform = 'translate(' + drag.x + 'px,' + drag.y + 'px) translate(-50%, -62%) rotate(-3deg)';
  }

  // Новый порядок витрины, если копию copyId положить на полку t (0, 1, 2).
  // Копии одной карточки (№2 и №5) могут стоять рядом: каждая копия — сама по себе.
  function planShelves(copyId, t) {
    var on = shelved();
    var order = on.map(function (k) { return k.copy_id; });
    var from = order.indexOf(copyId);
    var moving = from >= 0;              // эта копия уже стоит на витрине — просто двигаем
    if (from >= 0) {
      if (t >= order.length) { order.splice(from, 1); order.push(copyId); }       // на пустую — в конец
      else if (t !== from) { order[from] = order[t]; order[t] = copyId; }         // поменять местами
    } else if (t < order.length) {
      order[t] = copyId;                 // заменяет ту, что стояла
    } else {
      order.push(copyId);                // на первую свободную слева
    }
    var msg = !moving ? 'Поставлено на витрину' : (t < on.length ? 'Поменял местами' : 'Передвинул');
    return { on: on, order: order, msg: msg };
  }
  async function writeShelves(plan) {
    // пишем полки по порядку; убранная (при замене) уходит с витрины сама
    for (var i = 0; i < plan.order.length; i++) {
      var was = plan.on.filter(function (k) { return k.copy_id === plan.order[i]; })[0];
      if (!was || was.slot !== i + 1) await rpc('cards_set_showcase', { p_slot: i + 1, p_copy: plan.order[i] });
    }
  }

  // Карточку отпустили над полкой t.
  async function dropTo(d, t) {
    if (!d.copyId) return;
    if (isFake(d.copyId)) { A.toast('Копию из режима проверки на витрину не поставить'); return; }
    var plan = planShelves(d.copyId, t);
    var same = plan.order.length === plan.on.length && plan.order.every(function (id, i) { return plan.on[i].copy_id === id; });
    if (same) return;
    K.busy = true;
    try { await writeShelves(plan); A.toast(plan.msg); } catch (e) { A.toast(errText(e)); }
    K.busy = false;
    await reload();
  }

  /* ---------- открытие карточки и пака ---------- */
  // Сначала платим (база выбирает карточку), потом раскрываем по нажатиям:
  // рубашка → серый фон → (если редкость выше) зелёный → синий → фиолетовый → золотой → переворот.
  // У пака перед этим ещё одно нажатие: упаковка рвётся по линии отрыва, под ней — рубашка.
  async function openCard() {
    if (K.busy || !K.deck || !K.deck.price) return;
    var price = K.deck.price;
    if (bal() < price) { K.msg = 'Не хватает монет.'; draw(); return; }
    runReveal({ price: price });
  }
  // Открыть пак: copyId — какой (без него — первый по номеру). Что выпадет — решает база (cards_pack_open).
  function openPack(copyId) {
    if (K.busy) return;
    var mine = myPacks();
    var k = mine.filter(function (x) { return x.copy_id === copyId; })[0] || mine[0];
    if (!k) return;
    markPacksSeen();
    runReveal({ pack: k.copy_id });
  }
  // src: { price } — карточка из колоды за монеты; { pack: id копии пака } — открыть пак
  async function runReveal(src) {
    K.busy = true; K.msg = '';
    var had = {}; myAll().forEach(function (k) { had[k.card_id] = true; });
    myLots().forEach(function (l) { had[l.card_id] = true; }); // карточка в лавке — тоже «уже была»

    var o = overlay('kr' + (src.pack ? ' kr-pk' : ''), src.pack ? 'Открытие пака' : 'Открытие карточки');
    var layers = [1, 2, 3, 4, 5].map(function (i) { return el('div', { class: 'kr-l kr-l' + i, 'aria-hidden': 'true' }); });
    layers.forEach(function (l) { o.appendChild(l); });
    var flip = el('div', { class: 'kr-flip' });
    var backFace = el('div', { class: 'kr-face kr-back' }, [window.Cards.back('lg')]);
    var frontFace = el('div', { class: 'kr-face kr-front' });
    flip.appendChild(backFace); flip.appendChild(frontFace);
    var stage = el('button', { type: 'button', class: 'kr-stage kr-wait', 'aria-label': src.pack ? 'Открыть пак' : 'Открыть' }, [flip]);
    // пак лежит поверх рубашки: две половинки одного рисунка — полоска над линией отрыва и сама упаковка
    var cover = src.pack ? el('div', { class: 'kr-cover', 'aria-hidden': 'true' }, [
      el('div', { class: 'kr-cover-top' }, [window.Cards.pack('lg')]),
      el('div', { class: 'kr-cover-body' }, [window.Cards.pack('lg')])
    ]) : null;
    if (cover) stage.appendChild(cover);
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
      if (cover) {   // первое нажатие у пака — упаковка рвётся
        var c0 = cover; cover = null;
        c0.classList.add('torn');
        stage.setAttribute('aria-label', 'Открыть');
        setTimeout(function () { c0.remove(); }, reduce ? 0 : 650);
        return;
      }
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
    // номер под карточкой: «№2 из 4», единственная в тираже, из пака — «№7/6 · сверх тиража»
    function serialText() {
      if (res.serial > res.copies) return 'из пака · №' + res.serial + '/' + res.copies + ', сверх тиража';
      return res.copies === 1 ? 'единственная в тираже' : '№' + res.serial + ' из ' + res.copies;
    }
    // Результат: «Новая карточка» или «Повтор · теперь ×3», редкость, прогресс альбома,
    // «В коллекцию», «На витрину», «Открыть ещё за N» (не хватает монет — неактивна) или «Открыть ещё пак».
    function showResult(card) {
      var isNew = !had[res.card_id];
      var cat = cardById(res.card_id);
      var total = albumCards().length;
      var gotIds = ownedIds();
      var before = Object.keys(gotIds).length;
      gotIds[res.card_id] = true;
      var after = Object.keys(gotIds).length;
      var dup = myCopies(res.card_id).length + 1;     // K.my ещё старый — плюс только что открытая
      var badge = el('span', { class: 'kr-badge r-' + res.rarity, text: isNew ? 'Новая карточка' : dup >= 2 ? 'Повтор · теперь ×' + dup : 'Повтор' });
      o.insertBefore(badge, stage);
      var info = el('p', { class: 'kr-sub' }, [el('span', { class: 'kd-dot r-' + res.rarity, 'aria-hidden': 'true' }),
        ' ' + R(res.rarity).name + ' · ' + serialText()]);
      var extra = null;
      if (isNew) {
        var fill = el('span', { style: 'width:' + (total ? Math.round(before / total * 100) : 0) + '%' });
        extra = el('div', { class: 'kr-prog' }, [el('span', { class: 'kr-prog-t', text: 'Собрано ' + after + ' из ' + total }),
          el('div', { class: 'coll-bar', 'aria-hidden': 'true' }, [fill])]);
        requestAnimationFrame(function () { requestAnimationFrame(function () { fill.style.width = (total ? Math.round(after / total * 100) : 0) + '%'; }); });
      } else if (cat && cat.melt_value) {
        extra = el('p', { class: 'kr-sub' }); setText(extra, 'Повтор можно переплавить за ' + cat.melt_value + ' 🪙');
      }
      var toColl = el('button', { type: 'button', class: 'btn primary', text: 'В коллекцию', onclick: function () { finish(false); } });
      var toShelf = K.pv ? null : el('button', { type: 'button', class: 'btn kr-ghost', text: 'На витрину', onclick: function () { finish('shelf'); } });
      var again = el('button', { type: 'button', class: 'btn kr-again' });
      if (src.pack) {
        // ещё паки есть — «Открыть ещё пак · осталось N», нет — кнопки нет
        if (res.packs_left > 0) again.textContent = 'Открыть ещё пак · осталось ' + res.packs_left;
        else again = null;
      } else {
        var next = res.next_price;
        var short = next ? Math.max(0, cents(next) - cents(bal())) / 100 : 0;
        if (!next) again.textContent = 'Колода закончилась';
        else setText(again, 'Открыть ещё за ' + next + ' 🪙');   // не хватает монет — та же цена, кнопка неактивна
        again.disabled = !next || short > 0;
      }
      if (again) again.addEventListener('click', function () { finish(true); });
      result.replaceChildren.apply(result, [info, extra, el('div', { class: 'kr-btns' }, [toColl, toShelf, again].filter(Boolean))].filter(Boolean));
      result.classList.add('on');
      toColl.focus();
    }
    // more: true — открыть ещё; 'shelf' — поставить открытую копию на витрину (полная витрина — панель карточки с подсказкой)
    async function finish(more) {
      closeOverlay();
      K.busy = false;
      await reload();
      if (more === true) { if (src.pack) openPack(); else openCard(); return; }
      if (more === 'shelf') {
        var sel = (K.my || []).filter(function (k) { return k.copy_id === Number(res.copy_id); })[0];
        if (!sel) return;
        markSeen(sel.card_id);
        if (shelved().length >= 3) { openDetail(sel.card_id, sel.copy_id, 'Витрина полная: сначала убери одну карточку.'); return; }
        await shelfAdd(sel.card_id, sel, document.getElementById('coll-msg') || el('p'));
      }
    }

    o.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('button');
      if (b && b !== stage) return; // свои кнопки («Готово», «Открыть ещё») работают сами
      step();
    });
    o._cleanup = onKey(function () { if (done) finish(false); });

    try {
      if (src.pack && K.pv) { await new Promise(function (r) { setTimeout(r, 350); }); res = pvOpen(src.pack); }
      else res = one(src.pack ? await rpc('cards_pack_open', { p_copy: src.pack })
                              : await rpc('cards_open', { p_series: SERIES, p_price: src.price }));
      if (!res) throw new Error('empty');
      if (res.balance != null) A.setBalance(Number(res.balance));
      rank = R(res.rarity).rank;
      stage.classList.remove('kr-wait');
    } catch (e) {
      closeOverlay();
      K.busy = false;
      if (src.pack) A.toast(errText(e)); else K.msg = errText(e);
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

  /* ---------- моя витрина в Профиле ---------- */
  // Три карточки крупно и «Собрано X из 20». Данные — те же, что во вкладке (обновляются не чаще раза в 30 секунд).
  async function profileShelf(node) {
    A = window.AppAPI;
    function paint() {
      if (!K.catalog || !K.my) return;
      var on = shelved();
      var got = ownedIds();
      node.replaceChildren(
        el('div', { class: 'me-shelf-head' }, [el('span', { class: 'me-card-l', text: 'Моя витрина' }),
          el('span', { class: 'me-shelf-n', text: 'Собрано ' + Object.keys(got).length + ' из ' + albumCards().length })]),
        el('div', { class: 'shelves' }, [0, 1, 2].map(function (i) {
          var k = on[i], c = k && cardById(k.card_id);
          if (!c) return el('div', { class: 'shelf shelf-empty' }, [el('span', { text: 'пусто' })]);
          var w = el('div', { class: 'shelf' }); w.appendChild(window.Cards.face(c, k.serial, 'md')); return w;
        }))
      );
      if (!on.length) node.appendChild(el('p', { class: 'me-shelf-note', text: 'Поставь карточки на витрину в Коллекции' }));
      keepLoops(node);
    }
    paint();
    if (K.loadedAt && Date.now() - K.loadedAt < 30000) return;
    try {
      var res = await Promise.all([K.catalog ? K.catalog : rpc('cards_catalog', { p_series: SERIES }), rpc('cards_my')]);
      K.catalog = res[0] || []; K.my = res[1] || []; K.loadedAt = Date.now();
    } catch (e) { if (!K.my) { node.hidden = true; return; } }
    paint();
  }

  /* ---------- витрина друга (из таблицы «Участники») ---------- */
  // Раньше — окно с витриной друга; теперь открывается мини-профиль (people.js), там и витрина
  async function showFriend(userId, name) {
    if (window.People) { window.People.open(userId); return; }
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
      sheet.replaceChild(el('p', { class: 'muted', text: 'Собрано ' + got + ' из ' + albumCards().length }), sheet.lastChild);
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
    enter: enter, leave: leave, showFriend: showFriend, setMode: setMode, profileShelf: profileShelf,
    _state: function () { return K; }
  };
})();
