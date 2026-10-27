// Service worker : rend le site installable comme une application.
// Toujours le réseau d'abord (jamais de vieille version) ; la copie sert seulement sans internet.
// Les routes /api ne sont jamais gardées en copie : l'argent vient toujours du serveur.
const CACHE = 'brother-v1';
const SHELL = ['/', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api')) return;

  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then(r => r || caches.match('/'))),
  );
});
