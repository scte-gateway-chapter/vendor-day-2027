// admin.js — admin shell bootstrap (Task 16).
//
// Owns the tiny hash router inside /admin/, the pre-paint guard that
// bounces direct links to protected hashes through the login screen, the
// logout button handler, and the <body>-level class that hides the
// left-rail nav + logout button when the user is not authenticated.
//
// Tasks 17+ replace the placeholder route handlers below with real editor
// views. Each route is a drop-in replacement.
"use strict";

import * as router from "/js/router.js";
import { isAdminAuthenticated, clearAdminSession } from "./admin-auth.js";
import renderAdminLogin from "./login.js";

const UNAUTH_CLASS = "admin-shell--unauthenticated";

/** Protected routes mapped to their placeholder label. Later tasks swap
 *  the renderer; the route list stays stable so navigation keeps working. */
const PROTECTED_ROUTES = [
  { slug: "dashboard", label: "Admin Dashboard" },
  { slug: "agenda", label: "Admin Agenda" },
  { slug: "sponsors", label: "Admin Sponsors" },
  { slug: "map", label: "Admin Venue Map" },
  { slug: "announcements", label: "Admin Announcements" },
  { slug: "attendees", label: "Admin Attendees" },
  { slug: "feedback", label: "Admin Feedback" },
  { slug: "recap", label: "Admin Recap" },
  { slug: "settings", label: "Admin Settings" },
];

function viewHost() {
  return document.getElementById("admin-view-root");
}

function setAuthShell(authenticated) {
  document.body.classList.toggle(UNAUTH_CLASS, !authenticated);
}

function renderPlaceholder(title) {
  const host = viewHost();
  if (!host) return;
  host.innerHTML = "";
  const section = document.createElement("section");
  section.className = "placeholder-card";
  section.setAttribute("aria-live", "polite");
  const h2 = document.createElement("h2");
  h2.textContent = `${title} — Task 17`;
  const p = document.createElement("p");
  p.textContent = `${title} lands in Task 17. Login and session storage are live now.`;
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

function handleProtectedRoute(slug, label) {
  if (!isAdminAuthenticated()) {
    // Fall back to the login screen. Replace rather than push so Back from
    // the login screen does not re-enter the pre-auth URL.
    router.navigate("/");
    return;
  }
  setAuthShell(true);
  renderPlaceholder(label);
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
  for (const route of PROTECTED_ROUTES) {
    router.register(`#/${route.slug}`, () =>
      handleProtectedRoute(route.slug, route.label),
    );
  }
  router.register("#/logout", handleLogoutRoute);
  router.register("*", () => router.navigate("/"));
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
