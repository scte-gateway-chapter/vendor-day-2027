// views/bsc-waiver.js — BSC waiver step.
//
// Reads `getEffectiveBscWaiverMode()` (which folds in the fallback-to-
// paper rule when the admin selected Electronic but left the text
// empty) and renders either a paper reminder panel or the full
// electronic read-and-sign panel.
//
// Electronic submit sets `draft.waiver_signature` (trimmed) and
// `draft.waiver_signed_at` before invoking `onComplete(draft)`. On a
// `BscFinalizeError` from the orchestrator the view re-renders itself
// with an inline Retry banner that preserves the typed signature so
// the attendee doesn't retype after a transient outage (design 14.7.8).
"use strict";

import { getEffectiveBscWaiverMode, getBscWaiverText } from "../app-settings.js";

/**
 * Render the waiver step into `host`.
 * @param {HTMLElement} host
 * @param {{ draft: object, onBack: (draft: object) => void, onComplete: (draft: object) => Promise<void> | void }} opts
 */
export function renderBscWaiver(host, { draft, onBack, onComplete }) {
  const mode = getEffectiveBscWaiverMode();
  const text = getBscWaiverText();
  document.title = "BSC Waiver \u2014 Vendor Day 2027";

  if (mode === "paper") {
    renderPaper(host, { draft, onBack, onComplete });
  } else {
    renderElectronic(host, { draft, onBack, onComplete, text });
  }
}

export default renderBscWaiver;

/* ---------------- Paper mode ---------------- */

function renderPaper(host, { draft, onBack, onComplete }) {
  host.innerHTML = "";

  const panel = document.createElement("section");
  panel.className = "placeholder-card bsc-waiver-paper";
  panel.setAttribute("aria-live", "polite");
  panel.innerHTML = `
    <h3>Waiver</h3>
    <p>Please sign the paper waiver at the competition table before competing.</p>
  `;

  const banner = document.createElement("div");
  banner.className = "status-error bsc-leg-failure-banner";
  banner.setAttribute("role", "alert");
  banner.hidden = true;
  panel.append(banner);

  const actions = document.createElement("div");
  actions.className = "signin-form__actions bsc-waiver-actions";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn-secondary";
  backBtn.textContent = "Back";
  backBtn.addEventListener("click", () => onBack(draft));

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "btn-primary";
  confirmBtn.textContent = "Confirm and continue";
  confirmBtn.addEventListener("click", async () => {
    draft.waiver_mode = "paper";
    draft.waiver_signature = "";
    draft.waiver_signed_at = "";
    confirmBtn.disabled = true;
    backBtn.disabled = true;
    banner.hidden = true;
    banner.innerHTML = "";
    try {
      await onComplete(draft);
    } catch (err) {
      // BscFinalizeError (both legs failed) or unexpected error.
      console.warn("[bsc-waiver] paper finalize failed:", err);
      banner.innerHTML = `
        <span>Couldn't record your check-in. Please try again.</span>
        <button type="button" class="btn-secondary" data-retry>Retry</button>
      `;
      banner.hidden = false;
      confirmBtn.disabled = false;
      backBtn.disabled = false;
      const retry = banner.querySelector("[data-retry]");
      if (retry) retry.addEventListener("click", () => confirmBtn.click());
    }
  });

  actions.append(backBtn, confirmBtn);
  panel.append(actions);
  host.append(panel);
}

/* ---------------- Electronic mode ---------------- */

function renderElectronic(host, { draft, onBack, onComplete, text }) {
  host.innerHTML = "";

  const wrap = document.createElement("section");
  wrap.className = "bsc-waiver";

  const title = document.createElement("div");
  title.className = "bsc-step-title";
  title.innerHTML = `
    <h3>Waiver</h3>
    <p>Read the waiver below, then type your full legal name as your signature.</p>
  `;
  wrap.append(title);

  const panel = document.createElement("div");
  panel.className = "bsc-waiver-panel";
  panel.setAttribute("tabindex", "0");
  panel.setAttribute("aria-label", "Broadband Skills Challenge waiver text");
  const textEl = document.createElement("div");
  textEl.className = "bsc-waiver-panel__text";
  // Use textContent to avoid rendering any HTML from admin-authored
  // text; `white-space: pre-wrap` in the stylesheet renders author
  // line breaks.
  textEl.textContent = text;
  panel.append(textEl);
  wrap.append(panel);

  const form = document.createElement("form");
  form.className = "signin-form bsc-waiver-form";
  form.setAttribute("novalidate", "novalidate");
  form.setAttribute("aria-label", "Electronic waiver signature");

  const agreeWrap = document.createElement("div");
  agreeWrap.className = "form-field signin-field signin-field--checkbox";
  agreeWrap.innerHTML = `
    <label for="bsc-waiver-agree">
      <input id="bsc-waiver-agree" name="bsc_waiver_agree" type="checkbox" required />
      I have read and agree to the waiver above
    </label>
  `;
  form.append(agreeWrap);

  const sigWrap = document.createElement("div");
  sigWrap.className = "form-field signin-field";
  sigWrap.dataset.fieldName = "waiver_signature";
  sigWrap.innerHTML = `
    <label for="bsc-waiver-signature">
      Type your full legal name as signature
      <span class="required" aria-hidden="true">*</span><span class="sr-only"> required</span>
    </label>
    <input
      id="bsc-waiver-signature"
      name="waiver_signature"
      type="text"
      maxlength="120"
      required
      autocomplete="off"
      aria-describedby="bsc-waiver-signature-err"
    />
    <div class="error-message signin-field__error" id="bsc-waiver-signature-err" hidden></div>
  `;
  form.append(sigWrap);

  // Preserve typed signature across a retry (14.7.8).
  const sigInput = sigWrap.querySelector("input");
  if (sigInput && typeof draft.waiver_signature === "string" && draft.waiver_signature) {
    sigInput.value = draft.waiver_signature;
  }

  const banner = document.createElement("div");
  banner.className = "status-error bsc-leg-failure-banner";
  banner.setAttribute("role", "alert");
  banner.hidden = true;
  form.append(banner);

  const actions = document.createElement("div");
  actions.className = "signin-form__actions bsc-waiver-actions";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn-secondary";
  backBtn.textContent = "Back";
  backBtn.addEventListener("click", () => onBack(draft));

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "btn-primary signin-submit-btn";
  submitBtn.disabled = true;
  submitBtn.innerHTML = `
    <span class="signin-submit-btn__spinner" aria-hidden="true"></span>
    <span class="signin-submit-btn__label">Submit waiver &amp; check in</span>
  `;

  actions.append(backBtn, submitBtn);
  form.append(actions);
  wrap.append(form);

  const agreeInput = agreeWrap.querySelector('input[type="checkbox"]');
  function updateSubmitState() {
    const agreed = !!(agreeInput && agreeInput.checked);
    const typed = !!(sigInput && sigInput.value.trim());
    submitBtn.disabled = !(agreed && typed);
  }
  if (agreeInput) agreeInput.addEventListener("change", updateSubmitState);
  if (sigInput) sigInput.addEventListener("input", updateSubmitState);
  updateSubmitState();

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const signature = (sigInput && sigInput.value || "").trim();
    if (!signature) return;
    draft.waiver_mode = "electronic";
    draft.waiver_signature = signature;
    draft.waiver_signed_at = new Date().toISOString();

    submitBtn.disabled = true;
    backBtn.disabled = true;
    submitBtn.setAttribute("aria-busy", "true");
    submitBtn.classList.add("signin-submit-btn--loading");
    const label = submitBtn.querySelector(".signin-submit-btn__label");
    if (label) label.textContent = "Submitting\u2026";
    banner.hidden = true;
    banner.innerHTML = "";

    try {
      await onComplete(draft);
    } catch (err) {
      console.warn("[bsc-waiver] electronic finalize failed:", err);
      banner.innerHTML = `
        <span>Couldn't record your check-in. Please try again.</span>
        <button type="button" class="btn-secondary" data-retry>Retry</button>
      `;
      banner.hidden = false;
      submitBtn.classList.remove("signin-submit-btn--loading");
      submitBtn.removeAttribute("aria-busy");
      if (label) label.textContent = "Submit waiver & check in";
      backBtn.disabled = false;
      updateSubmitState();
      const retry = banner.querySelector("[data-retry]");
      if (retry) {
        retry.addEventListener("click", () => {
          banner.hidden = true;
          banner.innerHTML = "";
          form.requestSubmit();
        });
      }
    }
  });

  host.append(wrap);
}
