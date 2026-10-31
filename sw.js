/* Помощник приложения. Файлы сайта НЕ кэширует (всегда берёт свежие с сервера),
   только показывает понятную страницу, если открыть приложение без интернета. */
var OFFLINE = 'offline-v1';
var PAGE = '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>Вопрос дня</title><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#121212;color:#E8E6E3;font:17px system-ui,sans-serif;text-align:center;padding:24px">' +
  '<div><p style="font-size:44px;margin:0 0 12px">📡</p><p style="margin:0 0 8px;font-weight:600">Нет интернета</p>' +
  '<p style="margin:0 0 20px;color:#A0968E">Подключись к сети и попробуй ещё раз.</p>' +
  '<button onclick="location.reload()" style="font:600 16px system-ui;padding:12px 22px;border:0;border-radius:8px;background:#C4500B;color:#fff">Обновить</button></div></body></html>';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  if (e.request.mode !== 'navigate') return; // всё остальное — напрямую, как обычно
  e.respondWith(fetch(e.request).catch(function () {
    return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }));
});
