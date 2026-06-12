const CACHE_NAME = 'family-stocks-live';

// Obliga al Service Worker a instalarse al instante
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Toma el control de las pantallas de los móviles inmediatamente
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// Estrategia "Network First": Siempre pide a Vercel la versión nueva.
// Solo muestra caché viejo si el móvil pierde la conexión a internet (offline).
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .catch(() => caches.match(event.request))
  );
});