// Service worker : permet d'installer l'appli et de l'ouvrir sans connexion.
// Stratégie « réseau d'abord » : quand on est en ligne on a toujours la dernière version ; hors ligne, la dernière copie vue.
const CACHE = 'campass-v1';
const SHELL = ['./', 'index.html', 'feuille-blanche.html', 'manifest.webmanifest', 'css/tailwind.css', 'css/app.css', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'vendor/ical.min.js',
  'js/ai.js',
  'js/app.js',
  'js/backend.js',
  'js/cards.js',
  'js/confidence.js',
  'js/dates.js',
  'js/extract.js',
  'js/ics-export.js',
  'js/ics.js',
  'js/kinds.js',
  'js/library.js',
  'js/md.js',
  'js/pdfview.js',
  'js/planner.js',
  'js/scheduling.js',
  'js/sha1.js',
  'js/share.js',
  'js/srs.js',
  'js/stats.js',
  'js/store.js'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;           // l'assistant IA et les autres sites ne passent jamais par le cache
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
      return Response.error();
    }
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => list.length ? list[0].focus() : self.clients.openWindow('./')));
});
