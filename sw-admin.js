// Minimal service worker for Buddies and Bites Admin app.
// Its only job right now is to make the app installable (Add to Home Screen)
// and to be ready for real push notifications later if you upgrade to that.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

// Pass-through fetch handler (required for install eligibility on some browsers).
// This does not cache anything, so the app always loads the latest live version.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

// Placeholder for future real push notifications (needs a backend to trigger it).
self.addEventListener('push', (event) => {
  let data = { title: 'Buddies and Bites', body: 'You have a new update.' };
  try { data = event.data ? event.data.json() : data; } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'icon-192.png',
      badge: 'icon-192.png'
    })
  );
});
