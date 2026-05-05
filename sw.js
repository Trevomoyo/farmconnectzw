// FarmConnectZW — Service Worker v2

const CACHE_NAME = 'farmconnectzw-v2';
const STATIC_ASSETS = [
  '/login.html',
  '/styles.css',
  '/core.js',
  '/navbar.js',
  '/images/icon-192.png',
  '/favicon.ico'
];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .catch(() => {}) // non-fatal if assets missing
  );
  self.skipWaiting();
});

// ── Activate: remove old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: network-first, fall back to cache ──────────────────────────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;
  if (event.request.url.includes('/api/')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Push: show notification ───────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: 'FarmConnectZW', body: 'You have a new notification', url: '/' };
  try { data = { ...data, ...event.data.json() }; } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    '/images/icon-192.png',
      badge:   '/images/icon-192.png',
      tag:     data.tag || 'fcz-default',        // deduplicates same-type notifications
      renotify: true,
      data:    { url: data.url },
      vibrate: [200, 100, 200],
      requireInteraction: false,
      actions: data.actions || []
    })
  );
});

// ── Notification click: focus existing window or open new one ─────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus an existing tab pointing at our origin
      for (const client of list) {
        const clientUrl = new URL(client.url);
        const target    = new URL(targetUrl, self.location.origin);
        if (clientUrl.origin === target.origin && 'focus' in client) {
          client.navigate(target.href);
          return client.focus();
        }
      }
      // No existing window — open a new one with absolute URL
      const absoluteUrl = targetUrl.startsWith('http') ? targetUrl : new URL(targetUrl, self.location.origin).href;
      return self.clients.openWindow(absoluteUrl);
    })
  );
});

// ── Push subscription change (browser renews subscription) ───────────────────
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(
    self.registration.pushManager.subscribe(event.oldSubscription.options)
      .then(sub => {
        // Re-POST the new subscription to the server
        return fetch('/api/push/resubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub })
        });
      })
      .catch(err => console.error('SW pushsubscriptionchange failed:', err))
  );
});