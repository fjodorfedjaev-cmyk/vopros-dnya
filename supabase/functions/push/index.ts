// Функция отправки уведомлений «Вопроса дня».
// Вызывает её только сама база (через pg_net) с секретным заголовком x-hook-secret.
// Типы вызова: init (создать ключи), test, comment, reminder.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { sendPush, vapidKey, b64u } from './webpush.js';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false }
});
const SITE = 'https://fjodorfedjaev-cmyk.github.io/vopros-dnya/';
const cache: { secret?: string; vapid?: { key: CryptoKey; publicKey: string; subject: string } } = {};

function one(data: unknown) { return Array.isArray(data) ? data[0] : data; }
function cut(s: string, n: number) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

async function hookSecret() {
  if (!cache.secret) { const r = await db.rpc('push_hook_secret'); cache.secret = (r.data as string) || undefined; }
  return cache.secret;
}

async function vapid() {
  if (cache.vapid) return cache.vapid;
  let row = one((await db.rpc('push_vapid_keys')).data) as { pub?: string; priv?: string } | undefined;
  if (!row || !row.pub || !row.priv) {
    // первый запуск: создаём ключи и сохраняем в Vault (если кто-то успел раньше — возьмём его ключи)
    const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', k.privateKey);
    const pub = b64u(await crypto.subtle.exportKey('raw', k.publicKey));
    await db.rpc('push_vapid_store', { p_public: pub, p_private: jwk.d });
    row = one((await db.rpc('push_vapid_keys')).data) as { pub?: string; priv?: string };
  }
  cache.vapid = { key: await vapidKey(row!.pub!, row!.priv!), publicKey: row!.pub!, subject: SITE };
  return cache.vapid;
}

type Payload = { title: string; body: string; url: string; tag: string };
async function sendTo(user: string, payload: Payload) {
  const v = await vapid();
  const subs = ((await db.rpc('push_targets', { p_user: user })).data || []) as { endpoint: string; p256dh: string; auth: string }[];
  let sent = 0;
  for (const s of subs) {
    try {
      const st = await sendPush(s, payload, v);
      if (st === 404 || st === 410) await db.rpc('push_disable', { p_endpoint: s.endpoint });
      else if (st >= 200 && st < 300) sent++;
      else console.log('push status', st, new URL(s.endpoint).host);
    } catch (e) { console.log('push error', String(e)); }
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('only POST', { status: 405 });
  const secret = await hookSecret();
  if (!secret || req.headers.get('x-hook-secret') !== secret) return new Response('forbidden', { status: 403 });
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const out: Record<string, unknown> = { type: body.type };

  if (body.type === 'init') {
    out.public = (await vapid()).publicKey;
  } else if (body.type === 'test' && typeof body.user_id === 'string') {
    out.sent = await sendTo(body.user_id, {
      title: '🔔 Уведомления работают', body: 'Так будут приходить напоминания и комментарии к твоим ответам.',
      url: SITE + '?tab=profile', tag: 'test'
    });
  } else if (body.type === 'comment') {
    const c = one((await db.rpc('push_comment_info', { p_comment: body.comment_id })).data) as
      { owner: string; commenter: string; kind: string; name: string; body: string; answer_id: number } | undefined;
    if (c && c.owner !== c.commenter) {
      out.sent = await sendTo(c.owner, {
        title: c.kind === 'fill' ? '💬 Комментарий к твоему слову' : '💬 Комментарий к твоему ответу',
        body: cut(c.name, 40) + ': ' + cut(c.body, 120),
        url: SITE + '?tab=' + (c.kind === 'fill' ? 'fill' : 'today'), tag: 'c' + c.answer_id
      });
    }
  } else if (body.type === 'reminder') {
    const list = ((await db.rpc('push_reminder_targets')).data || []) as { user_id: string; question: string | null }[];
    let sent = 0;
    for (const t of list) {
      sent += await sendTo(t.user_id, {
        title: 'Вопрос дня ждёт тебя 👀',
        body: t.question ? cut(t.question, 140) : 'Загляни: новый вопрос и слово дня уже ждут.',
        url: SITE + '?tab=today', tag: 'reminder'
      });
    }
    out.users = list.length; out.sent = sent;
  } else {
    return new Response('unknown type', { status: 400 });
  }
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
});
