// views/feedback.js — attendee Feedback view (Task 14).
//
// Reads `feedbackConfig/singleton` and renders either the form (when
// `active === true`), the placeholder ("Feedback opens during the
// event..."), or the confirmation card (when this device has already
// submitted — tracked via localStorage key
// `vendorday2027.feedback.submitted`).
//
// Submission goes DIRECT to Firestore via `createDoc("feedbackResponses")`
// — not through `/api/firestore-write`. `firestore.rules` grants anonymous
// create on that collection (and denies read/update/delete). Offline
// submissions "fail loudly" per the resolved decision — we never queue.
//
// The config poll runs at 30s (longer than other views) because feedback
// config changes rarely. Admin flips of `active` and question edits
// still propagate on the next tick, which is enough.
//
// Cleanup follows the pattern from the other views: a module-level
// __cleanup slot stops the poll. The router.beforeEach hook (via
// registerViewCleanup in app.js) drains it before mounting the next view.
"use strict";

import { initFirestore, onSnapshot, createDoc } from "../firebase.js";
import * as ui from "../ui.js";
import { registerViewCleanup } from "../app.js";
import { relativeTime } from "../utils/time.js";

/** Keys shared with design section 13 and requirements 8.5 / 12.10. */
const SUBMITTED_KEY = "vendorday2027.feedback.submitted";
const POLL_INTERVAL_MS = 30000;

/** Module-level cleanup slot. Set at the end of each render call. */
let __cleanup = null;

/**
 * Render the Feedback view into `host`.
 * @param {HTMLElement} host  typically `#view-root`.
 * @returns {Promise<void>}
 */
export async function renderFeedback(host) {
  // Drain prior render handles so retries don't leave two pollers running.
  runCleanup();

  host.innerHTML = "";

  const sticky = buildStickyHeader();
  const bodySection = document.createElement("section");
  bodySection.className = "feedback-body";
  bodySection.setAttribute("aria-live", "polite");
  bodySection.setAttribute("aria-label", "Feedback");

  host.append(sticky, bodySection);

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    ui.showOfflineBanner();
  }

  document.title = "Event Feedback \u2014 Vendor Day 2027";

  // If this device has already submitted, short-circuit to the confirmation
  // card and skip the config fetch entirely. The one-submission-per-device
  // policy is enforced client-side only (design section 13 invariants);
  // reaching into Firestore to double-check would reveal nothing new.
  const submittedAt = readSubmittedAt();
  if (submittedAt) {
    renderConfirmationCard(bodySection, submittedAt);
    __cleanup = () => {};
    registerViewCleanup(() => runCleanup());
    return;
  }

  // Prime /api/config so the first poll tick doesn't race it.
  const configReady = initFirestore().catch((err) => {
    console.warn("[feedback] /api/config load failed:", err);
    return null;
  });

  /** @type {object | null} */
  let config = null;
  /** @type {Error | null} */
  let lastErr = null;
  let sawFirstResult = false;
  /** Last signature we rendered. Lets us skip a form rebuild when the poll
   *  returns the same question set and preserve the user's typed answers. */
  let renderedSignature = null;
  /** Snapshot of the user's current form input, keyed by question id. Used
   *  to preserve input across admin-driven config refreshes. */
  const answerState = Object.create(null);

  renderSkeleton(bodySection);

  function rerender() {
    // Guard: if the user submitted (e.g., from this very render path) and
    // the poll fires again, snap to the confirmation card.
    const nowSubmitted = readSubmittedAt();
    if (nowSubmitted) {
      renderConfirmationCard(bodySection, nowSubmitted);
      return;
    }
    if (lastErr && !config) {
      renderErrorNoConfig(bodySection, () => restartSubscription());
      return;
    }
    if (!sawFirstResult) {
      renderSkeleton(bodySection);
      return;
    }
    if (!config || config.active !== true) {
      renderPlaceholder(bodySection);
      renderedSignature = null;
      return;
    }
    const sig = buildSignature(config.questions);
    if (sig === renderedSignature) {
      // Same question set — just refresh the question text labels in place
      // so an admin wording change still shows up without blowing away the
      // user's typed answers.
      refreshQuestionLabels(bodySection, config.questions);
      return;
    }
    renderedSignature = sig;
    renderForm(bodySection, config.questions, answerState);
  }

  /** @type {(() => void) | null} */
  let unsub = null;
  let errorToasted = false;

  async function startSubscription() {
    try { await configReady; } catch (_err) { /* non-fatal */ }
    unsub = onSnapshot(
      "feedbackConfig/singleton",
      (data, err) => {
        if (err) {
          console.warn("[feedback] poll failed:", err);
          lastErr = err;
          if (typeof navigator !== "undefined" && navigator.onLine === false) {
            ui.showOfflineBanner();
          } else if (!config && !errorToasted) {
            ui.toast("error", "Couldn't load feedback. Tap Retry to try again.");
            errorToasted = true;
          }
        } else {
          lastErr = null;
          errorToasted = false;
          config = data;
        }
        sawFirstResult = true;
        rerender();
      },
      { intervalMs: POLL_INTERVAL_MS },
    );
  }

  function restartSubscription() {
    if (unsub) { unsub(); unsub = null; }
    lastErr = null;
    config = null;
    sawFirstResult = false;
    errorToasted = false;
    renderedSignature = null;
    renderSkeleton(bodySection);
    startSubscription();
  }

  startSubscription();

  __cleanup = () => {
    if (unsub) { unsub(); unsub = null; }
  };
  registerViewCleanup(() => runCleanup());
}

export default renderFeedback;

function runCleanup() {
  if (!__cleanup) return;
  try {
    __cleanup();
  } catch (err) {
    console.warn("[feedback] cleanup failed:", err);
  }
  __cleanup = null;
}

/* ---------------- Sticky header ---------------- */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "view-sticky-header";
  el.setAttribute("role", "banner");
  el.innerHTML = `<h2 class="view-sticky-header__title">Event Feedback</h2>`;
  return el;
}

/* ---------------- Loading / error / placeholder states ---------------- */

function renderSkeleton(host) {
  host.innerHTML = `
    <div class="feedback-question skeleton-feedback-question" aria-hidden="true">
      <div class="skeleton-row" style="height: 20px; width: 60%;"></div>
      <div class="skeleton-row" style="height: 44px; width: 90%;"></div>
    </div>
    <div class="feedback-question skeleton-feedback-question" aria-hidden="true">
      <div class="skeleton-row" style="height: 20px; width: 60%;"></div>
      <div class="skeleton-row" style="height: 44px; width: 90%;"></div>
    </div>
    <div class="feedback-question skeleton-feedback-question" aria-hidden="true">
      <div class="skeleton-row" style="height: 20px; width: 60%;"></div>
      <div class="skeleton-row" style="height: 88px; width: 90%;"></div>
    </div>
  `;
}

function renderErrorNoConfig(host, onRetry) {
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't load the feedback form.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

function renderPlaceholder(host) {
  host.innerHTML = `
    <div class="placeholder-card">
      <h2>Feedback is not open yet</h2>
      <p>Feedback opens during the event \u2014 check back soon.</p>
    </div>
  `;
}

/* ---------------- Form rendering ---------------- */

/**
 * Build a stable fingerprint of the current question set so a 30-second
 * poll that returns the same questions does not blow away user input.
 * The fingerprint includes `id`, `type`, `required`, `order`, and `text`
 * so a text edit still refreshes the labels (see refreshQuestionLabels).
 */
function buildSignature(questions) {
  const sorted = sortQuestions(questions || []);
  return sorted
    .map((q) => `${q.id}|${q.type}|${q.required ? 1 : 0}|${Number(q.order) || 0}|${q.text || ""}`)
    .join("\n");
}

function sortQuestions(questions) {
  const safe = Array.isArray(questions) ? questions.slice() : [];
  // Only keep well-formed questions — defensive against partial admin saves.
  const filtered = safe.filter(
    (q) =>
      q &&
      typeof q.id === "string" &&
      q.id.trim() &&
      (q.type === "rating" || q.type === "short" || q.type === "long") &&
      typeof q.text === "string",
  );
  filtered.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  return filtered;
}

function refreshQuestionLabels(host, questions) {
  const sorted = sortQuestions(questions || []);
  for (const q of sorted) {
    const node = host.querySelector(`[data-question-id="${cssId(q.id)}"] [data-question-text]`);
    if (node) node.textContent = q.text || "";
  }
}

function renderForm(host, questions, answerState) {
  const sorted = sortQuestions(questions || []);
  host.innerHTML = "";

  const form = document.createElement("form");
  form.className = "feedback-form";
  form.setAttribute("novalidate", "novalidate");
  form.setAttribute("aria-label", "Event feedback form");

  for (const q of sorted) {
    form.appendChild(buildQuestionBlock(q, answerState[q.id]));
  }

  // Inline banner slot (offline / submit error). Composes `.status-error`
  // for the red tone shared with other views and `.feedback-inline-banner`
  // for the local flex layout (text left, Retry on the trailing edge).
  // Kept in the DOM so aria-live updates land in the same place on
  // repeated retries.
  const banner = document.createElement("div");
  banner.className = "status-error feedback-inline-banner";
  banner.setAttribute("role", "alert");
  banner.hidden = true;
  form.appendChild(banner);

  const actions = document.createElement("div");
  actions.className = "feedback-form__actions";

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "btn-primary feedback-submit-btn";
  submitBtn.innerHTML = `
    <span class="feedback-submit-btn__spinner" aria-hidden="true"></span>
    <span class="feedback-submit-btn__label">Submit feedback</span>
  `;
  actions.appendChild(submitBtn);
  form.appendChild(actions);

  // Track every input so we can snapshot the current answer state on each
  // keystroke / change — the 30-second poll's refresh would otherwise lose
  // in-progress edits.
  form.addEventListener("input", () => captureAnswers(form, sorted, answerState));
  form.addEventListener("change", () => captureAnswers(form, sorted, answerState));

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    hideBanner(banner);
    captureAnswers(form, sorted, answerState);

    const { ok, firstInvalid, answers } = validateAndCollect(form, sorted);
    if (!ok) {
      focusFirstInvalid(form, firstInvalid);
      return;
    }

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      showBanner(banner, "No connection \u2014 please check your network and try again.");
      return;
    }

    setSubmitInFlight(submitBtn, true);
    try {
      const submittedAt = new Date().toISOString();
      await createDoc("feedbackResponses", { submittedAt, answers });
      writeSubmittedAt(submittedAt);
      // Stop the config poll — the confirmation card is terminal for this
      // view's lifetime and the next poll tick would only no-op through
      // the "already submitted" guard in rerender().
      runCleanup();
      ui.toast("success", "Thanks for your feedback.");
      // Swap the form for the confirmation card inline so the user does not
      // lose context (no page reload, no route change).
      renderConfirmationCard(host, submittedAt);
    } catch (err) {
      console.warn("[feedback] submit failed:", err);
      showBannerWithRetry(banner, submitBtn, () => form.requestSubmit());
    } finally {
      // When the form was replaced by the confirmation card above, submitBtn
      // is detached and setSubmitInFlight becomes a no-op. The guard is
      // important for the error path, which keeps the form rendered.
      if (submitBtn.isConnected) setSubmitInFlight(submitBtn, false);
    }
  });

  host.appendChild(form);
}

function buildQuestionBlock(q, prior) {
  if (q.type === "rating") return buildRatingQuestion(q, prior);
  if (q.type === "long") return buildLongTextQuestion(q, prior);
  return buildShortTextQuestion(q, prior);
}

function buildRatingQuestion(q, prior) {
  const fs = document.createElement("fieldset");
  fs.className = "feedback-question feedback-question--rating";
  fs.dataset.questionId = q.id;
  fs.dataset.questionType = "rating";
  fs.dataset.required = q.required ? "true" : "false";

  const legend = document.createElement("legend");
  legend.className = "feedback-question__legend";
  legend.innerHTML = `
    <span data-question-text>${escapeHtml(q.text || "")}</span>
    ${
      q.required
        ? `<span class="feedback-required-marker" aria-hidden="true">*</span><span class="sr-only"> required</span>`
        : ""
    }
  `;
  fs.appendChild(legend);

  const group = document.createElement("div");
  group.className = "feedback-rating-group";
  const name = `feedback-${cssId(q.id)}`;
  const priorInt = Number(prior);
  const hasPrior = Number.isInteger(priorInt) && priorInt >= 1 && priorInt <= 5;
  for (let i = 1; i <= 5; i++) {
    const label = document.createElement("label");
    label.className = "feedback-rating-radio";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = String(i);
    input.className = "feedback-rating-radio__input";
    if (hasPrior && priorInt === i) input.checked = true;
    const span = document.createElement("span");
    span.className = "feedback-rating-radio__label";
    span.textContent = String(i);
    label.append(input, span);
    group.appendChild(label);
  }
  fs.appendChild(group);

  const err = document.createElement("div");
  err.className = "feedback-inline-error";
  err.id = `feedback-err-${cssId(q.id)}`;
  err.hidden = true;
  fs.setAttribute("aria-describedby", err.id);
  fs.appendChild(err);

  return fs;
}

function buildShortTextQuestion(q, prior) {
  return buildTextQuestion(q, prior, "short", 200);
}

function buildLongTextQuestion(q, prior) {
  return buildTextQuestion(q, prior, "long", 2000);
}

function buildTextQuestion(q, prior, kind, maxLength) {
  const wrap = document.createElement("div");
  wrap.className = `feedback-question feedback-question--${kind}`;
  wrap.dataset.questionId = q.id;
  wrap.dataset.questionType = kind;
  wrap.dataset.required = q.required ? "true" : "false";

  const inputId = `feedback-input-${cssId(q.id)}`;
  const errId = `feedback-err-${cssId(q.id)}`;

  const label = document.createElement("label");
  label.className = "feedback-question__label";
  label.setAttribute("for", inputId);
  label.innerHTML = `
    <span data-question-text>${escapeHtml(q.text || "")}</span>
    ${
      q.required
        ? `<span class="feedback-required-marker" aria-hidden="true">*</span><span class="sr-only"> required</span>`
        : ""
    }
  `;
  wrap.appendChild(label);

  /** @type {HTMLInputElement | HTMLTextAreaElement} */
  let field;
  if (kind === "long") {
    field = document.createElement("textarea");
    field.className = "feedback-textarea";
    field.rows = 4;
  } else {
    field = /** @type {HTMLInputElement} */ (document.createElement("input"));
    /** @type {HTMLInputElement} */ (field).type = "text";
    field.className = "feedback-input";
  }
  field.id = inputId;
  field.setAttribute("maxlength", String(maxLength));
  field.setAttribute("aria-describedby", errId);
  if (typeof prior === "string") field.value = prior;
  wrap.appendChild(field);

  const err = document.createElement("div");
  err.className = "feedback-inline-error";
  err.id = errId;
  err.hidden = true;
  wrap.appendChild(err);

  return wrap;
}

/* ---------------- Validation + collection ---------------- */

function captureAnswers(form, sorted, answerState) {
  for (const q of sorted) {
    if (q.type === "rating") {
      const selected = form.querySelector(`input[name="feedback-${cssId(q.id)}"]:checked`);
      answerState[q.id] = selected ? Number(selected.value) : null;
    } else {
      const field = form.querySelector(`#feedback-input-${cssId(q.id)}`);
      answerState[q.id] = field ? field.value : "";
    }
  }
}

/**
 * Validate every required question and build the submission payload from
 * the current form state. Returns the collected answers (trimmed, typed)
 * plus a reference to the first invalid question so the caller can focus it.
 */
function validateAndCollect(form, sorted) {
  let firstInvalid = null;
  const answers = [];

  for (const q of sorted) {
    const block = form.querySelector(`[data-question-id="${cssId(q.id)}"]`);
    const errEl = block.querySelector(".feedback-inline-error");
    clearInvalid(block, errEl);

    if (q.type === "rating") {
      const selected = form.querySelector(`input[name="feedback-${cssId(q.id)}"]:checked`);
      const value = selected ? Number(selected.value) : null;
      if (q.required && (value === null || !Number.isInteger(value) || value < 1 || value > 5)) {
        setInvalid(block, errEl, "Please pick a rating.");
        if (!firstInvalid) firstInvalid = block;
        continue;
      }
      if (value !== null) answers.push({ questionId: q.id, value });
    } else {
      const field = form.querySelector(`#feedback-input-${cssId(q.id)}`);
      const trimmed = field ? field.value.trim() : "";
      const limit = q.type === "long" ? 2000 : 200;
      if (q.required && !trimmed) {
        setInvalid(block, errEl, "Please answer this question.");
        if (!firstInvalid) firstInvalid = block;
        continue;
      }
      if (trimmed.length > limit) {
        setInvalid(block, errEl, `Please keep this under ${limit} characters.`);
        if (!firstInvalid) firstInvalid = block;
        continue;
      }
      if (trimmed) answers.push({ questionId: q.id, value: trimmed });
    }
  }

  return { ok: firstInvalid == null, firstInvalid, answers };
}

function setInvalid(block, errEl, message) {
  block.setAttribute("aria-invalid", "true");
  errEl.textContent = message;
  errEl.hidden = false;
}

function clearInvalid(block, errEl) {
  block.removeAttribute("aria-invalid");
  errEl.textContent = "";
  errEl.hidden = true;
}

function focusFirstInvalid(form, block) {
  if (!block) return;
  const target = block.matches("fieldset")
    ? block.querySelector("input[type=radio]")
    : block.querySelector("input, textarea");
  if (target) {
    try { target.focus({ preventScroll: true }); } catch (_err) { target.focus(); }
  }
  try {
    block.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch (_err) {
    try { block.scrollIntoView(); } catch (_e) { /* no-op */ }
  }
}

/* ---------------- Submit state + inline banner ---------------- */

function setSubmitInFlight(btn, inFlight) {
  if (!btn) return;
  btn.disabled = inFlight;
  btn.classList.toggle("feedback-submit-btn--loading", inFlight);
}

function showBanner(el, message) {
  el.innerHTML = `<span>${escapeHtml(message)}</span>`;
  el.hidden = false;
  try {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  } catch (_err) { /* no-op */ }
}

function showBannerWithRetry(el, submitBtn, onRetry) {
  el.innerHTML = `
    <span>Could not submit your feedback. Please try again.</span>
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

/* ---------------- Confirmation card (post-submit) ---------------- */

function renderConfirmationCard(host, submittedAt) {
  const when = relativeTime(submittedAt) || "just now";
  host.innerHTML = `
    <section class="feedback-confirmation-card" role="status" aria-label="Feedback submitted">
      <h2 class="feedback-confirmation-card__title">Thanks for your feedback!</h2>
      <p class="feedback-confirmation-card__meta">Submitted ${escapeHtml(when)}.</p>
      <p class="feedback-confirmation-card__body">
        Your response helps the Gateway Chapter board plan next year's event.
      </p>
      <div class="feedback-confirmation-card__actions">
        <button type="button" class="btn-secondary" data-action="update">Update your feedback</button>
      </div>
    </section>
  `;
  const btn = host.querySelector("[data-action=update]");
  if (btn) {
    btn.addEventListener("click", () => {
      ui.toast("info", "Updating feedback isn't supported in this version.");
    });
  }
}

/* ---------------- localStorage helpers ---------------- */

function readSubmittedAt() {
  try {
    return localStorage.getItem(SUBMITTED_KEY);
  } catch (_err) {
    return null;
  }
}

function writeSubmittedAt(iso) {
  try {
    localStorage.setItem(SUBMITTED_KEY, iso);
  } catch (err) {
    console.warn("[feedback] submitted flag write failed:", err);
  }
}

/* ---------------- Escaping ---------------- */

/** Make a value DOM-id-safe. The resulting value is used inside the view's
 *  own namespace so collisions across questions with similar ids are not
 *  a concern. */
function cssId(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, "-");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
