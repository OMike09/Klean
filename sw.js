/* ═══════════ KLEAN — Service Worker (PWA) ═══════════
   L'app s'installe et reste ouvrable même réseau lent.
   API & temps réel : toujours en direct (jamais de cache). */
const CACHE = 'klean-v1';
const SHELL = [
  '/', '/index.html', '/net.js', '/manifest.json',
  '/klean-icon-192.png', '/klean-icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;                                  // jamais de POST en cache
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;  // API & WS : toujours réseau
  // Navigation (pages) : réseau d'abord, cache de secours
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; })
        .catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
    );
    return;
  }
  // Fichiers (icônes, net.js…) : cache d'abord, réseau de secours
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      const cp = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, cp));
      return r;
    }))
  );
});
