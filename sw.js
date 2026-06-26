/* HourFlow Service Worker — app shell offline + runtime cache.
   Relative paths so it also works from a GitHub Pages subfolder.

   Strategy
   - App shell (HTML incl. welcome, icons, manifest) -> precache, served instantly.
   - CDN libraries (Tailwind, jsPDF on cdnjs, Firebase SDK on gstatic)
                                                     -> stale-while-revalidate, so the
                                                        app boots & exports offline too.
   - Firebase *data* (Firestore/Auth/Installations)  -> always network; Firestore keeps
                                                        its own IndexedDB persistence. */
const PRECACHE = 'hourflow-precache-v4';
const RUNTIME  = 'hourflow-runtime-v4';

const SHELL = [
  './', './index.html', './welcome.html', './manifest.json',
  './apple-touch-icon.png', './favicon.ico', './favicon-32.png', './favicon-16.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PRECACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const keep = [PRECACHE, RUNTIME];
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Serve cache immediately, refresh from network for next time.
function staleWhileRevalidate(event, req) {
  return caches.match(req).then((cached) => {
    const fetching = fetch(req).then((res) => {
      if (res && (res.status === 200 || res.type === 'opaque')) {
        const copy = res.clone();
        caches.open(RUNTIME).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => cached);
    event.waitUntil(fetching.then(() => {}).catch(() => {}));
    return cached || fetching;
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Firebase realtime/auth/data endpoints: always network, never cache.
  // (Static Firebase SDK files on www.gstatic.com are intentionally NOT matched here.)
  if (/firestore\.googleapis|identitytoolkit|securetoken|firebaseio|firebaseinstallations|fcmregistrations/.test(url.href)) {
    return; // default browser handling
  }

  // Navigations: network-first (fresh deploys land fast) with offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(PRECACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
    );
    return;
  }

  // Everything else: app shell + CDN libraries via stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(event, req));
});
