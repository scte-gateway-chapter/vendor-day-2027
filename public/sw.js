// sw.js — Vendor Day 2027 service worker with tiered caching (Task 26).
//
// Polyfill `crypto.randomUUID` in the service worker scope BEFORE
// `importScripts` runs. The OneSignal SW SDK v16 that we pull in below
// calls `crypto.randomUUID()` unconditionally during init; older Chrome
// builds (pre-92) don't expose the Web Crypto method and would throw
// `TypeError: crypto.randomUUID is not a function`, breaking push
// delivery. The service worker is a separate JS context from the page,
// so it cannot import the module polyfill at `public/js/polyfills.js`;
// the logic is duplicated here on purpose. See that file for the
// RFC 4122 §4.4 derivation.
if (
  typeof globalThis.crypto?.getRandomValues === "function" &&
  typeof globalThis.crypto.randomUUID !== "function"
) {
  globalThis.crypto.randomUUID = function randomUUID() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
}

// OneSignal's hosted push worker is imported FIRST so its push,
// notificationclick, and pushsubscriptionchange handlers register against
// this worker's global scope before our listeners wire up. Removing or
// re-ordering this import silently breaks push delivery on iOS 16.4+
// installed PWAs (confirmed on real test devices in Task 25). The import
// path is pinned to v16 so SDK bumps are an explicit edit.
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");

/* ---------------- Versioning & caches ----------------
 * `scripts/build-sw.js` stamps `__BUILD_ID__` across the three cache name
 * constants and the standalone `BUILD_ID` string at build time. On the
 * next deploy, `activate` deletes caches whose names don't match the
 * current triple so stale shell / content / image bytes are reclaimed. */
const BUILD_ID = "1793224288793";
const SHELL_CACHE = "shell-v1793224288793";
const CONTENT_CACHE = "content-v1793224288793";
const IMAGES_CACHE = "images-v1793224288793";

/* ---------------- Pre-cache manifest ----------------
 * `scripts/build-sw.js` walks `public/` at build time and rewrites the
 * array literal between the START/END markers with the real list of
 * shell assets. First-run (before the build) stays an empty array so the
 * file parses — install will no-op in that case. */
const PRECACHE_MANIFEST = /* PRECACHE_MANIFEST_START */ ["/","/admin/","/admin/css/admin.css","/admin/index.html","/admin/js/admin-auth.js","/admin/js/admin-fetch.js","/admin/js/admin.js","/admin/js/agenda-editor.js","/admin/js/announcements-composer.js","/admin/js/attendees-importer.js","/admin/js/collision-check.js","/admin/js/csv-parse.js","/admin/js/dashboard.js","/admin/js/feedback-editor.js","/admin/js/login.js","/admin/js/map-uploader.js","/admin/js/recap-editor.js","/admin/js/settings-editor.js","/admin/js/sponsors-editor.js","/assets/brand/gateway-logo.png","/assets/brand/gateway-logo.svg","/assets/icons/icon-192.png","/assets/icons/icon-512.png","/assets/icons/icon-maskable-512.png","/assets/placeholders/logo-placeholder.svg","/assets/placeholders/venue-map-placeholder.svg","/css/app.css","/index.html","/js/app-settings.js","/js/app.js","/js/debug-log.js","/js/debug-overlay.js","/js/firebase.js","/js/markdown-mini.js","/js/onesignal.js","/js/polyfills.js","/js/router.js","/js/ui.js","/js/utils/focus-trap.js","/js/utils/time.js","/js/views/agenda-detail.js","/js/views/agenda.js","/js/views/announcements.js","/js/views/attendees-detail.js","/js/views/attendees.js","/js/views/feedback.js","/js/views/home.js","/js/views/map.js","/js/views/recap.js","/js/views/signin.js","/js/views/sponsors-detail.js","/js/views/sponsors.js","/js/views/welcome.js","/manifest.webmanifest","/offline.html"] /* PRECACHE_MANIFEST_END */;

const OFFLINE_URL = "/offline.html";

/* ---------------- Images cache quotas ----------------
 * Enforced on each put via a parallel metadata entry stored under
 * `IMAGES_META_KEY`. Eviction is "delete oldest by insertion order" —
 * design section 8 explicitly notes full LRU is not required. */
const IMAGES_META_KEY = "/__image-cache-meta__";
const MAX_IMAGE_ENTRIES = 60;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/* =================================================================
 * Lifecycle
 * ================================================================= */

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Add entries individually so one 404 (e.g., a developer removed a
    // file between the build-sw.js walk and the browser install) doesn't
    // abort the whole pre-cache.
    await Promise.all(PRECACHE_MANIFEST.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: "reload" }));
      } catch (err) {
        console.warn("[sw] pre-cache skipped:", url, err && err.message);
      }
    }));
    // Take over on next page load without a hard refresh.
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, CONTENT_CACHE, IMAGES_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.map((n) => (keep.has(n) ? null : caches.delete(n))));
    await self.clients.claim();
    // Notify every open client (even uncontrolled ones) that a new
    // version is live. `/js/app.js` listens for this and shows the
    // "App updated — tap to reload" banner.
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const client of clients) {
      try {
        client.postMessage({ type: "sw-updated", buildId: BUILD_ID });
      } catch (_err) { /* non-fatal */ }
    }
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.type === "skip-waiting") {
    // Clients post this when the user taps the update banner to force
    // an immediate takeover if a waiting SW exists. skipWaiting() is
    // already called from install; this just covers the rare case
    // where the install SW is still waiting on an older claim.
    self.skipWaiting();
  }
});

/* =================================================================
 * Routing
 * ================================================================= */

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only GET is cacheable. Let the browser handle anything else natively.
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_err) {
    return;
  }

  // Only HTTP(S) requests. Chrome extensions / data URLs would throw on cache.put.
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // OneSignal: pass through without caching. The SDK handles its own.
  if (url.hostname === "onesignal.com" || url.hostname.endsWith(".onesignal.com")) {
    event.respondWith(fetch(req));
    return;
  }

  // Content JSON: Firestore REST + our /api/config endpoint.
  if (
    url.hostname === "firestore.googleapis.com" ||
    (url.origin === self.location.origin && url.pathname === "/api/config")
  ) {
    event.respondWith(networkFirstContent(req));
    return;
  }

  // Images: Cloudflare R2 public bucket URLs look like `pub-<hash>.r2.dev`.
  if (/^pub-[a-z0-9]+\.r2\.dev$/i.test(url.hostname)) {
    event.respondWith(cacheFirstImages(req));
    return;
  }

  // Shell: same-origin HTML / CSS / JS / icon / font requests.
  if (url.origin === self.location.origin && isShellRequest(req, url)) {
    event.respondWith(cacheFirstShell(req));
    return;
  }

  // Everything else: pass through, no cache. event.respondWith is called
  // explicitly so iOS 16.4+ counts this handler as a "real" fetch
  // handler for PWA eligibility (an empty listener fails that probe).
  event.respondWith(fetch(req));
});

/* =================================================================
 * Strategy helpers
 * ================================================================= */

/** Shell = navigations, our own CSS / JS / icons / fonts / placeholders. */
function isShellRequest(request, url) {
  if (request.mode === "navigate") return true;
  const p = url.pathname;
  if (p === "/" || p === "/index.html" || p === "/admin/" || p === "/admin/index.html") return true;
  if (p === "/manifest.webmanifest" || p === OFFLINE_URL) return true;
  return /\.(css|js|svg|png|woff2)$/i.test(p);
}

/**
 * Shell cache-first. On miss, fetch + populate the cache. On navigation
 * failure with no cached copy, serve the offline fallback page.
 */
async function cacheFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.ok && (res.type === "basic" || res.type === "default")) {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    if (request.mode === "navigate") {
      const fallback = await cache.match(OFFLINE_URL);
      if (fallback) return fallback;
    }
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

/**
 * Content network-first. Updates the cache on every successful fetch;
 * falls back to the cached copy on network failure. If no cache entry
 * exists either, returns a 503 JSON body the UI can detect.
 */
async function networkFirstContent(request) {
  const cache = await caches.open(CONTENT_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ offline: true, error: "no connection" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
}

/**
 * Images cache-first with eviction. On miss, fetch + put + track in the
 * metadata record; then evict oldest entries while over the entry count
 * or byte quota.
 */
async function cacheFirstImages(request) {
  const cache = await caches.open(IMAGES_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      await cache.put(request, res.clone());
      await trackAndEvictImageEntry(cache, request.url, estimateBytes(res));
    }
    return res;
  } catch (err) {
    return new Response("", { status: 504, statusText: "Image unavailable" });
  }
}

function estimateBytes(res) {
  const len = Number(res.headers.get("Content-Length"));
  return Number.isFinite(len) && len > 0 ? len : 0;
}

async function readImageMeta(cache) {
  const metaRes = await cache.match(IMAGES_META_KEY);
  if (!metaRes) return { order: [], sizes: {} };
  try {
    const parsed = await metaRes.json();
    if (!parsed || !Array.isArray(parsed.order) || typeof parsed.sizes !== "object") {
      return { order: [], sizes: {} };
    }
    return parsed;
  } catch (_err) {
    return { order: [], sizes: {} };
  }
}

async function writeImageMeta(cache, meta) {
  await cache.put(
    IMAGES_META_KEY,
    new Response(JSON.stringify(meta), {
      headers: { "Content-Type": "application/json" },
    }),
  );
}

async function trackAndEvictImageEntry(cache, url, bytes) {
  const meta = await readImageMeta(cache);
  // Re-insert the url at the end of `order` so newest is always last.
  meta.order = meta.order.filter((u) => u !== url);
  meta.order.push(url);
  meta.sizes[url] = Number(bytes) || 0;

  let total = 0;
  for (const u of meta.order) total += Number(meta.sizes[u]) || 0;

  while (meta.order.length > MAX_IMAGE_ENTRIES || total > MAX_IMAGE_BYTES) {
    const oldest = meta.order.shift();
    if (!oldest) break;
    total -= Number(meta.sizes[oldest]) || 0;
    delete meta.sizes[oldest];
    try { await cache.delete(oldest); } catch (_err) { /* ignore */ }
  }

  await writeImageMeta(cache, meta);
}
