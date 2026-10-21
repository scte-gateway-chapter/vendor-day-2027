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
import { isAdminAuthenticated, clearAdminSession } from "./admin-auth.js";
import renderAdminLogin from "./login.js";
import renderAdminDashboard from "./dashboard.js";
import renderAgendaEditor from "./agenda-editor.js";

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
  { slug: "feedback", label: "Admin Feedback", taskLabel: "Task 23" },
  { slug: "recap", label: "Admin Recap", taskLabel: "Task 24" },
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
}

function handleDashboardRoute() {
  if (!isAdminAuthenticated()) {
    router.navigate("/");
    return;
  }
  setAuthShell(true);
  const host = viewHost();
  if (host) {
    renderAdminDashboard(host).catch((err) => {
      console.warn("[admin] dashboard render failed:", err);
    });
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
    renderAgendaEditor(host).catch((err) => {
      console.warn("[admin] agenda editor render failed:", err);
    });
  }
  syncPhoneDropdown("agenda");
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
  for (const route of PROTECTED_ROUTES) {
    if (route.slug === "dashboard" || route.slug === "agenda") continue;
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

function bootstrap() {
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
