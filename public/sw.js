/* Klean Services — Service Worker public, sans données privées */
const CACHE = 'ks-v6-public-shell';
const SHELL = ['/', '/index.html', '/styles.css', '/modern-ui.css', '/category-request.css', '/app.js', '/manifest.json', '/logo.png', '/icon-192.png', '/icon-512.png'];
const SAFE_ASSETS = new Set(SHELL);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('push', event => {
  let data = {}; try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Klean Services';
  const mission = data.category === 'mission';
  const missionId = mission && String(data.link || '').match(/#\/mission\/(\d+)/);
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '', icon: '/icon-192.png', badge: '/icon-192.png', data: { link: data.link || '#/notifications' },
    tag: missionId ? 'ks-mission-' + missionId[1] : (data.id ? 'ks-' + data.id : undefined),
    renotify: mission && data.sound !== false, silent: data.sound === false,
    requireInteraction: mission, vibrate: mission && data.sound !== false ? [120, 55, 120, 55, 180] : undefined
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close(); const link = event.notification.data && event.notification.data.link || '#/notifications';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list[0]; if (c) { c.focus(); c.postMessage({ type: 'navigate', link }); return; }
    return clients.openWindow('/' + link);
  }));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Jamais de cache de session, API, uploads ou requêtes porteuses d’informations privées.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;
  const key = url.pathname === '/' ? '/' : url.pathname;
  if (!SAFE_ASSETS.has(key)) return; // seule la coque publique installable est disponible hors connexion.
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request).then(hit => hit || caches.match('/'))));
});
