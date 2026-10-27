// app-settings.js — shared one-shot read of `appSettings/singleton`.
//
// Admin-gated feature flags on the appSettings doc (today: `signInEnabled`)
// are consumed by several attendee surfaces (Welcome CTA, Home quick-
// action, More menu entry, the Sign-In route). The attendee app has no
// snapshot listener for appSettings — the design pattern is "read once
// per page load" (see design section 16 → Admin gating), so each surface
// used to re-fetch the same document. This module hoists that single
// read into one module-level cache that every surface can consume
// synchronously after `loadAppSettings()` resolves.
//
// Fail-closed semantics: when the fetch fails, the doc is missing, or
// `signInEnabled` is absent, `isSignInEnabled()` returns `false`. The
// admin flips the flag on explicitly via the admin Settings page.
"use strict";

import { initFirestore, getDoc } from "./firebase.js";
import { pushDebugLog } from "./debug-log.js";

/** @type {object | null} Last successful read of appSettings/singleton, or null. */
let cached = null;

/** @type {number | null} Epoch ms of the last successful (or failed) load.
 *  Exposed via `getAppSettingsCachedAt()` for the debug overlay's "cache
 *  age" line; otherwise unused by production code. */
let cachedAt = null;

/** @type {Promise<object | null> | null} In-flight (or resolved) load promise. */
let loadPromise = null;

/**
 * Fetch `appSettings/singleton` once per page load and prime the module
 * cache. Safe to call from multiple surfaces — the first call starts the
 * fetch; subsequent calls resolve against the same promise. On fetch
 * failure or a missing doc the cache stays `null` and callers that
 * check feature flags fall back to the fail-closed default.
 * @returns {Promise<object | null>}
 */
export function loadAppSettings() {
  if (loadPromise) return loadPromise;
  pushDebugLog("app-settings", "fetch start");
  loadPromise = (async () => {
    try {
      await initFirestore();
      const doc = await getDoc("appSettings/singleton");
      cached = doc && typeof doc === "object" ? doc : null;
      cachedAt = Date.now();
      pushDebugLog("app-settings", "fetch success", {
        hasDoc: Boolean(cached),
        signInEnabled: cached?.signInEnabled === true,
      });
      return cached;
    } catch (err) {
      console.warn("[app-settings] load failed:", err);
      cached = null;
      cachedAt = Date.now();
      pushDebugLog("app-settings", "fetch error", String(err && err.message || err));
      return null;
    }
  })();
  return loadPromise;
}

/**
 * Synchronous accessor for the primed cache. Returns `null` when
 * `loadAppSettings()` has not yet resolved or when the last load failed.
 * Callers that care about a specific flag should use the dedicated
 * accessor (e.g. `isSignInEnabled`) rather than reading `cached` fields
 * directly, so the fail-closed defaults stay centralized here.
 * @returns {object | null}
 */
export function getAppSettings() {
  return cached;
}

/**
 * Whether the admin has turned on the attendee Sign-In surfaces. Returns
 * `false` whenever the cache is empty or the field is missing / falsy —
 * sign-in stays hidden until an admin explicitly flips the toggle. This
 * is the "fail-closed" default enforced across the four attendee
 * surfaces (Welcome CTA, Home quick-action, More menu entry, and the
 * `#/sign-in` route itself).
 * @returns {boolean}
 */
export function isSignInEnabled() {
  return cached?.signInEnabled === true;
}

/**
 * Epoch-ms of the last `loadAppSettings()` resolution (success OR failure),
 * or `null` if the load hasn't finished yet. Used only by the debug
 * overlay's "cache age" row; production code should keep using
 * `isSignInEnabled()` and friends.
 * @returns {number | null}
 */
export function getAppSettingsCachedAt() {
  return cachedAt;
}
