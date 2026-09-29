// web/service-worker.js
//
// Kill switch. An earlier release registered a cache-first service worker
// that kept serving stale app code on devices that had visited once. The
// app no longer uses a service worker; this file stays at the same URL so
// the browser's automatic update check replaces the old worker with this
// one, which deletes all caches, unregisters itself and reloads open pages.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: "window" });
    clients.forEach((client) => client.navigate(client.url));
  })());
});
