// settings-editor.js — admin Settings page.
//
// Mounts into #admin-view-root. Reads `appSettings/singleton` on open
// and polls on the shared 30-second cadence used by the other admin
// editors. The only field this editor owns today is the attendee
// Sign-In toggle (`signInEnabled`); other fields on the appSettings
// doc (eventTitle, venueName, venueMapUrl, venueMapCaption) are owned
// by the Venue Map editor and the seed script. Writes here use
// `op: "update"` so those other fields are preserved.
//
// Visual pattern reuses `.admin-feedback-toggle` from the Feedback
// editor — same ARIA switch, pill, and copy slot so the admin UI's
// on/off vocabulary stays consistent.
"use strict";

import { initFirestore, getDoc, onSnapshot } from "/js/firebase.js";
import * as ui from "/js/ui.js";
import { adminFetch } from "./admin-fetch.js";
import { registerAdminViewCleanup } from "./admin.js";
import { formatLastEditedPhrase } from "./collision-check.js";

const POLL_INTERVAL_MS = 30_000;
const OFFLINE_TOOLTIP = "You're offline \u2014 admin changes require connectivity.";

/**
 * Render the admin Settings view into `host`.
 * @param {HTMLElement} host  typically `#admin-view-root`.
 * @returns {Promise<void>}
 */
export default async function renderSettingsEditor(host) {
  host.innerHTML = "";

  const container = document.createElement("section");
  container.className = "admin-settings-editor";
  container.setAttribute("aria-label", "Admin Settings editor");
  host.appendChild(container);

  const header = buildStickyHeader();
  const offlineBanner = buildOfflineBanner();
  const panel = document.createElement("div");
  panel.className = "admin-settings-editor__panel";

  container.append(header.el, offlineBanner.el, panel);

  // Prime /api/config; cached inside firebase.js after the first call.
  const configReady = initFirestore().catch((err) => {
    console.warn("[admin-settings] /api/config load failed:", err);
    return null;
  });

  /** @type {object | null} Server copy of appSettings/singleton. */
  let serverState = null;
  /** @type {Error | null} */
  let serverErr = null;
  let sawFirstResult = false;
  let errorToasted = false;
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  /** Whether a write is in flight; blocks concurrent toggles. */
  let writeInFlight = false;

  /** @type {HTMLElement | null} Mounted toggle wrapper (null until the first render). */
  let toggleWrap = null;
  /** @type {HTMLInputElement | null} */
  let toggleInput = null;
  /** @type {HTMLElement | null} */
  let toggleBanner = null;

  function renderPanel() {
    offlineBanner.setVisible(!online);
    header.setLastEdited(serverState);

    if (serverErr && !serverState) {
      renderErrorNoCache(panel, () => restartSubscription());
      toggleWrap = null;
      toggleInput = null;
      toggleBanner = null;
      return;
    }
    if (!sawFirstResult) {
      renderSkeleton(panel);
      return;
    }
    if (!toggleWrap) {
      mountEditor();
    } else {
      syncToggleFromServer();
    }
  }

  function mountEditor() {
    panel.innerHTML = "";

    const section = document.createElement("section");
    section.className = "admin-settings-section";
    section.setAttribute("aria-label", "Attendee Sign-In");

    const heading = document.createElement("h2");
    heading.className = "admin-settings-section__title";
    heading.textContent = "Attendee Sign-In";
    section.appendChild(heading);

    const helper = document.createElement("p");
    helper.className = "admin-settings-section__helper";
    helper.textContent =
      "When enabled, the Sign-In form becomes available to attendees on " +
      "the Welcome screen, Home, and More menu. Attendees who already " +
      "signed in before the toggle was turned off will still see their " +
      "confirmation.";
    section.appendChild(helper);

    const { wrap, input, banner } = buildSignInToggle();
    toggleWrap = wrap;
    toggleInput = input;
    toggleBanner = banner;
    section.appendChild(wrap);
    panel.appendChild(section);

    syncToggleFromServer();
  }

  function buildSignInToggle() {
    const enabled = serverState?.signInEnabled === true;

    const wrap = document.createElement("div");
    wrap.className =
      `admin-feedback-toggle admin-settings-toggle admin-feedback-toggle--${enabled ? "on" : "off"}`;

    const label = document.createElement("label");
    label.className = "admin-feedback-toggle__label";
    label.htmlFor = "admin-settings-signin-toggle";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = "admin-settings-signin-toggle";
    input.className = "admin-feedback-toggle__input";
    input.setAttribute("role", "switch");
    input.setAttribute(
      "aria-label",
      enabled
        ? "Attendee Sign-In is on. Turn off to hide sign-in surfaces from attendees."
        : "Attendee Sign-In is off. Turn on to open sign-in to attendees.",
    );
    input.checked = enabled;
    input.disabled = !online || writeInFlight;

    const track = document.createElement("span");
    track.className = "admin-feedback-toggle__track";
    track.setAttribute("aria-hidden", "true");
    const thumb = document.createElement("span");
    thumb.className = "admin-feedback-toggle__thumb";
    track.appendChild(thumb);

    const copy = document.createElement("div");
    copy.className = "admin-feedback-toggle__copy";
    const pill = document.createElement("span");
    pill.className =
      `admin-feedback-toggle__pill admin-feedback-toggle__pill--${enabled ? "on" : "off"}`;
    pill.textContent = enabled ? "LIVE" : "OFF";
    const text = document.createElement("p");
    text.className = "admin-feedback-toggle__text";
    text.textContent = enabled
      ? "Attendee Sign-In is LIVE. The Welcome, Home, and More menu entries are visible to attendees."
      : "Attendee Sign-In is OFF. Attendees do not see the Sign-In form from the Welcome, Home, or More menu.";
    copy.append(pill, text);

    label.append(input, track, copy);
    wrap.appendChild(label);

    const banner = document.createElement("div");
    banner.className = "status-error admin-feedback-toggle__banner";
    banner.setAttribute("role", "alert");
    banner.hidden = true;
    wrap.appendChild(banner);

    input.addEventListener("change", async () => {
      if (writeInFlight) return;
      if (!online) {
        input.checked = enabled; // revert the optimistic flip
        return;
      }
      await handleToggleChange(input.checked);
    });

    return { wrap, input, banner };
  }

  function syncToggleFromServer() {
    if (!toggleWrap || !toggleInput) return;
    const enabled = serverState?.signInEnabled === true;

    toggleWrap.classList.toggle("admin-feedback-toggle--on", enabled);
    toggleWrap.classList.toggle("admin-feedback-toggle--off", !enabled);
    toggleInput.checked = enabled;
    toggleInput.disabled = !online || writeInFlight;
    toggleInput.setAttribute(
      "aria-label",
      enabled
        ? "Attendee Sign-In is on. Turn off to hide sign-in surfaces from attendees."
        : "Attendee Sign-In is off. Turn on to open sign-in to attendees.",
    );

    const pill = toggleWrap.querySelector(".admin-feedback-toggle__pill");
    if (pill) {
      pill.classList.toggle("admin-feedback-toggle__pill--on", enabled);
      pill.classList.toggle("admin-feedback-toggle__pill--off", !enabled);
      pill.textContent = enabled ? "LIVE" : "OFF";
    }
    const text = toggleWrap.querySelector(".admin-feedback-toggle__text");
    if (text) {
      text.textContent = enabled
        ? "Attendee Sign-In is LIVE. The Welcome, Home, and More menu entries are visible to attendees."
        : "Attendee Sign-In is OFF. Attendees do not see the Sign-In form from the Welcome, Home, or More menu.";
    }
  }

  async function handleToggleChange(nextEnabled) {
    if (!toggleInput || !toggleBanner) return;
    const previous = serverState?.signInEnabled === true;
    writeInFlight = true;
    toggleInput.disabled = true;
    toggleBanner.hidden = true;
    toggleBanner.textContent = "";

    try {
      await adminFetch("/api/firestore-write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection: "appSettings",
          docId: "singleton",
          op: "update",
          data: { signInEnabled: nextEnabled },
        }),
      });
      ui.toast(
        "success",
        nextEnabled
          ? "Attendee Sign-In turned on."
          : "Attendee Sign-In turned off.",
      );
      // Mirror the write locally so the UI reflects the change without
      // waiting for the next 30s poll.
      serverState = {
        ...(serverState || {}),
        signInEnabled: nextEnabled,
      };
      syncToggleFromServer();
      nudgeRefresh();
    } catch (err) {
      console.warn("[admin-settings] signInEnabled write failed:", err);
      if (err?.code === "session-expired") return;
      // Revert the optimistic flip and surface the error inline.
      toggleInput.checked = previous;
      toggleBanner.textContent = nextEnabled
        ? "Could not turn Sign-In on. Try again."
        : "Could not turn Sign-In off. Try again.";
      toggleBanner.hidden = false;
    } finally {
      writeInFlight = false;
      toggleInput.disabled = !online;
    }
  }

  /* ---------------- Subscription plumbing ---------------- */

  /** @type {(() => void) | null} */
  let unsub = null;

  async function startSubscription() {
    try { await configReady; } catch (_err) { /* non-fatal */ }
    unsub = onSnapshot(
      "appSettings/singleton",
      (data, err) => {
        if (err) {
          console.warn("[admin-settings] poll failed:", err);
          serverErr = err;
          if (!serverState && !errorToasted) {
            ui.toast(
              "error",
              "Couldn't load settings. Tap Retry to try again.",
            );
            errorToasted = true;
          }
        } else {
          serverErr = null;
          errorToasted = false;
          serverState = data || null;
        }
        sawFirstResult = true;
        renderPanel();
      },
      { intervalMs: POLL_INTERVAL_MS },
    );
  }

  function restartSubscription() {
    if (unsub) { unsub(); unsub = null; }
    serverErr = null;
    serverState = null;
    sawFirstResult = false;
    errorToasted = false;
    toggleWrap = null;
    toggleInput = null;
    toggleBanner = null;
    renderSkeleton(panel);
    startSubscription();
  }

  /**
   * Trigger an off-cycle poll right now so the view reflects a just-saved
   * write without waiting out the 30s interval. Keeps the current DOM
   * mounted so the admin's focus / caret isn't disturbed.
   */
  function nudgeRefresh() {
    if (unsub) { unsub(); unsub = null; }
    serverErr = null;
    errorToasted = false;
    startSubscription();
  }

  startSubscription();

  /* ---------------- Connectivity ---------------- */

  const onOnline = () => {
    online = true;
    if (toggleInput) {
      toggleInput.disabled = writeInFlight;
      toggleInput.removeAttribute("title");
    }
    renderPanel();
  };
  const onOffline = () => {
    online = false;
    if (toggleInput) {
      toggleInput.disabled = true;
      toggleInput.setAttribute("title", OFFLINE_TOOLTIP);
    }
    renderPanel();
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  const onVisibility = () => {
    if (document.visibilityState !== "visible") return;
    renderPanel();
  };
  document.addEventListener("visibilitychange", onVisibility);

  registerAdminViewCleanup(() => {
    if (unsub) { unsub(); unsub = null; }
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onVisibility);
  });

  document.title = "Admin \u2014 Settings \u2014 Vendor Day 2027";
}

/* =================================================================
 * Sticky secondary header
 * ================================================================= */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "admin-settings-header";
  el.innerHTML = `
    <div class="admin-settings-header__row">
      <h2 class="admin-settings-header__title">Admin \u2014 Settings</h2>
      <p class="admin-settings-header__meta" aria-live="polite">never edited</p>
    </div>
  `;

  const metaEl = el.querySelector(".admin-settings-header__meta");

  function setLastEdited(doc) {
    metaEl.textContent = formatLastEditedPhrase(doc);
  }

  return { el, setLastEdited };
}

/* =================================================================
 * Offline banner (scoped to the view)
 * ================================================================= */

function buildOfflineBanner() {
  const el = document.createElement("div");
  el.className = "admin-view-offline-banner";
  el.setAttribute("role", "status");
  el.textContent = "You're offline \u2014 admin changes require connectivity.";
  el.hidden = true;
  function setVisible(visible) {
    el.hidden = !visible;
  }
  return { el, setVisible };
}

/* =================================================================
 * Rendering states
 * ================================================================= */

function renderSkeleton(host) {
  host.innerHTML = `
    <div class="skeleton-row" style="height: 24px; width: 40%;" aria-hidden="true"></div>
    <div class="skeleton-row" style="height: 16px; width: 90%;" aria-hidden="true"></div>
    <div class="skeleton-card admin-settings-toggle-skeleton" aria-hidden="true"></div>
  `;
}

function renderErrorNoCache(host, onRetry) {
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't load settings.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}
