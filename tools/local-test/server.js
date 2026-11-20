// Локальная проверка сайта: раздаёт файлы сайта (корень репозитория) на http://localhost:8099
// и выполняет вызовы «базы» в локальном Postgres через psql от имени того, кто «вошёл».
// Запуск: DB=имя_базы node server.js
const http = require('http'), fs = require('fs'), path = require('path'), { execFile } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..'), DB = process.env.DB || 'e2e';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/json' };
function psql(user, sql) {
  return new Promise((ok) => {
    const claims = JSON.stringify({ sub: user, role: 'authenticated' }).replace(/'/g, "''");
    execFile('psql', ['-h', '/tmp', '-p', '5433', '-U', 'postgres', '-d', DB, '-qAt', '-v', 'ON_ERROR_STOP=1',
      '-c', `set request.jwt.claims = '${claims}'`, '-c', sql], { maxBuffer: 1 << 24 }, (err, out, errOut) => {
      if (err) { const m = /ERROR:\s+(.*)/.exec(errOut || ''); ok({ error: { message: m ? m[1] : String(errOut || err) } }); return; }
      ok({ out: out.trim() });
    });
  });
}
function lit(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'ARRAY[' + v.map(Number).join(',') + ']::integer[]';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return "'" + String(v).replace(/'/g, "''") + "'";
}
// функции, которые возвращают таблицу (PostgREST отдаёт их массивом)
const SETS = { my_points: true, member_coins: true,
  cards_deck: true, cards_catalog: true, cards_my: true, cards_open: true, cards_melt: true, cards_showcases: true, cards_members: true,
  market_buy: true, market_lots: true, market_sell: true, market_bid: true, market_bid_reprice: true, market_bids: true, market_history: true };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST' && u.pathname.startsWith('/mock/')) {
    let body = ''; for await (const c of req) body += c;
    const q = JSON.parse(body || '{}');
    let r;
    if (u.pathname === '/mock/rpc') {
      const name = String(q.name).replace(/[^a-z_]/g, '');
      const args = Object.keys(q.args || {}).map(k => k.replace(/[^a-z_]/g, '') + ' => ' + lit(q.args[k])).join(', ');
      const sql = SETS[name] ? `select coalesce(jsonb_agg(to_jsonb(x)), '[]')::text from public.${name}(${args}) x`
                             : `select public.${name}(${args})::text`;
      r = await psql(q.user, sql);
      if (!r.error) r = { data: r.out === '' ? null : JSON.parse(r.out) };
    } else if (u.pathname === '/mock/table') {
      const t = String(q.table).replace(/[^a-z_]/g, '');
      const where = (q.eq || []).map(([c, v]) => c.replace(/[^a-z_]/g, '') + ' = ' + lit(v)).join(' and ');
      r = await psql(q.user, `select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at), '[]')::text from public.${t} t` + (where ? ' where ' + where : ''));
      if (!r.error) r = { data: JSON.parse(r.out) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); return;
  }
  let f = path.join(ROOT, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  if (u.pathname === '/mock-supabase.js') f = path.join(__dirname, 'shim.js');
  if (!f.startsWith(ROOT) && !f.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data);
  });
}).listen(8099, () => console.log('mock on 8099'));
