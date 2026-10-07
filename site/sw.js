/* Offline cache for the AoIR kiosk.

   Two strategies, on purpose:

   - Photos and fonts are content-hashed and never change under a given name,
     so they are cache-first: instant, and they survive a dead network.
   - The shell (HTML/CSS/JS) and the catalogue are network-first with a cache
     fallback. Cache-first on the shell meant a rebuilt site kept serving the
     previous app.js until you reloaded twice, which is exactly the trap you
     fall into while setting up a booth.

   Either way the kiosk works with no network once it has been loaded. Checkout
   happens on the shopper's own phone, so the QR codes never depend on this. */

const VERSION = "aoir-kiosk-4af02ea067ff";
const SHELL = [
  "./", "index.html", "styles.css", "fonts.css", "app.js", "qrcode.js", "data.json",
  "fonts/archivo-400-700-latin.woff2",
  "fonts/archivo-400-700-latin-ext.woff2",
  "fonts/plexmono-400-latin.woff2",
  "fonts/plexmono-500-latin.woff2",
];

const immutable = (p) => p.includes("/img/") || p.includes("/fonts/");

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // never touch shop.aoir.org

  const keep = (res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
    }
    return res;
  };

  if (immutable(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(keep)));
    return;
  }

  // Shell + catalogue: take the network when there is one.
  e.respondWith(
    fetch(req)
      .then(keep)
      .catch(() => caches.match(req).then((hit) => hit || caches.match("index.html")))
  );
});
