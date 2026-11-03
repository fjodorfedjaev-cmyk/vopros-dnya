/* Ферма «Вопроса дня»: поле 4×4 и своя валюта — серебро (с монетами сайта не связана).
   Всё решает база (функции farm_* в Supabase): цены, время роста, выплаты, покупка клеток.
   Здесь только интерфейс. Таймеры на экране — для вида: готовность проверяет сервер по своим часам.
   Связь с сайтом — через window.AppAPI (sb, el, toast). */
(function () {
  'use strict';
  var A = null;                // AppAPI, появляется после запуска сайта
  var root = null;             // корневой элемент фермы (живёт между перерисовками)
  var F = {
    st: null,                  // последнее состояние с сервера (ответ farm_state)
    offset: 0,                 // время сервера минус время телефона, мс
    loading: false,
    error: '',                 // ошибка загрузки (нет сети, ошибка сервера)
    busy: false,               // идёт действие: новые нажатия ждут
    sheet: null,               // открытое окно: {type:'plant', plots:[…], seed} | {type:'buy', plot} | {type:'info', plot}
    timer: 0,
    floats: []                 // «+23» над собранными клетками после перерисовки
  };
  var reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function el() { return A.el.apply(null, arguments); }
  // Время «по часам сервера»: часы телефона + поправка. Перевод часов на телефоне урожай не ускорит —
  // сервер всё равно проверит готовность сам.
  function now() { return Date.now() + F.offset; }
  function num(n) { return Number(n || 0).toLocaleString('ru-RU'); }
  function pl(n, f) { n = Math.abs(n) % 100; var n1 = n % 10; if (n > 10 && n < 20) return f[2]; if (n1 > 1 && n1 < 5) return f[1]; if (n1 === 1) return f[0]; return f[2]; }
  function silverWord(n) { return pl(n, ['серебро', 'серебра', 'серебра']); }
  function cellsWord(n) { return pl(n, ['клетку', 'клетки', 'клеток']); }

  function errText(e) {
    var m = String((e && (e.message || e.details)) || e || '');
    if (/not_enough/.test(m)) return 'Не хватает серебра.';
    if (/not_next/.test(m)) return 'Эту клетку уже купили. Поле обновлено.';
    if (/plot_busy/.test(m)) return 'Клетка уже занята. Поле обновлено.';
    if (/plot_closed/.test(m)) return 'Эта клетка ещё закрыта.';
    if (/bad_seed/.test(m)) return 'Этого семени больше нет. Список обновлён.';
    if (/not_member/.test(m)) return 'Сначала войди по коду приглашения.';
    if (!navigator.onLine || /fetch|network|load failed/i.test(m)) return 'Нет связи. Проверь интернет и попробуй ещё раз.';
    return 'Ошибка сервера. Попробуй ещё раз чуть позже.';
  }
  async function rpc(name, args) {
    var r = await A.sb().rpc(name, args || {});
    if (r.error) throw r.error;
    return r.data;
  }

  /* ---------- данные ---------- */
  async function load() {
    F.loading = true;
    if (!F.st) draw();
    try {
      var t0 = Date.now();
      var d = await rpc('farm_state');
      var t1 = Date.now();
      F.offset = Number(d.server_ms) - Math.round((t0 + t1) / 2);
      F.st = d;
      F.error = '';
      // окно могло устареть: клетку купили или засадили в другой вкладке
      if (F.sheet && F.sheet.type === 'buy' && F.sheet.plot !== d.plots_open + 1) F.sheet = null;
      if (F.sheet && F.sheet.type === 'info' && !plantingAt(F.sheet.plot)) F.sheet = null;
      if (F.sheet && F.sheet.type === 'plant') {
        F.sheet.plots = F.sheet.plots.filter(function (p) { return p <= d.plots_open && !plantingAt(p); });
        if (!F.sheet.plots.length) F.sheet = null;
      }
    } catch (e) {
      F.error = errText(e);
    }
    F.loading = false;
    draw();
  }

  function seeds() { return (F.st && F.st.seeds) || []; }
  function seedById(id) { var s = seeds(); for (var i = 0; i < s.length; i++) if (s[i].id === id) return s[i]; return null; }
  function plantingAt(plot) {
    var p = (F.st && F.st.plantings) || [];
    for (var i = 0; i < p.length; i++) if (p[i].plot === plot) return p[i];
    return null;
  }
  function isReady(p) { return now() >= Number(p.ready_ms); }
  function readyList() { return ((F.st && F.st.plantings) || []).filter(isReady); }
  function freePlots() {
    var out = [];
    if (!F.st) return out;
    for (var i = 1; i <= F.st.plots_open; i++) if (!plantingAt(i)) out.push(i);
    return out;
  }
  function silver() { return F.st ? Number(F.st.silver) : 0; }
  function priceOf(plot) { return F.st ? Number(F.st.plot_prices[plot - 1]) : 0; }

  /* ---------- время ---------- */
  function left(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    if (s < 3600) { var m = Math.floor(s / 60), r = s % 60; return m + ':' + (r < 10 ? '0' : '') + r; }
    var h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
    return h + ' ч' + (mm ? ' ' + mm + ' м' : '');
  }
  function growText(sec) {
    if (sec < 60) return sec + ' сек';
    if (sec < 3600) return Math.round(sec / 60) + ' мин';
    return Math.round(sec / 3600) + ' ч';
  }
  function stageOf(p) {
    if (isReady(p)) return 'ripe';
    var a = Number(p.planted_ms), b = Number(p.ready_ms);
    var k = b > a ? (now() - a) / (b - a) : 1;
    return k < 0.5 ? 'sprout' : 'young';
  }

  /* ---------- рисунки растений ---------- */
  var COLORS = { cress: '#7ED081', radish: '#E0487A', carrot: '#F08A24', tomato: '#E5483B', strawberry: '#E23D52', pumpkin: '#E8862A', melon: '#3E9B4F' };
  var LEAF = '#5DBB63', LEAF2 = '#7ED081';
  function leaves(cx, cy, s) {
    s = s || 1;
    return '<ellipse cx="' + (cx - 4 * s) + '" cy="' + cy + '" rx="' + (5 * s) + '" ry="' + (2.4 * s) + '" fill="' + LEAF + '" transform="rotate(-35 ' + (cx - 4 * s) + ' ' + cy + ')"/>' +
           '<ellipse cx="' + (cx + 4 * s) + '" cy="' + cy + '" rx="' + (5 * s) + '" ry="' + (2.4 * s) + '" fill="' + LEAF2 + '" transform="rotate(35 ' + (cx + 4 * s) + ' ' + cy + ')"/>';
  }
  var RIPE = {
    cress: leaves(20, 30, 1) + leaves(20, 23, 1.15) + leaves(20, 16, 1) +
      '<path d="M20 36V12" stroke="' + LEAF + '" stroke-width="2" stroke-linecap="round"/>',
    radish: leaves(20, 11, 1.1) +
      '<path d="M20 35C12 30 11.5 19 20 17C28.5 19 28 30 20 35Z" fill="#E0487A"/>' +
      '<path d="M20 35V39" stroke="#F3D7E2" stroke-width="1.4" stroke-linecap="round"/>' +
      '<ellipse cx="16.5" cy="23" rx="2" ry="3.5" fill="#fff" opacity=".28"/>',
    carrot: leaves(20, 10, 1.1) +
      '<path d="M13.5 14.5H26.5L20 37.5Z" fill="#F08A24" stroke="#F08A24" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M16 20H19M18 26H21M19 31H21" stroke="#B8600F" stroke-width="1.3" stroke-linecap="round"/>',
    tomato: '<circle cx="20" cy="23" r="11.5" fill="#E5483B"/>' +
      '<path d="M20 11.5L22 15.5L26.5 14.5L23.5 17.5L25 21L20 18.8L15 21L16.5 17.5L13.5 14.5L18 15.5Z" fill="' + LEAF + '"/>' +
      '<ellipse cx="15" cy="21" rx="2.4" ry="3.6" fill="#fff" opacity=".25"/>',
    strawberry: '<path d="M20 36C10.5 29 9 18 13.5 15.5C16.5 14 18.5 15.8 20 16.2C21.5 15.8 23.5 14 26.5 15.5C31 18 29.5 29 20 36Z" fill="#E23D52"/>' +
      '<path d="M20 17L16 12.5L19 13.8L20 10.5L21 13.8L24 12.5Z" fill="' + LEAF + '"/>' +
      '<g fill="#FFD66B"><circle cx="16" cy="21" r=".9"/><circle cx="20" cy="22" r=".9"/><circle cx="24" cy="21" r=".9"/><circle cx="17.5" cy="26" r=".9"/><circle cx="22.5" cy="26" r=".9"/><circle cx="20" cy="30.5" r=".9"/></g>',
    pumpkin: '<path d="M20 15.5V11.5" stroke="#8A5A2B" stroke-width="2.6" stroke-linecap="round"/>' +
      '<ellipse cx="13.5" cy="25" rx="7" ry="9.5" fill="#D9761F"/><ellipse cx="26.5" cy="25" rx="7" ry="9.5" fill="#D9761F"/>' +
      '<ellipse cx="20" cy="25" rx="7.5" ry="10" fill="#E8862A"/>' +
      '<path d="M23 12.5C25 11 27 11.5 28 12.5" stroke="' + LEAF + '" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
    melon: '<circle cx="20" cy="23" r="13" fill="#3E9B4F"/>' +
      '<path d="M20 10C15 15 14 30 20 36M20 10C25 15 26 30 20 36M20 10C10.5 15 9 29 14 34M20 10C29.5 15 31 29 26 34" stroke="#23662F" stroke-width="1.8" fill="none"/>' +
      '<ellipse cx="14" cy="18" rx="2.5" ry="4" fill="#fff" opacity=".2"/>'
  };
  function art(id, stage) {
    var c = COLORS[id] || LEAF;
    var svg;
    if (stage === 'sprout') {
      svg = '<path d="M20 35V25" stroke="' + LEAF + '" stroke-width="2.4" stroke-linecap="round"/>' + leaves(20, 24, 1);
    } else if (stage === 'young') {
      svg = '<path d="M20 36V17" stroke="' + LEAF + '" stroke-width="2.4" stroke-linecap="round"/>' +
            leaves(20, 29, 1) + leaves(20, 21, 1.15) +
            (id === 'cress' ? leaves(20, 15, 0.9) : '<circle cx="20" cy="15" r="3.6" fill="' + c + '"/>');
    } else {
      svg = RIPE[id] || '<circle cx="20" cy="22" r="10" fill="' + c + '"/>';
    }
    var s = el('span', { class: 'farm-art', 'aria-hidden': 'true' });
    s.innerHTML = '<svg viewBox="0 0 40 40" width="100%" height="100%">' + svg + '</svg>';
    return s;
  }
  function lockIcon() {
    var s = el('span', { class: 'farm-lock', 'aria-hidden': 'true' });
    s.innerHTML = '<svg viewBox="0 0 24 24" width="100%" height="100%"><rect x="5" y="10.5" width="14" height="10" rx="2.5" fill="currentColor"/>' +
      '<path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" stroke-width="2" fill="none"/></svg>';
    return s;
  }
  function coin(n, cls) {
    return el('span', { class: 'farm-amt' + (cls ? ' ' + cls : '') }, [el('span', { class: 'farm-coin', 'aria-hidden': 'true' }), num(n)]);
  }

  /* ---------- экран ---------- */
  function view() {
    if (!root) {
      root = el('div', { class: 'farm' });
      draw();
    }
    return [root];
  }

  function draw() {
    if (!root || !A) return;
    if (!F.st) {
      if (F.error) {
        root.replaceChildren(el('div', { class: 'card farm-msg' }, [
          el('p', { text: F.error }),
          el('button', { type: 'button', class: 'btn primary', text: 'Попробовать ещё раз', onclick: function () { F.error = ''; load(); } })
        ]));
      } else {
        root.replaceChildren(el('p', { class: 'muted', text: 'Загружаю ферму…' }));
      }
      return;
    }
    var st = F.st;
    var head = el('div', { class: 'card farm-head' }, [
      el('div', { class: 'farm-head-l' }, [
        el('span', { class: 'muted small', text: 'Серебро' }),
        el('span', { class: 'farm-bal', id: 'farm-bal' }, [el('span', { class: 'farm-coin lg', 'aria-hidden': 'true' }), num(st.silver)])
      ]),
      el('div', { class: 'farm-head-r' }, [
        el('span', { class: 'muted small', text: 'Клетки' }),
        el('span', { class: 'farm-cells', text: st.plots_open + ' из 16' })
      ])
    ]);

    var ready = readyList().length, free = freePlots().length;
    var actions = el('div', { class: 'farm-actions' }, [
      el('button', {
        type: 'button', class: 'btn primary', id: 'farm-harvest-all', disabled: ready ? null : true,
        text: ready ? 'Собрать всё (' + ready + ')' : 'Собрать всё',
        onclick: function () { harvest(null); }
      }),
      el('button', {
        type: 'button', class: 'btn', disabled: free ? null : true,
        text: free ? 'Посадить на свободные (' + free + ')' : 'Свободных клеток нет',
        onclick: function () { openSheet({ type: 'plant', plots: freePlots(), seed: null }); }
      })
    ]);

    var grid = el('div', { class: 'farm-grid', role: 'group', 'aria-label': 'Поле 4 на 4' });
    for (var i = 1; i <= 16; i++) grid.appendChild(plotButton(i));

    var kids = [head, actions, grid];
    if (F.error) kids.push(el('p', { class: 'farm-err', role: 'status', text: F.error }));
    kids.push(el('p', { class: 'muted small farm-note', text: 'Урожай не портится и ждёт тебя на грядке. Сбор — только по нажатию.' }));
    if (F.sheet) kids.push(sheetView());
    root.replaceChildren.apply(root, kids);
    showFloats();
  }

  function plotButton(i) {
    var st = F.st, p = plantingAt(i);
    var b, label;
    if (i > st.plots_open) {
      var next = i === st.plots_open + 1;
      label = next ? 'Клетка ' + i + ': купить за ' + num(priceOf(i)) + ' ' + silverWord(priceOf(i)) : 'Клетка ' + i + ': откроется позже';
      b = el('button', { type: 'button', class: 'farm-plot ' + (next ? 'is-next' : 'is-locked'), 'aria-label': label,
        onclick: function () {
          if (next) openSheet({ type: 'buy', plot: i });
          else A.toast('Сначала открой клетку ' + (st.plots_open + 1));
        } }, [lockIcon(), next ? coin(priceOf(i), 'farm-price') : null]);
      return b;
    }
    if (!p) {
      return el('button', { type: 'button', class: 'farm-plot is-empty', 'aria-label': 'Клетка ' + i + ': пусто, посадить',
        onclick: function () { openSheet({ type: 'plant', plots: [i], seed: null }); } },
        [el('span', { class: 'farm-plus', 'aria-hidden': 'true', text: '+' })]);
    }
    var s = seedById(p.seed_id);
    var name = s ? s.name : 'Растение';
    var stage = stageOf(p);
    if (stage === 'ripe') {
      return el('button', { type: 'button', class: 'farm-plot is-ready', 'data-plot': String(i),
        'aria-label': 'Клетка ' + i + ': ' + name + ' готово, собрать ' + num(p.payout) + ' ' + silverWord(p.payout),
        onclick: function () { harvest([p.id]); } },
        [art(p.seed_id, 'ripe'), el('span', { class: 'farm-time ready', text: 'Готово' })]);
    }
    return el('button', { type: 'button', class: 'farm-plot is-growing', 'data-plot': String(i), 'data-stage': stage,
      'aria-label': 'Клетка ' + i + ': ' + name + ', растёт',
      onclick: function () { openSheet({ type: 'info', plot: i }); } },
      [art(p.seed_id, stage), el('span', { class: 'farm-time', 'data-ready': String(p.ready_ms), text: left(Number(p.ready_ms) - now()) })]);
  }

  /* ---------- окна снизу ---------- */
  function openSheet(s) {
    if (F.busy) return;
    F.sheet = s;
    draw();
    var first = root && root.querySelector('.farm-sheet [data-autofocus], .farm-sheet button');
    if (first) try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); }
  }
  function closeSheet() { F.sheet = null; draw(); }

  function sheetView() {
    var s = F.sheet, body;
    if (s.type === 'buy') body = buySheet(s);
    else if (s.type === 'info') body = infoSheet(s);
    else body = plantSheet(s);
    var back = el('div', { class: 'farm-back', onclick: function (e) { if (e.target === back) closeSheet(); } }, [
      el('div', { class: 'farm-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': body.title }, [
        el('div', { class: 'farm-sheet-head' }, [
          el('h2', { text: body.title }),
          el('button', { type: 'button', class: 'farm-x', 'aria-label': 'Закрыть', text: '×', onclick: closeSheet })
        ])
      ].concat(body.kids))
    ]);
    return back;
  }

  function buySheet(s) {
    var price = priceOf(s.plot), have = silver(), lack = price - have;
    var kids = [
      el('p', null, ['Цена клетки: ', coin(price)]),
      el('p', { class: 'muted' }, ['У тебя: ', coin(have), lack > 0 ? '' : ' → после покупки останется ', lack > 0 ? null : coin(have - price)])
    ];
    if (lack > 0) {
      kids.push(el('p', { class: 'farm-err', text: 'Не хватает ' + num(lack) + ' ' + silverWord(lack) + '.' }));
      kids.push(el('button', { type: 'button', class: 'btn', text: 'Понятно', onclick: closeSheet }));
    } else {
      kids.push(el('button', { type: 'button', class: 'btn primary', 'data-autofocus': '1', text: 'Купить за ' + num(price),
        onclick: function () { buy(s.plot); } }));
    }
    return { title: 'Клетка ' + s.plot, kids: kids };
  }

  function infoSheet(s) {
    var p = plantingAt(s.plot);
    if (!p) return { title: 'Клетка ' + s.plot, kids: [el('p', { class: 'muted', text: 'Здесь уже пусто.' })] };
    var sd = seedById(p.seed_id);
    var title = (sd ? sd.name : 'Растение') + ' · клетка ' + s.plot;
    if (isReady(p)) {
      return { title: title, kids: [
        el('div', { class: 'farm-info' }, [art(p.seed_id, 'ripe'), el('div', null, [
          el('p', null, [el('b', { text: 'Готово!' })]),
          el('p', null, ['Получишь при сборе: ', coin(p.payout)])
        ])]),
        el('button', { type: 'button', class: 'btn primary', 'data-autofocus': '1', text: 'Собрать',
          onclick: function () { F.sheet = null; harvest([p.id]); } })
      ] };
    }
    return { title: title, kids: [
      el('div', { class: 'farm-info' }, [art(p.seed_id, 'ripe'), el('div', null, [
        el('p', null, ['Созреет через ', el('b', { class: 'farm-time-big', 'data-ready': String(p.ready_ms), text: left(Number(p.ready_ms) - now()) })]),
        el('p', null, ['Получишь при сборе: ', coin(p.payout)]),
        el('p', { class: 'muted' }, ['Чистая прибыль: +' + num(Number(p.payout) - Number(p.cost))])
      ])]),
      el('button', { type: 'button', class: 'btn', text: 'Закрыть', onclick: closeSheet })
    ] };
  }

  function plantSheet(s) {
    var n = s.plots.length, have = silver();
    var title = n === 1 ? 'Клетка ' + s.plots[0] + ': что посадим?' : 'Посадить на ' + n + ' ' + cellsWord(n);
    // Шаг 2 массовой посадки: подтверждение с итоговой суммой.
    if (s.seed) {
      var sd = seedById(s.seed);
      if (!sd) { s.seed = null; return plantSheet(s); }
      var total = sd.cost * n;
      var canN = sd.cost > 0 ? Math.min(n, Math.floor(have / sd.cost)) : n;
      var kids = [
        el('div', { class: 'farm-info' }, [art(sd.id, 'ripe'), el('div', null, [
          el('p', null, [el('b', { text: sd.name + ' × ' + n })]),
          el('p', null, ['Посадка: ', sd.cost ? coin(total) : 'бесплатно']),
          el('p', null, ['Получишь при сборе: ', coin(sd.payout * n)]),
          el('p', { class: 'muted' }, ['Чистая прибыль: +' + num((sd.payout - sd.cost) * n) + ' · растёт ' + growText(sd.grow_seconds)])
        ])])
      ];
      if (canN >= n) {
        kids.push(el('button', { type: 'button', class: 'btn primary', 'data-autofocus': '1',
          text: sd.cost ? 'Посадить за ' + num(total) : 'Посадить',
          onclick: function () { plant(sd.id, s.plots); } }));
      } else {
        kids.push(el('p', { class: 'farm-err', text: 'На ' + n + ' ' + cellsWord(n) + ' не хватает ' + num(total - have) + ' ' + silverWord(total - have) + '.' }));
        if (canN > 0) {
          kids.push(el('button', { type: 'button', class: 'btn primary', 'data-autofocus': '1',
            text: 'Посадить на ' + canN + ' ' + cellsWord(canN) + ' за ' + num(sd.cost * canN),
            onclick: function () { plant(sd.id, s.plots.slice(0, canN)); } }));
        }
      }
      kids.push(el('button', { type: 'button', class: 'btn', text: '← Другое семя', onclick: function () { s.seed = null; draw(); } }));
      return { title: title, kids: kids };
    }
    // Шаг 1: список семян.
    var rows = seeds().map(function (sd) {
      var cost1 = sd.cost * n;
      var short = cost1 > have;
      return el('button', {
        type: 'button', class: 'farm-seed' + (short ? ' short' : ''), disabled: short && n === 1 ? true : null,
        'aria-label': sd.name + ', растёт ' + growText(sd.grow_seconds) + ', посадка ' + (sd.cost ? sd.cost : 'бесплатно') +
          ', получишь при сборе ' + sd.payout + ', чистая прибыль ' + (sd.payout - sd.cost),
        onclick: function () {
          if (n === 1) plant(sd.id, s.plots);
          else { s.seed = sd.id; draw(); }
        }
      }, [
        art(sd.id, 'ripe'),
        el('span', { class: 'farm-seed-main' }, [
          el('span', { class: 'farm-seed-name', text: sd.name }),
          el('span', { class: 'muted small', text: growText(sd.grow_seconds) + (short && n === 1 ? ' · не хватает ' + num(sd.cost - have) : '') })
        ]),
        el('span', { class: 'farm-seed-num', text: sd.cost ? num(sd.cost) : '0' }),
        el('span', { class: 'farm-seed-num', text: num(sd.payout) }),
        el('span', { class: 'farm-seed-num gain', text: '+' + num(sd.payout - sd.cost) })
      ]);
    });
    var head = el('div', { class: 'farm-seed-head', 'aria-hidden': 'true' }, [
      el('span', null), el('span', null),
      el('span', { text: 'Посадка' }), el('span', { text: 'Получишь при сборе' }), el('span', { text: 'Чистая прибыль' })
    ]);
    var kidsList = [el('p', { class: 'muted small', text: (n > 1 ? 'Цены за одну клетку. ' : '') + 'У тебя ' + num(have) + ' ' + silverWord(have) + '.' }), head].concat(rows);
    return { title: title, kids: kidsList };
  }

  /* ---------- действия ---------- */
  async function act(fn) {
    if (F.busy) return;
    F.busy = true;
    root && root.classList.add('busy');
    try { await fn(); }
    catch (e) {
      var t = errText(e);
      A.toast(t);
      if (/not_next|plot_busy|bad_seed|plot_closed/.test(String(e && e.message))) F.sheet = null;
    }
    F.busy = false;
    root && root.classList.remove('busy');
    await load();
  }

  function buy(plot) {
    return act(async function () {
      var r = await rpc('farm_buy_plot', { p_plot: plot });
      F.sheet = null;
      A.toast('Клетка ' + plot + ' твоя! −' + num(r.spent) + ' ' + silverWord(r.spent));
    });
  }

  function plant(seedId, plots) {
    return act(async function () {
      var r = await rpc('farm_plant', { p_seed: seedId, p_plots: plots });
      F.sheet = null;
      var sd = seedById(seedId);
      var nm = sd ? sd.name : 'Семя';
      A.toast(nm + (r.planted > 1 ? ' × ' + r.planted : '') + ' посажено' + (r.spent ? ' · −' + num(r.spent) + ' ' + silverWord(r.spent) : ''));
    });
  }

  function harvest(ids) {
    var targets = (ids ? ((F.st && F.st.plantings) || []).filter(function (p) { return ids.indexOf(p.id) >= 0; }) : readyList())
      .map(function (p) { return { plot: p.plot, payout: p.payout }; });
    return act(async function () {
      var r = await rpc('farm_harvest', { p_ids: ids });
      if (r.harvested > 0) {
        A.toast('+' + num(r.gained) + ' ' + silverWord(r.gained) + ' · прибыль +' + num(r.profit));
        F.floats = targets;
      } else {
        A.toast('Ещё не созрело. Поле обновлено.');
      }
    });
  }

  // «+23» над собранными клетками
  function showFloats() {
    if (!F.floats.length || !root) return;
    var list = F.floats; F.floats = [];
    if (reduce) return;
    list.forEach(function (f) {
      var cells = root.querySelectorAll('.farm-plot');
      var c = cells[f.plot - 1];
      if (!c) return;
      var t = el('span', { class: 'farm-float', 'aria-hidden': 'true', text: '+' + num(f.payout) });
      c.appendChild(t);
      setTimeout(function () { t.remove(); }, 1100);
    });
  }

  /* ---------- таймер для вида ---------- */
  function tick() {
    if (!root || !F.st) return;
    var changed = false;
    root.querySelectorAll('[data-ready]').forEach(function (n) {
      var ms = Number(n.getAttribute('data-ready')) - now();
      if (ms <= 0) changed = true;
      else n.textContent = left(ms);
    });
    // растение созрело или перешло в следующую стадию — перерисуем поле (без запроса к базе)
    root.querySelectorAll('.farm-plot.is-growing').forEach(function (b) {
      var p = plantingAt(Number(b.getAttribute('data-plot')));
      if (p && b.getAttribute('data-stage') !== stageOf(p)) changed = true;
    });
    if (changed && !F.busy) draw();
  }

  function onVisible() { if (!document.hidden && root) load(); }
  function onKey(e) { if (e.key === 'Escape' && F.sheet && root) closeSheet(); }

  /* ---------- вход и выход ---------- */
  function enter() {
    A = window.AppAPI;
    if (!A) return;
    load();
    clearInterval(F.timer);
    F.timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('keydown', onKey);
    window.addEventListener('online', onVisible);
  }
  function leave() {
    clearInterval(F.timer);
    F.timer = 0;
    document.removeEventListener('visibilitychange', onVisible);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('online', onVisible);
    F.sheet = null;
    root = null;
  }

  window.Farm = {
    view: function () { A = window.AppAPI; return view(); },
    enter: enter, leave: leave,
    // для проверок
    _state: function () { return F; },
    _left: left
  };
})();
