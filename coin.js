/* Монета сайта: своя картинка вместо смайлика 🪙.
   Смайлик каждый телефон рисует по-своему (на iPhone он серый), а эта монета
   выглядит одинаково везде и сделана в цветах сайта (оранжевая, со звездой).

   Как пользоваться:
   - в тексте можно по-прежнему писать «🪙» — помощники el() / h() сами заменят его на картинку;
   - Coin.fill(элемент, 'текст с 🪙') — то же самое для уже существующего элемента;
   - Coin.img — готовая картинка для рисования на холсте (Зигзаг). */
(function () {
  var SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" height="96">' + // размер нужен холсту, в тексте монета всё равно 1em
    '<defs>' +
    '<linearGradient id="r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E06A1F"/><stop offset="1" stop-color="#93390A"/></linearGradient>' +
    '<linearGradient id="f" x1=".2" y1=".08" x2=".8" y2=".95"><stop offset="0" stop-color="#FFB772"/><stop offset=".55" stop-color="#F2782C"/><stop offset="1" stop-color="#D45A14"/></linearGradient>' +
    '</defs>' +
    '<circle cx="12" cy="12" r="11.5" fill="url(#r)"/>' +                                   // ребро
    '<circle cx="12" cy="11.6" r="9.7" fill="url(#f)"/>' +                                  // лицевая сторона
    '<circle cx="12" cy="11.6" r="7.7" fill="none" stroke="#A8420B" stroke-opacity=".5" stroke-width=".9"/>' + // ободок
    '<path d="M12 6.6l1.55 3.25 3.55.45-2.6 2.45.66 3.5L12 14.55l-3.16 1.7.66-3.5-2.6-2.45 3.55-.45z" fill="#8A3405" fill-opacity=".85"/>' + // звезда
    '<path d="M5.3 9.3A7.2 7.2 0 0 1 9.3 5.1" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.1" stroke-linecap="round"/>' + // блик
    '</svg>';
  var URL_ = 'data:image/svg+xml,' + encodeURIComponent(SVG);
  var MARK = '🪙';

  // картинку берёт CSS-класс .coin (style.css)
  document.documentElement.style.setProperty('--coin-img', 'url("' + URL_ + '")');

  function el() {
    var s = document.createElement('span');
    s.className = 'coin';
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', 'монеты');
    return s;
  }
  // Записать текст в элемент, заменив каждый 🪙 на картинку монеты.
  function fill(node, text) {
    text = String(text);
    if (text.indexOf(MARK) < 0) { node.textContent = text; return node; }
    node.textContent = '';
    text.split(MARK).forEach(function (part, i) {
      if (i) node.appendChild(el());
      if (part) node.appendChild(document.createTextNode(part));
    });
    return node;
  }
  var img = new Image();
  img.src = URL_;

  window.Coin = { el: el, fill: fill, has: function (t) { return typeof t === 'string' && t.indexOf(MARK) >= 0; }, img: img, url: URL_ };
})();
