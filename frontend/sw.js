// Service worker de Rescatá: recibe las notificaciones push y abre la publicación al tocarlas.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  const opts = {
    body: d.body || 'Alguien publicó un hallazgo nuevo',
    icon: 'icon-192.png',
    badge: 'badge-72.png',
    tag: d.tag || 'rescata',
    renotify: true,
    data: { url: d.url || './' },
  };
  if (d.image) opts.image = d.image;
  e.waitUntil((async () => {
    // Siempre mostramos la notificación del sistema (iOS lo exige en cada push)...
    await self.registration.showNotification(d.title || 'Rescatá', opts);
    // ...y si la app está abierta en pantalla, le pasamos el aviso para el cartel emergente
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) if (c.visibilityState === 'visible') c.postMessage({ type: 'push', data: { ...d, tag: opts.tag } });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) {
        c.postMessage({ type: 'open', url });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
