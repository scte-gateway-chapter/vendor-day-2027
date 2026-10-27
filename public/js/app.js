// app.js — attendee shell bootstrap.
//
// Boot order:
//   1. Register the service worker and wire its lifecycle messages.
//   2. Capture `beforeinstallprompt` so the Welcome view (Task 7) can trigger it.
//   3. Load /api/config via initFirestore() so later Firestore reads work.
//   4. Mount the header + tab bar; register placeholder routes for every
//      area; register one real view (About & Install) that reads
//      appSettings/singleton.
//   5. Start the router.
"use strict";

// MUST stay first: `./polyfills.js` installs `crypto.randomUUID` on
// browsers that haven't shipped it yet. The OneSignal Web SDK v16
// constructor calls that method unconditionally during init, so the
// polyfill has to be in place before any other module (`onesignal.js`
// in particular) runs. ES-module import order within a file determines
// evaluation order, so leave this import above every other `import`.
import "./polyfills.js";

import * as router from "./router.js";
import * as ui from "./ui.js";
import { initFirestore, getDoc, onSnapshot } from "./firebase.js";
import { loadAppSettings, isSignInEnabled } from "./app-settings.js";
import { renderWelcome } from "./views/welcome.js";
import { renderHome } from "./views/home.js";
import { renderAgenda } from "./views/agenda.js";
import { renderAgendaDetail } from "./views/agenda-detail.js";
import { renderSponsors } from "./views/sponsors.js";
import { renderSponsorDetail } from "./views/sponsors-detail.js";
import { renderMap } from "./views/map.js";
import { renderAnnouncements } from "./views/announcements.js";
import { renderAttendees } from "./views/attendees.js";
import { renderAttendeeDetail } from "./views/attendees-detail.js";
import { renderFeedback } from "./views/feedback.js";
import { renderRecap } from "./views/recap.js";
import { renderSignIn } from "./views/signin.js";
import {
  initOneSignal,
  getSubscriptionState,
  requestPermissionAndSubscribe,
  addPermissionListener,
} from "./onesignal.js";
import { pushDebugLog, isDebugEnabled } from "./debug-log.js";
import { mountDebugOverlay } from "./debug-overlay.js";

/** Persistent flag — once the user taps "I'll do this later" we skip Welcome
 *  for every subsequent visit on this device. Cleared only by the user via
 *  site-data clear or private-mode. */
const WELCOME_DISMISS_KEY = "vendorday2027.welcome.dismissed";

/** Shared handle so views can `await` the one-time /api/config load. */
let firestoreReady = null;

/** Map a route path to the tab that should read as active while on it. */
const ROUTE_TO_TAB = {
  "#/": "home",
  "#/home": "home",
  "#/agenda": "agenda",
  "#/agenda/<id>": "agenda",
  "#/sponsors": "sponsors",
  "#/sponsors/<id>": "sponsors",
  "#/map": "map",
  "#/announcements": "more",
  "#/announcements/<id>": "more",
  "#/attendees": "more",
  "#/attendees/<id>": "more",
  "#/feedback": "more",
  "#/recap": "more",
  "#/sign-in": "more",
  "#/about-install": "more",
};

/* ----------------- Per-view cleanup registry ----------------- */

/** Views that spin up subscriptions, visibility listeners, or similar
 *  long-lived handles register a teardown here from their render function.
 *  The router.beforeEach hook drains this before dispatching the next route
 *  so background work (e.g., the Home view's 15-second agenda poll) stops
 *  the moment the user navigates away. One slot by design — a view that
 *  wires multiple handles should compose them into a single function. */
let pendingViewCleanup = null;

/**
 * Register (or clear) the current view's teardown. Called by view modules
 * from their render function. Passing a non-function clears the slot.
 * @param {() => void} fn
 */
export function registerViewCleanup(fn) {
  pendingViewCleanup = typeof fn === "function" ? fn : null;
}

function runPendingViewCleanup() {
  const fn = pendingViewCleanup;
  pendingViewCleanup = null;
  if (!fn) return;
  try {
    fn();
  } catch (err) {
    console.warn("[app] view cleanup failed:", err);
  }
}

/* ----------------- Placeholder view factory ----------------- */

/**
 * Render a minimal placeholder card into the view root. Views that land in
 * future tasks render themselves; this stays as a fallback until each one
 * ships so navigation remains functional today.
 * @param {string} sectionName
 * @param {string} taskLabel
 */
function placeholderView(sectionName, taskLabel) {
  return () =>
    ui.showView((root) => {
      const section = document.createElement("section");
      section.className = "placeholder-card";
      section.setAttribute("aria-live", "polite");
      const h = document.createElement("h2");
      h.textContent = sectionName;
      const p = document.createElement("p");
      p.textContent = `${sectionName} lands in ${taskLabel}. Shell wiring and navigation are live now.`;
      section.append(h, p);
      root.append(section);
      document.title = `${sectionName} \u2014 Vendor Day 2027`;
    });
}

/* ----------------- Welcome / Install (Task 7) ----------------- */

/**
 * `#/` handler. Three outcomes:
 *   1. localStorage dismiss flag is set  → navigate to #/home.
 *   2. The app is already installed (standalone)  → navigate to #/home.
 *   3. Otherwise, render the Welcome view and give it an `onDismiss`
 *      callback that writes the flag and routes to #/home.
 */
async function renderWelcomeRoute() {
  if (readWelcomeDismissed() || isStandaloneLaunch()) {
    router.navigate("/home");
    return;
  }
  await ui.showView(async (root) => {
    await renderWelcome(root, {
      onDismiss: () => {
        try {
          localStorage.setItem(WELCOME_DISMISS_KEY, "true");
        } catch (err) {
          // Private-mode Safari / blocked storage: non-fatal, the user will
          // just see Welcome again next time. Nothing else to do.
          console.warn("[app] welcome dismiss flag write failed:", err);
        }
        router.navigate("/home");
      },
    });
  });
}

function readWelcomeDismissed() {
  try {
    return localStorage.getItem(WELCOME_DISMISS_KEY) === "true";
  } catch (err) {
    return false;
  }
}

function isStandaloneLaunch() {
  return (
    window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
    window.navigator.standalone === true
  );
}

/* ----------------- About & Install (the one real view in Task 6) ----------------- */

/** Platform-specific install guidance. The Welcome view (Task 7) refines this. */
function detectPlatform() {
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)")?.matches ||
    window.navigator.standalone === true;
  return { isIOS, isAndroid, standalone };
}

async function renderAboutInstall() {
  await ui.showView(async (root) => {
    const h = document.createElement("h2");
    h.textContent = "About & Install";
    h.style.marginTop = "0";
    root.append(h);

    const eventCard = document.createElement("section");
    eventCard.className = "card";
    eventCard.setAttribute("aria-live", "polite");
    eventCard.innerHTML = `
      <h2>Event</h2>
      <div data-event-info>
        <p><strong>SCTE Gateway Chapter Vendor Day 2027</strong></p>
        <p>Doubletree Chesterfield, Chesterfield, MO 63005</p>
        <p>Date to be confirmed by the Gateway Chapter board.</p>
      </div>
    `;
    root.append(eventCard);

    // Best-effort Firestore read for the live event info. If the config
    // request or the doc read fails (empty seed, offline, misconfigured)
    // we leave the hard-coded placeholder text visible so this view never
    // renders blank.
    try {
      if (firestoreReady) await firestoreReady;
      const settings = await getDoc("appSettings/singleton");
      if (settings) {
        const target = eventCard.querySelector("[data-event-info]");
        const lines = [];
        if (settings.eventTitle) lines.push(`<p><strong>${escapeHtml(settings.eventTitle)}</strong></p>`);
        const place = [settings.venueName, settings.venueAddress].filter(Boolean).join(", ");
        if (place) lines.push(`<p>${escapeHtml(place)}</p>`);
        if (settings.eventDate) {
          lines.push(`<p>Date: ${escapeHtml(settings.eventDate)}</p>`);
        } else {
          lines.push(`<p>Date to be confirmed by the Gateway Chapter board.</p>`);
        }
        if (lines.length) target.innerHTML = lines.join("");
      }
    } catch (err) {
      console.warn("[about-install] appSettings read failed:", err);
    }

    const { isIOS, isAndroid, standalone } = detectPlatform();
    const install = document.createElement("section");
    install.className = "card";
    install.innerHTML = `<h2>How to install</h2>`;

    if (standalone) {
      install.insertAdjacentHTML(
        "beforeend",
        `<p>You're already running the installed app \u2014 nothing more to do.</p>`,
      );
    } else if (isIOS) {
      install.insertAdjacentHTML(
        "beforeend",
        `<p><strong>iOS Safari:</strong> tap the Share button, then choose <em>Add to Home Screen</em>.
         The app will appear on your home screen and launch like a native app.</p>
         <p>Push notifications on iOS 16.4+ require installing to the home screen first.</p>`,
      );
    } else if (isAndroid) {
      install.insertAdjacentHTML(
        "beforeend",
        `<p><strong>Android Chrome:</strong> when the install prompt appears, tap <em>Install</em>.
         If you don't see it, open Chrome's overflow menu and choose <em>Add to Home screen</em> / <em>Install app</em>.</p>`,
      );
    } else {
      install.insertAdjacentHTML(
        "beforeend",
        `<p>On desktop browsers the app runs in-browser; push notifications require a supporting browser.</p>
         <p>For the best experience, open this link on your phone and install from there.</p>`,
      );
    }

    root.append(install);

    // Notifications section (Task 25). Mounts a state-dependent control
    // (Enable button, or a muted status line) and re-renders when the
    // user's choice resolves or the OS-level permission changes while
    // the view is mounted. The section lives at the bottom so the event
    // + install content stays the primary read.
    const notifications = document.createElement("section");
    notifications.className = "card";
    notifications.setAttribute("aria-live", "polite");
    notifications.innerHTML = `<h2>Notifications</h2><div data-notifications-body></div>`;
    root.append(notifications);

    const body = notifications.querySelector("[data-notifications-body]");
    let rerenderInFlight = false;

    async function renderNotificationsBody() {
      // Guard against overlapping async renders from the listener + the
      // button handler racing each other.
      if (rerenderInFlight) return;
      rerenderInFlight = true;
      try {
        const state = await getSubscriptionState();
        body.innerHTML = "";
        if (state === "granted") {
          const p = document.createElement("p");
          p.textContent = "Notifications are enabled.";
          const note = document.createElement("p");
          note.textContent =
            "To stop receiving them, change notification settings in your device.";
          body.append(p, note);
        } else if (state === "denied") {
          const p = document.createElement("p");
          p.textContent = "Notifications are turned off.";
          const note = document.createElement("p");
          note.textContent =
            "To re-enable, change notification settings in your device. We cannot re-prompt from the app.";
          body.append(p, note);
        } else if (state === "ios-install-required") {
          const p = document.createElement("p");
          p.textContent =
            "Install this app to your home screen first to enable notifications.";
          const note = document.createElement("p");
          note.textContent =
            "Follow the Add to Home Screen steps above, then launch from the home-screen icon.";
          body.append(p, note);
        } else if (state === "unsupported") {
          const p = document.createElement("p");
          p.textContent = "Notifications aren't available in this browser.";
          body.append(p);
        } else {
          // state === "not-prompted"
          const p = document.createElement("p");
          p.textContent =
            "Get notified about schedule changes and announcements.";
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "btn-primary";
          btn.textContent = "Enable notifications";
          btn.addEventListener("click", async () => {
            btn.disabled = true;
            try {
              const result = await requestPermissionAndSubscribe();
              if (result === "granted") {
                ui.toast("success", "Notifications enabled.");
              } else if (result === "unsupported") {
                ui.toast(
                  "info",
                  "Notifications aren't available in this browser.",
                );
              }
            } catch (err) {
              console.warn("[about-install] enable notifications failed:", err);
              ui.toast("error", "Couldn't enable notifications. Try again.");
            } finally {
              btn.disabled = false;
              renderNotificationsBody();
            }
          });
          body.append(p, btn);
        }
      } finally {
        rerenderInFlight = false;
      }
    }

    // Register a permission listener so the section updates if the user
    // toggles permission in device settings and returns to this view.
    const unsubscribe = addPermissionListener(() => renderNotificationsBody());
    registerViewCleanup(() => {
      try { unsubscribe(); } catch (_err) { /* no-op */ }
    });

    renderNotificationsBody();

    document.title = "About & Install \u2014 Vendor Day 2027";
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/* ----------------- 404 fallback ----------------- */

function render404() {
  ui.showView((root) => {
    const section = document.createElement("section");
    section.className = "placeholder-card";
    section.innerHTML = `
      <h2>Page not found</h2>
      <p>We couldn't find that page.</p>
      <ul class="inline-link-list">
        <li><a href="#/">Back to Home</a></li>
        <li><a href="#/agenda">Open Agenda</a></li>
      </ul>
    `;
    root.append(section);
    document.title = "Page not found \u2014 Vendor Day 2027";
  });
}

/* ----------------- Service worker + install prompt wiring ----------------- */

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // Register on window.load so the attendee shell's first paint is not
  // blocked by the SW install step. The /sw.js file ships OneSignal's
  // push handler via importScripts, so this registration also wires up
  // push delivery for the installed PWA (see onesignal.js).
  const start = () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed:", err);
    });
  };
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });

  // iOS Safari fires the service worker's `activate` event on every PWA
  // launch, not only when a new SW version actually replaces the old one.
  // The SW posts `{ type: "sw-updated", buildId }` on each activate, so
  // we must gate the banner on an actual build-id change — otherwise
  // every launch flashes the update prompt.
  const LAST_SEEN_BUILD_KEY = "vendorday2027.lastSeenBuildId";
  navigator.serviceWorker.addEventListener("message", (ev) => {
    const data = ev && ev.data;
    if (!data || data.type !== "sw-updated") return;
    const incoming = typeof data.buildId === "string" ? data.buildId : "";
    if (!incoming) return;
    let lastKnown = "";
    try { lastKnown = localStorage.getItem(LAST_SEEN_BUILD_KEY) || ""; } catch (_err) { /* no-op */ }
    if (!lastKnown) {
      // First activation this device has seen — not a user-facing update.
      try { localStorage.setItem(LAST_SEEN_BUILD_KEY, incoming); } catch (_err) { /* no-op */ }
      return;
    }
    if (incoming === lastKnown) {
      // Same build id — iOS re-firing activate on launch. Silent.
      return;
    }
    // Genuinely new build. Record the id now so subsequent activates on
    // the same build don't re-show the banner, then surface it.
    try { localStorage.setItem(LAST_SEEN_BUILD_KEY, incoming); } catch (_err) { /* no-op */ }
    ui.showUpdateReadyBanner();
  });
}

function captureInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (ev) => {
    // Stash for the Welcome view (Task 7) and About & Install (Task 7 refines).
    ev.preventDefault?.();
    window.__deferredInstallPrompt = ev;
  });
}

/**
 * Last-chance safety net for promise rejections that escape a view's
 * local `.catch` / `try/catch`. We log at `warn` so admin diagnostics
 * surface the problem in devtools without spamming a user-facing toast
 * (per design section 13, failing fetches are already surfaced per-view
 * through `ui.toast` + the offline banner). The handler is additive —
 * views that already handle their own rejections are unaffected.
 */
function wireUnhandledRejection() {
  window.addEventListener("unhandledrejection", (ev) => {
    console.warn("[unhandledrejection]", ev.reason);
  });
}

function wireOnlineOffline() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    ui.showOfflineBanner();
  }
  window.addEventListener("online", () => ui.hideOfflineBanner());
  window.addEventListener("offline", () => ui.showOfflineBanner());
}

/* ----------------- Bootstrap ----------------- */

async function main() {
  // The debug overlay runs behind an explicit `?debug=1` gate. Logging
  // here is a no-op when the gate is off (see debug-log.js), so this
  // call site is safe to leave uninstrumented in production.
  pushDebugLog("boot", "app boot start");
  wireUnhandledRejection();
  registerServiceWorker();
  captureInstallPrompt();

  ui.renderHeader();
  ui.renderTabBar("home");
  wireOnlineOffline();

  // Register placeholder routes for every area called out in Task 6. Views
  // land in later tasks (Home in 8, etc). Welcome is the first real view
  // and owns `#/`.
  router.register("#/", renderWelcomeRoute);
  router.register("#/home", () => ui.showView((root) => renderHome(root)));
  router.register("#/agenda", () => ui.showView((root) => renderAgenda(root)));
  router.register("#/agenda/<id>", (params) =>
    ui.showView((root) => renderAgendaDetail(root, { id: params.id })),
  );
  router.register("#/sponsors", () => ui.showView((root) => renderSponsors(root)));
  router.register("#/sponsors/<id>", (params) =>
    ui.showView((root) => renderSponsorDetail(root, { id: params.id })),
  );
  router.register("#/map", () => ui.showView((root) => renderMap(root)));
  router.register("#/announcements", () =>
    ui.showView((root) => renderAnnouncements(root, {})),
  );
  router.register("#/announcements/<id>", (params) =>
    ui.showView((root) => renderAnnouncements(root, { highlightId: params.id })),
  );
  router.register("#/attendees", () => ui.showView((root) => renderAttendees(root)));
  router.register("#/attendees/<id>", (params) =>
    ui.showView((root) => renderAttendeeDetail(root, { id: params.id })),
  );
  router.register("#/feedback", () => ui.showView((root) => renderFeedback(root)));
  router.register("#/recap", () => ui.showView((root) => renderRecap(root)));
  router.register("#/sign-in", () => ui.showView((root) => renderSignIn(root)));
  router.register("#/about-install", renderAboutInstall);
  router.register("*", render404);

  // Drain any view-level teardown before the next route mounts so views that
  // subscribe to Firestore polls (e.g., Home's happening-now strip) stop
  // their background work when the user navigates elsewhere.
  router.beforeEach(() => runPendingViewCleanup());

  // After each navigation, update the active tab reflection. The router passes
  // the matched route pattern (not the raw hash) so ROUTE_TO_TAB keys line up.
  router.afterEach((ctx) => {
    const tab = ROUTE_TO_TAB[ctx.path] || null;
    if (tab) ui.setActiveTab(tab);
  });

  // Initialize Firestore config in the background. Views that need it await
  // `firestoreReady` to avoid racing the /api/config fetch.
  firestoreReady = initFirestore()
    .then((cfg) => {
      pushDebugLog("boot", "/api/config loaded", {
        keys: cfg ? Object.keys(cfg).sort() : [],
      });
      return cfg;
    })
    .catch((err) => {
      console.warn("[app] /api/config load failed \u2014 Firestore reads will error until this is resolved:", err);
      pushDebugLog("boot", "/api/config failed", String(err && err.message || err));
      ui.toast(
        "error",
        "Could not load app config. Some content may be unavailable.",
        { durationMs: 6000 },
      );
    });

  // Kick off the OneSignal SDK load on window.load so a slow CDN never
  // blocks first paint. The call is idempotent — any view that awaits
  // getSubscriptionState() will reuse the in-flight promise.
  if (document.readyState === "complete") {
    initOneSignal().catch((err) => console.warn("[app] initOneSignal failed:", err));
  } else {
    window.addEventListener(
      "load",
      () => {
        initOneSignal().catch((err) => console.warn("[app] initOneSignal failed:", err));
      },
      { once: true },
    );
  }

  // App-lifetime poll driving the More menu's Recap entry visibility.
  // Runs for the whole session (not registered with view cleanup) so the
  // menu reflects `recap.published` within ~60s of an admin flip even if
  // the user never navigates to #/recap. The Recap view itself still runs
  // its own 30s poll while it is mounted.
  startRecapMenuPoll();

  // One-shot prime of the shared appSettings cache so attendee surfaces
  // (Welcome CTA, Home quick-action, More menu entry, #/sign-in) can
  // consult `isSignInEnabled()` synchronously after boot. Unlike the
  // Recap entry we deliberately do NOT run a snapshot listener here —
  // the design pattern for appSettings is "next refresh" propagation
  // (see design section 16 → Admin gating). The More menu entry starts
  // hidden (fail-closed) and this call flips it on when appropriate.
  loadAppSettings()
    .then(() => {
      ui.setSignInMenuVisible(isSignInEnabled());
    })
    .catch(() => {
      // Fetch already surfaced its own warning; keep Sign-In hidden.
    });

  router.start();

  // Mount the on-device debug overlay last so it floats above every
  // other surface. Gated on `?debug=1` (or a sticky sessionStorage flag
  // from a prior visit); a no-op otherwise.
  if (isDebugEnabled()) {
    mountDebugOverlay();
  }
}

/* ----------------- App-lifetime recap-published poll ----------------- */

/** Unsubscribe handle for the app-lifetime recap-published poll. Kept at
 *  module scope so the beforeunload listener can clear it as a courtesy;
 *  the browser would reclaim the timer on page unload anyway. */
let __recapMenuUnsub = null;

function startRecapMenuPoll() {
  if (!firestoreReady) return;
  firestoreReady
    .then((config) => {
      // If /api/config failed (`config` undefined), onSnapshot's first
      // tick will throw inside firebase.js and the loop will retry on
      // every interval. We skip starting the poll in that case so we
      // don't flood the console with the same error every minute.
      if (!config) return;
      __recapMenuUnsub = onSnapshot(
        "recap/singleton",
        (data, err) => {
          if (err) {
            // Non-fatal: the Recap entry simply stays in its last-known
            // state until the next tick succeeds. A log is enough here
            // because the view-level poll surfaces the user-facing error
            // when the user visits #/recap directly.
            console.warn("[app] recap menu poll failed:", err);
            return;
          }
          ui.setRecapMenuVisible(data?.published === true);
        },
        { intervalMs: 60000 },
      );
    })
    .catch(() => { /* /api/config already surfaced its own toast above. */ });

  window.addEventListener("beforeunload", () => {
    if (__recapMenuUnsub) {
      try { __recapMenuUnsub(); } catch (_err) { /* page is leaving anyway */ }
      __recapMenuUnsub = null;
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
