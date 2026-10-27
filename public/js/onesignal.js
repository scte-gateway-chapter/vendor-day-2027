// onesignal.js — Task 25 real OneSignal Web SDK v16 integration.
//
// This file REPLACES the Task 12 stub. The module's public interface is
// unchanged — same exports, same signatures, same five-outcome contract
// on `getSubscriptionState()` and `requestPermissionAndSubscribe()` — so
// the Announcements view and About & Install view do not have to care
// that the body behind these calls is now the real SDK.
//
// Load strategy:
//   - The SDK is NOT bundled with the attendee shell. It is injected via
//     a dynamic <script> tag the first time anything in the app calls
//     `initOneSignal()`, keeping first paint on the Home / Welcome views
//     free of the OneSignal payload.
//   - `app.js` kicks `initOneSignal()` off from `window.load` so a slow
//     OneSignal CDN never blocks critical paint; views that await
//     `getSubscriptionState()` short-circuit on the platform state
//     (unsupported / ios-install-required / denied / default) before
//     touching the SDK, so they also don't block on it.
//
// Service worker:
//   - `/OneSignalSDKWorker.js` lives at the origin root (see that file).
//     We tell the SDK its path explicitly, same as the SDK's default,
//     for clarity.
//
// Config source:
//   - `oneSignalAppId` comes from `/api/config` via `initFirestore()` in
//     firebase.js (which is what the task's spec calls `getAppConfig`).
"use strict";

import { initFirestore } from "./firebase.js";
import { pushDebugLog } from "./debug-log.js";

const SDK_SRC = "https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js";

/** @type {Promise<void> | null} resolves once SDK is loaded + init'd (or we decide not to). */
let sdkReady = null;
/** @type {string | null} OneSignal app id from /api/config. */
let appIdCached = null;
/** @type {object | null} The `OneSignal` namespace once the SDK has initialized. */
let oneSignalNS = null;
/** True when `/api/config` has no `oneSignalAppId` (deploy misconfig) or
 *  SDK script failed to load. getSubscriptionState() will not surface
 *  "unsupported" for these — that's reserved for browser-capability
 *  gating per the Task 25 spec — but requestPermissionAndSubscribe()
 *  falls back to the native Notification.requestPermission() so the UI
 *  still has a sensible outcome. */
let sdkUnavailable = false;
/** Callbacks subscribed via `addPermissionListener`. One SDK-level
 *  permissionChange listener fans out to this set. */
const permissionListeners = new Set();

/* ---------------- Platform detection ---------------- */

function detectPlatform() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  // iOS Chrome/Firefox/Edge all shim Notification but cannot deliver web push.
  const isNonSafariIOS = isIOS && /CriOS|FxiOS|EdgiOS/.test(ua);
  const standalone =
    (typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches === true) ||
    (typeof window !== "undefined" && window.navigator.standalone === true);
  const hasNotification = typeof Notification !== "undefined";
  const hasServiceWorker =
    typeof navigator !== "undefined" && "serviceWorker" in navigator;
  return { isIOS, isNonSafariIOS, standalone, hasNotification, hasServiceWorker };
}

/**
 * Return the platform-level short-circuit state, or null if we need to
 * consult `Notification.permission` + the SDK.
 * @returns {"unsupported" | "ios-install-required" | null}
 */
function platformShortCircuit() {
  const p = detectPlatform();
  // iOS-specific checks come BEFORE the generic hasNotification probe.
  // iOS Safari exposes `window.Notification` inconsistently across versions —
  // some iOS 16.4+ builds have it only inside the installed PWA, not in the
  // Safari tab. Checking iOS install state first lets us tell the user
  // "install this app to receive notifications" instead of the less helpful
  // "notifications aren't available in this browser".
  if (p.isNonSafariIOS) return "unsupported";
  if (p.isIOS && !p.standalone) return "ios-install-required";
  if (!p.hasNotification) return "unsupported";
  return null;
}

/* ---------------- Init ---------------- */

/**
 * Lazy-load the OneSignal Web SDK and run its init. Idempotent — the
 * first call starts the work, subsequent calls return the same promise.
 * Resolves even on recoverable failures (missing app id, network error)
 * so callers can `await` without a try/catch; the module's internal
 * flags record the outcome and the public API returns the right state.
 * @returns {Promise<void>}
 */
export async function initOneSignal() {
  if (sdkReady) return sdkReady;
  pushDebugLog("onesignal", "init start");
  sdkReady = (async () => {
    // 1. Pull /api/config for the OneSignal app id. firebase.js caches
    //    this; subsequent callers share the same fetch.
    let config = null;
    try {
      config = await initFirestore();
    } catch (err) {
      console.warn("[onesignal] /api/config load failed:", err);
      pushDebugLog("onesignal", "init error (/api/config)", String(err && err.message || err));
      sdkUnavailable = true;
      return;
    }
    appIdCached = (config && typeof config.oneSignalAppId === "string") ? config.oneSignalAppId : "";
    if (!appIdCached) {
      // Deploy misconfiguration — no OneSignal app id. Leave the module
      // in sdkUnavailable so requestPermissionAndSubscribe falls back
      // to the native prompt rather than loading an unconfigured SDK.
      console.warn("[onesignal] /api/config returned no oneSignalAppId; skipping SDK load");
      pushDebugLog("onesignal", "init skipped: no oneSignalAppId");
      sdkUnavailable = true;
      return;
    }

    // 2. Skip the SDK on browsers that can't do web push at all. The
    //    module still handles state queries via Notification.permission
    //    where available.
    const p = detectPlatform();
    if (!p.hasNotification || !p.hasServiceWorker) {
      pushDebugLog("onesignal", "init skipped: browser lacks push capability", {
        hasNotification: p.hasNotification,
        hasServiceWorker: p.hasServiceWorker,
      });
      sdkUnavailable = true;
      return;
    }

    // 3. Inject the OneSignal SDK <script>. `defer` keeps it out of the
    //    critical paint path.
    const scriptEl = document.createElement("script");
    scriptEl.src = SDK_SRC;
    scriptEl.defer = true;
    const loaded = new Promise((resolve, reject) => {
      scriptEl.onload = () => resolve();
      scriptEl.onerror = () => reject(new Error("OneSignal SDK failed to load"));
    });
    document.head.appendChild(scriptEl);
    try {
      await loaded;
    } catch (err) {
      console.warn("[onesignal] SDK script load failed:", err);
      pushDebugLog("onesignal", "SDK script load failed", String(err && err.message || err));
      sdkUnavailable = true;
      return;
    }

    // 4. The SDK executes functions pushed to OneSignalDeferred once it
    //    is ready. Push an init function and a resolver function so we
    //    know when init has finished.
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    const initDone = new Promise((resolve) => {
      window.OneSignalDeferred.push(async function (OneSignal) {
        try {
          await OneSignal.init({
            appId: appIdCached,
            // Our main service worker (/sw.js) also runs OneSignal's push
            // handling code via `importScripts` at the top of that file.
            // Pointing OneSignal at /sw.js here (instead of registering a
            // second worker at /OneSignalSDKWorker.js) avoids a scope
            // conflict with our main worker that was silently dropping
            // push events.
            serviceWorkerPath: "sw.js",
            serviceWorkerParam: { scope: "/" },
            notifyButton: { enable: false }, // We render our own opt-in UI.
            allowLocalhostAsSecureOrigin: true, // Dev convenience; harmless in prod.
          });
          // Fan the SDK's permission-change event out to any listeners
          // the UI registered via addPermissionListener.
          try {
            OneSignal.Notifications.addEventListener("permissionChange", onSdkPermissionChange);
          } catch (err) {
            console.warn("[onesignal] permissionChange listener wire-up failed:", err);
          }
          pushDebugLog("onesignal", "init success");
        } catch (err) {
          console.warn("[onesignal] OneSignal.init failed:", err);
          pushDebugLog("onesignal", "OneSignal.init failed", String(err && err.message || err));
        } finally {
          oneSignalNS = OneSignal;
          resolve();
        }
      });
    });
    await initDone;
  })();
  return sdkReady;
}

/**
 * SDK-side permissionChange handler. Re-queries our normalized state and
 * dispatches to every registered listener. Errors in individual callbacks
 * are swallowed so one bad consumer can't break the fan-out.
 */
async function onSdkPermissionChange() {
  let state;
  try {
    state = await getSubscriptionState();
  } catch (err) {
    console.warn("[onesignal] permissionChange state query failed:", err);
    pushDebugLog("onesignal", "permissionChange state query failed", String(err && err.message || err));
    return;
  }
  pushDebugLog("onesignal", "permissionChange", { state });
  for (const cb of permissionListeners) {
    try {
      cb(state);
    } catch (_err) {
      // Deliberately swallowed — see note above.
    }
  }
}

/* ---------------- State query ---------------- */

/**
 * Report the current normalized push-subscription state. Precedence:
 *   1. Browser-level `unsupported` or iOS `ios-install-required` short-circuits.
 *   2. `Notification.permission === "denied"` → `"denied"`.
 *   3. `Notification.permission === "default"` → `"not-prompted"`.
 *   4. `Notification.permission === "granted"` + OneSignal subscribed → `"granted"`.
 *   5. `Notification.permission === "granted"` + NOT subscribed → `"not-prompted"`
 *      (the user granted the OS permission but the OneSignal subscription
 *      hasn't completed; the next prompt completes it).
 *
 * The SDK is loaded lazily in the background. When permission is `"denied"`
 * or `"default"` we return without awaiting the SDK so the Announcements
 * opt-in card can render promptly even on a slow CDN. When permission is
 * `"granted"` we await the SDK so we can read `User.PushSubscription.optedIn`.
 *
 * @returns {Promise<"unsupported"|"ios-install-required"|"not-prompted"|"denied"|"granted">}
 */
export async function getSubscriptionState() {
  const short = platformShortCircuit();
  if (short) return short;

  // Kick off init in the background without awaiting it for the simple
  // branches. If init is already in flight, this is a no-op.
  if (!sdkReady) initOneSignal();

  const perm = Notification.permission;
  if (perm === "denied") return "denied";
  if (perm === "default") return "not-prompted";

  // perm === "granted" — the OS has granted notification permission.
  // Try to confirm with OneSignal that the subscription is also
  // registered, but if the SDK is unavailable (offline, blocked, slow
  // CDN), trust the OS-level grant rather than downgrading to
  // "not-prompted". Downgrading would show the Enable button when the
  // user already has notifications on, which is confusing and would
  // let them re-trigger a prompt the browser won't display anyway.
  try {
    await sdkReady;
  } catch (_err) {
    /* non-fatal; falls through to the grant-trusting return below */
  }
  if (sdkUnavailable || !oneSignalNS) return "granted";
  try {
    const sub = oneSignalNS.User && oneSignalNS.User.PushSubscription;
    // Only downgrade to "not-prompted" if we have definitive SDK
    // evidence that the subscription wasn't actually registered.
    // Otherwise the OS grant is sufficient.
    if (sub && sub.optedIn === false) return "not-prompted";
    return "granted";
  } catch (_err) {
    return "granted";
  }
}

/* ---------------- Request permission + subscribe ---------------- */

/**
 * Register (or re-register) this browser's push subscription with
 * OneSignal. Terminal states short-circuit without acting; the only
 * state that invokes the SDK is `"not-prompted"`.
 *
 * Implementation note (bug fix, 2026-10-28): this previously called
 * `OneSignal.Notifications.requestPermission()`, which per the Web SDK
 * v16 reference only requests OS-level notification permission — it
 * does NOT create or restore the OneSignal push subscription. On a
 * device whose OneSignal `optedIn` flag was `false` (e.g., a previous
 * SDK run marked the subscription unsubscribed, or the device had a
 * stale push token after a factory reset), tapping "Enable" produced
 * no OS prompt (permission was already granted) and no subscription
 * change, leaving the dashboard showing "Unsubscribed". We now call
 * `OneSignal.User.PushSubscription.optIn()` explicitly, which per the
 * same v16 reference either (a) sets the subscription status to
 * subscribed when a valid push token exists, or (b) attempts to show
 * the OS permission prompt when it doesn't — a single
 * gesture-preserving call that handles both the first-time grant and
 * the re-subscribe-after-optOut paths. The iOS 16.4+ gesture concern
 * that motivated the previous implementation is still satisfied because
 * `optIn()` combines the OS prompt and the subscription registration
 * into one SDK method call.
 *
 * After the SDK call resolves, we re-query `getSubscriptionState()` and
 * return that so the Announcements opt-in card can branch on the same
 * five-state enum it uses everywhere else.
 *
 * Fallback: if the SDK is unavailable (missing app id, script load
 * failed) but `Notification.requestPermission` exists, we call it
 * directly so the user at least sees the native prompt. The push won't
 * actually be delivered without OneSignal, but the UI's "Enable" button
 * still gives a sensible outcome rather than silently doing nothing.
 *
 * @returns {Promise<"granted"|"denied"|"default"|"ios-install-required"|"unsupported">}
 */
export async function requestPermissionAndSubscribe() {
  const state = await getSubscriptionState();
  if (
    state === "unsupported" ||
    state === "ios-install-required" ||
    state === "denied" ||
    state === "granted"
  ) {
    return state;
  }

  // state === "not-prompted". Await SDK readiness first; init is kicked
  // off by app.js on window.load so it should already be settled by the
  // time the user taps Enable, but defend against a slow CDN.
  if (!sdkReady) initOneSignal();
  try {
    await Promise.race([
      sdkReady,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("SDK init timeout")), 5000),
      ),
    ]);
  } catch (_err) {
    /* non-fatal; try the native fallback below */
  }

  if (
    !sdkUnavailable &&
    oneSignalNS &&
    oneSignalNS.User &&
    oneSignalNS.User.PushSubscription &&
    typeof oneSignalNS.User.PushSubscription.optIn === "function"
  ) {
    pushDebugLog("onesignal", "subscribe start (optIn)");
    try {
      await oneSignalNS.User.PushSubscription.optIn();
      pushDebugLog("onesignal", "subscribe success (optIn resolved)");
    } catch (err) {
      console.warn("[onesignal] PushSubscription.optIn failed:", err);
      pushDebugLog("onesignal", "subscribe error", String(err && err.message || err));
    }
    const after = await getSubscriptionState();
    pushDebugLog("onesignal", "subscribe final state", { state: after });
    return after;
  }

  // SDK unavailable (deploy misconfig or script failed to load). Fall
  // back to the native prompt so the UI still has a definitive outcome,
  // even though the subscription won't register on OneSignal's side.
  if (typeof Notification === "undefined" || typeof Notification.requestPermission !== "function") {
    return "unsupported";
  }
  try {
    const result = await Promise.resolve(Notification.requestPermission());
    if (result === "granted" || result === "denied" || result === "default") {
      return result;
    }
    return "default";
  } catch (err) {
    console.warn("[onesignal] native requestPermission fallback failed:", err);
    return "denied";
  }
}

/* ---------------- Unsubscribe ---------------- */

/**
 * Opt the current browser out of OneSignal push notifications. This is
 * the ONLY path in the attendee shell that calls `optOut()` — intended
 * exclusively for a user-initiated "Turn off notifications" affordance.
 * The OS-level permission state is left untouched; the user can later
 * re-enable via the same opt-in flow without re-granting permission.
 *
 * Resolves with the normalized subscription state after the opt-out, so
 * callers can rerender off the same five-state enum they use elsewhere.
 *
 * @returns {Promise<"granted"|"denied"|"default"|"ios-install-required"|"unsupported"|"not-prompted">}
 */
export async function unsubscribeFromPush() {
  if (!sdkReady) initOneSignal();
  try {
    await Promise.race([
      sdkReady,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("SDK init timeout")), 5000),
      ),
    ]);
  } catch (_err) {
    /* non-fatal; the state query below still returns something sensible */
  }
  if (
    !sdkUnavailable &&
    oneSignalNS &&
    oneSignalNS.User &&
    oneSignalNS.User.PushSubscription &&
    typeof oneSignalNS.User.PushSubscription.optOut === "function"
  ) {
    pushDebugLog("onesignal", "unsubscribe start (optOut)");
    try {
      await oneSignalNS.User.PushSubscription.optOut();
      pushDebugLog("onesignal", "unsubscribe success (optOut resolved)");
    } catch (err) {
      console.warn("[onesignal] PushSubscription.optOut failed:", err);
      pushDebugLog("onesignal", "unsubscribe error", String(err && err.message || err));
    }
  }
  const after = await getSubscriptionState();
  pushDebugLog("onesignal", "unsubscribe final state", { state: after });
  return after;
}

/* ---------------- Listeners ---------------- */

/**
 * Register a callback invoked whenever the normalized push-permission
 * state changes (e.g., user re-enables OS-level permission and returns
 * to the app, or completes the SDK subscription after granting). The
 * callback receives the same five-state enum as `getSubscriptionState()`.
 *
 * Returns an unsubscribe function. Non-function callbacks are ignored
 * and return a no-op unsubscribe.
 *
 * @param {(state: string) => void} callback
 * @returns {() => void} unsubscribe
 */
export function addPermissionListener(callback) {
  if (typeof callback !== "function") return () => {};
  permissionListeners.add(callback);
  return () => {
    permissionListeners.delete(callback);
  };
}
