// views/pre-register-bsc.js — standalone BSC pre-registration page.
//
// Reachable only by URL (`#/pre-register-bsc`) shared with managers
// out-of-band. NOT linked from any attendee-facing navigation and NOT
// gated by `bscEnabled` so managers can pre-register before the day-of
// toggle flips. POSTs to the new `/api/bsc-register` Pages Function
// which upserts `bscPreReg/{emailLowered}` via the service account.
//
// Reuses `buildField` + `postFormEncoded` + the inline email / phone
// validators from `./signin.js` so the chrome (labels, `.form-field`
// primitive, aria-describedby error wiring) and the server-side bar
// stay in lockstep with the attendee sign-in form.
//
// NO email confirmation sent in Phase 1 (admin runbook notes the
// future consideration — the existing Google Form Zap keeps the email
// confirmation path alive until Phase 3 retires it).
"use strict";

import { buildField, postFormEncoded } from "./signin.js";
import { registerViewCleanup } from "../app.js";

const ENDPOINT = "/api/bsc-register";

/**
 * Render the standalone BSC pre-registration form into `host`.
 * @param {HTMLElement} host  typically `#view-root`.
 * @returns {Promise<void>}
 */
export async function renderPreRegisterBsc(host) {
  host.innerHTML = "";

  const sticky = buildStickyHeader();
  const body = document.createElement("section");
  body.className = "pre-register-view__body";
  body.setAttribute("aria-live", "polite");
  body.setAttribute("aria-label", "BSC pre-registration");

  const wrapper = document.createElement("div");
  wrapper.className = "pre-register-view";
  wrapper.append(sticky, body);
  host.append(wrapper);

  document.title = "BSC Pre-Registration \u2014 Vendor Day 2027";

  // No long-lived subscriptions; register an empty cleanup for symmetry
  // with the other views so the router's beforeEach hook has something
  // to drain.
  registerViewCleanup(() => {});

  renderForm(body);
}

export default renderPreRegisterBsc;

/* ---------------- Sticky header ---------------- */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "view-sticky-header";
  // No ARIA role: shell <header id="app-header"> is the sole banner.
  el.innerHTML = `<h2 class="view-sticky-header__title">BSC Pre-Registration</h2>`;
  return el;
}

/* ---------------- Form ---------------- */

/**
 * Field list reused by `renderForm`, `collectValues`, and `renderFormWith`
 * so the single source of truth for shape + validation lives in one place.
 */
const FIELDS = [
  { id: "attendee_name", name: "attendee_name", label: "Competitor name", type: "text", required: true, autocomplete: "name" },
  { id: "email", name: "email", label: "Email", type: "email", required: true, autocomplete: "email", kind: "email" },
  { id: "company", name: "company", label: "Company", type: "text", required: true, autocomplete: "organization" },
  { id: "office_location", name: "office_location", label: "Office location", type: "text", required: true },
  { id: "job_role", name: "job_role", label: "Job role", type: "text", required: true, autocomplete: "organization-title" },
  { id: "supervisor_name", name: "supervisor_name", label: "Supervisor name", type: "text", required: true },
  { id: "supervisor_email", name: "supervisor_email", label: "Supervisor email", type: "email", required: true, autocomplete: "email", kind: "email" },
  { id: "supervisor_phone", name: "supervisor_phone", label: "Supervisor phone", type: "tel", required: true, autocomplete: "tel", kind: "phone" },
  { id: "scte_member_id", name: "scte_member_id", label: "SCTE member #", type: "text", required: false, hint: "Optional" },
];

function renderForm(host, prefill = null) {
  host.innerHTML = "";

  const intro = document.createElement("p");
  intro.className = "signin-intro";
  intro.textContent =
    "Pre-register a competitor for the Broadband Skills Challenge. Required fields are marked with *.";
  host.append(intro);

  const form = document.createElement("form");
  form.className = "signin-form";
  form.setAttribute("novalidate", "novalidate");
  form.setAttribute("aria-label", "BSC pre-registration form");

  for (const f of FIELDS) {
    form.append(
      buildField({
        id: f.id,
        name: f.name,
        label: f.label,
        type: f.type,
        required: f.required,
        autocomplete: f.autocomplete,
        hint: f.hint,
      }),
    );
  }

  // Re-populate from a previous submit attempt (preserved on failure
  // per the brief's Retry behavior).
  if (prefill && typeof prefill === "object") {
    for (const f of FIELDS) {
      const input = form.querySelector(`[data-field-name="${f.name}"] input`);
      if (input && typeof prefill[f.name] === "string") input.value = prefill[f.name];
    }
  }

  // Inline error / status banner.
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
    <span class="signin-submit-btn__label">Pre-register</span>
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
      const result = await postFormEncodedJson(ENDPOINT, payload);
      if (result && result.ok === true) {
        renderConfirmationCard(host, payload, result);
      } else {
        showBannerWithRetry(
          banner,
          humanReason(result && result.reason) || "Pre-registration failed. Please try again.",
          () => form.requestSubmit(),
        );
      }
    } catch (err) {
      console.warn("[pre-register-bsc] submit failed:", err);
      showBannerWithRetry(
        banner,
        humanReason(err && err.reason) || "Pre-registration failed. Please try again.",
        () => form.requestSubmit(),
      );
    } finally {
      if (submitBtn.isConnected) setSubmitInFlight(submitBtn, false);
    }
  });

  host.append(form);
}

/* ---------------- Validation + collection ---------------- */

function validateAndCollect(form) {
  const payload = {};
  let firstInvalid = null;

  for (const f of FIELDS) {
    const block = form.querySelector(`[data-field-name="${f.name}"]`);
    const input = block ? block.querySelector("input") : null;
    const errEl = block ? block.querySelector(".signin-field__error") : null;
    if (!block || !input) continue;
    if (errEl) clearInvalid(block, input, errEl);

    const trimmed = (input.value || "").trim();
    payload[f.name] = trimmed;

    if (f.required && !trimmed) {
      if (errEl) setInvalid(block, input, errEl, `Please enter ${lower(f.label)}.`);
      if (!firstInvalid) firstInvalid = input;
      continue;
    }
    if (trimmed && f.kind === "email" && !isLikelyEmail(trimmed)) {
      if (errEl) setInvalid(block, input, errEl, "Please enter a valid email address.");
      if (!firstInvalid) firstInvalid = input;
      continue;
    }
    if (trimmed && f.kind === "phone" && !isLikelyPhone(trimmed)) {
      if (errEl) setInvalid(block, input, errEl, "Please enter a valid phone number.");
      if (!firstInvalid) firstInvalid = input;
      continue;
    }
  }

  return { ok: firstInvalid == null, firstInvalid, payload };
}

// Permissive client-side validators mirroring the server regex in
// `functions/api/bsc-register.js`. Inlined (not imported from signin.js)
// because signin.js keeps them module-local; copying the two one-liners
// is cheaper than widening the signin.js export surface.
function isLikelyEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function isLikelyPhone(s) {
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

function lower(s) {
  return String(s || "").toLowerCase();
}

/* ---------------- Submit + banner helpers ---------------- */

function setSubmitInFlight(btn, inFlight) {
  if (!btn) return;
  btn.disabled = inFlight;
  btn.setAttribute("aria-busy", inFlight ? "true" : "false");
  btn.classList.toggle("signin-submit-btn--loading", inFlight);
  const label = btn.querySelector(".signin-submit-btn__label");
  if (label) label.textContent = inFlight ? "Submitting\u2026" : "Pre-register";
}

function showBanner(el, message) {
  el.innerHTML = `<span>${escapeHtml(message)}</span>`;
  el.hidden = false;
  try {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch (_err) { /* no-op */ }
}

function showBannerWithRetry(el, message, onRetry) {
  el.innerHTML = `
    <span>${escapeHtml(message)}</span>
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

/* ---------------- Server call ---------------- */

/**
 * POST `payload` as `application/x-www-form-urlencoded` and read the JSON
 * body. Reuses `postFormEncoded` from signin.js (which only resolves on
 * 2xx) via a thin wrapper that parses the response the server sends.
 * On non-2xx `postFormEncoded` throws with `.status` attached; we try
 * to read the JSON reason first via a direct fetch below.
 */
async function postFormEncodedJson(url, payload) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(payload)) {
    body.append(k, v == null ? "" : String(v));
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "application/json",
    },
    body,
  });
  let parsed = null;
  try { parsed = await res.json(); } catch (_err) { /* fall through */ }
  if (!res.ok) {
    const err = new Error(
      `bsc-register returned ${res.status} ${res.statusText}`,
    );
    err.status = res.status;
    err.reason = parsed && typeof parsed.reason === "string" ? parsed.reason : null;
    throw err;
  }
  return parsed || { ok: false, reason: "unknown" };
}

// Reference `postFormEncoded` so it is clearly part of the dependency
// surface even though we use the private `postFormEncodedJson` wrapper
// above to read `{ ok: false, reason }` bodies on non-2xx. Removing the
// import would silently drop the "shared sign-in form chrome" tether to
// signin.js — this keeps the two paths co-located for grep.
void postFormEncoded;

function humanReason(reason) {
  if (!reason || typeof reason !== "string") return null;
  if (reason === "rate-limited") {
    return "Too many submissions from this network. Please try again in an hour.";
  }
  if (reason === "timeout") {
    return "Server timed out. Please try again.";
  }
  if (reason === "upstream") {
    return "The pre-registration server is temporarily unavailable. Please try again shortly.";
  }
  if (reason === "invalid-body" || reason === "server-error") {
    return "Pre-registration failed. Please try again.";
  }
  if (reason.endsWith(" required")) {
    const field = reason.replace(" required", "");
    return `Please provide ${field.replace(/_/g, " ")}.`;
  }
  if (reason.endsWith(" invalid")) {
    const field = reason.replace(" invalid", "");
    return `Please check the ${field.replace(/_/g, " ")} value.`;
  }
  return reason;
}

/* ---------------- Confirmation ---------------- */

function renderConfirmationCard(host, payload, result) {
  const competitor = String(payload.attendee_name || "").trim() || "this competitor";
  const referenceId = (result && typeof result.reference_id === "string") ? result.reference_id : "";
  const serverEmail = (result && typeof result.email === "string") ? result.email : (payload.email || "").trim().toLowerCase();

  host.innerHTML = `
    <section class="placeholder-card" role="status" aria-label="Pre-registration confirmed">
      <h2>Thanks \u2014 ${escapeHtml(competitor)} is pre-registered for the Broadband Skills Challenge. We'll see you on event day.</h2>
      ${referenceId ? `<p>Reference ID: <strong>${escapeHtml(referenceId)}</strong></p>` : ""}
      ${serverEmail ? `<p>Email on file: ${escapeHtml(serverEmail)}</p>` : ""}
      <p>Re-submitting with the same email overwrites every stored field (including the reference ID). Save this card if you need the current reference for your records.</p>
      <div class="signin-form__actions">
        <button type="button" class="btn-secondary" data-action="again">Pre-register another competitor</button>
      </div>
    </section>
  `;
  const btn = host.querySelector('[data-action="again"]');
  if (btn) {
    btn.addEventListener("click", () => {
      renderForm(host);
    });
  }
}

/* ---------------- Escaping ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
