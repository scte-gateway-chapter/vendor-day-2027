// views/attendees-detail.js — Attendee detail modal (Task 13).
//
// Fetches `attendees/<id>` once per mount — no polling here, the list
// view owns that for the collection. Renders a half-sheet modal on
// wider viewports and a full-screen modal on narrow viewports (see
// the media query in app.css).
//
// Opt-out invariant: the detail view NEVER reveals that a specific
// attendee opted out. firestore.rules enforces `optedOut == false` on
// gets, so an opted-out document returns 403; we treat that status
// (and any `optedOut === true` on a doc that somehow slipped through)
// the same as a plain 404 — the modal shows "This attendee is not
// available." with no further detail.
//
// Close behavior: if the user came from the list view this session,
// close via `history.back()` so the browser preserves the list's
// scroll position. Otherwise navigate forward to `#/attendees` so a
// deep-link visit still has a sensible destination.
//
// Focus trap: the modal captures the previously-focused element on
// open, moves focus to the close button, keeps Tab/Shift+Tab inside
// the modal, handles Escape, and restores focus on close.
//
// No contact info, messaging, or QR exchange features (Requirement 7.4,
// design section 7.4).
"use strict";

import { initFirestore, getDoc } from "../firebase.js";
import * as router from "../router.js";
import * as ui from "../ui.js";
import { getCachedAttendee, navigatedFromList } from "./attendees.js";

/**
 * Render the Attendee detail modal into `host`.
 * @param {HTMLElement} host  typically `#view-root`.
 * @param {{ id: string }} params  from the hash route `#/attendees/<id>`.
 * @returns {Promise<void>}
 */
export async function renderAttendeeDetail(host, { id } = {}) {
  host.innerHTML = "";

  const offline = typeof navigator !== "undefined" && navigator.onLine === false;

  const overlay = document.createElement("div");
  overlay.className = "attendee-modal-overlay";
  overlay.setAttribute("data-overlay", "");

  const modal = document.createElement("div");
  modal.className = "attendee-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "attendee-modal-title");
  modal.setAttribute("tabindex", "-1");

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "attendee-modal__close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.innerHTML = "&times;";

  const bodyEl = document.createElement("div");
  bodyEl.className = "attendee-modal__body";
  bodyEl.setAttribute("aria-live", "polite");

  modal.append(closeBtn, bodyEl);
  overlay.appendChild(modal);
  host.appendChild(overlay);

  // Build the inner skeleton + optional offline banner + body note so
  // the modal has a stable height while the fetch resolves.
  renderModalSkeleton(bodyEl, offline);

  // Install focus trap + close listeners. The trap captures the
  // previously-focused element on construction and restores it when
  // uninstall() runs.
  const close = () => closeModal(uninstall);
  const uninstall = installFocusTrap(modal, close);
  // Click on the dark backdrop closes the modal. Clicks inside the modal
  // body (which is a child of the overlay via the modal element) do not
  // bubble as `target === overlay`, so this test is safe.
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });
  closeBtn.addEventListener("click", () => close());

  try {
    // Prime config so the following getDoc call has the Firebase values.
    try {
      await initFirestore();
    } catch (err) {
      console.warn("[attendees-detail] /api/config load failed:", err);
    }

    let attendee = null;
    let fetchErr = null;
    let treatAsNotAvailable = false;
    try {
      attendee = await getDoc(`attendees/${id}`);
    } catch (err) {
      // 403 → firestore.rules denied the read, which means
      // `optedOut == true` on this doc. Treat exactly like a 404 so the
      // response text does not reveal why the attendee is missing.
      if (err && err.status === 403) {
        treatAsNotAvailable = true;
      } else {
        fetchErr = err;
        console.warn("[attendees-detail] fetch failed:", err);
      }
    }

    // Defense in depth: if a document arrives with `optedOut: true`
    // (rules weakened, bug, or race) treat it as not available.
    if (attendee && attendee.optedOut === true) {
      treatAsNotAvailable = true;
      attendee = null;
    }

    if (fetchErr) {
      // Best-effort offline fallback: if the list view ran this session
      // and we have a cached copy of this attendee, show it with the
      // offline banner. Otherwise show the error state with a retry link.
      const cached = (typeof navigator !== "undefined" && navigator.onLine === false)
        ? getCachedAttendee(id)
        : null;
      if (cached && cached.optedOut !== true) {
        renderAttendeeBody(bodyEl, cached, { offline: true });
        document.title = `${cached.name || "Attendee"} \u2014 Vendor Day 2027`;
        return;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        renderOfflineError(bodyEl, () => renderAttendeeDetail(host, { id }));
      } else {
        ui.toast("error", "Couldn't load this attendee.");
        renderErrorBody(bodyEl, () => renderAttendeeDetail(host, { id }));
      }
      document.title = "Attendee \u2014 Vendor Day 2027";
      return;
    }

    if (!attendee || treatAsNotAvailable) {
      renderNotAvailableBody(bodyEl, () => close());
      document.title = "Attendee not available \u2014 Vendor Day 2027";
      return;
    }

    renderAttendeeBody(bodyEl, attendee, { offline });
    document.title = `${attendee.name || "Attendee"} \u2014 Vendor Day 2027`;
  } finally {
    // Focus the close button AFTER ui.showView's own post-render focus
    // call. ui.showView does `view-root.focus({ preventScroll: true })`
    // synchronously after this renderFn's promise resolves. Scheduling
    // via requestAnimationFrame in the finally block ensures our focus
    // call runs on the next animation frame — after the current
    // microtask queue drains (including showView's continuation).
    requestAnimationFrame(() => {
      try { closeBtn.focus(); } catch (_err) { /* no-op */ }
    });
  }
}

export default renderAttendeeDetail;

/* ---------------- Close navigation ---------------- */

function closeModal(uninstallFocusTrap) {
  try { uninstallFocusTrap(); } catch (_err) { /* no-op */ }
  if (navigatedFromList()) {
    // The list is the previous entry in the browser's back stack and
    // its scroll position is preserved — history.back() is the best UX.
    try { window.history.back(); return; } catch (_err) { /* fall through */ }
  }
  router.navigate("/attendees");
}

/* ---------------- Focus trap ---------------- */

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Install a lightweight focus trap on `modal`. Captures the previously-
 * focused element on construction so uninstall() can restore it; traps
 * Tab/Shift+Tab inside the modal; invokes `onEscape` when the user
 * presses Escape.
 *
 * @param {HTMLElement} modal
 * @param {() => void} onEscape
 * @returns {() => void} uninstall
 */
function installFocusTrap(modal, onEscape) {
  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

  function onKeydown(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      onEscape();
      return;
    }
    if (ev.key !== "Tab") return;
    const focusable = Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) {
      ev.preventDefault();
      modal.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (ev.shiftKey) {
      if (active === first || !modal.contains(active)) {
        ev.preventDefault();
        last.focus();
      }
    } else if (active === last || !modal.contains(active)) {
      ev.preventDefault();
      first.focus();
    }
  }

  modal.addEventListener("keydown", onKeydown);

  return function uninstall() {
    modal.removeEventListener("keydown", onKeydown);
    if (previousFocus && typeof previousFocus.focus === "function") {
      try { previousFocus.focus(); } catch (_err) { /* no-op */ }
    }
  };
}

/* ---------------- Body renderers ---------------- */

function renderModalSkeleton(host, offline) {
  host.innerHTML = `
    ${offline ? `<div class="attendee-modal__offline" role="status">You're offline — showing last-saved content.</div>` : ""}
    <div class="skeleton-row" style="height: 32px; width: 70%;"></div>
    <div class="skeleton-row" style="width: 60%;"></div>
    <div class="skeleton-row" style="width: 45%;"></div>
    <p id="attendee-modal-title" class="sr-only">Loading attendee</p>
  `;
}

/**
 * Render the attendee's name, company/title, and the opt-out footnote.
 * No contact info, no messaging. The opt-out footnote is generic — it
 * does not reveal anyone's opt-out status, just the policy.
 */
function renderAttendeeBody(host, attendee, { offline } = {}) {
  const name = typeof attendee.name === "string" && attendee.name.trim()
    ? attendee.name.trim()
    : "Unnamed attendee";
  const company = typeof attendee.company === "string" ? attendee.company.trim() : "";
  const title = typeof attendee.title === "string" ? attendee.title.trim() : "";

  host.innerHTML = `
    ${offline ? `<div class="attendee-modal__offline" role="status">You're offline — showing last-saved content.</div>` : ""}
    <h2 id="attendee-modal-title" class="attendee-modal__name">${escapeHtml(name)}</h2>
    ${company ? `<p class="attendee-modal__company">${escapeHtml(company)}</p>` : ""}
    ${title ? `<p class="attendee-modal__title">${escapeHtml(title)}</p>` : ""}
    <p class="attendee-modal__note">Attendees are listed by the registration list. To opt out, see the check-in table.</p>
  `;
}

/**
 * Not-found + opted-out share this body. The wording is deliberately
 * neutral so the view does not reveal why the attendee is missing.
 */
function renderNotAvailableBody(host, onClose) {
  host.innerHTML = `
    <h2 id="attendee-modal-title" class="attendee-modal__name">Attendee not available</h2>
    <p class="attendee-modal__company">This attendee is not available.</p>
    <div class="attendee-modal__actions">
      <button type="button" class="btn-secondary" data-close>Close</button>
    </div>
  `;
  host.querySelector("[data-close]").addEventListener("click", onClose);
}

function renderErrorBody(host, onRetry) {
  host.innerHTML = `
    <h2 id="attendee-modal-title" class="attendee-modal__name">Couldn't load</h2>
    <div class="status-error" role="alert">
      <p>Couldn't load this attendee.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

function renderOfflineError(host, onRetry) {
  host.innerHTML = `
    <div class="attendee-modal__offline" role="status">You're offline — showing last-saved content.</div>
    <h2 id="attendee-modal-title" class="attendee-modal__name">Not available offline</h2>
    <p class="attendee-modal__company">This attendee hasn't been loaded on this device yet. Reconnect to view the details.</p>
    <div class="attendee-modal__actions">
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

/* ---------------- Escaping ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
