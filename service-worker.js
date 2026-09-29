// web/service-worker.js
//
// Network-first for the app shell so a redeploy reaches users immediately
// (falls back to cache only when offline). Bump CACHE_NAME on any change
// so the activate handler cleans out the old cache instead of leaving a
// stale copy that never gets used.
const CACHE_NAME = "papaya-shell-v2";
const SHELL_FILES = ["./index.html", "./styles.css", "./app.js", "./logic.js", "./manifest.json", "./icon.png"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
