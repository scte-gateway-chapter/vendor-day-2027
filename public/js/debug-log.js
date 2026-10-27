// debug-log.js — in-memory ring buffer for the on-device debug overlay.
//
// This module is a no-op in production: callers invoke `pushDebugLog` at
// instrumentation points scattered across the app shell, but nothing is
// retained unless the overlay is explicitly enabled via `?debug=1` on
// the URL or a prior sessionStorage write by the overlay dismiss button.
// The gate lives here (rather than at each call site) so instrumentation
// stays readable: `pushDebugLog("boot", "app boot start")` at a hook
// point costs zero bytes of memory when debug is off.
//
// The overlay (public/js/debug-overlay.js) imports `subscribeToDebugLog`
// to re-render its events feed, `getDebugLog` to seed the first paint,
// and `isDebugEnabled` to decide whether to mount at all. The three
// hook-site modules (app.js, onesignal.js, app-settings.js, and
// views/announcements.js) only need `pushDebugLog` and `isDebugEnabled`.
"use strict";

const BUFFER_MAX = 50;
const SESSION_KEY = "vendorday2027.debug";
const QUERY_KEY = "debug";

/** @type {Array<{ ts: number, category: string, message: string, data: unknown }>} */
const buffer = [];
/** @type {Set<(entry: object) => void>} */
const listeners = new Set();

/** Cached boolean for `isDebugEnabled()` after the first call so repeated
 *  hook-site invocations don't re-parse the URL on every push. The cache
 *  is primed by the first call and refreshed any time `setDebugEnabled`
 *  flips it (the overlay toggles it via that path on dismiss). */
let cachedEnabled = null;

/**
 * Reads `?debug=1` / `?debug=0` out of the current URL and syncs the
 * sessionStorage flag accordingly, then returns whether the overlay
 * should be considered active. Called from the boot path in app.js and
 * from every `pushDebugLog` invocation (cheap after the first).
 *
 * @returns {boolean}
 */
export function isDebugEnabled() {
  if (cachedEnabled !== null) return cachedEnabled;
  cachedEnabled = computeDebugEnabled();
  return cachedEnabled;
}

/**
 * Explicit setter so the overlay's dismiss button can turn the flag off
 * without reloading. Writes the sessionStorage marker and busts the
 * cache so subsequent `pushDebugLog` calls short-circuit immediately.
 * @param {boolean} on
 */
export function setDebugEnabled(on) {
  cachedEnabled = Boolean(on);
  try {
    if (on) sessionStorage.setItem(SESSION_KEY, "on");
    else sessionStorage.setItem(SESSION_KEY, "off");
  } catch (_err) {
    // Private-mode Safari / blocked storage: non-fatal. The cache still
    // reflects the requested value for the lifetime of the page.
  }
}

/**
 * Returns a shallow copy of the current ring buffer, newest LAST.
 * The overlay renders newest-first by reversing on display rather than
 * on storage so FIFO eviction stays trivial.
 * @returns {Array<{ ts: number, category: string, message: string, data: unknown }>}
 */
export function getDebugLog() {
  return buffer.slice();
}

/**
 * Register a listener invoked every time a new entry is appended.
 * Returns an unsubscribe function. Listener errors are swallowed so one
 * bad consumer can't break fan-out.
 * @param {(entry: object) => void} fn
 * @returns {() => void}
 */
export function subscribeToDebugLog(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Append a diagnostic entry to the ring buffer. No-op when the overlay
 * is disabled so instrumentation at hot paths doesn't allocate.
 * @param {string} category  short tag ("boot", "onesignal", "app-settings", "signin", ...)
 * @param {string} message   human-readable one-liner
 * @param {unknown} [data]   optional structured payload (shallow-cloned-ish via JSON.stringify in the overlay)
 */
export function pushDebugLog(category, message, data) {
  if (!isDebugEnabled()) return;
  const entry = {
    ts: Date.now(),
    category: String(category || "misc"),
    message: String(message || ""),
    data: data === undefined ? null : data,
  };
  buffer.push(entry);
  // FIFO eviction: oldest first. Keeping ~50 entries is plenty for the
  // overlay's "last 20 events" view with headroom for events logged
  // before the user expands the panel.
  while (buffer.length > BUFFER_MAX) buffer.shift();
  for (const cb of listeners) {
    try {
      cb(entry);
    } catch (_err) {
      // Deliberately swallowed — see note above.
    }
  }
}

/* ---------------- Internal ---------------- */

function computeDebugEnabled() {
  // 1. URL query string. `?debug=1` turns the flag on; `?debug=0` turns
  //    it off and clears the sessionStorage marker (the overlay also
  //    offers a dismiss button that goes through setDebugEnabled).
  let fromQuery = null;
  try {
    if (typeof window !== "undefined" && window.location) {
      const params = new URLSearchParams(window.location.search || "");
      const raw = params.get(QUERY_KEY);
      if (raw === "1" || raw === "true" || raw === "on") fromQuery = true;
      else if (raw === "0" || raw === "false" || raw === "off") fromQuery = false;
    }
  } catch (_err) {
    // Malformed URL / SSR context — fall through to sessionStorage.
  }

  if (fromQuery === true) {
    try { sessionStorage.setItem(SESSION_KEY, "on"); } catch (_err) { /* storage blocked */ }
    return true;
  }
  if (fromQuery === false) {
    try { sessionStorage.setItem(SESSION_KEY, "off"); } catch (_err) { /* storage blocked */ }
    return false;
  }

  // 2. sessionStorage — makes the overlay sticky across hashchange
  //    navigations within the same tab without putting `?debug=1` on
  //    every link.
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored === "on") return true;
  } catch (_err) {
    // Private-mode Safari / blocked storage: treat as off.
  }
  return false;
}
