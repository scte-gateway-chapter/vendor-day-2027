// polyfills.js — browser-compat shims the app shell depends on at boot.
//
// Scope is deliberately tight: ONE polyfill, `crypto.randomUUID`, because
// the OneSignal Web SDK v16 constructor calls it unconditionally during
// init and throws `TypeError: crypto.randomUUID is not a function` on
// browsers that haven't shipped the Web Crypto method yet. Field testing
// on a factory-reset Motorola Android (Chrome) during Task 25 iteration
// confirmed this failure mode — the debug overlay surfaced it in the
// `onesignal.OneSignal.init failed` event. The polyfill is RFC 4122
// version 4, backed by `crypto.getRandomValues`, which has been
// universally available in HTTPS contexts since ~2015.
//
// This module runs for its SIDE EFFECTS. Importing it is sufficient; the
// exported `applyPolyfills()` function is provided so a caller that
// wants an explicit entry point (or an unambiguous unit-test seam) can
// call it directly. A near-identical inline copy of the same logic
// lives at the top of `public/sw.js` because the service worker is a
// separate JS context with its own `globalThis` and cannot share this
// module.
"use strict";

import { pushDebugLog } from "./debug-log.js";

/**
 * Install `crypto.randomUUID` if the host browser hasn't shipped it
 * natively. Returns `true` when the polyfill was installed, `false`
 * when the native method was already present — the debug overlay logs
 * this so a given device can confirm which path ran.
 * @returns {boolean}
 */
export function applyPolyfills() {
  let randomUUIDApplied = false;
  if (
    typeof globalThis.crypto?.getRandomValues === "function" &&
    typeof globalThis.crypto.randomUUID !== "function"
  ) {
    globalThis.crypto.randomUUID = function randomUUID() {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      // Per RFC 4122 §4.4
      bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
      const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    };
    randomUUIDApplied = true;
  }
  return randomUUIDApplied;
}

// Run on module evaluation. app.js imports this file at the top so the
// polyfill is installed before any OneSignal-related code runs. The
// debug log entry is a no-op when the overlay isn't enabled.
const randomUUIDApplied = applyPolyfills();
pushDebugLog("polyfills", "applied", { randomUUID: randomUUIDApplied });
