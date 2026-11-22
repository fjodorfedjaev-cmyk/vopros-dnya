// Поддельный supabase-js для локальной проверки сайта в браузере.
// Кто вошёл — из localStorage (mock-user). Вызовы из LOCAL_RPC и таблица profiles идут в локальный Postgres (через server.js),
// остальное получает пустой ответ — этого хватает, чтобы сайт загрузился. Для новой функции добавь её вызовы в LOCAL_RPC.
(function () {
  var USER = localStorage.getItem('mock-user');
  var TABLES = { profiles: true };
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ user: USER }, body)) })
      .then(function (r) { return r.json(); });
  }
  var LOCAL_RPC = /^(durak_|poker_|bluff_|cards_|market_|my_points$|member_coins$|member_stats$|member_profile$|is_admin$)/;
  var DEFAULTS = {
    ensure_today_question: [{ q_day: '2026-11-18', q_id: 1, q_category: 'funny', q_text: 'Тестовый вопрос дня?' }],
    ensure_today_fill: [{ q_day: '2026-11-18', q_id: 1, q_category: 'fill', q_text: 'Тест ___ фраза' }],
    ensure_today_poll: [{ q_day: '2026-11-18', q_id: 1, q_category: 'poll', q_text: 'Тест?', q_options: ['а', 'б', 'в', 'г'] }]
  };
  function query(table) {
    var st = { eq: [], single: false, maybe: false };
    var b = {
      select: function () { return b; }, order: function () { return b; }, limit: function () { return b; }, in: function () { return b; },
      gte: function () { return b; }, lte: function () { return b; }, lt: function () { return b; }, gt: function () { return b; }, neq: function () { return b; },
      is: function () { return b; }, not: function () { return b; }, range: function () { return b; }, filter: function () { return b; },
      insert: function () { return b; }, update: function () { return b; }, upsert: function () { return b; }, delete: function () { return b; },
      eq: function (c, v) { st.eq.push([c, v]); return b; },
      single: function () { st.single = true; return b; }, maybeSingle: function () { st.maybe = true; return b; },
      then: function (ok, bad) {
        // строки для проверки (ответы, комментарии…) можно положить в localStorage 'mock-tables': { таблица: [строки] }
        var fake = null;
        try { fake = JSON.parse(localStorage.getItem('mock-tables') || 'null'); } catch (e) { fake = null; }
        var p = fake && fake[table] ? Promise.resolve({ data: fake[table] })
          : TABLES[table] ? post('/mock/table', { table: table, eq: st.eq }) : Promise.resolve({ data: [] });
        return p.then(function (r) {
          if (r.error) return { data: null, error: r.error };
          var d = r.data;
          if (st.single || st.maybe) d = d && d.length ? d[0] : null;
          return { data: d, error: null };
        }).then(ok, bad);
      }
    };
    return b;
  }
  function chan() { var c = { on: function () { return c; }, subscribe: function () { return c; }, unsubscribe: function () {} }; return c; }
  window.supabase = {
    createClient: function () {
      var session = USER ? { access_token: 'mock', user: { id: USER, email: 'mock@x' }, expires_at: 9999999999 } : null;
      return {
        auth: {
          getSession: function () { return Promise.resolve({ data: { session: session }, error: null }); },
          onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
          signOut: function () { return Promise.resolve({ error: null }); }
        },
        from: query,
        rpc: function (name, args) {
          if (LOCAL_RPC.test(name)) return post('/mock/rpc', { name: name, args: args || {} }).then(function (r) { return { data: r.data === undefined ? null : r.data, error: r.error || null }; });
          // ответы для проверки можно положить в localStorage 'mock-rpc': { имя_функции: данные }
          var fakeRpc = null;
          try { fakeRpc = JSON.parse(localStorage.getItem('mock-rpc') || 'null'); } catch (e) { fakeRpc = null; }
          if (fakeRpc && Object.prototype.hasOwnProperty.call(fakeRpc, name)) return Promise.resolve({ data: fakeRpc[name], error: null });
          return Promise.resolve({ data: Object.prototype.hasOwnProperty.call(DEFAULTS, name) ? DEFAULTS[name] : [], error: null });
        },
        channel: chan, removeChannel: function () {},
        functions: { invoke: function () { return Promise.resolve({ data: null, error: null }); } }
      };
    }
  };
})();
