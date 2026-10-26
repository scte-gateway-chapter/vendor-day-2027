// admin.js — admin shell bootstrap (Task 16, Task 17).
//
// Owns the tiny hash router inside /admin/, the pre-paint guard that
// bounces direct links to protected hashes through the login screen, the
// logout button handler, and the <body>-level class that hides the
// left-rail nav + logout button when the user is not authenticated.
//
// Task 17 wires the real Dashboard view and adds a per-view cleanup
// registry (registerAdminViewCleanup / router.beforeEach drain) so the
// dashboard's health poll and card refresh intervals stop the moment the
// user navigates away. Tasks 18-24 replace the remaining placeholder
// routes with real editor views and reuse the same cleanup hook.
"use strict";

import * as router from "/js/router.js";
import { injectViewHeading } from "/js/ui.js";
import { isAdminAuthenticated, clearAdminSession } from "./admin-auth.js";
import renderAdminLogin from "./login.js";
import renderAdminDashboard from "./dashboard.js";
import renderAgendaEditor from "./agenda-editor.js";
import renderSponsorsEditor from "./sponsors-editor.js";
import renderMapUploader from "./map-uploader.js";
import renderAnnouncementsComposer from "./announcements-composer.js";
import renderAttendeesImporter from "./attendees-importer.js";
import renderFeedbackEditor from "./feedback-editor.js";
import renderRecapEditor from "./recap-editor.js";

const UNAUTH_CLASS = "admin-shell--unauthenticated";

/** Protected routes mapped to their placeholder label + the task that
 *  replaces each placeholder with a real editor. The route list stays
 *  stable across tasks so navigation keeps working. Dashboard and Agenda
 *  are special-cased in registerRoutes() to call their real renderers;
 *  the rest fall through to the placeholder renderer until their task
 *  lands. */
const PROTECTED_ROUTES = [
  { slug: "dashboard", label: "Admin Dashboard", taskLabel: "Task 17" },
  { slug: "agenda", label: "Admin Agenda", taskLabel: "Task 18" },
  { slug: "sponsors", label: "Admin Sponsors", taskLabel: "Task 19" },
  { slug: "map", label: "Admin Venue Map", taskLabel: "Task 20" },
  { slug: "announcements", label: "Admin Announcements", taskLabel: "Task 21" },
  { slug: "attendees", label: "Admin Attendees", taskLabel: "Task 22" },
  { slug: "feedback", label: "Admin Feedback", taskLabel: "Task 23" }, // replaced by renderFeedbackEditor below
  { slug: "recap", label: "Admin Recap", taskLabel: "Task 24" }, // replaced by renderRecapEditor below
  { slug: "settings", label: "Admin Settings", taskLabel: "a later task" },
];

/* ----------------- Per-view cleanup registry ----------------- */

/** Views that spin up subscriptions, intervals, or visibility listeners
 *  register a teardown here from their render function. The router's
 *  beforeEach hook drains this before dispatching the next route so
 *  background work (health check loop, 30s card poll) stops the moment
 *  the user navigates away. One slot by design — views that wire
 *  multiple handles should compose them into a single function. */
let pendingAdminViewCleanup = null;

/**
 * Register (or clear) the current admin view's teardown. Called from a
 * view's render function. Passing a non-function clears the slot.
 * @param {() => void} fn
 */
export function registerAdminViewCleanup(fn) {
  pendingAdminViewCleanup = typeof fn === "function" ? fn : null;
}

function runPendingAdminViewCleanup() {
  const fn = pendingAdminViewCleanup;
  pendingAdminViewCleanup = null;
  if (!fn) return;
  try {
    fn();
  } catch (err) {
    console.warn("[admin] view cleanup failed:", err);
  }
}

function viewHost() {
  return document.getElementById("admin-view-root");
}

/**
 * Inject an sr-only `<h1>` sourced from `document.title` into the admin
 * view host, matching the attendee shell's showView() behavior. The admin
 * app-header carries a `<p>` (not an `<h1>`) so the sr-only heading is
 * the page's single h1 for screen reader navigation. No-op when the
 * current view already rendered its own `<h1>` (e.g., login.js).
 *
 * The call is deferred to a microtask so async editor renderers (which
 * typically set `document.title` late in their render path) have a tick
 * to settle their title before we read it.
 */
function injectAdminHeadingSoon() {
  queueMicrotask(() => {
    const host = viewHost();
    if (host) injectViewHeading(host);
  });
}

function setAuthShell(authenticated) {
  document.body.classList.toggle(UNAUTH_CLASS, !authenticated);
}

function renderPlaceholder(title, taskLabel) {
  const host = viewHost();
  if (!host) return;
  host.innerHTML = "";
  const section = document.createElement("section");
  section.className = "placeholder-card";
  section.setAttribute("aria-live", "polite");
  const h2 = document.createElement("h2");
  h2.textContent = `${title} \u2014 ${taskLabel}`;
  const p = document.createElement("p");
  p.textContent = `${title} lands in ${taskLabel}. The dashboard links here for navigation.`;
  section.append(h2, p);
  host.appendChild(section);
  document.title = `${title} \u2014 Vendor Day 2027`;
}

/* ---------------- Route handlers ---------------- */

function handleRootRoute() {
  if (isAdminAuthenticated()) {
    // Authenticated visitors to /admin/ or /admin/#/ belong on the dashboard.
    router.navigate("/dashboard");
    return;
  }
  setAuthShell(false);
  const host = viewHost();
  if (host) renderAdminLogin(host);
  document.title = "Admin sign in \u2014 Vendor Day 2027";
  syncPhoneDropdown(null);
  // Login already renders its own visible <h1>; injectViewHeading() is
  // a no-op in that case, so calling it is safe + consistent.
  injectAdminHeadingSoon();
}

function handleDashboardRoute() {
  if (!isAdminAuthenticated()) {
    router.navigate("/");
    return;
  }
  setAuthShell(true);
  const host = viewHost();
  if (host) {
    renderAdminDashboard(host)
      .catch((err) => {
        console.warn("[admin] dashboard render failed:", err);
      })
      .finally(() => injectAdminHeadingSoon());
  }
  syncPhoneDropdown("dashboard");
}

function handleAgendaRoute() {
  if (!isAdminAuthenticated()) {
    router.navigate("/");
    return;
  }
  setAuthShell(true);
  const host = viewHost();
  if (host) {
    renderAgendaEditor(host)
      .catch((err) => {
        console.warn("[admin] agenda editor render failed:", err);
      })
      .finally(() => injectAdminHeadingSoon());
  }
  syncPhoneDropdown("agenda");
}

function handleSponsorsRoute() {
  if (!isAdminAuthenticated()) {
    router.navigate("/");
    return;
  }
  setAuthShell(true);
  const host = viewHost();
  if (host) {
    renderSponsorsEditor(host)
      .catch((err) => {
        console.warn("[admin] sponsors editor render failed:", err);
      })
      .finally(() => injectAdminHeadingSoon());
  }
  syncPhoneDropdown("sponsors");
}

function handleMapRoute() {
  if (!isAdminAuthenticated()) {
    router.navigate("/");
    return;
  }
  setAuthShell(true);
  const host = viewHost();
  if (host) {
    renderMapUploader(host)
      .catch((err) => {
        console.warn("[admin] map uploader render failed:", err);
      })
      .finally(() => injectAdminHeadingSoon());
  }
  syncPhoneDropdown("map");
}

function handleAnnouncementsRoute() {
  if (!isAdminAuthenticated()) {
    router.navigate("/");
    return;
  }
  setAuthShell(true);
  const host = viewHost();
  if (host) {
    renderAnnouncementsComposer(host)
      .catch((err) => {
        console.warn("[admin] announcements composer render failed:", err);
      })
      .finally(() => injectAdminHeadingSoon());
  }
  syncPhoneDropdown("announcements");
}

function handleAttendeesRoute() {
  if (!isAdminAuthenticated()) {
    router.navigate("/");
    return;
  }
  setAuthShell(true);
  const host = viewHost();
  if (host) {
    renderAttendeesImporter(host)
      .catch((err) => {
        console.warn("[admin] attendees importer render failed:", err);
      })
      .finally(() => injectAdminHeadingSoon());
  }
  syncPhoneDropdown("attendees");
}

function handleFeedbackRoute() {
  if (!isAdminAuthenticated()) {
    router.navigate("/");
    return;
  }
  setAuthShell(true);
  const host = viewHost();
  if (host) {
    renderFeedbackEditor(host)
      .catch((err) => {
        console.warn("[admin] feedback editor render failed:", err);
      })
      .finally(() => injectAdminHeadingSoon());
  }
  syncPhoneDropdown("feedback");
}

function handleRecapRoute() {
  if (!isAdminAuthenticated()) {
    router.navigate("/");
    return;
  }
  setAuthShell(true);
  const host = viewHost();
  if (host) {
    renderRecapEditor(host)
      .catch((err) => {
        console.warn("[admin] recap editor render failed:", err);
      })
      .finally(() => injectAdminHeadingSoon());
  }
  syncPhoneDropdown("recap");
}

function handleProtectedRoute(slug, label, taskLabel) {
  if (!isAdminAuthenticated()) {
    // Fall back to the login screen. Replace rather than push so Back from
    // the login screen does not re-enter the pre-auth URL.
    router.navigate("/");
    return;
  }
  setAuthShell(true);
  renderPlaceholder(label, taskLabel);
  syncPhoneDropdown(slug);
  injectAdminHeadingSoon();
}

function handleLogoutRoute() {
  clearAdminSession();
  setAuthShell(false);
  router.navigate("/");
}

/* ---------------- Shell wiring ---------------- */

function registerRoutes() {
  router.register("#/", handleRootRoute);
  router.register("#/dashboard", handleDashboardRoute);
  router.register("#/agenda", handleAgendaRoute);
  router.register("#/sponsors", handleSponsorsRoute);
  router.register("#/map", handleMapRoute);
  router.register("#/announcements", handleAnnouncementsRoute);
  router.register("#/attendees", handleAttendeesRoute);
  router.register("#/feedback", handleFeedbackRoute);
  router.register("#/recap", handleRecapRoute);
  for (const route of PROTECTED_ROUTES) {
    if (
      route.slug === "dashboard" ||
      route.slug === "agenda" ||
      route.slug === "sponsors" ||
      route.slug === "map" ||
      route.slug === "announcements" ||
      route.slug === "attendees" ||
      route.slug === "feedback" ||
      route.slug === "recap"
    ) continue;
    router.register(`#/${route.slug}`, () =>
      handleProtectedRoute(route.slug, route.label, route.taskLabel),
    );
  }
  router.register("#/logout", handleLogoutRoute);
  router.register("*", () => router.navigate("/"));
  // Drain any view-level teardown before the next route mounts so views
  // with background work (dashboard health poll, 30s card refresh) stop
  // when the user navigates elsewhere.
  router.beforeEach(() => runPendingAdminViewCleanup());
}

function wireLogoutButton() {
  const btn = document.getElementById("admin-logout-btn");
  if (!btn) return;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    handleLogoutRoute();
  });
}

function wirePhoneNavDropdown() {
  const sel = document.getElementById("admin-nav-select");
  if (!sel) return;
  sel.addEventListener("change", () => {
    const value = sel.value;
    if (!value) return;
    if (value === "logout") {
      handleLogoutRoute();
      return;
    }
    router.navigate(`/${value}`);
  });
}

function syncPhoneDropdown(slug) {
  const sel = document.getElementById("admin-nav-select");
  if (!sel) return;
  if (!slug) return; // login screen — leave the dropdown alone
  const hasOption = Array.from(sel.options).some((o) => o.value === slug);
  if (hasOption && sel.value !== slug) sel.value = slug;
}

/* ---------------- Bootstrap ---------------- */

/**
 * Last-chance safety net for promise rejections that escape an editor's
 * local `.catch` / `try/catch`. We log at `warn` so admin diagnostics
 * surface the problem in devtools without spamming a user-facing toast
 * (per design section 13, each editor already surfaces failed writes /
 * deletes through `ui.toast` + inline banners that keep dialog values
 * intact). The handler is additive — editors that already handle their
 * own rejections are unaffected.
 */
function wireUnhandledRejection() {
  window.addEventListener("unhandledrejection", (ev) => {
    console.warn("[unhandledrejection]", ev.reason);
  });
}

function bootstrap() {
  wireUnhandledRejection();
  // Pre-paint the shell state so the login screen never flashes nav.
  setAuthShell(isAdminAuthenticated());

  // Guard: an unauthenticated visitor arriving on any protected hash gets
  // sent back to /admin/ (which falls through to the login screen) with
  // a clean URL. Done BEFORE route registration so the handler for the
  // protected route never fires.
  if (!isAdminAuthenticated()) {
    const hash = window.location.hash || "";
    const path = hash.startsWith("#") ? hash.slice(1) : hash;
    if (path && path !== "/") {
      // Full-page nav to /admin/ drops the stale hash cleanly. The admin
      // shell boots again and the login handler renders from a fresh URL.
      window.location.replace("/admin/");
      return;
    }
  }

  registerRoutes();
  wireLogoutButton();
  wirePhoneNavDropdown();
  router.start();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
  bootstrap();
}
