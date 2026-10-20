// ui.js — shared UI chrome (header, tab bar, toasts, banners).
//
// All DOM owned by this module lives inside #app-header, #app-tab-bar,
// #toast-root, and #banner-root. Views own #view-root content.
"use strict";

import * as router from "./router.js";

const TAB_DEFS = [
  { id: "home", label: "Home", path: "/" },
  { id: "agenda", label: "Agenda", path: "/agenda" },
  { id: "sponsors", label: "Sponsors", path: "/sponsors" },
  { id: "map", label: "Map", path: "/map" },
  { id: "more", label: "More", path: "/about-install" },
];

let adminSessionVisible = false;

/* ---------------- Header ---------------- */

/**
 * Mount the sticky top header into #app-header. Includes the chapter logo,
 * app title, and an overflow menu button with a dropdown.
 */
export function renderHeader() {
  const mount = document.getElementById("app-header");
  if (!mount) return;
  mount.className = "app-header";
  mount.setAttribute("role", "banner");
  mount.innerHTML = `
    <img
      class="app-header__logo"
      src="/assets/brand/gateway-logo.svg"
      alt="Gateway Chapter SCTE"
      height="32"
    />
    <h1 class="app-header__title">Vendor Day 2027</h1>
    <div class="app-header__menu-wrap">
      <button
        type="button"
        class="app-header__overflow"
        aria-label="More options"
        aria-haspopup="menu"
        aria-expanded="false"
        aria-controls="app-header-menu"
      ><span aria-hidden="true">\u22EF</span></button>
      <ul
        id="app-header-menu"
        class="app-header__menu"
        role="menu"
        hidden
      >
        <li role="none"><a role="menuitem" href="#/about-install">About &amp; Install</a></li>
        <li role="none" data-admin-only hidden><a role="menuitem" href="/admin">Admin</a></li>
      </ul>
    </div>
  `;

  const button = mount.querySelector(".app-header__overflow");
  const menu = mount.querySelector("#app-header-menu");
  if (!button || !menu) return;

  function setOpen(open) {
    button.setAttribute("aria-expanded", String(open));
    menu.hidden = !open;
  }
  button.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setOpen(button.getAttribute("aria-expanded") !== "true");
  });
  // Click-outside / Escape dismiss keeps the menu usable with just a keyboard.
  document.addEventListener("click", (ev) => {
    if (!mount.contains(ev.target)) setOpen(false);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") setOpen(false);
  });
  menu.addEventListener("click", () => setOpen(false));

  applyAdminVisibility(mount);
}

/**
 * Show / hide the hidden Admin menu entry. Called by the auth flow in Task 16;
 * exported here so other modules can flip it without reaching into the DOM.
 * @param {boolean} visible
 */
export function setAdminMenuVisible(visible) {
  adminSessionVisible = Boolean(visible);
  const mount = document.getElementById("app-header");
  if (mount) applyAdminVisibility(mount);
}

function applyAdminVisibility(mount) {
  const entry = mount.querySelector("[data-admin-only]");
  if (entry) entry.hidden = !adminSessionVisible;
}

/* ---------------- Tab bar ---------------- */

/**
 * Mount the fixed bottom tab bar. `active` is the tab id (`home`, `agenda`,
 * ...); omit or pass a non-matching id and no tab is highlighted.
 * @param {string} [active]
 */
export function renderTabBar(active) {
  const mount = document.getElementById("app-tab-bar");
  if (!mount) return;
  mount.className = "tab-bar";
  mount.setAttribute("role", "tablist");
  mount.setAttribute("aria-label", "Main navigation");
  mount.innerHTML = TAB_DEFS.map((t, i) => {
    const selected = t.id === active;
    return `
      <button
        type="button"
        class="tab-bar__button"
        role="tab"
        id="tab-${t.id}"
        data-tab="${t.id}"
        data-path="${t.path}"
        aria-selected="${selected ? "true" : "false"}"
        aria-controls="view-root"
        tabindex="${selected ? "0" : "-1"}"
      >
        <span class="tab-bar__label">${t.label}</span>
        <span class="tab-bar__badge" data-badge hidden aria-hidden="true"></span>
      </button>
    `;
  }).join("");

  const buttons = Array.from(mount.querySelectorAll("[data-tab]"));
  buttons.forEach((btn, idx) => {
    btn.addEventListener("click", () => {
      const path = btn.getAttribute("data-path");
      if (path) router.navigate(path);
    });
    btn.addEventListener("keydown", (ev) => {
      // ARIA tab pattern: left/right arrow cycles, Home/End jump to ends.
      let next = null;
      if (ev.key === "ArrowRight") next = (idx + 1) % buttons.length;
      else if (ev.key === "ArrowLeft") next = (idx - 1 + buttons.length) % buttons.length;
      else if (ev.key === "Home") next = 0;
      else if (ev.key === "End") next = buttons.length - 1;
      if (next == null) return;
      ev.preventDefault();
      buttons[next].focus();
      buttons[next].click();
    });
  });
}

/**
 * Update which tab reads as selected. Useful from router.afterEach so the tab
 * bar reflects the active route without a full re-render.
 * @param {string} active
 */
export function setActiveTab(active) {
  const mount = document.getElementById("app-tab-bar");
  if (!mount) return;
  mount.querySelectorAll("[data-tab]").forEach((btn) => {
    const match = btn.getAttribute("data-tab") === active;
    btn.setAttribute("aria-selected", match ? "true" : "false");
    btn.setAttribute("tabindex", match ? "0" : "-1");
  });
}

/**
 * Set the unread badge count on a tab. Count `0` hides the badge.
 * @param {string} tabName  e.g. "more"
 * @param {number} count
 */
export function updateBadge(tabName, count) {
  const mount = document.getElementById("app-tab-bar");
  if (!mount) return;
  const btn = mount.querySelector(`[data-tab="${tabName}"]`);
  if (!btn) return;
  const badge = btn.querySelector("[data-badge]");
  if (!badge) return;
  const n = Number(count) || 0;
  if (n <= 0) {
    badge.hidden = true;
    badge.textContent = "";
    btn.removeAttribute("aria-describedby");
  } else {
    badge.hidden = false;
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.setAttribute("aria-hidden", "false");
  }
}

/* ---------------- View host ---------------- */

/**
 * Mount a view by invoking `renderFn(root)` into #view-root. Scrolls the
 * viewport to the top so each navigation starts at the top of the view.
 * @param {(root: HTMLElement) => void | Promise<void>} renderFn
 */
export async function showView(renderFn) {
  const root = document.getElementById("view-root");
  if (!root) return;
  root.innerHTML = "";
  await renderFn(root);
  // Focus the view root so screen readers announce the new view after nav.
  if (typeof root.focus === "function") root.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

/* ---------------- Toasts ---------------- */

/**
 * Show a toast at the bottom-center. `type` is `success | error | info`.
 * Toasts auto-dismiss after `durationMs` and dismiss on tap.
 * @param {"success"|"error"|"info"} type
 * @param {string} message
 * @param {{ durationMs?: number }} [opts]
 */
export function toast(type, message, opts = {}) {
  const { durationMs = 4000 } = opts;
  const root = document.getElementById("toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.textContent = message;
  // Tap-to-dismiss and keyboard dismiss keep the pattern reachable without a mouse.
  el.tabIndex = 0;
  el.addEventListener("click", () => dismiss());
  el.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " " || ev.key === "Escape") {
      ev.preventDefault();
      dismiss();
    }
  });
  root.appendChild(el);
  const timer = setTimeout(dismiss, durationMs);
  function dismiss() {
    clearTimeout(timer);
    el.classList.add("toast--leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    // Fallback in case animations are disabled (prefers-reduced-motion / no CSS).
    setTimeout(() => el.remove(), 400);
  }
}

/* ---------------- Banners ---------------- */

function bannerRoot() {
  return document.getElementById("banner-root");
}

/** Show the yellow "You're offline" banner. Idempotent. */
export function showOfflineBanner() {
  const root = bannerRoot();
  if (!root || root.querySelector(".offline-banner")) return;
  const el = document.createElement("div");
  el.className = "offline-banner";
  el.setAttribute("role", "status");
  el.textContent = "You're offline — showing last-saved content.";
  root.appendChild(el);
}

/** Remove the offline banner if present. */
export function hideOfflineBanner() {
  const root = bannerRoot();
  if (!root) return;
  const el = root.querySelector(".offline-banner");
  if (el) el.remove();
}

/**
 * Show the "App updated — tap to reload" banner. Clicking it reloads. The SW
 * fires a `message` event that triggers this on new-version activation.
 */
export function showUpdateReadyBanner() {
  const root = bannerRoot();
  if (!root || root.querySelector(".update-ready-banner")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "update-ready-banner";
  btn.setAttribute("aria-live", "polite");
  btn.innerHTML = "App updated \u2014 tap to reload";
  btn.addEventListener("click", () => window.location.reload());
  root.appendChild(btn);
}
