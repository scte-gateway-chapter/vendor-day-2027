// OneSignalSDKWorker.js — OneSignal Web SDK v16 service worker (Task 25).
//
// OneSignal requires its push service worker to be served at the exact
// origin root path `/OneSignalSDKWorker.js` so it can register with the
// browser's root scope. The simplest reliable approach is to delegate to
// OneSignal's hosted implementation via importScripts — that way SDK
// updates (bug fixes, protocol changes) ship from the CDN without us
// touching a byte in this repo.
//
// This worker coexists with the app's own `/sw.js` (navigation + caching).
// The two workers do not conflict: this one handles push + notification
// events only, and OneSignal's SDK registers it explicitly against its
// own scope.
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
