// TARGET: autocore-npa/public/sw.js
// ═══════════════════════════════════════════════════════════════════════════
// AutoCore NPA — Service Worker (PWA: installability + offline shell)
//
// Strategy (built for a frequently-redeployed internal tool — never serve a
// stale app while online):
//   • Navigations  → network-first. Online users ALWAYS get fresh HTML, which
//                    references the current hashed /_next chunks. Offline →
//                    last-cached page, then /offline.html.
//   • Static assets (/_next/static, /icons, fonts, images) → cache-first with
//                    background refresh. These are content-hashed/immutable, so
//                    cache-first is safe and fast. New build = new filenames =
//                    cache miss = fetched fresh.
//   • Cross-origin (Supabase, Meta, etc.) → not intercepted. The SW only ever
//                    touches same-origin GETs, so API/data calls are untouched.
//
// skipWaiting + clients.claim → a new deploy's SW takes over promptly without a
// forced reload (network-first keeps the open session on current code).
// ═══════════════════════════════════════════════════════════════════════════

const VERSION = "autocore-npa-v1";
const STATIC_CACHE = VERSION + "-static";
const RUNTIME_CACHE = VERSION + "-runtime";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // Don't let a single 404 abort the whole install.
      await Promise.all(
        PRECACHE.map((url) =>
          fetch(url, { cache: "no-cache" })
            .then((res) => (res && res.ok ? cache.put(url, res) : null))
            .catch(() => null)
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    /\.(?:css|js|mjs|woff2?|ttf|otf|png|jpg|jpeg|gif|svg|webp|ico)$/.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never touch POST/PATCH/etc.

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return; // skip Supabase/Meta/3rd-party

  // ── Navigations: network-first, then cache, then offline page ──────────────
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(req, fresh.clone());
          return fresh;
        } catch (e) {
          const cached = await caches.match(req);
          if (cached) return cached;
          const offline = await caches.match(OFFLINE_URL);
          return (
            offline ||
            new Response("Sin conexión", {
              status: 503,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            })
          );
        }
      })()
    );
    return;
  }

  // ── Immutable static assets: cache-first + background refresh ──────────────
  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res && res.status === 200) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        return cached || (await network) || new Response("", { status: 504 });
      })()
    );
    return;
  }

  // ── Other same-origin GETs: network, fall back to cache ────────────────────
  event.respondWith(
    (async () => {
      try {
        return await fetch(req);
      } catch (e) {
        const cached = await caches.match(req);
        return cached || new Response("", { status: 504 });
      }
    })()
  );
});

// Lets the page ask a waiting SW to activate immediately (future update toast).
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});