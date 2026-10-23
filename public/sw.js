// Scaffolded by Task 2; full strategy implemented in Task 26.
// The three cache name constants below carry a `__BUILD_ID__` token that
// scripts/build-sw.js replaces at build time with the Cloudflare BUILD_ID
// (or Date.now() locally). The actual install/activate/fetch logic lands
// in Task 26 — this file exists today so the attendee shell registers a
// service worker on first deploy and the production URL demonstrates the
// PWA plumbing works end-to-end.
//
// We also importScripts OneSignal's hosted service worker code at the
// TOP of this file. This is OneSignal's recommended pattern when the
// site has its own service worker: use a single worker file (ours) that
// also runs OneSignal's push handling, instead of registering OneSignal's
// separate worker at the same scope — which would conflict and cause
// push events to silently drop. See `onesignal.js` for the matching
// `serviceWorkerPath` config that points OneSignal at this file.
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");

const SHELL_CACHE = "shell-v1792703591406";
const CONTENT_CACHE = "content-v1792703591406";
const IMAGES_CACHE = "images-v1792703591406";

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
  // Minimal "I am a real service worker" implementation until the
  // tiered caching strategy lands in Task 26. iOS 16.4+ requires the
  // fetch handler to actually call event.respondWith() for the site to
  // be classified as a PWA (not a bookmark); an empty listener fails
  // that check and installing to home screen produces a bookmark that
  // can't receive push notifications. This pass-through just delegates
  // to the network, which is identical functionally to not having a SW
  // but satisfies iOS's PWA eligibility probe.
  event.respondWith(fetch(event.request));
});
