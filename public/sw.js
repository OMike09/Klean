/* Klean Services — PWA publique : coque + images de catalogue versionnées, aucune donnée privée. */
const SHELL_CACHE = 'ks-v12-public-shell';
const IMAGE_CACHE = 'ks-v1-public-images';
const MAX_PUBLIC_IMAGES = 96;
const SHELL = ['/', '/index.html', '/styles.css', '/modern-ui.css', '/category-request.css', '/category-cards.css', '/app.js', '/manifest.json', '/logo.png', '/icon-192.png', '/icon-512.png'];
const SAFE_ASSETS = new Set(SHELL);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(k => k !== SHELL_CACHE && k !== IMAGE_CACHE)
    .map(k => caches.delete(k)))).then(() => self.clients.claim()));
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

function isVersionedPublicImage(request) {
  if (!request || request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (!(url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/category-images/'))) return false;
  // Un fichier privé ne devient jamais admissible au cache parce qu'il porte un simple paramètre :
  // le serveur ajoute aussi X-Klean-Public-Image uniquement après contrôle de l'asset actif.
  return /^[a-f0-9]{12,64}$/i.test(url.searchParams.get('v') || '');
}
function publicImageResponse(response) {
  return !!(response && response.ok && /^image\//i.test(response.headers.get('content-type') || '') && response.headers.get('X-Klean-Public-Image') === '1');
}
function sameImageFile(a, b) {
  const ua = new URL(a), ub = new URL(b);
  return ua.origin === ub.origin && ua.pathname === ub.pathname;
}
async function trimImageCache(cache, justStoredUrl) {
  const keys = await cache.keys();
  // À la réception d'une nouvelle version d'un même fichier, les anciennes variantes
  // sont retirées immédiatement ; les autres images restent réutilisables hors ligne.
  await Promise.all(keys.filter(k => k.url !== justStoredUrl && sameImageFile(k.url, justStoredUrl)).map(k => cache.delete(k)));
  const remaining = await cache.keys();
  if (remaining.length <= MAX_PUBLIC_IMAGES) return;
  const dated = await Promise.all(remaining.map(async k => {
    const r = await cache.match(k); const d = Date.parse((r && r.headers.get('date')) || '') || 0;
    return { k, d };
  }));
  dated.sort((a,b) => a.d - b.d);
  await Promise.all(dated.slice(0, Math.max(0, dated.length - MAX_PUBLIC_IMAGES)).map(x => cache.delete(x.k)));
}
async function updatePublicImage(cache, request) {
  try {
    const response = await fetch(request);
    if (publicImageResponse(response)) {
      await cache.put(request, response.clone());
      await trimImageCache(cache, request.url);
    } else if ([401,403,404,410].includes(response.status)) {
      await cache.delete(request);
    }
    return response;
  } catch { return null; }
}
async function imageResponse(event) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(event.request);
  const update = updatePublicImage(cache, event.request);
  if (cached) {
    // Stale-while-revalidate : déjà téléchargée = affichage immédiat hors ligne/lent,
    // tandis que la version exacte est discrètement revalidée lorsqu'un réseau existe.
    event.waitUntil(update);
    return cached;
  }
  const network = await update;
  return network || new Response('', { status: 504, statusText: 'Image indisponible hors connexion' });
}
function absoluteList(list) {
  return new Set((Array.isArray(list) ? list : []).map(value => {
    try { return new URL(String(value), self.location.origin).href; } catch { return ''; }
  }).filter(Boolean));
}
async function synchronizeImageCache(data) {
  const active = absoluteList(data && data.active_urls), obsolete = absoluteList(data && data.invalidated_urls);
  const cache = await caches.open(IMAGE_CACHE), keys = await cache.keys();
  await Promise.all(keys.map(async key => {
    if (obsolete.has(key.url)) return cache.delete(key);
    // Une version active connue purge seulement les autres versions du même fichier ; on ne
    // vide pas les photos d'autres catégories, afin de préserver l'usage hors connexion.
    for (const current of active) if (sameImageFile(key.url, current) && key.url !== current) return cache.delete(key);
  }));
  await trimImageCache(cache, 'https://cache-control.invalid/no-match');
}
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'KS_IMAGE_CACHE_SYNC') event.waitUntil(synchronizeImageCache(data));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // API, sessions, pages privées et autres uploads restent strictement hors cache.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (isVersionedPublicImage(event.request)) { event.respondWith(imageResponse(event)); return; }
  const key = url.pathname === '/' ? '/' : url.pathname;
  if (!SAFE_ASSETS.has(key)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) caches.open(SHELL_CACHE).then(cache => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request).then(hit => hit || caches.match('/'))));
});
