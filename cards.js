/* Коллекционные карточки: рисунки серии «Начало», рубашка и сама карточка (вид «во всю карту»).
   Все рисунки — свои SVG в квадрате 24×24, в стиле значков сайта (icons.js).
   Каждый раз id градиентов получают свою приставку: если на странице две одинаковые карточки,
   их градиенты не путаются. Разметка статичная (без данных от людей), поэтому innerHTML безопасен.
   Подключается после icons.js и до app.js. */
(function () {
  'use strict';

  // Редкости по порядку: имя, цвет (для рамки, точек и фона при открытии).
  var RARITY = {
    common:    { rank: 1, name: 'Обычная',     plural: 'Обычные',     color: '#8F8983' },
    uncommon:  { rank: 2, name: 'Необычная',   plural: 'Необычные',   color: '#3FB97F' },
    rare:      { rank: 3, name: 'Редкая',      plural: 'Редкие',      color: '#4C95F5' },
    epic:      { rank: 4, name: 'Эпическая',   plural: 'Эпические',   color: '#9B7BFF' },
    legendary: { rank: 5, name: 'Легендарная', plural: 'Легендарная', color: '#F5B04A' }
  };
  var ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

  // Общие куски рисунков
  var COIN_GRAD = '<linearGradient id="r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E06A1F"/><stop offset="1" stop-color="#93390A"/></linearGradient>' +
    '<linearGradient id="f" x1=".2" y1=".08" x2=".8" y2=".95"><stop offset="0" stop-color="#FFB772"/><stop offset=".55" stop-color="#F2782C"/><stop offset="1" stop-color="#D45A14"/></linearGradient>';
  var FIRE = '<path d="M12.6 2.2c.5 3.2 2.9 5 4.6 7.4 1.3 1.8 2 3.7 2 5.7a7.2 7.2 0 0 1-14.4 0c0-2.5 1.1-4.4 2.6-6 .3 1.6 1 2.7 2.2 3.4-.5-3.8.8-7.6 3-10.5z" fill="url(#fo)"/>' +
    '<path d="M12.2 12.2c1.7 1.6 3.2 3.1 3.2 5.1a3.4 3.4 0 0 1-6.8 0c0-1.4.6-2.5 1.6-3.4.1.8.5 1.3 1.1 1.6-.2-1.2.1-2.3.9-3.3z" fill="url(#fi)"/>';
  var FIRE_GRAD = '<linearGradient id="fo" x1=".3" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="#FFB45C"/><stop offset=".55" stop-color="#F2782C"/><stop offset="1" stop-color="#C4500B"/></linearGradient>' +
    '<linearGradient id="fi" x1=".5" y1="0" x2=".5" y2="1"><stop offset="0" stop-color="#FFE3A3"/><stop offset="1" stop-color="#FFB347"/></linearGradient>';
  var SUN_RAYS = 'M12 3.3V.8M16.45 4.29l.75-1.3M19.53 7.65l2.17-1.25M20.9 12h1.5M19.53 16.35l2.17 1.25M16.45 19.71l.75 1.3M12 20.7v2.5M7.55 19.71l-.75 1.3M4.47 16.35L2.3 17.6M3.1 12H1.6M4.47 7.65L2.3 6.4M7.55 4.29l-.75-1.3';
  var QMARK = function (x, y, size, color) {
    return '<text x="' + x + '" y="' + y + '" text-anchor="middle" font-family="Literata, Georgia, serif" font-weight="600" font-size="' + size + '" fill="' + color + '">?</text>';
  };
  // Кольцо Сектора: дорожка и цветной кусок (кольцевой сектор между радиусами 6 и 9)
  var RING = '<circle cx="12" cy="12" r="7.5" fill="none" stroke="#3A3634" stroke-width="3"/>';

  var ART = {
    // ---- обычные ----
    coin: { body: '<defs>' + COIN_GRAD + '</defs>' +
      '<circle cx="12" cy="12" r="11.5" fill="url(#r)"/><circle cx="12" cy="11.6" r="9.7" fill="url(#f)"/>' +
      '<circle cx="12" cy="11.6" r="7.7" fill="none" stroke="#A8420B" stroke-opacity=".5" stroke-width=".9"/>' +
      '<path d="M12 6.6l1.55 3.25 3.55.45-2.6 2.45.66 3.5L12 14.55l-3.16 1.7.66-3.5-2.6-2.45 3.55-.45z" fill="#8A3405" fill-opacity=".85"/>' +
      '<path d="M5.3 9.3A7.2 7.2 0 0 1 9.3 5.1" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.1" stroke-linecap="round"/>' },
    fire: { body: '<defs>' + FIRE_GRAD + '</defs>' + FIRE },
    question: { body: '<defs><linearGradient id="q" x1=".2" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="#FFB772"/><stop offset=".6" stop-color="#F2782C"/><stop offset="1" stop-color="#D45A14"/></linearGradient></defs>' +
      '<path d="M4.5 3.5h15A2 2 0 0 1 21.5 5.5v9.5a2 2 0 0 1-2 2H11l-5 4.2V17H4.5a2 2 0 0 1-2-2V5.5a2 2 0 0 1 2-2z" fill="url(#q)"/>' +
      '<path d="M5 6.2a2 2 0 0 1 1.6-1.3" fill="none" stroke="#FFF4D6" stroke-opacity=".6" stroke-width=".9" stroke-linecap="round"/>' +
      QMARK(12, 14.4, 10, '#2A1608') },
    blank: { body: '<rect x="2.5" y="4.5" width="19" height="14" rx="2.2" fill="#EDE3D9"/>' +
      '<rect x="5.5" y="7.6" width="8.5" height="1.5" rx=".75" fill="#B7ADA4"/>' +
      '<path d="M5.5 12.4h13" stroke="#F2782C" stroke-width="1.5" stroke-dasharray="1.7 1.2" stroke-linecap="round"/>' +
      '<rect x="5.5" y="15" width="6" height="1.5" rx=".75" fill="#B7ADA4"/>' +
      '<path d="M15.4 21.6l.4-2.2 5.4-5.4 1.8 1.8-5.4 5.4z" fill="#F2782C"/><path d="M20.4 14.8l1.8 1.8" stroke="#C4500B" stroke-width=".9"/>' },
    arrow: { body: RING +
      '<path d="M16.5 4.21A9 9 0 0 1 20.46 8.92L17.64 9.95A6 6 0 0 0 15 6.8Z" fill="#F2782C"/>' +
      '<path d="M12 12L17.9 7.05" stroke="#F2ECE6" stroke-width="1.7" stroke-linecap="round"/>' +
      '<circle cx="12" cy="12" r="1.9" fill="#F2ECE6"/><circle cx="12" cy="12" r=".8" fill="#2A2725"/>' },
    ball: { body: '<path d="M2.5 19.5L8.5 13.5 12.5 17.5 20.5 9.5" fill="none" stroke="#3A3634" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M2.5 19.5L8.5 13.5 12.5 17.5 20.5 9.5" fill="none" stroke="#5A5450" stroke-width=".7" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 -1.2)"/>' +
      '<defs>' + COIN_GRAD + '</defs><circle cx="6" cy="16" r="1.4" fill="url(#f)"/>' +
      '<circle cx="17.2" cy="9.6" r="2.7" fill="#F2ECE6"/><circle cx="16.3" cy="8.7" r=".8" fill="#fff"/>' +
      '<path d="M12.6 8.6h-2.4M13.4 11.2h-2.2" stroke="#A0968E" stroke-width=".7" stroke-linecap="round"/>' },
    // кресс-салат: горшочек с землёй и тонкие ростки, у каждого — пара круглых листочков
    cress: { body: '<defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#A9461F"/><stop offset=".45" stop-color="#D9774B"/><stop offset="1" stop-color="#9A3E1A"/></linearGradient>' +
      '<linearGradient id="l" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#A6EA98"/><stop offset="1" stop-color="#5FB35C"/></linearGradient></defs>' +
      '<ellipse cx="12" cy="15.1" rx="6.9" ry="1" fill="#4A3424"/>' +
      '<path d="M7.8 15.2c-.3-2.4-.8-4.4-1.5-6.1M10.2 15.2c0-2.9 0-5.4-.4-8.3M12.5 15.2c.1-3.5.2-6.7.1-10M14.7 15.2c.2-2.9.6-5.3 1.1-7.7M16.6 15.2c.5-2 1.1-3.7 1.9-5.1" fill="none" stroke="#D8EFC4" stroke-width=".8" stroke-linecap="round"/>' +
      '<ellipse cx="5.05" cy="8.75" rx="1.5" ry=".95" transform="rotate(-28 5.05 8.75)" fill="url(#l)"/><ellipse cx="7.55" cy="8.75" rx="1.5" ry=".95" transform="rotate(28 7.55 8.75)" fill="url(#l)"/><ellipse cx="8.55" cy="6.55" rx="1.5" ry=".95" transform="rotate(-28 8.55 6.55)" fill="url(#l)"/><ellipse cx="11.05" cy="6.55" rx="1.5" ry=".95" transform="rotate(28 11.05 6.55)" fill="url(#l)"/>' +
      '<ellipse cx="11.35" cy="4.85" rx="1.5" ry=".95" transform="rotate(-28 11.35 4.85)" fill="url(#l)"/><ellipse cx="13.85" cy="4.85" rx="1.5" ry=".95" transform="rotate(28 13.85 4.85)" fill="url(#l)"/><ellipse cx="14.55" cy="7.15" rx="1.5" ry=".95" transform="rotate(-28 14.55 7.15)" fill="url(#l)"/><ellipse cx="17.05" cy="7.15" rx="1.5" ry=".95" transform="rotate(28 17.05 7.15)" fill="url(#l)"/><ellipse cx="17.25" cy="9.75" rx="1.5" ry=".95" transform="rotate(-28 17.25 9.75)" fill="url(#l)"/><ellipse cx="19.75" cy="9.75" rx="1.5" ry=".95" transform="rotate(28 19.75 9.75)" fill="url(#l)"/>' +
      '<path d="M6.1 17.2h11.8l-1.25 4.6a1.1 1.1 0 0 1-1.06.8H8.41a1.1 1.1 0 0 1-1.06-.8z" fill="url(#p)"/>' +
      '<rect x="4.7" y="15.4" width="14.6" height="2.1" rx=".7" fill="#D9774B"/><path d="M5.6 15.9h12.8" stroke="#F2A27A" stroke-width=".5" stroke-linecap="round" opacity=".8"/>' },
    mine: { body: '<path d="M12 2.8v3.4M12 17.8v3.4M2.8 12h3.4M17.8 12h3.4M5.5 5.5l2.4 2.4M16.1 16.1l2.4 2.4M5.5 18.5l2.4-2.4M16.1 7.9l2.4-2.4" stroke="#F2782C" stroke-width="2" stroke-linecap="round"/>' +
      '<circle cx="12" cy="12" r="6.4" fill="#1A1716" stroke="#F2782C" stroke-width="1.6"/><circle cx="9.8" cy="9.8" r="1.6" fill="#FFB37A"/>' },

    // ---- необычные ----
    rocket: { body: '<defs><linearGradient id="fl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE3A3"/><stop offset=".5" stop-color="#FFB347"/><stop offset="1" stop-color="#F2782C" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="M2.5 21.5C6 20.5 8.5 18.6 10.4 16" fill="none" stroke="#A0968E" stroke-width=".7" stroke-dasharray="1 1.3" stroke-linecap="round"/>' +
      '<circle cx="4.2" cy="5.2" r=".5" fill="#A0968E"/><circle cx="19.5" cy="19.2" r=".45" fill="#A0968E"/><circle cx="7.5" cy="2.6" r=".35" fill="#A0968E"/>' +
      '<g transform="rotate(40 13 11)"><path d="M11.7 17.2c.2 2 .7 3.3 1.3 4.4.6-1.1 1.1-2.4 1.3-4.4z" fill="url(#fl)"/>' +
      '<path d="M9.7 12.3L7 15.6v1.9l2.7-1.6zM16.3 12.3l2.7 3.3v1.9l-2.7-1.6z" fill="#F2782C"/>' +
      '<path d="M13 2.4c2.4 2 3.4 5 3.4 8.6v5.3H9.6V11c0-3.6 1-6.6 3.4-8.6z" fill="#EDE3D9"/>' +
      '<path d="M13 2.4c1.3 1.1 2.1 2.4 2.7 3.9h-5.4c.6-1.5 1.4-2.8 2.7-3.9z" fill="#F2782C"/>' +
      '<circle cx="13" cy="9.6" r="1.75" fill="#1A1817" stroke="#F2782C" stroke-width=".8"/><circle cx="12.5" cy="9.1" r=".45" fill="#FFE3A3"/>' +
      '<rect x="10.6" y="16.3" width="4.8" height="1.2" rx=".4" fill="#C4500B"/></g>' },
    bell: { body: '<defs><linearGradient id="b" x1=".2" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="#FFD08A"/><stop offset=".55" stop-color="#F2782C"/><stop offset="1" stop-color="#C4500B"/></linearGradient></defs>' +
      '<path d="M3.6 8.6a8.6 8.6 0 0 1 2.2-3.6M20.4 8.6a8.6 8.6 0 0 0-2.2-3.6" fill="none" stroke="#A0968E" stroke-width=".9" stroke-linecap="round"/>' +
      '<circle cx="12" cy="19.6" r="1.9" fill="#C4500B"/>' +
      '<path d="M12 2.6a1.3 1.3 0 0 1 1.3 1.3v.8a6.2 6.2 0 0 1 4.9 6.1v3.9l1.9 2.4v1H3.9v-1l1.9-2.4v-3.9a6.2 6.2 0 0 1 4.9-6.1v-.8A1.3 1.3 0 0 1 12 2.6z" fill="url(#b)"/>' +
      '<path d="M8.6 9.4a3.6 3.6 0 0 1 2-2.4" fill="none" stroke="#FFF1D6" stroke-opacity=".7" stroke-width=".9" stroke-linecap="round"/>' },
    cloud: { body: '<path d="M7.4 17.6a4.6 4.6 0 0 1-.7-9.1 5.6 5.6 0 0 1 10.7-1.4 4.8 4.8 0 0 1-.2 10.5z" fill="#EDE3D9"/>' +
      '<circle cx="5.6" cy="20" r="1.2" fill="#EDE3D9"/><circle cx="3.4" cy="22" r=".7" fill="#EDE3D9"/>' +
      '<circle cx="8.6" cy="12.6" r="1.25" fill="#F2782C"/><circle cx="12.2" cy="12.6" r="1.25" fill="#F2782C"/><circle cx="15.8" cy="12.6" r="1.25" fill="#F2782C"/>' },
    silver: { body: '<defs><linearGradient id="se" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C9C3BE"/><stop offset="1" stop-color="#6E6863"/></linearGradient>' +
      '<linearGradient id="sf" x1=".2" y1=".08" x2=".8" y2=".95"><stop offset="0" stop-color="#FFFFFF"/><stop offset=".5" stop-color="#D2CCC7"/><stop offset="1" stop-color="#9C958F"/></linearGradient></defs>' +
      '<circle cx="12" cy="12" r="11.5" fill="url(#se)"/><circle cx="12" cy="11.6" r="9.7" fill="url(#sf)"/>' +
      '<circle cx="12" cy="11.6" r="7.7" fill="none" stroke="#7D7671" stroke-opacity=".5" stroke-width=".9"/>' +
      '<path d="M12 16.4V10.6" stroke="#5E5853" stroke-width="1.3" stroke-linecap="round"/>' +
      '<path d="M12 11.2c-2.6 0-4-1.6-4.2-3.8 2.5 0 4 1.4 4.2 3.8zM12 12.4c.2-2.6 1.8-4 4.2-4.2-.1 2.5-1.7 4-4.2 4.2z" fill="#5E5853"/>' +
      '<path d="M5.3 9.3A7.2 7.2 0 0 1 9.3 5.1" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1.1" stroke-linecap="round"/>' },
    bronze: { body: '<defs><radialGradient id="m" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#F7BE93"/><stop offset=".58" stop-color="#D9783A"/><stop offset="1" stop-color="#9C4A16"/></radialGradient></defs>' +
      '<path d="M7.4 1.8h3.6l2.3 6.6H9.7z" fill="#C4500B"/><path d="M16.6 1.8H13l-2.3 6.6h3.6z" fill="#F2782C"/>' +
      '<circle cx="12" cy="15" r="6.6" fill="url(#m)"/><circle cx="12" cy="15" r="5" fill="none" stroke="#8A3F12" stroke-opacity=".5" stroke-width=".8"/>' +
      '<text x="12" y="17.6" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-weight="600" font-size="7.2" fill="#351604">3</text>' },

    // ---- редкие ----
    trophy: { body: '<defs><linearGradient id="tr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFD08A"/><stop offset=".6" stop-color="#F2782C"/><stop offset="1" stop-color="#C4500B"/></linearGradient></defs>' +
      '<path d="M7 4.5H4.2v1.8a3.6 3.6 0 0 0 3.4 3.6M17 4.5h2.8v1.8a3.6 3.6 0 0 1-3.4 3.6" fill="none" stroke="#F2782C" stroke-width="1.6" stroke-linecap="round"/>' +
      '<path d="M6.8 3h10.4v5.2a5.2 5.2 0 0 1-10.4 0z" fill="url(#tr)"/><path d="M10.6 13.2h2.8l.5 3.6h-3.8z" fill="#C4500B"/>' +
      '<rect x="7.6" y="16.6" width="8.8" height="3.6" rx="1.2" fill="#F2782C"/><path d="M9.2 5v3" stroke="#FFE3A3" stroke-width="1.3" stroke-linecap="round"/>' },
    streak30: { body: '<defs>' + FIRE_GRAD + '</defs><g transform="translate(2.2 -.4) scale(.82)">' + FIRE + '</g>' +
      '<rect x="6.6" y="15.6" width="10.8" height="6.4" rx="3.2" fill="#1A1817" stroke="#F2782C" stroke-width="1.1"/>' +
      '<text x="12" y="20.4" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-weight="600" font-size="5" fill="#FFD08A">30</text>' },
    first: { body: '<defs><radialGradient id="m" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#FFE7AE"/><stop offset=".58" stop-color="#F2B33D"/><stop offset="1" stop-color="#B9800F"/></radialGradient></defs>' +
      '<path d="M7.4 1.8h3.6l2.3 6.6H9.7z" fill="#3D6FD1"/><path d="M16.6 1.8H13l-2.3 6.6h3.6z" fill="#4C95F5"/>' +
      '<circle cx="12" cy="15" r="6.6" fill="url(#m)"/><circle cx="12" cy="15" r="5" fill="none" stroke="#9A6A08" stroke-opacity=".5" stroke-width=".8"/>' +
      '<text x="12" y="17.6" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-weight="600" font-size="7.2" fill="#3D2604">1</text>' +
      '<path d="M8.2 12.6a4.4 4.4 0 0 1 2.2-2" fill="none" stroke="#FFF6DA" stroke-opacity=".8" stroke-width=".8" stroke-linecap="round"/>' },
    x10: { body: '<path d="M3 21h18M3 21V3" stroke="#3A3634" stroke-width=".8" stroke-linecap="round"/>' +
      '<path d="M3 20.6c6.5-.4 11.2-3.2 16.4-12.4" fill="none" stroke="#F2782C" stroke-width="1.7" stroke-linecap="round"/>' +
      '<circle cx="19.4" cy="8.2" r="1.7" fill="#FFE3A3"/><circle cx="19.4" cy="8.2" r="3" fill="#FFB347" fill-opacity=".25"/>' +
      '<text x="4.4" y="10.4" font-family="Literata, Georgia, serif" font-weight="600" font-size="7.6" fill="#F2ECE6">×10</text>' },

    // ---- эпические ----
    ramp: { body: '<rect x="1" y="16" width="9.4" height="3.2" rx="1" fill="#3E3757"/><rect x="15.8" y="16" width="7.2" height="3.2" rx="1" fill="#3E3757"/>' +
      '<path d="M4.4 16h6v-4.6z" fill="#9B7BFF"/><path d="M5.6 15.2l3.9-2.7" stroke="#C9B8FF" stroke-width=".6" stroke-linecap="round"/>' +
      '<path d="M10.6 11.1Q14.2 2.2 18.2 15.3" fill="none" stroke="#9B7BFF" stroke-width=".8" stroke-dasharray="1 1.3" stroke-linecap="round"/>' +
      '<circle cx="14.1" cy="6.9" r="2" fill="#F2ECE6"/><circle cx="13.4" cy="6.2" r=".55" fill="#fff"/>' +
      '<path d="M10.4 6.2h-1.8M10.8 8.2h-2.4" stroke="#ADA3C8" stroke-width=".6" stroke-linecap="round"/>' },
    reverse: { body: RING +
      '<path d="M8.92 3.54A9 9 0 0 1 15.08 3.54L14.05 6.36A6 6 0 0 0 9.95 6.36Z" fill="#9B7BFF"/>' +
      '<path d="M15.6 12a3.6 3.6 0 1 1-1.05-2.55" fill="none" stroke="#F2ECE6" stroke-width="1.5" stroke-linecap="round"/>' +
      '<path d="M15.9 7.4l-.9 2.7-2.6-.9" fill="none" stroke="#F2ECE6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' },

    // ---- легендарная ----
    sun: { vb: '-1 -1 26 26', body: '<defs><linearGradient id="s" x1=".2" y1=".1" x2=".8" y2=".95"><stop offset="0" stop-color="#FFE08A"/><stop offset=".5" stop-color="#F5A33F"/><stop offset="1" stop-color="#E0661F"/></linearGradient></defs>' +
      '<path d="' + SUN_RAYS + '" stroke="#F5A33F" stroke-width="1.2" stroke-linecap="round"/>' +
      '<circle cx="12" cy="12" r="7.3" fill="url(#s)"/><path d="M7.6 9.2A5 5 0 0 1 10.6 6.2" fill="none" stroke="#FFF4D6" stroke-opacity=".7" stroke-width=".8" stroke-linecap="round"/>' +
      QMARK(12, 15.6, 10.5, '#2A1608') }
  };

  // Рубашка: тёмная карта с маленьким «Солнцем дня» и названием серии
  var BACK = { vb: '-1 -1 26 26', body: '<defs><linearGradient id="s" x1=".2" y1=".1" x2=".8" y2=".95"><stop offset="0" stop-color="#FFB772"/><stop offset=".6" stop-color="#F2782C"/><stop offset="1" stop-color="#C4500B"/></linearGradient></defs>' +
    '<path d="' + SUN_RAYS + '" stroke="#F2782C" stroke-opacity=".7" stroke-width="1.1" stroke-linecap="round"/>' +
    '<circle cx="12" cy="12" r="7.3" fill="url(#s)"/>' + QMARK(12, 15.6, 10.5, '#2A1608') };

  var uid = 0;
  // Готовый <svg> строкой. Приставка к id — своя у каждого рисунка.
  function svg(code, label) {
    var a = code === 'back' ? BACK : ART[code];
    if (!a) a = { body: QMARK(12, 16, 14, '#4A4542') };
    var p = 'k' + (++uid) + '-';
    var body = a.body.replace(/id="([a-z0-9-]+)"/gi, 'id="' + p + '$1"').replace(/url\(#([a-z0-9-]+)\)/gi, 'url(#' + p + '$1)');
    return '<svg viewBox="' + (a.vb || '0 0 24 24') + '" ' + (label ? 'role="img" aria-label="' + label + '"' : 'aria-hidden="true"') + '>' + body + '</svg>';
  }
  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  // Рисунок в обёртке <span class="kc-art">
  function art(code, label) {
    var s = node('span', 'kc-art');
    s.innerHTML = svg(code, label);
    return s;
  }

  // Карточка «во всю карту». card: { code, name, rarity, copies }, serial — номер копии (может не быть).
  // size: 'lg' (крупно) или 'md' (витрина).
  function face(card, serial, size) {
    var r = RARITY[card.rarity] || RARITY.common;
    var k = node('div', 'kc r-' + card.rarity + ' kc-' + card.rarity + ' kc-' + (size || 'lg'));
    var top = node('div', 'kc-top');
    top.appendChild(node('span', 'kc-pill', r.name));
    if (serial) top.appendChild(node('span', 'kc-no', card.copies === 1 ? '1/1' : '№' + serial + '/' + card.copies));
    k.appendChild(top);
    var a = node('div', 'kc-mid');
    a.appendChild(art(card.code, card.name));
    k.appendChild(a);
    k.appendChild(node('div', 'kc-name', card.name));
    k.appendChild(node('div', 'kc-band', 'Начало'));
    if (card.rarity === 'legendary') { var sh = node('span', 'kc-shine'); sh.setAttribute('aria-hidden', 'true'); k.appendChild(sh); }
    return k;
  }
  function back(size) {
    var k = node('div', 'kc kc-back kc-' + (size || 'lg'));
    var a = node('div', 'kc-mid');
    a.appendChild(art('back'));
    k.appendChild(a);
    k.appendChild(node('div', 'kc-back-name', 'Начало'));
    return k;
  }

  window.Cards = { RARITY: RARITY, ORDER: ORDER, svg: svg, art: art, face: face, back: back, has: function (code) { return !!ART[code]; } };
})();
