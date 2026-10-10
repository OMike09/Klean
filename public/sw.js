/* Klean Services — Service Worker */
const CACHE = 'ks-v3';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json', '/logo.png', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('push', event => {
  let data = {}; try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Klean Services';
  const mission = data.category === 'mission';
  const missionId = mission && String(data.link || '').match(/#\/mission\/(\d+)/);
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '', icon: '/icon-192.png', badge: '/icon-192.png',
    data: { link: data.link || '#/notifications' },
    // Le même tag remplace une ancienne alerte lorsqu'une mission est attribuée ; renotify permet le rappel autorisé.
    tag: missionId ? 'ks-mission-' + missionId[1] : (data.id ? 'ks-' + data.id : undefined),
    renotify: mission && data.sound !== false, silent: data.sound === false,
    requireInteraction: mission, vibrate: mission && data.sound !== false ? [120, 55, 120, 55, 180] : undefined
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close(); const link = event.notification.data && event.notification.data.link || '#/notifications';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => { const c = list[0]; if (c) { c.focus(); c.postMessage({ type: 'navigate', link }); return; } return clients.openWindow('/' + link); }));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return; // réseau direct pour l'API
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && url.origin === location.origin && !url.pathname.startsWith('/uploads/')) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});
