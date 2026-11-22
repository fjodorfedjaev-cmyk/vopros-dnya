/* Игральные карты — общие для карточных игр («Дурак», «Покер», «Верю — не верю»): как нарисовать карту и рубашку, и как карты летают по столу.
   Карта — число 0..51: достоинство = карта / 4 + 2 (11 — валет, 14 — туз), масть = карта % 4 (♠ ♥ ♦ ♣); 52..55 — джокеры.
   Элементы создаются через window.AppAPI.el (как и весь сайт). */
(function () {
  'use strict';
  var SUITS = ['♠', '♥', '♦', '♣'];
  var NAMES = { 11: 'В', 12: 'Д', 13: 'К', 14: 'Т' };
  var VS = '︎'; // чтобы ♥ и ♦ рисовались значком, а не цветным смайликом
  function el() { return window.AppAPI.el.apply(null, arguments); }
  function isJoker(c) { return c >= 52; }
  function rank(c) { return isJoker(c) ? 0 : Math.floor(c / 4) + 2; }   // у джокера номинала нет
  function suit(c) { return c % 4; }
  function rankName(r) { return NAMES[r] || String(r); }
  function cardName(c) { return isJoker(c) ? 'Джокер' : rankName(rank(c)) + SUITS[suit(c)] + VS; }
  function isRed(c) { return !isJoker(c) && (suit(c) === 1 || suit(c) === 2); }

  // Лицо карты. opts: small, button, cls, label, pressed, onclick
  function face(c, opts) {
    opts = opts || {};
    var cls = 'dk-card' + (isRed(c) ? ' red' : '') + (isJoker(c) ? ' joker' : '') + (opts.small ? ' sm' : '') + (opts.cls ? ' ' + opts.cls : '');
    return el(opts.button ? 'button' : 'span', {
      class: cls, type: opts.button ? 'button' : null, 'aria-label': opts.label || cardName(c), 'data-card': String(c),
      'aria-pressed': opts.pressed != null ? String(!!opts.pressed) : null, onclick: opts.onclick || null
    }, [
      el('span', { class: 'dk-r', 'aria-hidden': 'true', text: isJoker(c) ? 'Дж' : rankName(rank(c)) }),
      el('span', { class: 'dk-s', 'aria-hidden': 'true', text: isJoker(c) ? '★' : SUITS[suit(c)] + VS })
    ]);
  }
  // Рубашка. opts: small, button, n (число поверх), cls, label, onclick
  function back(opts) {
    opts = opts || {};
    return el(opts.button ? 'button' : 'span', {
      class: 'dk-card back' + (opts.small ? ' sm' : '') + (opts.cls ? ' ' + opts.cls : ''), type: opts.button ? 'button' : null,
      'aria-label': opts.label || 'Закрытая карта', onclick: opts.onclick || null
    }, opts.n != null ? [el('span', { class: 'dk-n', text: String(opts.n) })] : []);
  }

  /* ---------- полёты ---------- */
  // Слой поверх страницы, в нём летают карты. Время каждого полёта — доли секунды, игру не задерживают.
  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function layer() {
    var l = document.getElementById('dk-fx');
    if (!l) { l = el('div', { id: 'dk-fx', class: 'dk-fx', 'aria-hidden': 'true' }); document.body.appendChild(l); }
    return l;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function centerOf(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  function visible(node) { return !!(node && node.getBoundingClientRect().width); }
  // Поставить node в центр элемента from (с масштабом s)
  function placeAt(node, from, s) {
    var a = from.getBoundingClientRect();
    layer().appendChild(node);
    var c = centerOf(a);
    node.style.left = (c.x - node.offsetWidth / 2) + 'px';
    node.style.top = (c.y - node.offsetHeight / 2) + 'px';
    node.style.transform = 'scale(' + s + ')';
    return c;
  }
  // Полёт node из from в to. o: s0, s1 (масштаб в начале и в конце), ms, delay, rot, fade
  function fly(node, from, to, o) {
    o = o || {};
    if (!visible(from) || !visible(to)) return Promise.resolve();
    node.classList.add('dk-flying');
    var s0 = o.s0 || 1, s1 = o.s1 || 1;
    var a = placeAt(node, from, s0), b = centerOf(to.getBoundingClientRect());
    var dx = b.x - a.x, dy = b.y - a.y;
    var anim = node.animate([
      { transform: 'translate(0,0) scale(' + s0 + ') rotate(0deg)', opacity: 1 },
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + s1 + ') rotate(' + (o.rot || 0) + 'deg)', opacity: o.fade ? 0 : 1 }
    ], { duration: o.ms || 340, delay: o.delay || 0, easing: 'cubic-bezier(.25,.75,.3,1)', fill: 'forwards' });
    return anim.finished.then(function () { node.remove(); }, function () { node.remove(); });
  }
  // Несколько рубашек подряд
  function flyBacks(from, to, n, o) {
    o = o || {};
    var all = [];
    for (var i = 0; i < Math.max(1, Math.min(n, 5)); i++) {
      all.push(fly(back({ cls: 'dk-fly-back' }), from, to, { s0: o.s0 || 0.6, s1: o.s1 || 0.6, delay: (o.delay || 0) + i * (o.gap || 60), rot: o.rot || 0, ms: o.ms || 330, fade: o.fade }));
    }
    return Promise.all(all);
  }
  // Переворот на месте: рубашка → лицо карты c. s — масштаб; o: ms, delay, hold (пауза после), keep (не прятать карту под ним), faceEl (своё лицо карты)
  function flipAt(from, c, s, o) {
    o = o || {};
    if (!visible(from)) return Promise.resolve();
    var inner = el('div', { class: 'dk-flip-in' }, [back({ cls: 'dk-flip-back' }), o.faceEl ? o.faceEl(c) : face(c, { cls: 'dk-flip-face' })]);
    var node = el('div', { class: 'dk-flip dk-flying' }, [inner]);
    placeAt(node, from, s);
    if (from.firstChild && !o.keep) from.firstChild.style.visibility = 'hidden';
    return inner.animate([{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }],
      { duration: o.ms || 420, delay: o.delay || 0, easing: 'ease-in-out', fill: 'forwards' }).finished
      .then(function () { return wait(o.hold != null ? o.hold : 160); }).then(function () { node.remove(); });
  }
  // Вспышка надписи над элементом («Бита!»)
  function flash(target, text, cls) {
    if (!target) return;
    var node = el('div', { class: 'dk-flash' + (cls ? ' ' + cls : ''), text: text });
    placeAt(node, target, 1);
    node.animate([{ transform: 'scale(.5)', opacity: 0 }, { transform: 'scale(1.15)', opacity: 1, offset: 0.3 }, { transform: 'scale(1)', opacity: 0 }],
      { duration: 900, easing: 'ease-out', fill: 'forwards' }).finished.then(function () { node.remove(); }, function () { node.remove(); });
  }

  window.PlayingCards = {
    SUITS: SUITS, rank: rank, suit: suit, rankName: rankName, cardName: cardName, isRed: isRed, isJoker: isJoker,
    face: face, back: back,
    REDUCED: REDUCED, layer: layer, wait: wait, centerOf: centerOf, placeAt: placeAt, fly: fly, flyBacks: flyBacks, flipAt: flipAt, flash: flash
  };
})();
