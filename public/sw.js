const cachePrefix = `family-shopping-shell:${self.registration.scope}:`;
const cacheName = cachePrefix + 'v2';
const assets = new Set(['./', 'styles.css', 'app.mjs', 'model.mjs', 'config.mjs', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']
  .map((path) => new URL(path, self.registration.scope).href));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll([...assets])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names
    .filter((name) => (name.startsWith(cachePrefix) || name === 'family-shopping-shell-v1') && name !== cacheName)
    .map((name) => caches.delete(name)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  url.search = '';
  if (request.method !== 'GET' || !assets.has(url.href)) return;
  event.respondWith(fetch(request).catch(async () => (await caches.open(cacheName)).match(url.href)));
});
