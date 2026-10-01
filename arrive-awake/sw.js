/* Arrive Awake service worker: caches the app shell, shows push alarms. API calls always go to the network. */
const CACHE = 'arrive-awake-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;           // API + fonts: network only
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});

/* Server-side alarm: the backend sends a push when alarm time is reached (repeated each minute until acknowledged). */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (err) { d = { kind: 'wake', title: 'Arrive Awake', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Arrive Awake';
  const opts = {
    body: d.body || '', tag: 'arrive-awake-' + (d.kind || 'wake'), renotify: true, requireInteraction: d.kind !== 'test',
    vibrate: [800, 300, 800, 300, 800, 300, 800, 300, 800], icon: './icon-192.png', badge: './icon-192.png', data: d, timestamp: Date.now(),
  };
  e.waitUntil(Promise.all([
    self.registration.showNotification(title, opts),
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => cs.forEach(c => c.postMessage({ type: 'push', data: d }))),
  ]));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => 'focus' in x);
    if (c) { c.postMessage({ type: 'push', data: e.notification.data || {} }); return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
