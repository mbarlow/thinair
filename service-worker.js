// ThinAir service worker. Cache-first for the static shell so the PWA opens
// offline; network-first for everything else (including the runtime CDN libs
// which we still want fresh on each release).
const VERSION = "__BUILD_SHA__";
const CACHE = "thinair-shell-" + VERSION;

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./app-icon.svg",
  "./app-icon-mask.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never cache cross-origin (CDN libs) — let the network rule them.
  if (url.origin !== location.origin) return;
  // Module fetches use ?v=<sha>; trust the URL and cache aggressively.
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh.ok && (req.destination !== "document")) {
        const c = await caches.open(CACHE);
        c.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      return cached || new Response("offline", { status: 503 });
    }
  })());
});
