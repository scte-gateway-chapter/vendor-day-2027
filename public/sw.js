// Scaffolded by Task 2; full strategy implemented in Task 26.
// The three cache name constants below carry a `__BUILD_ID__` token that
// scripts/build-sw.js replaces at build time with the Cloudflare BUILD_ID
// (or Date.now() locally). The actual install/activate/fetch logic lands
// in Task 26 — this file exists today so the attendee shell registers a
// service worker on first deploy and the production URL demonstrates the
// PWA plumbing works end-to-end.

const SHELL_CACHE = "shell-v1792586472387";
const CONTENT_CACHE = "content-v1792586472387";
const IMAGES_CACHE = "images-v1792586472387";

self.addEventListener("install", (event) => {
  // Full pre-cache of the app shell lands in Task 26. For now, take over
  // immediately so a new deploy's SW replaces the previous one without
  // forcing a hard refresh.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Full old-cache cleanup lands in Task 26. clients.claim() so this SW
  // controls open tabs as soon as it activates.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Intentionally empty — tiered caching (cache-first shell, network-first
  // content, cache-first images) is implemented in Task 26.
});
