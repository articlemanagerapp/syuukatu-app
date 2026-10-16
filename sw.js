// 就活管理の Service Worker
// ホーム画面に追加して使えるようにするためのもの。通信できるときは常に最新を取りに行き(ネットワーク優先)、
// 圏外のときだけ前回の画面を出す。Firebase など別ドメインへの通信には手を出さない。
const CACHE_NAME = 'shukatsu-v1';
const APP_SHELL = [
  './syuukatu-v3.html',
  './syuukatu-v3.css',
  './syuukatu-v3.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
