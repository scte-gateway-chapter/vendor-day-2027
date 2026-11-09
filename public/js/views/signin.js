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

import { initFirestore, getDoc, createDoc } from "../firebase.js";
import { loadAppSettings, isSignInEnabled, isBscEnabled } from "../app-settings.js";
import * as router from "../router.js";
import * as ui from "../ui.js";
import { registerViewCleanup } from "../app.js";
import { relativeTime } from "../utils/time.js";
import { installFocusTrap } from "../utils/focus-trap.js";
import { pushDebugLog } from "../debug-log.js";

/** Retroactive BSC-flip POST timeout. Zapier Catch Hook responses in the
 *  field are consistently sub-second; 5 seconds is a conservative cap that
 *  guarantees the user's `#/bsc` navigation never stalls behind a hung
 *  webhook. See design section 17 ("Retroactive sign-in update") and
 *  requirement 14.6.7. */
const BSC_RETROACTIVE_POST_TIMEOUT_MS = 5000;

/** Keys shared with design + requirements for the sign-in flow. */
const LAST_SUBMISSION_KEY = "vendorday2027.signin.lastSubmission";
/** BSC pre-reg prompt + return-after-signin flag keys (see design section 17). */
const BSC_PROMPT_SUPPRESS_KEY = "vendorday2027.bsc.promptSuppressSubmittedAt";
const BSC_RETURN_AFTER_SIGNIN_KEY = "vendorday2027.bsc.returnAfterSignIn";
const BSC_PRECHECK_ON_SIGNIN_KEY = "vendorday2027.bsc.preCheckOnSignIn";

/** Phase 1 dual-write: id of the just-created `signIns/{docId}` document.
 *  Written from the chained Firestore create on sign-in success; read by
 *  the retroactive `/api/signin-mark-bsc` call when the attendee accepts
 *  the pre-reg prompt. Module-scoped is the authoritative source during
 *  the current page lifetime; the localStorage mirror below survives a
 *  reload between sign-in and the retroactive prompt. */
let lastSignInDocId = null;
const SIGNIN_LAST_DOC_ID_KEY = "vendorday2027.signin.lastDocId";

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

  // Admin gate: `signInEnabled` on appSettings/singleton controls whether
  // the Sign-In form is open to attendees. The toggle is fail-closed —
  // when the fetch fails or the field is missing it stays off. Prime the
  // shared cache first so the check below reflects the latest write.
  try { await loadAppSettings(); } catch (_err) { /* fail-closed */ }
  const prior = readLastSubmission();

  if (!isSignInEnabled()) {
    // Deep-link / bookmark reached #/sign-in while the admin has sign-in
    // turned off. Attendees with a prior stored submission see their
    // confirmation card as a read-only informational state (no "Sign in
    // as someone else" reset, because re-signing isn't allowed while
    // disabled). Everyone else sees a friendly "not available yet"
    // placeholder.
    if (prior) {
      renderConfirmationCard(body, prior, { readOnly: true });
    } else {
      renderDisabledPlaceholder(body);
    }
    return;
  }

  // Short-circuit if this device has already signed in — the terminal state
  // is a confirmation card, not the form. The reset link rewrites to the
  // form state inline.
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

  // BSC pre-check-on-mount handshake. The flag is read and cleared
  // immediately so a reload doesn't persist the state (see design
  // section 17 → flag lifecycle table).
  let preCheckBsc = false;
  try {
    preCheckBsc = sessionStorage.getItem(BSC_PRECHECK_ON_SIGNIN_KEY) === "1";
    if (preCheckBsc) sessionStorage.removeItem(BSC_PRECHECK_ON_SIGNIN_KEY);
  } catch (_err) { /* no-op */ }

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

  // BSC competitor checkbox — rendered only when the admin has flipped
  // `bscEnabled` on. When off, no form field is attached and
  // validateAndCollect sends `bsc_competitor: "no"` on every submit (see
  // design NIT 8, Option A — the main sign-in Zap column always carries
  // an explicit value).
  if (isBscEnabled()) {
    const bscField = buildField({
      id: "bsc-competitor",
      name: "bsc_competitor",
      label: "I'm competing in the Broadband Skills Challenge today",
      type: "checkbox",
    });
    form.append(bscField);
    if (preCheckBsc) {
      const checkbox = bscField.querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.checked = true;
    }
  }

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

    const { ok, firstInvalid, payload, bscChecked } = validateAndCollect(form);
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
        email: (payload.email || "").trim().toLowerCase(),
        phone: payload.phone || "",
        office_location: payload.office_location || "",
        scte_member_number: payload.scte_member_number || "",
      };
      writeLastSubmission(record);
      ui.toast("success", "You're signed in \u2014 thanks!");
      renderConfirmationCard(host, record);
      // Phase 1 dual-write: chained Firestore `signIns` create.
      //
      // Chained AFTER Zapier success. Fire-and-forget — the submit
      // handler does not await this and the confirmation card has
      // already rendered. Chaining (vs. the brief's original "parallel
      // / Promise.allSettled" wording in confirmed decision 4) closes
      // two race paths the design review iteration 3 flagged on the
      // parallel-with-guard orchestration:
      //   (a) Zapier rejects while a parallel Firestore create is still
      //       in flight → user clicks Retry → second create fires
      //       because the first hasn't resolved yet → duplicate row.
      //   (b) Firestore write actually succeeds but the client-side
      //       10s timeout rejects first → state gets cleared → retry
      //       fires a second create → duplicate row + orphan.
      // Chaining eliminates both: the Firestore leg only ever runs
      // after Zapier returned 2xx, and Zapier-2xx means the retry
      // banner is never shown, so there is no mechanism for a second
      // submit on this page lifecycle. (The attendee can still "Sign
      // in as someone else" which calls clearLastSubmission() → both
      // state slots cleared → fresh submit cycle is correctly
      // independent.) The brief's stronger clauses — "Do NOT block UI
      // on either" and "Confirmation card renders as soon as the
      // Zapier POST resolves" — are honored verbatim; attendee-visible
      // latency is unchanged. Supersedes decision 4's "IN PARALLEL"
      // wording per design iteration 4 (correctness over performance).
      kickOffSignInsCreate(payload);
      // Post-submit BSC routing. Runs after the confirmation card
      // renders so a slow Firestore GET never delays the attendee's
      // "You're signed in" feedback. The original `payload` and the
      // `webhookUrl` ride along so the pre-reg prompt's Yes-path can
      // fire a retroactive `bsc_competitor=yes` POST without rebuilding
      // the form shape (see requirement 14.6.7 / design section 17).
      if (isBscEnabled()) {
        void maybeRouteOrPromptForBsc(record, bscChecked, payload, webhookUrl);
      }
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
 *
 * `type: "checkbox"` builds a wrapper-label pattern (input inside the
 * label) so the label click toggles the checkbox natively; no inline
 * error slot is attached because the BSC checkbox is optional and the
 * electronic-waiver checkbox is gated by a disabled Submit button
 * rather than per-field validation. Preserve the full signature
 * (including `autocomplete`) so the BSC flow in `bsc.js` can reuse this
 * helper without regressing WCAG 1.3.5 Input Purpose on text fields.
 *
 * Exported so `public/js/views/bsc.js` can build its intake forms with
 * the same chrome and the same signature (see design → MEDIUM finding 4).
 */
export function buildField({ id, name, label, type, required, autocomplete, hint }) {
  const wrap = document.createElement("div");
  wrap.dataset.fieldName = name;

  if (type === "checkbox") {
    wrap.className = "form-field signin-field signin-field--checkbox";
    const lab = document.createElement("label");
    lab.setAttribute("for", id);
    const input = document.createElement("input");
    input.id = id;
    input.name = name;
    input.type = "checkbox";
    if (required) input.required = true;
    lab.append(input, document.createTextNode(` ${label}`));
    wrap.append(lab);
    return wrap;
  }

  wrap.className = "form-field signin-field";

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

  // BSC competitor flag — always sent on every submit so the main sign-in
  // Sheet's "BSC Competitor" column is never a mixed blank/yes/no mess
  // (design NIT 8, Option A). When `bscEnabled === false` the checkbox is
  // not rendered and the value is "no".
  const bscCheckbox = form.querySelector('[data-field-name="bsc_competitor"] input');
  payload.bsc_competitor = bscCheckbox && bscCheckbox.checked ? "yes" : "no";

  return { ok: firstInvalid == null, firstInvalid, payload, bscChecked: !!(bscCheckbox && bscCheckbox.checked) };
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

/* ---------------- Firestore signIns dual-write ---------------- */

/**
 * Fire the chained Firestore write of the sign-in record. Returns a
 * promise that resolves to the created doc (with `.id`) or rejects on
 * any underlying createDoc failure (non-2xx, network, CORS, etc). The
 * caller runs this AFTER the Zapier POST resolves 2xx and attaches
 * .then/.catch; the submit handler does not await it.
 *
 * Deliberately NO Promise.race timeout wrapper: a client-side timeout
 * that rejects while Firestore actually wrote would orphan a doc and
 * (worse, in the pre-iteration-4 design) clear state so a retry
 * duplicates the row. Chaining eliminates the retry-duplicate risk
 * entirely, so we let the underlying fetch resolve or reject on its
 * own schedule. Observational "slow write" logging lives in the caller
 * (`kickOffSignInsCreate`) and is purely a debug-feed signal.
 */
async function createSignInDoc(payload) {
  const doc = {
    attendee_name:      payload.attendee_name,
    company:            payload.company,
    office_location:    payload.office_location,
    phone:              payload.phone,
    email:              (payload.email || "").trim().toLowerCase(),
    scte_member_number: payload.scte_member_number || "",
    signed_in_at:       payload.signed_in_at,       // same locale string as Zap
    bsc_competitor:     payload.bsc_competitor,     // "yes" | "no"
    source:             "app",
    createdAt:          new Date().toISOString(),
  };
  return await createDoc("signIns", doc);
}

/**
 * Fire-and-forget wrapper around `createSignInDoc`. Writes the returned
 * docId into both module state and `localStorage` on success so the
 * retroactive `/api/signin-mark-bsc` call in `openPreRegPrompt → go()`
 * can target the correct row. On failure, logs and leaves state alone
 * (the chain only runs after a Zapier success, so there is no stale
 * state to clear from this submit's own prior attempt).
 */
function kickOffSignInsCreate(payload) {
  // Observational "slow write" log at 10s. Instrumentation ONLY — does
  // NOT reject the create, does NOT clear state, does NOT trigger a
  // retry. The underlying fetch inside createDoc will eventually
  // resolve or reject on its own schedule; chaining means a slow-but-
  // successful write still lands with the correct docId in state (no
  // orphan path).
  const slowLogTimer = setTimeout(() => {
    pushDebugLog("signin", "signIns create slow (>10s), still waiting", {});
  }, 10000);
  createSignInDoc(payload)
    .then((doc) => {
      clearTimeout(slowLogTimer);
      if (!doc || !doc.id) {
        pushDebugLog("signin", "signIns create returned no id", { doc });
        return;
      }
      lastSignInDocId = doc.id;
      try { localStorage.setItem(SIGNIN_LAST_DOC_ID_KEY, doc.id); } catch (_err) { /* no-op */ }
      pushDebugLog("signin", "signIns created", {
        docId: doc.id,
        email: (payload.email || "").trim().toLowerCase(),
      });
    })
    .catch((err) => {
      clearTimeout(slowLogTimer);
      // Do NOT touch lastSignInDocId / SIGNIN_LAST_DOC_ID_KEY here.
      // The chain only runs after a successful Zapier POST, so there
      // is no stale state to clear from a prior attempt in this page
      // lifecycle, and clearing them now would open the door to a
      // confusingly-empty retroactive flow if the user accepts the
      // pre-reg prompt before this .catch fires.
      pushDebugLog("signin", "signIns create FAILED", {
        err: String(err && err.message || err),
      });
      console.warn("[signin] signIns create failed:", err);
    });
}

/* ---------------- Webhook POST ---------------- */

/**
 * POST a plain JS object as `application/x-www-form-urlencoded` to the
 * Zapier webhook. Matches the public GoDaddy form's content-type and body
 * shape so the Zap's Sheet mapping works for both intake paths without
 * changes. Resolves on 2xx; rejects on non-2xx or network error.
 */
export async function postFormEncoded(url, payload) {
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

/**
 * Render the "You're signed in" confirmation card. When `readOnly` is
 * true the "Sign in as someone else" reset button is omitted — used when
 * the admin has turned sign-in off but the attendee has a prior
 * submission on this device, so the card is informational only.
 * @param {HTMLElement} host
 * @param {{ name: string, company: string, submittedAt: string }} record
 * @param {{ readOnly?: boolean }} [opts]
 */
function renderConfirmationCard(host, record, opts = {}) {
  const { readOnly = false } = opts;
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
      ${
        readOnly
          ? ""
          : `
      <div class="signin-confirmation-card__actions">
        <button type="button" class="btn-secondary" data-action="reset">Sign in as someone else</button>
      </div>`
      }
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

/**
 * Friendly placeholder shown on `#/sign-in` when the admin has not yet
 * flipped `signInEnabled` on. Deep-link / bookmark gap closer: without
 * this, an attendee reaching the route before sign-in opens would see
 * the form (which would then POST a submission). Reuses the shared
 * `.placeholder-card` empty-state styling so the view matches the rest
 * of the "coming soon" surfaces in the app.
 * @param {HTMLElement} host
 */
function renderDisabledPlaceholder(host) {
  host.innerHTML = `
    <section class="placeholder-card" aria-live="polite">
      <h2>Sign-in isn't available yet</h2>
      <p>Check back closer to the event.</p>
      <button type="button" class="btn-secondary" data-action="home">Back to Home</button>
    </section>
  `;
  const btn = host.querySelector('[data-action="home"]');
  if (btn) {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      router.navigate("/home");
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
      email: typeof parsed.email === "string" ? parsed.email : "",
      phone: typeof parsed.phone === "string" ? parsed.phone : "",
      office_location: typeof parsed.office_location === "string" ? parsed.office_location : "",
      scte_member_number: typeof parsed.scte_member_number === "string" ? parsed.scte_member_number : "",
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
    localStorage.removeItem(BSC_PROMPT_SUPPRESS_KEY);
    localStorage.removeItem(SIGNIN_LAST_DOC_ID_KEY);
  } catch (err) {
    console.warn("[signin] last-submission clear failed:", err);
  }
  // Phase 1 dual-write: reset the module-scoped signIns docId alongside
  // the localStorage mirror so "Sign in as someone else" starts a fresh
  // session with both slots empty.
  lastSignInDocId = null;
  try {
    sessionStorage.removeItem(BSC_RETURN_AFTER_SIGNIN_KEY);
    sessionStorage.removeItem(BSC_PRECHECK_ON_SIGNIN_KEY);
  } catch (_err) { /* no-op */ }
}

/* ---------------- BSC post-sign-in routing + pre-reg prompt ---------------- */

/**
 * After a successful sign-in POST, decide whether to navigate directly
 * to `#/bsc` or show the pre-reg prompt dialog. Called only when
 * `isBscEnabled() === true`. Any failure in the Firestore pre-reg
 * lookup is swallowed with a `console.warn` — the attendee's
 * confirmation card is never disturbed by a transient read error
 * (design 14.6.5).
 *
 * @param {object} record  the attendee's confirmation-card record (normalized subset)
 * @param {boolean} bscCheckboxWasChecked  whether the attendee checked the BSC box
 * @param {object} originalPayload  the exact object just POSTed to the sign-in Zap
 *   (used by the Yes-path of the pre-reg prompt to fire a retroactive
 *   `bsc_competitor=yes` POST without rebuilding the field shape).
 * @param {string} webhookUrl  the sign-in Zap webhook URL (same URL the
 *   original POST targeted; threaded through so the pre-reg prompt can
 *   reach it without re-reading `/api/config`).
 */
async function maybeRouteOrPromptForBsc(record, bscCheckboxWasChecked, originalPayload, webhookUrl) {
  // 1. Return-handshake from a #/bsc deep-link that bounced to sign-in.
  let returnAfter = null;
  try { returnAfter = sessionStorage.getItem(BSC_RETURN_AFTER_SIGNIN_KEY); } catch (_err) { /* no-op */ }
  if (returnAfter === "1") {
    try { sessionStorage.removeItem(BSC_RETURN_AFTER_SIGNIN_KEY); } catch (_err) { /* no-op */ }
    router.navigate("/bsc");
    return;
  }

  // 2. Attendee explicitly checked the BSC box — go to the BSC flow.
  if (bscCheckboxWasChecked) {
    router.navigate("/bsc");
    return;
  }

  // 3. Pre-reg prompt eligibility — fire a one-shot roster lookup.
  const key = (record.email || "").trim().toLowerCase();
  if (!key) return;

  let suppress = null;
  try { suppress = localStorage.getItem(BSC_PROMPT_SUPPRESS_KEY); } catch (_err) { /* no-op */ }
  if (suppress === record.submittedAt) return;

  let doc = null;
  try {
    // Raw key — getDoc's docUrl helper already segment-encodes.
    // Pre-encoding here would double-encode `@` and return null for
    // every real email (design review HIGH finding 1).
    doc = await getDoc(`bscPreReg/${key}`);
  } catch (err) {
    console.warn("[signin] bscPreReg lookup failed:", err);
    return; // silent skip on transient read failure
  }
  if (!doc) return;

  openPreRegPrompt(record, originalPayload, webhookUrl);
}

/**
 * Build and mount the pre-reg prompt dialog. The "Yes, take me there"
 * path fires a retroactive sign-in POST so the Google Sheet row for
 * this attendee reflects their actual BSC participation (see
 * requirement 14.6.7 / design section 17 → "Retroactive sign-in
 * update"). The retroactive POST is intentionally non-blocking: the
 * dialog dismisses and navigation to `#/bsc` happens immediately on
 * click so the attendee never sees a spinner or stall; the POST
 * completes in the background with a 5-second timeout cap and
 * success/failure is surfaced through the debug overlay.
 *
 * The retroactive POST ONLY fires on the Yes path. The "No thanks"
 * button and the Escape / backdrop dismiss paths represent the
 * attendee declining BSC, so the first POST's `bsc_competitor=no` is
 * correct for them and no second POST is issued.
 *
 * @param {object} record  the stored confirmation record (used for
 *   suppression keying and dialog state only)
 * @param {object} originalPayload  the exact object just POSTed to the
 *   sign-in Zap on submit. The retroactive POST reuses every field
 *   (critically `signed_in_at`, so the two sheet rows correlate to the
 *   same sign-in event) and overrides only `bsc_competitor`.
 * @param {string} webhookUrl  the sign-in Zap webhook URL (same URL the
 *   original POST targeted).
 */
function openPreRegPrompt(record, originalPayload, webhookUrl) {
  const container = document.createElement("div");
  container.className = "bsc-prompt-dialog";
  container.setAttribute("role", "dialog");
  container.setAttribute("aria-modal", "true");
  container.setAttribute("aria-labelledby", "bsc-prereg-heading");
  container.tabIndex = -1;
  container.innerHTML = `
    <div class="bsc-prompt-dialog__backdrop" aria-hidden="true"></div>
    <div class="bsc-prompt-dialog__panel" role="document">
      <h2 id="bsc-prereg-heading" class="bsc-prompt-dialog__title">Pre-registered for the Broadband Skills Challenge</h2>
      <p class="bsc-prompt-dialog__body">
        It looks like you're already registered to compete. Head to the BSC check-in now?
      </p>
      <div class="bsc-prompt-dialog__actions">
        <button type="button" class="btn-secondary" data-action="dismiss">No thanks</button>
        <button type="button" class="btn-primary" data-action="go">Yes, take me there</button>
      </div>
    </div>
  `;
  document.body.append(container);

  function dismiss() {
    try { localStorage.setItem(BSC_PROMPT_SUPPRESS_KEY, record.submittedAt); } catch (_err) { /* no-op */ }
    close();
  }
  function go() {
    // Retroactive sign-in sheet update: re-POST the original payload
    // with `bsc_competitor` flipped to "yes" so the sign-in Sheet row
    // reflects reality now that the attendee has committed to the BSC
    // flow. Zapier's Sheet action is insert-only, so this intentionally
    // produces a second row that correlates with the first by email and
    // the shared `signed_in_at` timestamp — the dedupe is a post-event
    // operational task on the Sheet, not an in-app feature. See
    // requirement 14.6.7 and design section 17 → "Retroactive sign-in
    // update" for the full trade-off.
    //
    // The call is deliberately fire-and-forget: we do NOT `await` it
    // before closing the dialog or navigating. Any delay here would be
    // a visible UI stall between the user's click and the BSC view
    // appearing, which the requirement explicitly rules out. A 5-second
    // timeout guards against a hung Zapier endpoint leaking a
    // long-lived in-flight fetch (and surfaces as a debug-log entry
    // either way). Only `bsc_competitor` is overridden — the original
    // `signed_in_at` and every other field pass through unchanged.
    if (webhookUrl && originalPayload && typeof originalPayload === "object") {
      const retroPayload = { ...originalPayload, bsc_competitor: "yes" };
      const retroRace = Promise.race([
        postFormEncoded(webhookUrl, retroPayload),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`retroactive BSC update timed out after ${BSC_RETROACTIVE_POST_TIMEOUT_MS}ms`)),
            BSC_RETROACTIVE_POST_TIMEOUT_MS,
          ),
        ),
      ]);
      retroRace
        .then(() => {
          pushDebugLog("signin", "retroactive bsc_competitor=yes sent", {
            email: originalPayload.email,
          });
        })
        .catch((err) => {
          console.warn("[signin] retroactive BSC update failed:", err);
          pushDebugLog("signin", "retroactive bsc_competitor=yes FAILED", {
            err: String(err && err.message || err),
          });
        });
    }

    // Phase 1 retroactive Firestore update: alongside the existing
    // retroactive Zapier POST above, flip `bsc_competitor: no → yes`
    // on the Firestore `signIns/{docId}` row created at sign-in time
    // so the admin dashboard reads one-row-per-attendee (vs the two-
    // row-on-retroactive-yes behavior the Google Sheet produces by
    // design). Prefer the module-scoped in-memory id so same-session
    // accepts hit the freshest value; fall back to localStorage so
    // a reload-then-accept flow still targets the correct row. Both
    // fire-and-forget; the dialog dismisses and `#/bsc` navigation
    // already happen immediately on click so neither can stall the UI.
    let signInDocId = lastSignInDocId;
    if (!signInDocId) {
      try { signInDocId = localStorage.getItem(SIGNIN_LAST_DOC_ID_KEY) || ""; }
      catch (_err) { signInDocId = ""; }
    }
    const markEmail = (originalPayload && typeof originalPayload.email === "string")
      ? originalPayload.email.trim().toLowerCase()
      : "";
    if (signInDocId && markEmail) {
      // Reuse the existing retroactive-Zap timeout constant so both
      // retroactive POSTs (Zapier + mark-bsc) move together under one
      // named value — see design iteration 2 NIT #7.
      const markRace = Promise.race([
        fetch("/api/signin-mark-bsc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docId: signInDocId, email: markEmail }),
        }).then(async (res) => {
          if (!res.ok) {
            const err = new Error(`signin-mark-bsc ${res.status}`);
            err.status = res.status;
            throw err;
          }
          return res.json();
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`signin-mark-bsc timed out after ${BSC_RETROACTIVE_POST_TIMEOUT_MS}ms`)),
            BSC_RETROACTIVE_POST_TIMEOUT_MS,
          ),
        ),
      ]);
      markRace
        .then((r) => {
          // Success response is { ok: true }; log the ok flag, not the
          // absent `reason` field (which is only present on failure).
          pushDebugLog("signin", "signin-mark-bsc OK", {
            docId: signInDocId,
            ok: r && r.ok === true,
          });
          // Optional tidy-up: clear both state slots so a subsequent
          // accept (via browser back nav + re-accept) no longer finds
          // the same id.
          lastSignInDocId = null;
          try { localStorage.removeItem(SIGNIN_LAST_DOC_ID_KEY); } catch (_err) { /* no-op */ }
        })
        .catch((err) => {
          pushDebugLog("signin", "signin-mark-bsc FAILED", {
            err: String(err && err.message || err),
          });
        });
    } else {
      pushDebugLog("signin", "signin-mark-bsc SKIPPED (no docId or email)", {
        haveDocId: Boolean(signInDocId),
      });
    }

    try { localStorage.removeItem(BSC_PROMPT_SUPPRESS_KEY); } catch (_err) { /* no-op */ }
    close();
    router.navigate("/bsc");
  }
  let uninstall = null;
  function close() {
    try { if (uninstall) uninstall(); } catch (_err) { /* no-op */ }
    if (container.isConnected) container.remove();
  }

  container.querySelector('[data-action="dismiss"]').addEventListener("click", dismiss);
  container.querySelector('[data-action="go"]').addEventListener("click", go);

  uninstall = installFocusTrap(container, {
    onEscape: dismiss,
    initialFocus: () => container.querySelector('[data-action="go"]'),
  });
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
