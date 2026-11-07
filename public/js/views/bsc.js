// views/bsc.js — `#/bsc` Broadband Skills Challenge check-in orchestrator.
//
// One route, three internal steps ("intake" / "waiver" / "confirmation")
// backed by a closure-held draft so hashchange navigation doesn't drop
// mid-flow form state. On mount:
//
//   1. Prime the shared appSettings cache (`loadAppSettings`) so
//      `isBscEnabled()` reflects the latest admin flip.
//   2. If disabled or `bscWebhookUrl` is empty, render a `.placeholder-card`
//      and stop.
//   3. If no device-local sign-in exists, bounce to `#/sign-in` with the
//      handshake flags so sign-in success routes back here.
//   4. Look up `bscPreReg/{emailLowered}` ONCE. Hit → pre-reg confirm
//      form; miss → walk-up intake form; error → retry card (no silent
//      fall-through to walk-up — design 14.3.4).
//   5. Intake submit → waiver step. Waiver submit → finalize both legs
//      (`Promise.allSettled` between the Zap POST and the Firestore
//      `bscCheckins` create) → confirmation.
//
// Shape invariants (design review carry-overs):
//   • `getDoc(\`bscPreReg/${key}\`)` MUST receive the RAW lowercased +
//     trimmed email — the helper segment-encodes internally. HIGH #1.
//   • `generateBscReferenceId` MUST produce `BSC-YYYYMMDD-HHMMSS` with
//     second resolution and NO suffix (matches 2026 Zap). MEDIUM #1.
//   • Both intake submits normalize `email` + `supervisor_email` with
//     `.trim().toLowerCase()` before persistence; `buildBscWebhookPayload`
//     does one more defensive pass. MEDIUM #3.
//   • `buildField`'s full signature (including `autocomplete`) is reused
//     end-to-end — not lifted into a new utils module. MEDIUM #4 / #5.
"use strict";

import { postFormEncoded, buildField, getLastSignIn } from "./signin.js";
import { initFirestore, getDoc, createDoc, getConfig } from "../firebase.js";
import {
  loadAppSettings,
  isBscEnabled,
  getEffectiveBscWaiverMode,
} from "../app-settings.js";
import { renderBscWaiver } from "./bsc-waiver.js";
import { renderBscConfirmation } from "./bsc-confirmation.js";
import * as router from "../router.js";
import * as ui from "../ui.js";
import { registerViewCleanup } from "../app.js";

/** Handshake session flag keys (mirrored in signin.js). */
const BSC_RETURN_AFTER_SIGNIN_KEY = "vendorday2027.bsc.returnAfterSignIn";
const BSC_PRECHECK_ON_SIGNIN_KEY = "vendorday2027.bsc.preCheckOnSignIn";

/** Loose email regex matching the sign-in form's shape. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Thrown by `finalize` when BOTH the Zap POST and the Firestore create
 * reject. The waiver view detects this and re-renders itself with a
 * retry banner that preserves the typed signature.
 */
export class BscFinalizeError extends Error {
  constructor(kind, results) {
    super(`BSC finalize failed: ${kind}`);
    this.name = "BscFinalizeError";
    this.kind = kind;
    this.results = results;
  }
}

/**
 * Produce a `BSC-YYYYMMDD-HHMMSS` reference id. Second resolution, no
 * random suffix — matches the 2026 Zap's on-the-wire format exactly
 * (brief decision 9, Req 14.4.3, MEDIUM finding 1). The pre-launch
 * checklist Section 6b item 12 scan is the primary mitigation for
 * same-second collisions among walk-ups.
 */
export function generateBscReferenceId(now = new Date()) {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `BSC-${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

/**
 * Build the exact BSC Zap webhook payload shape (brief decision 4).
 * Runs a defensive `.trim().toLowerCase()` on `email` and
 * `supervisor_email` even though the intake submit handlers already
 * normalize them — belt-and-braces so a future refactor can't regress
 * invariant 14.8.1 silently (MEDIUM finding 3).
 */
export function buildBscWebhookPayload(draft) {
  const waiverMode = draft.waiver_mode === "electronic" ? "electronic" : "paper";
  return {
    attendee_name: draft.attendee_name || "",
    email: (draft.email || "").trim().toLowerCase(),
    company: draft.company || "",
    office_location: draft.office_location || "",
    job_role: draft.job_role || "",
    supervisor_name: draft.supervisor_name || "",
    supervisor_email: (draft.supervisor_email || "").trim().toLowerCase(),
    supervisor_phone: draft.supervisor_phone || "",
    scte_member_id: draft.scte_member_id || "",
    reference_id: draft.reference_id || "",
    submitted_at: new Date().toISOString(),
    entry_type: draft.entry_type || "",
    manager_approved: draft.manager_approved || "",
    waiver_mode: waiverMode,
    waiver_signature: waiverMode === "electronic" ? (draft.waiver_signature || "").trim() : "",
    waiver_signed_at: waiverMode === "electronic" ? (draft.waiver_signed_at || "") : "",
  };
}

/**
 * Render the BSC check-in view into `host`.
 * @param {HTMLElement} host
 */
export async function renderBsc(host) {
  host.innerHTML = "";

  const sticky = document.createElement("header");
  sticky.className = "view-sticky-header";
  sticky.innerHTML = `<h2 class="view-sticky-header__title">Broadband Skills Challenge</h2>`;

  const body = document.createElement("section");
  body.className = "bsc-view";
  body.setAttribute("aria-live", "polite");
  body.setAttribute("aria-label", "Broadband Skills Challenge check-in");

  host.append(sticky, body);

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    ui.showOfflineBanner();
  }

  document.title = "Broadband Skills Challenge \u2014 Vendor Day 2027";

  registerViewCleanup(() => { /* no long-lived handles */ });

  // 1. Prime appSettings. Fail-closed on error.
  try { await loadAppSettings(); } catch (_err) { /* fail-closed */ }

  if (!isBscEnabled()) {
    renderDisabledPlaceholder(body);
    return;
  }

  // 2. Load /api/config so we have webhookUrl + project info.
  try {
    await initFirestore();
  } catch (err) {
    console.warn("[bsc] /api/config load failed:", err);
    renderConfigError(body, () => renderBsc(host));
    return;
  }

  // 3. Need a device-local sign-in with an email to look up the roster.
  const signin = getLastSignIn();
  if (!signin || !signin.email) {
    try {
      sessionStorage.setItem(BSC_RETURN_AFTER_SIGNIN_KEY, "1");
      sessionStorage.setItem(BSC_PRECHECK_ON_SIGNIN_KEY, "1");
    } catch (_err) { /* no-op */ }
    router.navigate("/sign-in");
    return;
  }

  // 4. Webhook URL must be configured.
  let webhookUrl = null;
  try {
    const cfg = getConfig();
    if (cfg && typeof cfg.bscWebhookUrl === "string" && cfg.bscWebhookUrl.trim()) {
      webhookUrl = cfg.bscWebhookUrl.trim();
    }
  } catch (_err) { /* no-op */ }
  if (!webhookUrl) {
    console.warn("[bsc] bscWebhookUrl missing from /api/config \u2014 set ZAPIER_BSC_WEBHOOK_URL in Cloudflare Pages env vars");
    renderNotConfigured(body);
    return;
  }

  // 5. Seed the draft from the sign-in record (email already lowercased).
  const draft = {
    attendee_name: signin.name || "",
    email: signin.email || "",
    company: signin.company || "",
    office_location: signin.office_location || "",
    scte_member_id: signin.scte_member_number || "",
    phone: signin.phone || "",
    job_role: "",
    supervisor_name: "",
    supervisor_email: "",
    supervisor_phone: "",
    entry_type: null,
    manager_approved: "",
    reference_id: "",
    waiver_mode: "",
    waiver_signature: "",
    waiver_signed_at: "",
  };

  await runRosterLookup(body, draft, webhookUrl);
}

export default renderBsc;

/* ---------------- Roster lookup ---------------- */

async function runRosterLookup(body, draft, webhookUrl) {
  renderLookupSkeleton(body);
  const key = (draft.email || "").trim().toLowerCase();
  let roster = null;
  try {
    // Raw key — getDoc's docUrl helper already segment-encodes
    // (public/js/firebase.js). Pre-encoding here would double-encode
    // the `@` and silently return null for every real email (design
    // review HIGH finding 1 — DO NOT re-introduce an encodeURIComponent
    // wrapper on this call site on autopilot).
    roster = await getDoc(`bscPreReg/${key}`);
  } catch (err) {
    console.warn("[bsc] bscPreReg lookup failed:", err);
    renderLookupError(body, () => runRosterLookup(body, draft, webhookUrl));
    return;
  }

  if (roster) {
    draft.entry_type = "pre-registered";
    // Merge roster fields over the sign-in seed values when the roster
    // has data for a field (design 14.3.3: roster is authoritative on
    // the pre-reg path for anything it carries).
    for (const field of [
      "attendee_name", "email", "company", "office_location", "job_role",
      "supervisor_name", "supervisor_email", "supervisor_phone", "scte_member_id",
    ]) {
      const v = roster[field];
      if (typeof v === "string" && v) draft[field] = v;
    }
    draft.reference_id = (typeof roster.reference_id === "string" && roster.reference_id)
      ? roster.reference_id
      : generateBscReferenceId();
    renderPreRegConfirm(body, draft, webhookUrl);
  } else {
    draft.entry_type = "walk-up";
    renderWalkUp(body, draft, webhookUrl);
  }
}

/* ---------------- Intake: pre-reg confirmation ---------------- */

function renderPreRegConfirm(body, draft, webhookUrl) {
  body.innerHTML = "";

  const intro = document.createElement("div");
  intro.className = "bsc-step-title";
  intro.innerHTML = `
    <h3>Confirm your competitor details</h3>
    <p>We found you on the pre-registration roster. Review your details below and continue to the waiver.</p>
  `;
  body.append(intro);

  const form = buildIntakeForm(draft, { walkUp: false });
  body.append(form);

  wireIntakeSubmit(form, draft, {
    walkUp: false,
    onSuccess: () => goToWaiver(body, draft, webhookUrl),
  });
}

/* ---------------- Intake: walk-up ---------------- */

function renderWalkUp(body, draft, webhookUrl) {
  body.innerHTML = "";

  const intro = document.createElement("div");
  intro.className = "bsc-step-title";
  intro.innerHTML = `
    <h3>Walk-up competitor sign-up</h3>
    <p>We don't see you on the pre-registration roster. Fill in your details and confirm your manager approved your participation.</p>
  `;
  body.append(intro);

  const form = buildIntakeForm(draft, { walkUp: true });
  body.append(form);

  wireIntakeSubmit(form, draft, {
    walkUp: true,
    onSuccess: () => {
      if (!draft.reference_id) draft.reference_id = generateBscReferenceId();
      goToWaiver(body, draft, webhookUrl);
    },
  });
}

/* ---------------- Shared intake form builder ---------------- */

function buildIntakeForm(draft, { walkUp }) {
  const form = document.createElement("form");
  form.className = "signin-form bsc-intake-form";
  form.setAttribute("novalidate", "novalidate");
  form.setAttribute("aria-label", walkUp ? "Walk-up BSC intake" : "Pre-registration BSC intake");

  const fieldDefs = [
    { id: "bsc-attendee-name", name: "attendee_name", label: "Competitor name", type: "text", required: true, autocomplete: "name" },
    { id: "bsc-email", name: "email", label: "Email", type: "email", required: true, autocomplete: "email" },
    { id: "bsc-company", name: "company", label: "Company", type: "text", required: true, autocomplete: "organization" },
    { id: "bsc-office-location", name: "office_location", label: "Office location", type: "text", required: true, autocomplete: "address-level2" },
    { id: "bsc-job-role", name: "job_role", label: "Job role / title", type: "text", required: true, autocomplete: "organization-title" },
    { id: "bsc-supervisor-name", name: "supervisor_name", label: "Supervisor / manager name", type: "text", required: true, autocomplete: "off" },
    { id: "bsc-supervisor-email", name: "supervisor_email", label: "Supervisor / manager email", type: "email", required: true, autocomplete: "off" },
    { id: "bsc-supervisor-phone", name: "supervisor_phone", label: "Supervisor / manager phone", type: "tel", required: true, autocomplete: "off" },
    { id: "bsc-scte-member-id", name: "scte_member_id", label: "SCTE member ID", type: "text", required: false, autocomplete: "off", hint: "Optional" },
  ];

  for (const def of fieldDefs) {
    const field = buildField(def);
    const input = field.querySelector("input");
    const seed = draft[def.name];
    if (input && typeof seed === "string" && seed) {
      input.value = seed;
      if (!walkUp) {
        const chip = document.createElement("span");
        chip.className = "bsc-prefilled-chip";
        chip.textContent = "pre-filled";
        const label = field.querySelector("label");
        if (label) label.append(" ", chip);
      }
    }
    form.append(field);
  }

  if (walkUp) {
    const fs = document.createElement("fieldset");
    fs.className = "bsc-manager-approval";
    fs.dataset.fieldName = "manager_approved";
    fs.innerHTML = `
      <legend>Manager approval <span class="required" aria-hidden="true">*</span><span class="sr-only"> required</span></legend>
      <p class="signin-field__hint">Confirm your manager has approved your participation in the Broadband Skills Challenge.</p>
      <label class="bsc-manager-approval__option">
        <input type="radio" name="manager_approved" value="yes" />
        Yes, my manager approved
      </label>
      <label class="bsc-manager-approval__option">
        <input type="radio" name="manager_approved" value="no" />
        No, not yet
      </label>
      <div class="error-message bsc-manager-approval__error" id="bsc-err-manager" hidden></div>
    `;
    form.append(fs);
  }

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
    <span class="signin-submit-btn__label">Continue to waiver</span>
  `;
  actions.append(submitBtn);
  form.append(actions);

  return form;
}

function wireIntakeSubmit(form, draft, { walkUp, onSuccess }) {
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const banner = form.querySelector(".signin-inline-banner");
    if (banner) { banner.hidden = true; banner.innerHTML = ""; }

    let firstInvalid = null;
    const fields = [
      { name: "attendee_name", label: "Competitor name", required: true, kind: "text" },
      { name: "email", label: "Email", required: true, kind: "email" },
      { name: "company", label: "Company", required: true, kind: "text" },
      { name: "office_location", label: "Office location", required: true, kind: "text" },
      { name: "job_role", label: "Job role", required: true, kind: "text" },
      { name: "supervisor_name", label: "Supervisor name", required: true, kind: "text" },
      { name: "supervisor_email", label: "Supervisor email", required: true, kind: "email" },
      { name: "supervisor_phone", label: "Supervisor phone", required: true, kind: "phone" },
      { name: "scte_member_id", label: "SCTE member ID", required: false, kind: "text" },
    ];

    for (const f of fields) {
      const block = form.querySelector(`[data-field-name="${f.name}"]`);
      const input = block ? block.querySelector("input") : null;
      const errEl = block ? block.querySelector(".signin-field__error") : null;
      if (!block || !input) continue;
      if (errEl) { errEl.textContent = ""; errEl.hidden = true; }
      block.removeAttribute("aria-invalid");
      input.removeAttribute("aria-invalid");

      const trimmed = (input.value || "").trim();
      draft[f.name] = trimmed;

      if (f.required && !trimmed) {
        if (errEl) { errEl.textContent = `Please enter ${f.label.toLowerCase()}.`; errEl.hidden = false; }
        block.setAttribute("aria-invalid", "true");
        input.setAttribute("aria-invalid", "true");
        if (!firstInvalid) firstInvalid = input;
        continue;
      }
      if (trimmed && f.required && trimmed.length > 120) {
        if (errEl) { errEl.textContent = `${f.label} is too long.`; errEl.hidden = false; }
        block.setAttribute("aria-invalid", "true");
        input.setAttribute("aria-invalid", "true");
        if (!firstInvalid) firstInvalid = input;
        continue;
      }
      if (trimmed && f.kind === "email" && !EMAIL_RE.test(trimmed)) {
        if (errEl) { errEl.textContent = "Please enter a valid email address."; errEl.hidden = false; }
        block.setAttribute("aria-invalid", "true");
        input.setAttribute("aria-invalid", "true");
        if (!firstInvalid) firstInvalid = input;
        continue;
      }
      if (trimmed && f.kind === "phone") {
        const digits = trimmed.replace(/[^\d]/g, "");
        if (digits.length < 7) {
          if (errEl) { errEl.textContent = "Please enter a valid phone number."; errEl.hidden = false; }
          block.setAttribute("aria-invalid", "true");
          input.setAttribute("aria-invalid", "true");
          if (!firstInvalid) firstInvalid = input;
          continue;
        }
      }
    }

    if (walkUp) {
      const fs = form.querySelector('[data-field-name="manager_approved"]');
      const err = form.querySelector("#bsc-err-manager");
      if (err) { err.textContent = ""; err.hidden = true; }
      const picked = form.querySelector('input[name="manager_approved"]:checked');
      if (!picked) {
        if (err) { err.textContent = "Please choose Yes or No."; err.hidden = false; }
        if (fs) fs.setAttribute("aria-invalid", "true");
        if (!firstInvalid) {
          const firstRadio = form.querySelector('input[name="manager_approved"]');
          if (firstRadio) firstInvalid = firstRadio;
        }
      } else {
        if (fs) fs.removeAttribute("aria-invalid");
        draft.manager_approved = picked.value;
      }
    } else {
      // Pre-reg confirm: no manager-approval prompt (14.5.5).
      draft.manager_approved = "";
    }

    if (firstInvalid) {
      try { firstInvalid.focus({ preventScroll: true }); } catch (_err) { firstInvalid.focus(); }
      try { firstInvalid.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_err) { /* no-op */ }
      return;
    }

    // Normalize email + supervisor_email once intake clears validation
    // (design MEDIUM finding 3 — belt-and-braces matches the webhook
    // builder's defensive pass but keeps persistence canonical from the
    // moment the user leaves the intake step).
    draft.email = (draft.email || "").trim().toLowerCase();
    draft.supervisor_email = (draft.supervisor_email || "").trim().toLowerCase();

    onSuccess();
  });
}

/* ---------------- Waiver step hand-off ---------------- */

function goToWaiver(body, draft, webhookUrl) {
  body.innerHTML = "";
  renderBscWaiver(body, {
    draft,
    onBack: () => {
      if (draft.entry_type === "pre-registered") renderPreRegConfirm(body, draft, webhookUrl);
      else renderWalkUp(body, draft, webhookUrl);
    },
    onComplete: (completedDraft) => finalize(body, completedDraft, webhookUrl),
  });
}

/* ---------------- Finalize + confirmation ---------------- */

async function finalize(body, draft, webhookUrl) {
  // Stamp effective waiver mode in case something upstream missed it.
  if (draft.waiver_mode !== "paper" && draft.waiver_mode !== "electronic") {
    draft.waiver_mode = getEffectiveBscWaiverMode();
  }

  const payload = buildBscWebhookPayload(draft);
  const firestorePayload = { ...payload, createdAt: new Date().toISOString() };

  const results = await Promise.allSettled([
    postFormEncoded(webhookUrl, payload),
    createDoc("bscCheckins", firestorePayload),
  ]);
  const [zap, fs] = results;

  if (zap.status === "rejected" && fs.status === "rejected") {
    console.warn("[bsc] both finalize legs failed:", zap.reason, fs.reason);
    throw new BscFinalizeError("both", results);
  }

  let legFailure = null;
  if (zap.status === "rejected") {
    console.warn("[bsc] Zap POST failed:", zap.reason);
    legFailure = "sheet";
  }
  if (fs.status === "rejected") {
    console.warn("[bsc] bscCheckins create failed:", fs.reason);
    legFailure = "firestore";
  }

  body.innerHTML = "";
  renderBscConfirmation(body, { draft, legFailure });
}

/* ---------------- Placeholder / error states ---------------- */

function renderDisabledPlaceholder(host) {
  host.innerHTML = `
    <section class="placeholder-card" aria-live="polite">
      <h2>BSC check-in isn't available yet</h2>
      <p>Check back closer to the event.</p>
      <button type="button" class="btn-secondary" data-action="home">Back to Home</button>
    </section>
  `;
  const btn = host.querySelector('[data-action="home"]');
  if (btn) btn.addEventListener("click", () => router.navigate("/home"));
}

function renderNotConfigured(host) {
  host.innerHTML = `
    <section class="placeholder-card" aria-live="polite">
      <h2>BSC check-in is not yet configured</h2>
      <p>Please check back shortly. If this persists, let a BSC coordinator know.</p>
      <button type="button" class="btn-secondary" data-action="home">Back to Home</button>
    </section>
  `;
  const btn = host.querySelector('[data-action="home"]');
  if (btn) btn.addEventListener("click", () => router.navigate("/home"));
}

function renderConfigError(host, onRetry) {
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't load BSC configuration.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  const btn = host.querySelector("[data-retry]");
  if (btn) btn.addEventListener("click", onRetry);
}

function renderLookupSkeleton(host) {
  host.innerHTML = `
    <div class="skeleton-row" style="height: 20px; width: 50%;" aria-hidden="true"></div>
    <div class="skeleton-row" style="height: 44px; width: 90%;" aria-hidden="true"></div>
    <div class="skeleton-row" style="height: 44px; width: 90%;" aria-hidden="true"></div>
  `;
}

function renderLookupError(host, onRetry) {
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't check the pre-registration roster. Please try again.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  const btn = host.querySelector("[data-retry]");
  if (btn) btn.addEventListener("click", onRetry);
}
