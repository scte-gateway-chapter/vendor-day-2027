// onesignal.js — Task 12 STUB. Task 25 will replace the body of each
// exported function with the real OneSignal Web SDK integration (lazy
// script load, SDK init with ONESIGNAL_APP_ID, subscription register,
// permission change listener) while preserving these signatures and
// return shapes so the Announcements view does not have to change.
//
// For Task 12 we provide just enough surface area for the Announcements
// opt-in card to render the right variant and (on supported browsers)
// invoke the browser-level permission prompt directly, so the UX can be
// built and tested without pulling in a third-party SDK.
"use strict";

/**
 * Load the OneSignal Web SDK and call its init. Task 12 stub: no-op.
 * Task 25 replaces this with a dynamic `<script>` import of the SDK and
 * `OneSignal.init({ appId })`.
 * @returns {Promise<void>}
 */
export async function initOneSignal() {
  return;
}

/**
 * Report the current push-subscription state. Task 12 reads it from
 * `Notification.permission` plus a platform sniff; Task 25 will prefer
 * the OneSignal SDK's own state once the SDK is loaded, falling back to
 * the browser signal before the SDK finishes initializing.
 *
 * Returned values:
 *   - "unsupported"            — the browser has no Notification API, or
 *                                we're on a non-Safari iOS browser (iOS
 *                                Chrome/Firefox/Edge cannot do web push).
 *   - "ios-install-required"   — iOS Safari before Add-to-Home-Screen
 *                                (iOS 16.4+ requires the installed PWA).
 *   - "not-prompted"           — permission is `"default"` and we can
 *                                still call `requestPermission()`.
 *   - "denied"                 — user previously denied; cannot re-prompt.
 *   - "granted"                — permission already granted.
 *
 * @returns {Promise<"unsupported"|"ios-install-required"|"not-prompted"|"denied"|"granted">}
 */
export async function getSubscriptionState() {
  if (typeof Notification === "undefined") return "unsupported";

  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  // iOS Chrome/Firefox/Edge all ship with the Notification API shimmed but
  // cannot actually deliver web push even from an installed PWA.
  const isNonSafariIOS = isIOS && /CriOS|FxiOS|EdgiOS/.test(ua);
  if (isNonSafariIOS) return "unsupported";

  if (isIOS) {
    const standalone =
      (typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(display-mode: standalone)").matches === true) ||
      (typeof window !== "undefined" && window.navigator.standalone === true);
    if (!standalone) return "ios-install-required";
  }

  const perm = Notification.permission;
  if (perm === "granted") return "granted";
  if (perm === "denied") return "denied";
  return "not-prompted";
}

/**
 * Trigger the browser permission prompt and (in Task 25) register the
 * subscription with OneSignal. Returns the resolved permission string:
 *   - "granted" | "denied" | "default"
 *   - "ios-install-required" when the device needs the installed PWA first
 *   - "unsupported" when the browser cannot do web push
 *
 * Task 12 only calls `Notification.requestPermission()` directly; Task 25
 * will replace this with the OneSignal SDK's `requestPermission()` flow
 * and the resulting SDK subscription register call, keeping this
 * signature + the five-outcome contract above intact.
 *
 * @returns {Promise<"granted"|"denied"|"default"|"ios-install-required"|"unsupported">}
 */
export async function requestPermissionAndSubscribe() {
  const state = await getSubscriptionState();
  if (state === "unsupported") return "unsupported";
  if (state === "ios-install-required") return "ios-install-required";
  if (state === "granted" || state === "denied") return state;

  if (
    typeof Notification === "undefined" ||
    typeof Notification.requestPermission !== "function"
  ) {
    return "unsupported";
  }

  try {
    // Some older browsers only support the callback form of
    // requestPermission; Promise.resolve normalizes both.
    const result = await Promise.resolve(Notification.requestPermission());
    if (result === "granted" || result === "denied" || result === "default") {
      return result;
    }
    return "default";
  } catch (err) {
    console.warn("[onesignal] permission request failed:", err);
    return "denied";
  }
}

/**
 * Register a callback for permission-state changes. Task 12 stub returns
 * a no-op unsubscribe so view code can wire it today; Task 25 will listen
 * via `navigator.permissions.query({ name: "notifications" })` and / or
 * the OneSignal SDK's `addEventListener("permissionChange", ...)`.
 *
 * @param {(state: string) => void} _callback
 * @returns {() => void} unsubscribe
 */
export function addPermissionListener(_callback) {
  return () => {};
}
