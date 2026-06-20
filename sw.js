/* HourFlow Service Worker — app shell offline + runtime cache.
   Path relativi per funzionare anche in sottocartella di GitHub Pages. */
const CACHE = 'hourflow-v1';
const SHELL = ['./', './index.html', './manifest.json', './apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Le chiamate Firebase/Auth/Firestore devono SEMPRE andare in rete
  // (la persistenza offline è gestita da Firestore stesso).
  if (/firestore|googleapis|firebaseio|identitytoolkit|gstatic/.test(url.host)) return;

  // Navigazioni: network-first con fallback alla cache (per l'uso offline).
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => { const cl = r.clone(); caches.open(CACHE).then((c) => c.put(req, cl)); return r; })
        .catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
    );
    return;
  }

  // Altri asset (incluse CDN come Tailwind): cache-first, poi rete e memorizza.
  e.respondWith(
    caches.match(req).then((m) => m || fetch(req).then((r) => {
      try {
        if (r && (r.status === 200 || r.type === 'opaque')) {
          const cl = r.clone();
          caches.open(CACHE).then((c) => c.put(req, cl));
        }
      } catch (_) {}
      return r;
    }).catch(() => m))
  );
});
