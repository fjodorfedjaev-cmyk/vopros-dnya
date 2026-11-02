// Web Push без сторонних библиотек: шифрование aes128gcm (RFC 8291) и подпись VAPID (RFC 8292).
// Работает в Deno (Supabase Edge Functions) и в Node 20+ — только встроенный WebCrypto.
const enc = new TextEncoder();

export function b64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const n = parts.reduce((m, p) => m + p.length, 0); const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// Шифрует payload для подписки { endpoint, keys: { p256dh, auth } }.
export async function encrypt(payload, p256dh, authSecret, salt, asKeys) {
  const uaPublic = unb64u(p256dh), auth = unb64u(authSecret);
  salt = salt || crypto.getRandomValues(new Uint8Array(16));
  const as = asKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(auth, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const data = typeof payload === 'string' ? enc.encode(payload) : payload;
  const padded = concat(data, new Uint8Array([2]));
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, padded));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

// Ключ VAPID из публичного (65 байт, base64url) и приватного (d, base64url).
export async function vapidKey(publicB64, privateB64) {
  const pub = unb64u(publicB64);
  const jwk = { kty: 'EC', crv: 'P-256', d: privateB64, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}
export async function vapidJwt(endpoint, key, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body));
  return head + '.' + body + '.' + b64u(sig);
}

// Отправка одного уведомления. Возвращает HTTP-статус (201 — доставлено, 404/410 — подписка устарела).
export async function sendPush(sub, payload, vapid) {
  const body = await encrypt(JSON.stringify(payload), sub.p256dh, sub.auth);
  const jwt = await vapidJwt(sub.endpoint, vapid.key, vapid.subject);
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: String(vapid.ttl || 86400), Urgency: 'normal',
      Authorization: 'vapid t=' + jwt + ', k=' + vapid.publicKey
    },
    body
  });
  return r.status;
}
