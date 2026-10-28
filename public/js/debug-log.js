// debug-log.js — in-memory ring buffer for the on-device debug overlay.
//
// This module is a no-op in production: callers invoke `pushDebugLog` at
// instrumentation points scattered across the app shell, but nothing is
// retained unless the overlay is explicitly enabled via `?debug=1` on
// the URL, a `#debug=1` hash fragment, or a prior localStorage write
// (either from a previous `?debug=1` visit or from the overlay dismiss
// button flipping it off). localStorage (not sessionStorage) is used so
// the flag survives the Safari-tab → installed-PWA transition on iOS:
// on that platform the two contexts have separate sessionStorage but
// share localStorage per-origin.
// The gate lives here (rather than at each call site) so instrumentation
// stays readable: `pushDebugLog("boot", "app boot start")` at a hook
// point costs zero bytes of memory when debug is off.
//
// The overlay (public/js/debug-overlay.js) imports `subscribeToDebugLog`
// to re-render its events feed, `getDebugLog` to seed the first paint,
// `isDebugEnabled` to decide whether to mount at all, and
// `getDebugActivationSource` to log how the overlay got turned on. The
// hook-site modules (app.js, onesignal.js, app-settings.js, and
// views/announcements.js) only need `pushDebugLog` and `isDebugEnabled`.
"use strict";

const BUFFER_MAX = 50;
const STORAGE_KEY = "vendorday2027.debug";
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
/** @type {"url" | "localStorage" | "none"} */
let activationSource = "none";

/**
 * Reads `?debug=1` / `?debug=0` (or the same keys off the URL hash) out
 * of the current URL and syncs the localStorage flag accordingly, then
 * returns whether the overlay should be considered active. Called from
 * the boot path in app.js and from every `pushDebugLog` invocation
 * (cheap after the first).
 *
 * @returns {boolean}
 */
export function isDebugEnabled() {
  if (cachedEnabled !== null) return cachedEnabled;
  cachedEnabled = computeDebugEnabled();
  return cachedEnabled;
}

/**
 * Returns which input turned the overlay on for the current page load:
 *   - "url"          — the URL carried `?debug=1` or `#debug=1`.
 *   - "localStorage" — a prior visit (or the install-time Safari tab)
 *                      wrote `"on"` to localStorage.
 *   - "none"         — the overlay is not active.
 * Only meaningful after `isDebugEnabled()` has been called at least
 * once (which the overlay guarantees before reading this).
 * @returns {"url" | "localStorage" | "none"}
 */
export function getDebugActivationSource() {
  if (cachedEnabled === null) isDebugEnabled();
  return activationSource;
}

/**
 * Explicit setter so the overlay's dismiss button can turn the flag off
 * without reloading. Writes the localStorage marker and busts the
 * cache so subsequent `pushDebugLog` calls short-circuit immediately.
 * @param {boolean} on
 */
export function setDebugEnabled(on) {
  cachedEnabled = Boolean(on);
  activationSource = on ? activationSource || "localStorage" : "none";
  try {
    if (on) localStorage.setItem(STORAGE_KEY, "on");
    else localStorage.setItem(STORAGE_KEY, "off");
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
  // 1. URL — `?debug=1` or `#debug=1` turns the flag on; `?debug=0` /
  //    `#debug=0` turns it off and clears the localStorage marker (the
  //    overlay also offers a dismiss button that goes through
  //    setDebugEnabled). The query string wins over the hash.
  const fromUrl = readDebugFromUrl();

  if (fromUrl === true) {
    writeStoredFlag("on");
    activationSource = "url";
    return true;
  }
  if (fromUrl === false) {
    writeStoredFlag("off");
    activationSource = "none";
    return false;
  }

  // 2. localStorage — makes the overlay sticky across page loads AND
  //    across the Safari-tab → installed-PWA transition on iOS, which
  //    is the whole reason we're on localStorage instead of
  //    sessionStorage. The flag was written by a prior `?debug=1`
  //    visit (step 1 above) or by `setDebugEnabled(true)` elsewhere.
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "on") {
      activationSource = "localStorage";
      return true;
    }
  } catch (_err) {
    // Private-mode Safari / blocked storage: treat as off.
  }
  activationSource = "none";
  return false;
}

/** Parse `debug=…` out of the URL query string, then the hash fragment.
 *  Returns true/false if the value was recognised, null if absent. */
function readDebugFromUrl() {
  try {
    if (typeof window === "undefined" || !window.location) return null;
    const fromQuery = parseDebugParam(window.location.search || "");
    if (fromQuery !== null) return fromQuery;
    // The hash can look like `#debug=1`, `#/route?debug=1`, or
    // `#foo&debug=1`. Normalise to the substring after `?` if present,
    // otherwise everything after the leading `#`.
    const hash = window.location.hash || "";
    const stripped = hash.replace(/^#/, "");
    if (!stripped) return null;
    const qIdx = stripped.indexOf("?");
    const hashQs = qIdx >= 0 ? stripped.slice(qIdx + 1) : stripped;
    return parseDebugParam(hashQs);
  } catch (_err) {
    // Malformed URL / SSR context — fall through.
    return null;
  }
}

/** @returns {boolean | null} */
function parseDebugParam(queryLike) {
  try {
    const params = new URLSearchParams(queryLike);
    const raw = params.get(QUERY_KEY);
    if (raw === "1" || raw === "true" || raw === "on") return true;
    if (raw === "0" || raw === "false" || raw === "off") return false;
  } catch (_err) { /* malformed — treat as absent */ }
  return null;
}

function writeStoredFlag(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch (_err) { /* storage blocked */ }
}
