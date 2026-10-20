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

import * as router from "./router.js";
import * as ui from "./ui.js";
import { initFirestore, getDoc } from "./firebase.js";

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
  "#/about-install": "more",
};

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
  navigator.serviceWorker.register("/sw.js").catch((err) => {
    console.warn("Service worker registration failed:", err);
  });
  navigator.serviceWorker.addEventListener("message", (ev) => {
    if (ev?.data?.type === "NEW_VERSION_ACTIVATED") {
      ui.showUpdateReadyBanner();
    }
  });
}

function captureInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (ev) => {
    // Stash for the Welcome view (Task 7) and About & Install (Task 7 refines).
    ev.preventDefault?.();
    window.__deferredInstallPrompt = ev;
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
  registerServiceWorker();
  captureInstallPrompt();

  ui.renderHeader();
  ui.renderTabBar("home");
  wireOnlineOffline();

  // Register placeholder routes for every area called out in Task 6. Views
  // land in later tasks (Welcome in 7, Home in 8, etc).
  router.register("#/", placeholderView("Home", "Task 8"));
  router.register("#/home", placeholderView("Home", "Task 8"));
  router.register("#/agenda", placeholderView("Agenda", "Task 9"));
  router.register("#/agenda/<id>", placeholderView("Agenda", "Task 9"));
  router.register("#/sponsors", placeholderView("Sponsors", "Task 10"));
  router.register("#/sponsors/<id>", placeholderView("Sponsors", "Task 10"));
  router.register("#/map", placeholderView("Venue Map", "Task 11"));
  router.register("#/announcements", placeholderView("Announcements", "Task 12"));
  router.register("#/announcements/<id>", placeholderView("Announcements", "Task 12"));
  router.register("#/attendees", placeholderView("Attendee Directory", "Task 13"));
  router.register("#/attendees/<id>", placeholderView("Attendee Directory", "Task 13"));
  router.register("#/feedback", placeholderView("Feedback", "Task 14"));
  router.register("#/recap", placeholderView("Recap", "Task 15"));
  router.register("#/about-install", renderAboutInstall);
  router.register("*", render404);

  // After each navigation, update the active tab reflection. The router passes
  // the matched route pattern (not the raw hash) so ROUTE_TO_TAB keys line up.
  router.afterEach((ctx) => {
    const tab = ROUTE_TO_TAB[ctx.path] || null;
    if (tab) ui.setActiveTab(tab);
  });

  // Initialize Firestore config in the background. Views that need it await
  // `firestoreReady` to avoid racing the /api/config fetch.
  firestoreReady = initFirestore().catch((err) => {
    console.warn("[app] /api/config load failed \u2014 Firestore reads will error until this is resolved:", err);
    ui.toast(
      "error",
      "Could not load app config. Some content may be unavailable.",
      { durationMs: 6000 },
    );
  });

  router.start();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
