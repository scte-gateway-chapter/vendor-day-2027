// login.js — Admin Login screen (Task 16).
//
// Renders the single passphrase form, submits to /api/admin-login, and
// handles the three response paths:
//   200 — store the JWT + expiresAt in sessionStorage; redirect to the
//         admin dashboard hash route.
//   401 — show an inline "Incorrect passphrase." error, clear the input,
//         refocus for a retry.
//   429 — show an inline "Too many attempts…" error with a live countdown
//         ("Try again in Xm Ys"); the submit button stays disabled until
//         the countdown reaches zero.
// Network and other 5xx errors fall through to a generic "Something went
// wrong. Please try again." message with the submit button re-enabled.
//
// The ?reason=expired | ?reason=invalid query param (written by
// onSessionExpired or sent as a direct link) surfaces a banner at the top
// of the card. The query is cleared from the URL via history.replaceState
// after the first paint so a reload doesn't persist the banner.
"use strict";

import { storeAdminSession } from "./admin-auth.js";

const LOGIN_ENDPOINT = "/api/admin-login";
const DEFAULT_LOCKOUT_SEC = 600; // design section 6: 10-minute window

/**
 * Mount the login form inside `host` and wire the submit flow.
 * @param {HTMLElement} host  usually #admin-view-root
 */
export default function renderAdminLogin(host) {
  const bannerText = readReasonBanner();

  host.innerHTML = "";

  const container = document.createElement("section");
  container.className = "admin-login-container";
  container.setAttribute("aria-labelledby", "admin-login-title");

  if (bannerText) {
    const banner = document.createElement("div");
    banner.className = "admin-login-banner";
    banner.setAttribute("role", "status");
    banner.textContent = bannerText;
    container.appendChild(banner);
  }

  const title = document.createElement("h1");
  title.id = "admin-login-title";
  title.className = "admin-login-title";
  title.textContent = "Sign in to the admin area";
  container.appendChild(title);

  const form = document.createElement("form");
  form.className = "admin-login-form";
  form.setAttribute("novalidate", "");

  const field = document.createElement("div");
  field.className = "form-field";

  const label = document.createElement("label");
  label.setAttribute("for", "admin-passphrase");
  label.textContent = "Admin passphrase";
  field.appendChild(label);

  const input = document.createElement("input");
  input.id = "admin-passphrase";
  input.className = "admin-login-input";
  input.type = "password";
  input.name = "passphrase";
  input.required = true;
  input.autocomplete = "current-password";
  input.setAttribute(
    "aria-describedby",
    "admin-login-error admin-login-countdown",
  );
  field.appendChild(input);

  form.appendChild(field);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "btn-primary admin-login-submit";
  submit.textContent = "Sign in";
  form.appendChild(submit);

  // aria-live polite so retries announce without interrupting the user mid-type.
  const errorEl = document.createElement("div");
  errorEl.id = "admin-login-error";
  errorEl.className = "admin-login-error status-error";
  errorEl.setAttribute("aria-live", "polite");
  errorEl.hidden = true;
  form.appendChild(errorEl);

  const countdownEl = document.createElement("div");
  countdownEl.id = "admin-login-countdown";
  countdownEl.className = "admin-login-countdown";
  countdownEl.setAttribute("aria-live", "polite");
  countdownEl.hidden = true;
  form.appendChild(countdownEl);

  container.appendChild(form);
  host.appendChild(container);

  // Autofocus the input for keyboard users. Defer so we don't fight any
  // shell-level focus call that may be in flight.
  queueMicrotask(() => input.focus());

  let countdownTimer = null;

  function clearCountdown() {
    if (countdownTimer != null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    countdownEl.hidden = true;
    countdownEl.textContent = "";
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.textContent = "";
    errorEl.hidden = true;
  }

  function enableSubmit() {
    submit.disabled = false;
    submit.classList.remove("admin-login-submit--loading");
  }

  function disableSubmit({ loading = false } = {}) {
    submit.disabled = true;
    submit.classList.toggle("admin-login-submit--loading", Boolean(loading));
  }

  function startLockout(seconds) {
    const safeSec = Number.isFinite(seconds) && seconds > 0
      ? seconds
      : DEFAULT_LOCKOUT_SEC;
    const until = Date.now() + Math.ceil(safeSec) * 1000;
    disableSubmit();
    tick();
    countdownTimer = setInterval(tick, 1000);

    function tick() {
      const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      if (remaining <= 0) {
        clearCountdown();
        clearError();
        enableSubmit();
        input.focus();
        return;
      }
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      countdownEl.hidden = false;
      countdownEl.textContent = `Try again in ${mins}m ${secs}s.`;
    }
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    clearError();
    clearCountdown();

    const passphrase = input.value;
    if (!passphrase) {
      showError("Enter the admin passphrase.");
      input.focus();
      return;
    }

    disableSubmit({ loading: true });

    let response;
    try {
      response = await fetch(LOGIN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
    } catch (err) {
      console.warn("[admin-login] network error:", err);
      showError("Something went wrong. Please try again.");
      enableSubmit();
      return;
    }

    if (response.status === 200) {
      let data = null;
      try {
        data = await response.json();
      } catch (_err) {
        data = null;
      }
      if (!data || !data.token || !data.expiresAt) {
        showError("Something went wrong. Please try again.");
        enableSubmit();
        return;
      }
      storeAdminSession({ token: data.token, expiresAt: data.expiresAt });
      // Hash change triggers the admin router, which resolves #/dashboard
      // against the authenticated guard and renders the Task 17 placeholder.
      window.location.hash = "#/dashboard";
      return;
    }

    if (response.status === 401) {
      input.value = "";
      showError("Incorrect passphrase.");
      enableSubmit();
      input.focus();
      return;
    }

    if (response.status === 429) {
      const body = await safeJson(response);
      const headerVal = response.headers.get("Retry-After");
      const headerSec = headerVal ? Number.parseInt(headerVal, 10) : NaN;
      const bodySec = body && Number.isFinite(Number(body.retryAfterSec))
        ? Number(body.retryAfterSec)
        : NaN;
      const seconds = Number.isFinite(bodySec)
        ? bodySec
        : Number.isFinite(headerSec)
        ? headerSec
        : DEFAULT_LOCKOUT_SEC;
      showError("Too many attempts.");
      startLockout(seconds);
      return;
    }

    // 400, 500, 502, 503 … anything else that isn't a known branch.
    showError("Something went wrong. Please try again.");
    enableSubmit();
  });
}

/**
 * Parse ?reason=... from the URL, map it to banner copy, and clear the
 * query string so a reload does not persist the banner.
 * @returns {string|null}
 */
function readReasonBanner() {
  const search = window.location.search;
  if (!search) return null;
  const params = new URLSearchParams(search);
  const reason = params.get("reason");

  if (reason) {
    // Preserve the path + hash; drop the query. Non-fatal if replaceState
    // isn't available for some reason.
    const cleanUrl = window.location.pathname + window.location.hash;
    try {
      history.replaceState(null, "", cleanUrl);
    } catch (_err) {
      /* ignore */
    }
  }

  if (reason === "expired") return "Session expired. Please sign in again.";
  if (reason === "invalid") return "Please sign in to continue.";
  return null;
}

async function safeJson(response) {
  try {
    return await response.clone().json();
  } catch (_err) {
    return null;
  }
}
