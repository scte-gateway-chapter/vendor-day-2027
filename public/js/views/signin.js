// views/signin.js — attendee Sign-In view (post-launch feature).
//
// Mirrors the public GoDaddy sign-in page (Vendor Day Sign In HTML) so the
// in-app form and the GoDaddy page both POST to the SAME Zapier Catch Hook,
// which lands rows in a single Google Sheet. Field names, encoding, and
// content-type match the GoDaddy form verbatim so the Zap's Sheet mapping
// works for both intake paths without changes.
//
// The webhook URL is NOT hardcoded here. It arrives through `/api/config`
// as `signInWebhookUrl` (sourced from the Cloudflare env var
// `ZAPIER_SIGNIN_WEBHOOK_URL`). When the env var is missing, the view
// renders a graceful "not yet configured" placeholder — same pattern as
// other views degrade when their config is absent.
//
// Local persistence: on a successful submit, `{name, company, submittedAt}`
// is written to `localStorage` under `vendorday2027.signin.lastSubmission`.
// On re-visit the view short-circuits to a confirmation card with a
// "Sign in as someone else" reset link.
//
// No Firestore collection is created for sign-ins — the Google Sheet (via
// Zapier) is the source of truth. The design doc covers the rationale.
"use strict";

import { initFirestore } from "../firebase.js";
import * as ui from "../ui.js";
import { registerViewCleanup } from "../app.js";
import { relativeTime } from "../utils/time.js";

/** Keys shared with design + requirements for the sign-in flow. */
const LAST_SUBMISSION_KEY = "vendorday2027.signin.lastSubmission";

/**
 * Render the Sign-In view into `host`.
 * @param {HTMLElement} host  typically `#view-root`.
 * @returns {Promise<void>}
 */
export async function renderSignIn(host) {
  host.innerHTML = "";

  const sticky = buildStickyHeader();
  const body = document.createElement("section");
  body.className = "signin-body";
  body.setAttribute("aria-live", "polite");
  body.setAttribute("aria-label", "Sign in");

  host.append(sticky, body);

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    ui.showOfflineBanner();
  }

  document.title = "Sign In \u2014 Vendor Day 2027";

  // No long-lived subscriptions, but we still register an empty cleanup so
  // the router's beforeEach hook has something to drain and stays symmetric
  // with the other views.
  registerViewCleanup(() => {});

  // Short-circuit if this device has already signed in — the terminal state
  // is a confirmation card, not the form. The reset link rewrites to the
  // form state inline.
  const prior = readLastSubmission();
  if (prior) {
    renderConfirmationCard(body, prior);
    return;
  }

  // Load /api/config so we know the webhook URL. The call is shared with
  // the Firestore client and other views cache it, so this is usually a
  // no-op resolve against the primed promise.
  renderSkeleton(body);
  let config = null;
  try {
    config = await initFirestore();
  } catch (err) {
    console.warn("[signin] /api/config load failed:", err);
    renderConfigError(body, () => renderSignIn(host));
    return;
  }

  const webhookUrl =
    config && typeof config.signInWebhookUrl === "string" && config.signInWebhookUrl.trim()
      ? config.signInWebhookUrl.trim()
      : null;

  if (!webhookUrl) {
    console.warn(
      "[signin] signInWebhookUrl missing from /api/config \u2014 set ZAPIER_SIGNIN_WEBHOOK_URL in Cloudflare Pages env vars",
    );
    renderNotConfigured(body);
    return;
  }

  renderForm(body, webhookUrl);
}

export default renderSignIn;

/* ---------------- Sticky header ---------------- */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "view-sticky-header";
  // No ARIA role: shell <header id="app-header"> is the sole banner.
  // A second banner landmark fails Lighthouse's duplicate-banner rule.
  el.innerHTML = `<h2 class="view-sticky-header__title">Sign In</h2>`;
  return el;
}

/* ---------------- Loading / config error / unconfigured states ---------------- */

function renderSkeleton(host) {
  host.innerHTML = `
    <div class="skeleton-row" style="height: 20px; width: 40%;" aria-hidden="true"></div>
    <div class="skeleton-row" style="height: 44px; width: 90%;" aria-hidden="true"></div>
    <div class="skeleton-row" style="height: 20px; width: 40%;" aria-hidden="true"></div>
    <div class="skeleton-row" style="height: 44px; width: 90%;" aria-hidden="true"></div>
  `;
}

function renderConfigError(host, onRetry) {
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't load sign-in configuration.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  const btn = host.querySelector("[data-retry]");
  if (btn) btn.addEventListener("click", onRetry);
}

function renderNotConfigured(host) {
  host.innerHTML = `
    <div class="placeholder-card">
      <h2>Sign-in is not yet configured</h2>
      <p>In-app sign-in will open closer to the event. In the meantime, use the sign-in sheet linked from the event email.</p>
    </div>
  `;
}

/* ---------------- Form ---------------- */

function renderForm(host, webhookUrl) {
  host.innerHTML = "";

  const intro = document.createElement("p");
  intro.className = "signin-intro";
  intro.textContent = "Sign in so the Gateway Chapter board can confirm attendance. Required fields are marked with *.";
  host.append(intro);

  const form = document.createElement("form");
  form.className = "signin-form";
  form.setAttribute("novalidate", "novalidate");
  form.setAttribute("aria-label", "Vendor Day sign-in form");

  form.append(
    buildField({ id: "attendee-name", name: "attendee_name", label: "Name", type: "text", required: true, autocomplete: "name" }),
    buildField({ id: "company", name: "company", label: "Company", type: "text", required: true, autocomplete: "organization" }),
    buildField({ id: "office-location", name: "office_location", label: "Office Location", type: "text", required: true }),
    buildField({ id: "phone", name: "phone", label: "Phone Number", type: "tel", required: true, autocomplete: "tel" }),
    buildField({ id: "email", name: "email", label: "Email Address", type: "email", required: true, autocomplete: "email" }),
    buildField({ id: "scte-member", name: "scte_member_number", label: "SCTE Member Number", type: "text", required: false, hint: "Optional" }),
  );

  // Inline error/offline banner. Composes `.status-error` for the shared
  // red tone and `.signin-inline-banner` for the local flex layout with an
  // optional Retry button. Kept in the DOM so aria-live replaces land in
  // the same place on repeated retries.
  const banner = document.createElement("div");
  banner.className = "status-error signin-inline-banner";
  banner.setAttribute("role", "alert");
  banner.hidden = true;
  form.append(banner);

  const actions = document.createElement("div");
  actions.className = "signin-form__actions";

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "btn-primary signin-submit-btn";
  submitBtn.innerHTML = `
    <span class="signin-submit-btn__spinner" aria-hidden="true"></span>
    <span class="signin-submit-btn__label">Sign In</span>
  `;
  actions.append(submitBtn);
  form.append(actions);

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    hideBanner(banner);

    const { ok, firstInvalid, payload } = validateAndCollect(form);
    if (!ok) {
      focusFirstInvalid(firstInvalid);
      return;
    }

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      showBanner(banner, "No connection \u2014 please check your network and try again.");
      return;
    }

    setSubmitInFlight(submitBtn, true);
    try {
      await postFormEncoded(webhookUrl, payload);
      const submittedAt = new Date().toISOString();
      const record = {
        name: payload.attendee_name,
        company: payload.company,
        submittedAt,
      };
      writeLastSubmission(record);
      ui.toast("success", "You're signed in \u2014 thanks!");
      renderConfirmationCard(host, record);
    } catch (err) {
      console.warn("[signin] submit failed:", err);
      showBannerWithRetry(banner, () => form.requestSubmit());
    } finally {
      // When the form was replaced by the confirmation card above, submitBtn
      // is detached and setSubmitInFlight becomes a no-op. The guard is
      // important for the error path, which keeps the form rendered with
      // the user's typed values intact.
      if (submitBtn.isConnected) setSubmitInFlight(submitBtn, false);
    }
  });

  host.append(form);
}

/**
 * Build a `.form-field` block with label + input + inline error slot.
 * `required` adds the red asterisk and marks the input `required`.
 * `hint` is an optional secondary line below the label.
 */
function buildField({ id, name, label, type, required, autocomplete, hint }) {
  const wrap = document.createElement("div");
  wrap.className = "form-field signin-field";
  wrap.dataset.fieldName = name;

  const lab = document.createElement("label");
  lab.setAttribute("for", id);
  lab.innerHTML = `${escapeHtml(label)}${
    required
      ? ` <span class="required" aria-hidden="true">*</span><span class="sr-only"> required</span>`
      : ""
  }`;
  wrap.append(lab);

  if (hint) {
    const hintEl = document.createElement("span");
    hintEl.className = "signin-field__hint";
    hintEl.textContent = hint;
    wrap.append(hintEl);
  }

  const input = document.createElement("input");
  input.id = id;
  input.name = name;
  input.type = type;
  if (required) input.required = true;
  if (autocomplete) input.setAttribute("autocomplete", autocomplete);
  input.setAttribute("maxlength", "200");
  const errId = `signin-err-${id}`;
  input.setAttribute("aria-describedby", errId);
  wrap.append(input);

  const err = document.createElement("div");
  err.className = "error-message signin-field__error";
  err.id = errId;
  err.hidden = true;
  wrap.append(err);

  return wrap;
}

/* ---------------- Validation + collection ---------------- */

function validateAndCollect(form) {
  const fields = [
    { name: "attendee_name", label: "Name", required: true },
    { name: "company", label: "Company", required: true },
    { name: "office_location", label: "Office Location", required: true },
    { name: "phone", label: "Phone Number", required: true, kind: "phone" },
    { name: "email", label: "Email Address", required: true, kind: "email" },
    { name: "scte_member_number", label: "SCTE Member Number", required: false },
  ];

  const payload = {};
  let firstInvalid = null;

  for (const f of fields) {
    const block = form.querySelector(`[data-field-name="${f.name}"]`);
    const input = block ? block.querySelector("input") : null;
    const errEl = block ? block.querySelector(".signin-field__error") : null;
    if (!block || !input || !errEl) continue;
    clearInvalid(block, input, errEl);

    const trimmed = (input.value || "").trim();
    payload[f.name] = trimmed;

    if (f.required && !trimmed) {
      setInvalid(block, input, errEl, `Please enter your ${f.label.toLowerCase()}.`);
      if (!firstInvalid) firstInvalid = input;
      continue;
    }
    if (trimmed && f.kind === "email" && !isLikelyEmail(trimmed)) {
      setInvalid(block, input, errEl, "Please enter a valid email address.");
      if (!firstInvalid) firstInvalid = input;
      continue;
    }
    if (trimmed && f.kind === "phone" && !isLikelyPhone(trimmed)) {
      setInvalid(block, input, errEl, "Please enter a valid phone number.");
      if (!firstInvalid) firstInvalid = input;
      continue;
    }
  }

  // Mirror the GoDaddy form's `signed_in_at` field so Zapier receives the
  // same shape from both intake paths. Local time string (not ISO) matches
  // the public form byte-for-byte.
  payload.signed_in_at = new Date().toLocaleString();

  return { ok: firstInvalid == null, firstInvalid, payload };
}

function isLikelyEmail(s) {
  // Deliberately permissive: Zapier / the Sheet is the source of truth
  // and will tolerate loose formats. We only block obvious typos.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function isLikelyPhone(s) {
  // Strip common separators and require at least seven digits.
  const digits = s.replace(/[^\d]/g, "");
  return digits.length >= 7;
}

function setInvalid(block, input, errEl, message) {
  block.setAttribute("aria-invalid", "true");
  input.setAttribute("aria-invalid", "true");
  errEl.textContent = message;
  errEl.hidden = false;
}

function clearInvalid(block, input, errEl) {
  block.removeAttribute("aria-invalid");
  input.removeAttribute("aria-invalid");
  errEl.textContent = "";
  errEl.hidden = true;
}

function focusFirstInvalid(input) {
  if (!input) return;
  try { input.focus({ preventScroll: true }); } catch (_err) { input.focus(); }
  try {
    input.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch (_err) {
    try { input.scrollIntoView(); } catch (_e) { /* no-op */ }
  }
}

/* ---------------- Submit + banner helpers ---------------- */

function setSubmitInFlight(btn, inFlight) {
  if (!btn) return;
  btn.disabled = inFlight;
  btn.setAttribute("aria-busy", inFlight ? "true" : "false");
  btn.classList.toggle("signin-submit-btn--loading", inFlight);
  const label = btn.querySelector(".signin-submit-btn__label");
  if (label) label.textContent = inFlight ? "Signing in\u2026" : "Sign In";
}

function showBanner(el, message) {
  el.innerHTML = `<span>${escapeHtml(message)}</span>`;
  el.hidden = false;
  try {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch (_err) { /* no-op */ }
}

function showBannerWithRetry(el, onRetry) {
  el.innerHTML = `
    <span>Submission failed. Please try again.</span>
    <button type="button" class="btn-secondary" data-retry>Retry</button>
  `;
  el.hidden = false;
  const btn = el.querySelector("[data-retry]");
  if (btn) {
    btn.addEventListener("click", () => {
      hideBanner(el);
      onRetry();
    });
  }
  try {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch (_err) { /* no-op */ }
}

function hideBanner(el) {
  el.hidden = true;
  el.innerHTML = "";
}

/* ---------------- Webhook POST ---------------- */

/**
 * POST a plain JS object as `application/x-www-form-urlencoded` to the
 * Zapier webhook. Matches the public GoDaddy form's content-type and body
 * shape so the Zap's Sheet mapping works for both intake paths without
 * changes. Resolves on 2xx; rejects on non-2xx or network error.
 */
async function postFormEncoded(url, payload) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(payload)) {
    body.append(k, v == null ? "" : String(v));
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
    mode: "cors",
  });
  if (!res.ok) {
    const err = new Error(`Sign-in webhook returned ${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
}

/* ---------------- Confirmation card ---------------- */

function renderConfirmationCard(host, record) {
  const when = relativeTime(record.submittedAt);
  const whenLabel = when ? `Signed in ${when}` : "Signed in";
  const nameLine = record.company
    ? `${record.name} (${record.company})`
    : record.name;

  host.innerHTML = `
    <section class="signin-confirmation-card" role="status" aria-label="Signed in">
      <h2 class="signin-confirmation-card__title">You're signed in \u2014 thanks, ${escapeHtml(record.name)}!</h2>
      <p class="signin-confirmation-card__who">Signed in as ${escapeHtml(nameLine)}.</p>
      <p class="signin-confirmation-card__meta">${escapeHtml(whenLabel)}.</p>
      <p class="signin-confirmation-card__body">
        Your sign-in has been recorded. Enjoy the show.
      </p>
      <div class="signin-confirmation-card__actions">
        <button type="button" class="btn-secondary" data-action="reset">Sign in as someone else</button>
      </div>
    </section>
  `;
  const btn = host.querySelector('[data-action="reset"]');
  if (btn) {
    btn.addEventListener("click", async () => {
      clearLastSubmission();
      // Re-run the full render path so we hit the config load branch and
      // land back on the form (or the "not configured" state if the env
      // var has since been cleared).
      const container = host.parentElement; // #view-root
      if (container) await renderSignIn(container);
    });
  }
}

/* ---------------- localStorage helpers ---------------- */

function readLastSubmission() {
  try {
    const raw = localStorage.getItem(LAST_SUBMISSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.name !== "string" || !parsed.name) return null;
    return {
      name: parsed.name,
      company: typeof parsed.company === "string" ? parsed.company : "",
      submittedAt: typeof parsed.submittedAt === "string" ? parsed.submittedAt : "",
    };
  } catch (_err) {
    return null;
  }
}

function writeLastSubmission(record) {
  try {
    localStorage.setItem(LAST_SUBMISSION_KEY, JSON.stringify(record));
  } catch (err) {
    console.warn("[signin] last-submission write failed:", err);
  }
}

function clearLastSubmission() {
  try {
    localStorage.removeItem(LAST_SUBMISSION_KEY);
  } catch (err) {
    console.warn("[signin] last-submission clear failed:", err);
  }
}

/**
 * Exposed so other views (Home quick-action, More menu entry) can read the
 * same "already signed in" flag without duplicating the key or parsing logic.
 * @returns {{ name: string, company: string, submittedAt: string } | null}
 */
export function getLastSignIn() {
  return readLastSubmission();
}

/* ---------------- Escaping ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
