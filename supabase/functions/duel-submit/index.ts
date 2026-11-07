// Проверка дуэли «Сектора». Телефон игрока присылает НЕ счёт, а запись нажатий (мс от старта) и как закончилась игра.
// Здесь партия переигрывается по зерну дуэли тем же ядром, что и на телефоне (sector-core.js — копия файла сайта),
// и в базу записывается счёт, который насчитал сервер. Подделать счёт так нельзя.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import './sector-core.js';

// deno-lint-ignore no-explicit-any
const Core = (globalThis as any).SectorCore;
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false }
});
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function one(d: unknown) { return Array.isArray(d) ? d[0] : d; }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'only POST' }, 405);

  // кто прислал (вход игрока)
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const u = await db.auth.getUser(token);
  const user = u.data && u.data.user;
  if (!user) return json({ error: 'not_signed_in' }, 401);

  // что прислал
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const id = Number(body && body.duel_id);
  const presses = body && body.presses;
  const end = String((body && body.end) || '');
  const endT = Number(body && body.end_t) || 0;
  if (!Number.isInteger(id) || id <= 0 || !Array.isArray(presses) || presses.length > 5000 ||
      !['miss', 'skip', 'win', 'quit'].includes(end) ||
      !presses.every((x) => typeof x === 'number' && isFinite(x) && x >= 0 && x < 3.6e6)) {
    return json({ error: 'bad_request' }, 400);
  }

  // зерно дуэли (только у сервера) и состояние
  const sec = one((await db.rpc('duel_secret', { p_id: id, p_user: user.id })).data) as
    { seed: number; status: string; my_end: string | null } | undefined;
  if (!sec) return json({ error: 'duel_gone' }, 404);
  if (sec.status !== 'playing' || sec.my_end) return json({ status: sec.status, outcome: null, already: true });

  // переигрываем партию и записываем то, что насчитал сервер
  // в дуэли очки по трём зонам сектора (края 1, ближе к центру 2, центр 3)
  const r = Core.replay(sec.seed, presses as number[], end, endT, { zones3: true });
  const used = (presses as number[]).filter((t) => t <= r.endAt);
  const st = await db.rpc('duel_store_result', {
    p_id: id, p_user: user.id, p_score: r.score, p_hits: r.hits, p_perfects: r.perfects,
    p_end: r.end, p_presses: used, p_end_ms: r.endAt
  });
  if (st.error) return json({ error: st.error.message, score: r.score }, 409);
  const row = (one(st.data) || {}) as { status?: string; outcome?: string | null };
  return json({ status: row.status, outcome: row.outcome, score: r.score, hits: r.hits, perfects: r.perfects, end: r.end });
});
