/* Nikaas service worker: emergency alerts while the page is closed (Web Push), and the app shell offline. */
const CACHE = 'nikaas-shell-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k)
  await self.clients.claim()
})()))

// Pages: network first, last good copy when offline. Hashed build assets: cache first (they never change).
self.addEventListener('fetch', e => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // the API is another origin: never cached here
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./', copy)); return res })
      .catch(() => caches.match('./').then(r => r || Response.error())))
    return
  }
  if (url.pathname.includes('/assets/') || url.pathname.includes('/fonts/') || url.pathname.includes('/icons/')) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)) }
      return res
    })))
  }
})

self.addEventListener('push', e => {
  let m = {}
  try { m = e.data ? e.data.json() : {} } catch { m = { title: 'Nikaas', body: e.data ? e.data.text() : '' } }
  const alarm = !!m.alarm
  e.waitUntil((async () => {
    await self.registration.showNotification(m.title || 'Nikaas', {
      body: m.body || '', tag: m.tag || 'nikaas', renotify: true, requireInteraction: alarm,
      icon: 'icons/icon-192.png', badge: 'icons/badge-96.png',
      vibrate: alarm ? [600, 200, 600, 200, 600, 200, 1200] : [300, 120, 300],
      data: { url: m.url || './#/go' },
    })
    // an open page refreshes straight away instead of waiting for its next poll
    for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'nikaas-push', message: m })
  })())
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const target = new URL(e.notification.data?.url || './#/go', self.registration.scope).href
  e.waitUntil((async () => {
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (c.url.split('#')[0] === target.split('#')[0]) { await c.navigate(target).catch(() => {}); return c.focus() }
    }
    return self.clients.openWindow(target)
  })())
})
