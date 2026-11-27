// Caches the app shell so it opens offline; API lookups always go to the network.
const CACHE = "profiler-v2";
const SHELL = ["./", "index.html", "style.css", "app.js", "lib/engine.js", "lib/http.js", "lib/links.js",
  "lib/sources.js", "lib/presence.js", "lib/audit.js", "lib/render.js", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Network first so updates arrive; fall back to the cached shell when offline.
  event.respondWith(fetch(event.request)
    .then((response) => {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(event.request, copy));
      return response;
    })
    .catch(() => caches.match(event.request).then((hit) => hit || caches.match("index.html"))));
});
