/* Свои значки сайта вместо смайликов: огонёк серии, меню ответа, знаки зодиака,
   медали рейтинга, мина в Сапёре, картинки после ответа.
   Смайлики каждый телефон рисует по-своему, а эти значки одинаковые везде и в цветах сайта.

   Как пользоваться:
   - Icons.el('edit') — готовый <span class="ic ic-edit"> с картинкой внутри;
   - Icons.FIRE — особый невидимый знак: если вставить его в текст, el() / setText() заменят его
     на огонёк (как 🪙 на монету). Обычный смайлик 🔥 не трогаем — он нужен в реакциях.
   Файл грузится после coin.js и до app.js. */
(function () {
  'use strict';

  // Контурные значки: рисуются цветом текста (stroke: currentColor в style.css).
  var LINE = {
    edit: '<path d="M15.5 4.5l4 4L9 19H5v-4z"/><path d="M13.5 6.5l4 4"/>',
    copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
    trash: '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.2 7l.9 12.2A2 2 0 0 0 9.1 21h5.8a2 2 0 0 0 2-1.8L17.8 7"/><path d="M10 11v6M14 11v6"/>',
    reply: '<path d="M9.5 5.5L4 11l5.5 5.5"/><path d="M4 11h9.5a6.5 6.5 0 0 1 6.5 6.5V19"/>',
    // знаки зодиака — простые линии, как в нижнем меню
    aries: '<path d="M12 20.5V9.5"/><path d="M12 9.5C12 5.6 9.9 3.5 7.6 3.5 5.6 3.5 4 5 4 7s1.4 3.2 3.2 3.2"/><path d="M12 9.5c0-3.9 2.1-6 4.4-6 2 0 3.6 1.5 3.6 3.5s-1.4 3.2-3.2 3.2"/>',
    taurus: '<circle cx="12" cy="15" r="5.2"/><path d="M4 3.8c.9 3.4 3.9 6 8 6s7.1-2.6 8-6"/>',
    gemini: '<path d="M5 4.2c4.4 1.6 9.6 1.6 14 0"/><path d="M5 19.8c4.4-1.6 9.6-1.6 14 0"/><path d="M9 5.4v13.2M15 5.4v13.2"/>',
    cancer: '<circle cx="7" cy="9" r="2.6"/><circle cx="17" cy="15" r="2.6"/><path d="M7 6.4c3.6-2.2 9.4-1.8 13 1.6"/><path d="M17 17.6c-3.6 2.2-9.4 1.8-13-1.6"/>',
    leo: '<circle cx="7" cy="15.5" r="3"/><path d="M10 15.5c0-3.4-2.4-5.6-2.4-8.3a4.2 4.2 0 0 1 8.4 0c0 3.3-2.6 6.3-2.6 10.1 0 1.9 1.3 3.2 3.1 3.2 1.4 0 2.5-1 2.5-2.4"/>',
    virgo: '<path d="M3.5 5.5c1.2 0 1.8.8 1.8 2V18"/><path d="M5.3 8.2c0-1.6 1-2.6 2.2-2.6s2.2 1 2.2 2.6V18"/><path d="M9.7 8.2c0-1.6 1-2.6 2.2-2.6s2.2 1 2.2 2.6v6.3c0 3.4 2 5.5 5.4 5.5"/><path d="M14.1 14.8c.4-2.6 2.2-4.3 4.2-3.8 2.4.6 1.8 4.3-2.2 7.2"/>',
    libra: '<path d="M4 20h16"/><path d="M4 15.5h4.7a4 4 0 1 1 6.6 0H20"/>',
    scorpio: '<path d="M3.5 5.5c1.2 0 1.8.8 1.8 2V18"/><path d="M5.3 8.2c0-1.6 1-2.6 2.2-2.6s2.2 1 2.2 2.6V18"/><path d="M9.7 8.2c0-1.6 1-2.6 2.2-2.6s2.2 1 2.2 2.6v8.3c0 1.6 1 2.5 2.5 2.5h3.6"/><path d="M18.2 16.8l2.2 2.2-2.2 2.2"/>',
    sagittarius: '<path d="M5 19L19 5"/><path d="M12 5h7v7"/><path d="M7.5 10.5l6 6"/>',
    capricorn: '<path d="M3.5 5.5c2 0 3 1.4 3 3.6V18"/><path d="M6.5 9.2c0-2.4 1.4-3.7 3.1-3.7s3 1.3 3 3.7v7.5c0 2.3 1.4 3.8 3.4 3.8a3.1 3.1 0 0 0 0-6.2c-1.5 0-2.8.9-3.3 2.3"/>',
    aquarius: '<path d="M3 10.5l3-3 3 3 3-3 3 3 3-3 3 3"/><path d="M3 17l3-3 3 3 3-3 3 3 3-3 3 3"/>',
    pisces: '<path d="M5.5 4c2.9 3.4 2.9 12.6 0 16"/><path d="M18.5 4c-2.9 3.4-2.9 12.6 0 16"/><path d="M5 12h14"/>'
  };

  // Цветные значки: свои цвета внутри картинки. id градиентов уникальны (префикс i-),
  // чтобы несколько одинаковых значков на странице не мешали друг другу.
  var COLOR = {
    // огонёк серии: оранжевый снаружи, светлое пламя внутри
    fire: '<defs><linearGradient id="i-fo" x1=".3" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="#FFB45C"/><stop offset=".55" stop-color="#F2782C"/><stop offset="1" stop-color="#C4500B"/></linearGradient>' +
      '<linearGradient id="i-fi" x1=".5" y1="0" x2=".5" y2="1"><stop offset="0" stop-color="#FFE3A3"/><stop offset="1" stop-color="#FFB347"/></linearGradient></defs>' +
      '<path d="M12.6 2.2c.5 3.2 2.9 5 4.6 7.4 1.3 1.8 2 3.7 2 5.7a7.2 7.2 0 0 1-14.4 0c0-2.5 1.1-4.4 2.6-6 .3 1.6 1 2.7 2.2 3.4-.5-3.8.8-7.6 3-10.5z" fill="url(#i-fo)"/>' +
      '<path d="M12.2 12.2c1.7 1.6 3.2 3.1 3.2 5.1a3.4 3.4 0 0 1-6.8 0c0-1.4.6-2.5 1.6-3.4.1.8.5 1.3 1.1 1.6-.2-1.2.1-2.3.9-3.3z" fill="url(#i-fi)"/>',
    // мина в Сапёре: тёмный шар с оранжевыми шипами и бликом
    mine: '<path d="M12 2.8v3.4M12 17.8v3.4M2.8 12h3.4M17.8 12h3.4M5.5 5.5l2.4 2.4M16.1 16.1l2.4 2.4M5.5 18.5l2.4-2.4M16.1 7.9l2.4-2.4" stroke="#F2782C" stroke-width="2" stroke-linecap="round"/>' +
      '<circle cx="12" cy="12" r="6.4" fill="#1A1716" stroke="#F2782C" stroke-width="1.6"/>' +
      '<circle cx="9.8" cy="9.8" r="1.6" fill="#FFB37A"/>',
    // после ответа: большая и маленькая искры
    sparkle: '<defs><linearGradient id="i-sp" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFD08A"/><stop offset=".5" stop-color="#F2782C"/><stop offset="1" stop-color="#C4500B"/></linearGradient></defs>' +
      '<path d="M10 2.5c.7 4.6 2.4 6.3 7 7-4.6.7-6.3 2.4-7 7-.7-4.6-2.4-6.3-7-7 4.6-.7 6.3-2.4 7-7z" fill="url(#i-sp)"/>' +
      '<path d="M18.2 13.5c.35 2.3 1.2 3.15 3.5 3.5-2.3.35-3.15 1.2-3.5 3.5-.35-2.3-1.2-3.15-3.5-3.5 2.3-.35 3.15-1.2 3.5-3.5z" fill="#FFB347"/>',
    // рекорд серии (3, 7, 30, 100 дней): кубок
    trophy: '<defs><linearGradient id="i-tr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFD08A"/><stop offset=".6" stop-color="#F2782C"/><stop offset="1" stop-color="#C4500B"/></linearGradient></defs>' +
      '<path d="M7 4.5H4.2v1.8a3.6 3.6 0 0 0 3.4 3.6M17 4.5h2.8v1.8a3.6 3.6 0 0 1-3.4 3.6" fill="none" stroke="#F2782C" stroke-width="1.6" stroke-linecap="round"/>' +
      '<path d="M6.8 3h10.4v5.2a5.2 5.2 0 0 1-10.4 0z" fill="url(#i-tr)"/>' +
      '<path d="M10.6 13.2h2.8l.5 3.6h-3.8z" fill="#C4500B"/>' +
      '<rect x="7.6" y="16.6" width="8.8" height="3.6" rx="1.2" fill="#F2782C"/>' +
      '<path d="M9.2 5v3" stroke="#FFE3A3" stroke-width="1.3" stroke-linecap="round"/>'
  };

  function svg(name) {
    if (LINE[name]) return '<svg viewBox="0 0 24 24" aria-hidden="true" class="ic-line">' + LINE[name] + '</svg>';
    if (COLOR[name]) return '<svg viewBox="0 0 24 24" aria-hidden="true">' + COLOR[name] + '</svg>';
    return '';
  }
  // <span class="ic ic-имя"> с картинкой. Разметка статичная (без данных от людей), поэтому innerHTML безопасен.
  function el(name, cls) {
    var s = document.createElement('span');
    s.className = 'ic ic-' + name + (cls ? ' ' + cls : '');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = svg(name);
    return s;
  }

  // Огонёк серии в тексте: невидимый знак из «личной» области Юникода, который сам по себе нигде не встречается.
  var FIRE = '';
  if (window.Coin && Coin.register) Coin.register(FIRE, function () { return el('fire', 'flame'); });

  window.Icons = { el: el, svg: svg, FIRE: FIRE };
})();
