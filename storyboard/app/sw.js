// Lets the installed Chrome app explain what to do when the Storyboard
// server isn't running, instead of showing Chrome's "can't be reached" page.
// Only page loads are intercepted, and only when the server doesn't answer;
// everything else always comes straight from the server.

const CACHE = 'storyboard-offline-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/offline.html'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')));
});
