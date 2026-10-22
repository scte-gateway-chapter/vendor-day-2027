// feedback-editor.js — admin Feedback config + results view (Task 23).
//
// Mounts into #admin-view-root. Two tabs: Form and Results.
//
// Form tab owns:
//   - the activation toggle, a one-field update to feedbackConfig.active
//     via /api/firestore-write (op:"update") that fires on tap.
//   - the questions editor: ordered list with type dropdown, text input,
//     required toggle, up/down reorder arrows, delete, Add question, and
//     Save/Reset buttons that are enabled only when the local draft is
//     dirty. Save normalizes `order` to 1..N based on the current UI
//     order before writing.
//
// Results tab owns:
//   - response count summary + latest-response timestamp,
//   - per-question aggregates (bar chart for ratings, scrollable list
//     for short/long text answers),
//   - Export CSV button (gated to year 2027; replaced by an archive note
//     from 2028 onward) that builds the CSV client-side and triggers a
//     Blob download.
//
// Read paths:
//   - feedbackConfig/singleton is publicly readable (firestore.rules
//     grants `allow read: if true;`), so we subscribe via /js/firebase.js
//     onSnapshot (30s poll).
//   - feedbackResponses is NOT publicly readable (rules deny read/update/
//     delete). The Results tab reads via adminReadCollection() which
//     routes to /api/firestore-read with the admin JWT.
//
// Write path:
//   - All writes go through /api/firestore-write via adminFetch. The
//     activation toggle writes only { active }. The Save flow writes
//     only { questions }. The two fields are never written in the same
//     request so the admin can flip activation independently of the
//     question edits-in-progress.
"use strict";

import { initFirestore, getDoc, onSnapshot } from "/js/firebase.js";
import * as ui from "/js/ui.js";
import { adminFetch, adminReadCollection } from "./admin-fetch.js";
import { registerAdminViewCleanup } from "./admin.js";
import {
  snapshotEditingTimestamp,
  hasConflict,
  formatLastEditedPhrase,
} from "./collision-check.js";
import { relativeTime } from "/js/utils/time.js";

const CONFIG_POLL_INTERVAL_MS = 30_000;
const RESPONSES_POLL_INTERVAL_MS = 60_000;
const QUESTION_TEXT_MAX = 200;
const EXPORT_YEAR = 2027;
const QUESTION_TYPES = ["rating", "short", "long"];
const QUESTION_TYPE_LABELS = {
  rating: "Rating (1-5)",
  short: "Short text",
  long: "Long text",
};
const ACTIVE_TAB_KEY = "vendorday2027.admin.feedback.activeTab";
const OFFLINE_TOOLTIP = "You're offline \u2014 admin changes require connectivity.";
const CSV_HEADER_MAX = 60;

/**
 * Render the admin Feedback editor into `host`.
 * @param {HTMLElement} host  typically `#admin-view-root`.
 * @returns {Promise<void>}
 */
export default async function renderFeedbackEditor(host) {
  host.innerHTML = "";

  const container = document.createElement("section");
  container.className = "admin-feedback-view";
  container.setAttribute("aria-label", "Admin Feedback editor");
  host.appendChild(container);

  const header = buildStickyHeader();
  const offlineBanner = buildOfflineBanner();
  const tabBar = buildTabBar();
  const panels = buildPanels();

  container.append(header.el, offlineBanner.el, tabBar.el, panels.el);

  // Prime /api/config; cached inside firebase.js after the first call.
  const configReady = initFirestore().catch((err) => {
    console.warn("[admin-feedback] /api/config load failed:", err);
    return null;
  });

  /** @type {object | null} Server copy of feedbackConfig/singleton. */
  let serverConfig = null;
  /** @type {Array<Question>} Local draft of the question list the admin is editing. */
  let draftQuestions = [];
  /** Collision snapshot taken when the editor last synced from the server. */
  let snapshotTs = null;
  /** @type {Error | null} */
  let configErr = null;
  let sawFirstConfig = false;
  /**
   * Whether we have ever synced the draft from a server read. This is distinct
   * from `serverConfig === null`: the config doc may be legitimately absent
   * (first-time setup, before anyone has saved), in which case every poll
   * still returns null but we should only sync-into-the-draft once, not on
   * every subsequent poll (which would clobber the admin's in-progress edits).
   */
  let hasInitiallySynced = false;
  let configErrorToasted = false;
  let activationInFlight = false;
  let saveInFlight = false;
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  let activeTab = readActiveTab();

  /** @type {object[] | null} Response docs for the Results tab. Null = not loaded yet. */
  let responses = null;
  /** @type {Error | null} */
  let responsesErr = null;
  let responsesLoading = false;
  let responsesInitialLoaded = false;
  /** @type {number | null} */
  let responsesPollTimer = null;

  /* ---------------- Config subscription (public read) ---------------- */

  /** @type {(() => void) | null} */
  let unsubConfig = null;
  async function startConfigSubscription() {
    try { await configReady; } catch (_err) { /* non-fatal */ }
    unsubConfig = onSnapshot(
      "feedbackConfig/singleton",
      (data, err) => {
        if (err) {
          console.warn("[admin-feedback] config poll failed:", err);
          configErr = err;
          if (!serverConfig && !configErrorToasted) {
            ui.toast(
              "error",
              "Couldn't load feedback config. Tap Retry to try again.",
            );
            configErrorToasted = true;
          }
        } else {
          configErr = null;
          configErrorToasted = false;
          applyServerConfig(data);
        }
        sawFirstConfig = true;
        renderActive();
      },
      { intervalMs: CONFIG_POLL_INTERVAL_MS },
    );
  }

  function restartConfigSubscription() {
    if (unsubConfig) { unsubConfig(); unsubConfig = null; }
    configErr = null;
    serverConfig = null;
    sawFirstConfig = false;
    configErrorToasted = false;
    renderActive();
    startConfigSubscription();
  }

  /**
   * Replace the local server copy with the latest Firestore read. If the
   * local draft is clean (equal to the previously-rendered server state),
   * sync the draft forward too so an admin colleague's edits are visible.
   * If the draft is dirty, leave it alone — the admin's unsaved edits
   * are preserved and the Save flow surfaces a collision banner on write.
   */
  function applyServerConfig(data) {
    const nextConfig = data && typeof data === "object" ? data : null;
    const nextQuestions = normalizeQuestions(nextConfig?.questions);
    const nextSnapshotTs = snapshotEditingTimestamp(nextConfig);

    // "Clean" means either this is the very first server read (so there is
    // nothing to preserve), OR the current draft is byte-identical to what
    // we last synced from the server (so the admin hasn't started editing
    // yet and it is safe to pick up colleagues' changes). Any divergence
    // leaves the draft alone; the Save flow handles collisions on write.
    const draftWasClean =
      !hasInitiallySynced ||
      serializeQuestions(draftQuestions) ===
        serializeQuestions(normalizeQuestions(serverConfig?.questions));

    serverConfig = nextConfig;
    if (draftWasClean) {
      draftQuestions = cloneQuestions(nextQuestions);
      snapshotTs = nextSnapshotTs;
    }
    hasInitiallySynced = true;
  }

  /* ---------------- Responses load (admin broker) ---------------- */

  async function refreshResponses() {
    if (responsesLoading) return;
    responsesLoading = true;
    try {
      const list = await adminReadCollection("feedbackResponses", {
        limit: 1000,
      });
      responses = Array.isArray(list) ? list : [];
      responsesErr = null;
    } catch (err) {
      if (err?.code === "session-expired") return;
      console.warn("[admin-feedback] responses load failed:", err);
      responsesErr = err;
    } finally {
      responsesLoading = false;
      responsesInitialLoaded = true;
      if (activeTab === "results") renderResultsPanel();
    }
  }

  function startResponsesPoll() {
    stopResponsesPoll();
    responsesPollTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refreshResponses();
    }, RESPONSES_POLL_INTERVAL_MS);
  }

  function stopResponsesPoll() {
    if (responsesPollTimer != null) {
      clearInterval(responsesPollTimer);
      responsesPollTimer = null;
    }
  }

  /* ---------------- Rendering ---------------- */

  function renderActive() {
    offlineBanner.setVisible(!online);
    header.setLastEdited(serverConfig);
    tabBar.setActive(activeTab);
    panels.setActive(activeTab);
    if (activeTab === "form") {
      renderFormPanel();
    } else {
      renderResultsPanel();
    }
  }

  function renderFormPanel() {
    const host = panels.form;

    if (configErr && !serverConfig) {
      host.innerHTML = `
        <div class="status-error" role="alert">
          <p>Couldn't load the feedback form config.</p>
          <button type="button" class="btn-secondary" data-retry>Retry</button>
        </div>
      `;
      host.querySelector("[data-retry]").addEventListener("click", () =>
        restartConfigSubscription(),
      );
      return;
    }
    if (!sawFirstConfig) {
      host.innerHTML = `
        <div class="admin-feedback-toggle skeleton-card" aria-hidden="true"></div>
        <div class="admin-question-row skeleton-card" aria-hidden="true"></div>
        <div class="admin-question-row skeleton-card" aria-hidden="true"></div>
      `;
      return;
    }

    host.innerHTML = "";
    host.appendChild(buildActivationToggle());

    // Form-level banner slot (collision warning on save).
    const banner = document.createElement("div");
    banner.className = "admin-modal__banner admin-feedback-form-banner";
    banner.setAttribute("data-form-banner", "");
    banner.hidden = true;
    host.appendChild(banner);

    host.appendChild(buildQuestionsList());
    host.appendChild(buildQuestionsActions());
  }

  function renderResultsPanel() {
    const host = panels.results;

    const questions = normalizeQuestions(serverConfig?.questions);

    host.innerHTML = "";

    // Top bar: summary (left) + Export (right / replaced by archive note).
    const summaryBar = document.createElement("div");
    summaryBar.className = "admin-results-summary";

    const summaryText = document.createElement("p");
    summaryText.className = "admin-results-summary__text";
    summaryText.setAttribute("aria-live", "polite");
    if (responsesErr && !responses) {
      summaryText.textContent = "Couldn't load responses.";
    } else if (!responsesInitialLoaded) {
      summaryText.textContent = "Loading responses\u2026";
    } else {
      const count = (responses || []).length;
      const latest = latestResponseTimestamp(responses || []);
      const latestPhrase = latest ? ` Latest ${relativeTime(latest) || "just now"}.` : "";
      summaryText.textContent =
        count === 0
          ? "No responses collected yet."
          : `${count} ${count === 1 ? "response" : "responses"} collected.${latestPhrase}`;
    }
    summaryBar.appendChild(summaryText);

    const exportSlot = document.createElement("div");
    exportSlot.className = "admin-results-export";
    const currentYear = new Date().getFullYear();
    if (currentYear === EXPORT_YEAR) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-secondary admin-results-export__btn";
      btn.textContent = "Export CSV";
      const canExport =
        responsesInitialLoaded && !responsesErr && (responses || []).length > 0;
      if (!canExport) {
        btn.disabled = true;
        btn.setAttribute("aria-disabled", "true");
      }
      btn.addEventListener("click", () => {
        exportCsv(questions, responses || []);
      });
      exportSlot.appendChild(btn);
    } else {
      const note = document.createElement("p");
      note.className = "admin-results-export__archive";
      note.textContent =
        "Response data has been archived (export was available during 2027).";
      exportSlot.appendChild(note);
    }
    summaryBar.appendChild(exportSlot);
    host.appendChild(summaryBar);

    // Error strip (shown when a refresh failed but we have cached data).
    if (responsesErr && responses) {
      const strip = document.createElement("div");
      strip.className = "status-error admin-feedback-error-strip";
      strip.setAttribute("role", "status");
      strip.innerHTML = `
        <span>Couldn't refresh responses. Showing last-loaded.</span>
        <button type="button" class="btn-secondary" data-retry>Retry</button>
      `;
      strip.querySelector("[data-retry]").addEventListener("click", () =>
        refreshResponses(),
      );
      host.appendChild(strip);
    }
    if (responsesErr && !responses) {
      const err = document.createElement("div");
      err.className = "status-error";
      err.setAttribute("role", "alert");
      err.innerHTML = `
        <p>Couldn't load responses.</p>
        <button type="button" class="btn-secondary" data-retry>Retry</button>
      `;
      err.querySelector("[data-retry]").addEventListener("click", () =>
        refreshResponses(),
      );
      host.appendChild(err);
      return;
    }

    // Empty-state cases.
    if (!questions.length) {
      const empty = document.createElement("div");
      empty.className = "placeholder-card";
      empty.innerHTML = `
        <h2>No questions configured yet</h2>
        <p>Add questions in the Form tab to start collecting feedback.</p>
      `;
      host.appendChild(empty);
      return;
    }
    if (!responsesInitialLoaded) {
      const loading = document.createElement("div");
      loading.className = "admin-result-card skeleton-card";
      loading.setAttribute("aria-hidden", "true");
      host.appendChild(loading);
      return;
    }

    // Per-question aggregation cards.
    for (const q of questions) {
      host.appendChild(buildResultCard(q, responses || []));
    }
  }

  /* ---------------- Form tab building blocks ---------------- */

  function buildActivationToggle() {
    const active = serverConfig?.active === true;
    const wrap = document.createElement("div");
    wrap.className = `admin-feedback-toggle admin-feedback-toggle--${active ? "on" : "off"}`;

    const label = document.createElement("label");
    label.className = "admin-feedback-toggle__label";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "admin-feedback-toggle__input";
    input.setAttribute("role", "switch");
    input.setAttribute(
      "aria-label",
      active
        ? "Feedback form is on. Deactivate to hide the form from attendees."
        : "Feedback form is off. Activate to open the form to attendees.",
    );
    input.checked = active;
    input.disabled = !online || activationInFlight;

    const track = document.createElement("span");
    track.className = "admin-feedback-toggle__track";
    track.setAttribute("aria-hidden", "true");
    const thumb = document.createElement("span");
    thumb.className = "admin-feedback-toggle__thumb";
    track.appendChild(thumb);

    const copy = document.createElement("div");
    copy.className = "admin-feedback-toggle__copy";
    const pill = document.createElement("span");
    pill.className = `admin-feedback-toggle__pill admin-feedback-toggle__pill--${active ? "on" : "off"}`;
    pill.textContent = active ? "LIVE" : "OFF";
    const text = document.createElement("p");
    text.className = "admin-feedback-toggle__text";
    text.textContent = active
      ? "Feedback form is LIVE. Attendees can submit responses right now."
      : "Feedback form is OFF. Attendees see \u201CFeedback opens during the event.\u201D";
    copy.append(pill, text);

    label.append(input, track, copy);
    wrap.appendChild(label);

    const banner = document.createElement("div");
    banner.className = "status-error admin-feedback-toggle__banner";
    banner.setAttribute("role", "alert");
    banner.hidden = true;
    wrap.appendChild(banner);

    input.addEventListener("change", async () => {
      if (activationInFlight) return;
      if (!online) {
        input.checked = active; // revert
        return;
      }
      const nextActive = input.checked;
      activationInFlight = true;
      input.disabled = true;
      banner.hidden = true;
      banner.textContent = "";
      try {
        await adminFetch("/api/firestore-write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            collection: "feedbackConfig",
            docId: "singleton",
            op: "update",
            data: { active: nextActive },
          }),
        });
        ui.toast(
          "success",
          nextActive ? "Feedback form activated." : "Feedback form deactivated.",
        );
        // Optimistically mirror the write locally so the UI updates
        // without waiting for the next 30s poll.
        if (serverConfig) {
          serverConfig = { ...serverConfig, active: nextActive };
        } else {
          serverConfig = { active: nextActive, questions: [] };
        }
        renderActive();
      } catch (err) {
        console.warn("[admin-feedback] activation toggle failed:", err);
        if (err?.code === "session-expired") return;
        input.checked = active; // revert optimistic flip
        banner.textContent = nextActive
          ? "Could not activate the form. Try again."
          : "Could not deactivate the form. Try again.";
        banner.hidden = false;
      } finally {
        activationInFlight = false;
        input.disabled = !online;
      }
    });

    return wrap;
  }

  function buildQuestionsList() {
    const list = document.createElement("div");
    list.className = "admin-questions-list";
    list.setAttribute("aria-label", "Feedback questions");

    if (!draftQuestions.length) {
      const empty = document.createElement("div");
      empty.className = "placeholder-card admin-questions-empty";
      empty.innerHTML = `
        <p>No questions yet. Tap <strong>Add question</strong> to create the first one.</p>
      `;
      list.appendChild(empty);
      return list;
    }

    draftQuestions.forEach((q, idx) => {
      list.appendChild(
        buildQuestionRow(q, idx, {
          isFirst: idx === 0,
          isLast: idx === draftQuestions.length - 1,
        }),
      );
    });
    return list;
  }

  function buildQuestionRow(q, idx, { isFirst, isLast }) {
    const row = document.createElement("div");
    row.className = "admin-question-row";
    row.dataset.questionId = q.id;

    const idText = idx + 1;

    // --- Reorder arrows ---
    const reorder = document.createElement("div");
    reorder.className = "admin-question-row__reorder";
    reorder.setAttribute("role", "group");
    reorder.setAttribute("aria-label", `Reorder question ${idText}`);

    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "admin-question-row__reorder-btn";
    upBtn.setAttribute("aria-label", `Move question ${idText} up`);
    upBtn.textContent = "\u2191";
    upBtn.disabled = isFirst || !online;
    if (!online) upBtn.setAttribute("title", OFFLINE_TOOLTIP);
    upBtn.addEventListener("click", () => {
      if (isFirst || !online) return;
      swapQuestions(idx, idx - 1);
    });

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "admin-question-row__reorder-btn";
    downBtn.setAttribute("aria-label", `Move question ${idText} down`);
    downBtn.textContent = "\u2193";
    downBtn.disabled = isLast || !online;
    if (!online) downBtn.setAttribute("title", OFFLINE_TOOLTIP);
    downBtn.addEventListener("click", () => {
      if (isLast || !online) return;
      swapQuestions(idx, idx + 1);
    });

    reorder.append(upBtn, downBtn);

    // --- Type dropdown ---
    const typeWrap = document.createElement("div");
    typeWrap.className = "admin-question-row__type";
    const typeId = `admin-q-type-${idx}`;
    const typeLabel = document.createElement("label");
    typeLabel.setAttribute("for", typeId);
    typeLabel.textContent = "Type";
    typeLabel.className = "sr-only";
    const typeSelect = document.createElement("select");
    typeSelect.id = typeId;
    typeSelect.className = "admin-input admin-question-row__type-select";
    typeSelect.setAttribute("aria-label", `Question ${idText} type`);
    for (const t of QUESTION_TYPES) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = QUESTION_TYPE_LABELS[t];
      if (q.type === t) opt.selected = true;
      typeSelect.appendChild(opt);
    }
    typeSelect.addEventListener("change", () => {
      q.type = typeSelect.value;
      syncActionsEnabled();
    });
    typeWrap.append(typeLabel, typeSelect);

    // --- Text input ---
    const textWrap = document.createElement("div");
    textWrap.className = "admin-question-row__text";
    const textId = `admin-q-text-${idx}`;
    const textLabel = document.createElement("label");
    textLabel.setAttribute("for", textId);
    textLabel.textContent = `Question ${idText}`;
    textLabel.className = "sr-only";
    const textInput = document.createElement("input");
    textInput.type = "text";
    textInput.id = textId;
    textInput.className = "admin-input admin-question-row__text-input";
    textInput.setAttribute("maxlength", String(QUESTION_TEXT_MAX));
    textInput.setAttribute("required", "required");
    textInput.setAttribute(
      "aria-label",
      `Question ${idText} text`,
    );
    textInput.value = q.text || "";
    textInput.placeholder = "Question text";
    textInput.addEventListener("input", () => {
      q.text = textInput.value;
      clearRowError(row);
      syncActionsEnabled();
    });
    const err = document.createElement("p");
    err.className = "admin-inline-error admin-question-row__error";
    err.hidden = true;
    err.id = `admin-q-text-err-${idx}`;
    textInput.setAttribute("aria-describedby", err.id);
    textWrap.append(textLabel, textInput, err);

    // --- Required toggle ---
    const requiredWrap = document.createElement("label");
    requiredWrap.className = "admin-question-row__required";
    const requiredInput = document.createElement("input");
    requiredInput.type = "checkbox";
    requiredInput.className = "admin-question-row__required-input";
    requiredInput.checked = q.required === true;
    requiredInput.setAttribute(
      "aria-label",
      `Question ${idText} is required`,
    );
    requiredInput.addEventListener("change", () => {
      q.required = requiredInput.checked;
      syncActionsEnabled();
    });
    const requiredText = document.createElement("span");
    requiredText.className = "admin-question-row__required-text";
    requiredText.textContent = "Required to answer";
    requiredWrap.append(requiredInput, requiredText);

    // --- Delete button ---
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn-destructive admin-question-row__delete";
    deleteBtn.setAttribute("aria-label", `Delete question ${idText}`);
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      draftQuestions.splice(idx, 1);
      renderFormPanel();
    });

    row.append(reorder, typeWrap, textWrap, requiredWrap, deleteBtn);
    return row;
  }

  function buildQuestionsActions() {
    const wrap = document.createElement("div");
    wrap.className = "admin-questions-actions";

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn-secondary admin-questions-actions__add";
    addBtn.textContent = "Add question";
    addBtn.setAttribute("data-questions-add", "");
    addBtn.disabled = !online;
    if (!online) addBtn.setAttribute("title", OFFLINE_TOOLTIP);
    addBtn.addEventListener("click", () => {
      draftQuestions.push(createBlankQuestion());
      renderFormPanel();
      // Focus the new row's text input for immediate typing.
      requestAnimationFrame(() => {
        const inputs = panels.form.querySelectorAll(
          ".admin-question-row__text-input",
        );
        const last = inputs[inputs.length - 1];
        if (last && typeof last.focus === "function") {
          try { last.focus(); } catch (_err) { /* no-op */ }
        }
      });
    });

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "btn-secondary admin-questions-actions__reset";
    resetBtn.textContent = "Reset changes";
    resetBtn.setAttribute("data-questions-reset", "");
    resetBtn.addEventListener("click", () => {
      draftQuestions = cloneQuestions(normalizeQuestions(serverConfig?.questions));
      renderFormPanel();
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn-primary admin-questions-actions__save";
    saveBtn.textContent = "Save changes";
    saveBtn.setAttribute("data-questions-save", "");
    saveBtn.addEventListener("click", () => {
      saveQuestions();
    });

    wrap.append(addBtn, resetBtn, saveBtn);

    // Initial state — enable/disable Save/Reset based on dirty state.
    queueMicrotask(() => syncActionsEnabled());

    return wrap;
  }

  /** Enable/disable Save and Reset based on whether draft != server. */
  function syncActionsEnabled() {
    const resetBtn = panels.form.querySelector("[data-questions-reset]");
    const saveBtn = panels.form.querySelector("[data-questions-save]");
    const addBtn = panels.form.querySelector("[data-questions-add]");
    if (!resetBtn || !saveBtn) return;

    const dirty = isDraftDirty();
    const disable = !dirty || !online || saveInFlight;

    resetBtn.disabled = disable;
    saveBtn.disabled = disable;
    if (disable) {
      resetBtn.setAttribute("aria-disabled", "true");
      saveBtn.setAttribute("aria-disabled", "true");
    } else {
      resetBtn.removeAttribute("aria-disabled");
      saveBtn.removeAttribute("aria-disabled");
    }
    if (!online) {
      resetBtn.setAttribute("title", OFFLINE_TOOLTIP);
      saveBtn.setAttribute("title", OFFLINE_TOOLTIP);
    } else {
      resetBtn.removeAttribute("title");
      saveBtn.removeAttribute("title");
    }
    if (addBtn) {
      addBtn.disabled = !online || saveInFlight;
      if (!online) addBtn.setAttribute("title", OFFLINE_TOOLTIP);
      else addBtn.removeAttribute("title");
    }
  }

  function isDraftDirty() {
    const serverSerialized = serializeQuestions(
      normalizeQuestions(serverConfig?.questions),
    );
    const draftSerialized = serializeQuestions(draftQuestions);
    return serverSerialized !== draftSerialized;
  }

  function swapQuestions(aIdx, bIdx) {
    if (
      aIdx < 0 ||
      bIdx < 0 ||
      aIdx >= draftQuestions.length ||
      bIdx >= draftQuestions.length
    ) {
      return;
    }
    const tmp = draftQuestions[aIdx];
    draftQuestions[aIdx] = draftQuestions[bIdx];
    draftQuestions[bIdx] = tmp;
    renderFormPanel();
  }

  function showFormBanner(kind, html) {
    const banner = panels.form.querySelector("[data-form-banner]");
    if (!banner) return;
    banner.className = `admin-modal__banner admin-modal__banner--${kind} admin-feedback-form-banner`;
    banner.innerHTML = html;
    banner.hidden = false;
    try { banner.scrollIntoView({ block: "center", behavior: "smooth" }); }
    catch (_err) { /* no-op */ }
    const retryBtn = banner.querySelector("[data-banner-retry]");
    if (retryBtn) retryBtn.addEventListener("click", () => {
      hideFormBanner();
      saveQuestions();
    });
    const overwriteBtn = banner.querySelector("[data-banner-overwrite]");
    if (overwriteBtn) overwriteBtn.addEventListener("click", () => {
      hideFormBanner();
      saveQuestions({ bypassConflictCheck: true });
    });
    const reloadBtn = banner.querySelector("[data-banner-reload]");
    if (reloadBtn) reloadBtn.addEventListener("click", async () => {
      hideFormBanner();
      try {
        const latest = await getDoc("feedbackConfig/singleton");
        serverConfig = latest;
        draftQuestions = cloneQuestions(normalizeQuestions(latest?.questions));
        snapshotTs = snapshotEditingTimestamp(latest);
        renderFormPanel();
      } catch (err) {
        console.warn("[admin-feedback] reload-latest failed:", err);
        showFormBanner(
          "error",
          `<p>Couldn't reload the latest copy. <button type="button" class="btn-link" data-banner-retry>Retry</button></p>`,
        );
      }
    });
  }

  function hideFormBanner() {
    const banner = panels.form.querySelector("[data-form-banner]");
    if (!banner) return;
    banner.hidden = true;
    banner.innerHTML = "";
    banner.className = "admin-modal__banner admin-feedback-form-banner";
  }

  async function saveQuestions({ bypassConflictCheck } = {}) {
    if (saveInFlight) return;
    if (!online) {
      showFormBanner("error", `<p>You're offline. Reconnect and try again.</p>`);
      return;
    }

    // Validate every row before writing. Highlight the first invalid row.
    hideFormBanner();
    let firstInvalid = null;
    for (let i = 0; i < draftQuestions.length; i++) {
      const q = draftQuestions[i];
      const row = panels.form.querySelectorAll(".admin-question-row")[i];
      clearRowError(row);
      const text = (q.text || "").trim();
      if (!text) {
        setRowError(row, "Question text is required.");
        if (!firstInvalid) firstInvalid = row;
        continue;
      }
      if (text.length > QUESTION_TEXT_MAX) {
        setRowError(
          row,
          `Keep this under ${QUESTION_TEXT_MAX} characters.`,
        );
        if (!firstInvalid) firstInvalid = row;
        continue;
      }
      if (!QUESTION_TYPES.includes(q.type)) {
        setRowError(row, "Pick a question type.");
        if (!firstInvalid) firstInvalid = row;
      }
    }
    if (firstInvalid) {
      const focusable =
        firstInvalid.querySelector(".admin-question-row__text-input") ||
        firstInvalid.querySelector("select");
      if (focusable) {
        try { focusable.focus(); } catch (_err) { /* no-op */ }
      }
      try { firstInvalid.scrollIntoView({ block: "center", behavior: "smooth" }); }
      catch (_err) { /* no-op */ }
      return;
    }

    // Build the payload: trim text and normalize `order` to 1..N.
    const payloadQuestions = draftQuestions.map((q, idx) => ({
      id: q.id,
      type: q.type,
      text: (q.text || "").trim(),
      required: q.required === true,
      order: idx + 1,
    }));

    saveInFlight = true;
    syncActionsEnabled();

    try {
      // Collision soft-safeguard: re-read before writing.
      if (!bypassConflictCheck && snapshotTs) {
        try {
          const latest = await getDoc("feedbackConfig/singleton");
          if (hasConflict(latest, snapshotTs)) {
            saveInFlight = false;
            syncActionsEnabled();
            showFormBanner(
              "warning",
              `<p>These questions were edited by someone else since you opened the editor. Reload to see their changes, or Overwrite to save yours anyway.</p>
               <div class="admin-modal__banner-actions">
                 <button type="button" class="btn-secondary" data-banner-reload>Reload</button>
                 <button type="button" class="btn-primary" data-banner-overwrite>Overwrite</button>
               </div>`,
            );
            return;
          }
        } catch (err) {
          // Non-fatal; proceed to save. The write will surface its own
          // error on failure.
          console.warn("[admin-feedback] collision pre-check failed:", err);
        }
      }

      await adminFetch("/api/firestore-write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection: "feedbackConfig",
          docId: "singleton",
          op: "update",
          data: { questions: payloadQuestions },
        }),
      });

      // Reflect the write locally so Save/Reset go idle until a new edit
      // dirties the draft. The next poll (<=30s) picks up the server-
      // stamped updatedAt / updatedBy for the sticky header.
      serverConfig = {
        ...(serverConfig || {}),
        questions: cloneQuestions(payloadQuestions),
      };
      draftQuestions = cloneQuestions(payloadQuestions);
      ui.toast("success", "Feedback questions saved.");
      renderFormPanel();
    } catch (err) {
      console.warn("[admin-feedback] save failed:", err);
      if (err?.code === "session-expired") return;
      showFormBanner(
        "error",
        `<p>Could not save \u2014 try again. <button type="button" class="btn-link" data-banner-retry>Retry</button></p>`,
      );
    } finally {
      saveInFlight = false;
      syncActionsEnabled();
    }
  }

  function clearRowError(row) {
    if (!row) return;
    const err = row.querySelector(".admin-question-row__error");
    if (err) {
      err.hidden = true;
      err.textContent = "";
    }
    const input = row.querySelector(".admin-question-row__text-input");
    if (input) input.removeAttribute("aria-invalid");
  }

  function setRowError(row, message) {
    if (!row) return;
    const err = row.querySelector(".admin-question-row__error");
    if (err) {
      err.textContent = message;
      err.hidden = false;
    }
    const input = row.querySelector(".admin-question-row__text-input");
    if (input) input.setAttribute("aria-invalid", "true");
  }

  /* ---------------- Tab switching ---------------- */

  tabBar.setOnChange((next) => {
    if (next === activeTab) return;
    activeTab = next;
    writeActiveTab(next);
    renderActive();
    if (next === "results") {
      refreshResponses();
    }
  });

  /* ---------------- Connectivity + visibility ---------------- */

  const onOnline = () => {
    online = true;
    renderActive();
    if (activeTab === "results") refreshResponses();
  };
  const onOffline = () => {
    online = false;
    renderActive();
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  const onVisibility = () => {
    if (document.visibilityState !== "visible") return;
    if (activeTab === "results") refreshResponses();
  };
  document.addEventListener("visibilitychange", onVisibility);

  registerAdminViewCleanup(() => {
    if (unsubConfig) { unsubConfig(); unsubConfig = null; }
    stopResponsesPoll();
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onVisibility);
  });

  // Initial paint before any data arrives.
  renderActive();
  startConfigSubscription();
  // Kick off the Results-tab load eagerly so switching tabs feels instant.
  refreshResponses();
  startResponsesPoll();

  document.title = "Admin \u2014 Feedback \u2014 Vendor Day 2027";
}

/* =================================================================
 * Sticky secondary header
 * ================================================================= */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "admin-feedback-header";
  el.innerHTML = `
    <div class="admin-feedback-header__row">
      <h2 class="admin-feedback-header__title">Admin \u2014 Feedback</h2>
      <p class="admin-feedback-header__meta" aria-live="polite">never edited</p>
    </div>
  `;
  const metaEl = el.querySelector(".admin-feedback-header__meta");
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
  el.textContent = "You're offline \u2014 showing last-saved feedback config.";
  el.hidden = true;
  function setVisible(visible) {
    el.hidden = !visible;
  }
  return { el, setVisible };
}

/* =================================================================
 * Tab bar
 * ================================================================= */

function buildTabBar() {
  const el = document.createElement("div");
  el.className = "admin-tab-bar";
  el.setAttribute("role", "tablist");
  el.setAttribute("aria-label", "Feedback tabs");

  const tabs = [
    { id: "form", label: "Form", panelId: "admin-feedback-panel-form" },
    { id: "results", label: "Results", panelId: "admin-feedback-panel-results" },
  ];

  /** @type {HTMLButtonElement[]} */
  const btns = [];
  let onChangeHandler = null;

  for (const t of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "admin-tab";
    btn.id = `admin-feedback-tab-${t.id}`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-controls", t.panelId);
    btn.setAttribute("aria-selected", "false");
    btn.setAttribute("tabindex", "-1");
    btn.dataset.tabId = t.id;
    btn.textContent = t.label;
    btn.addEventListener("click", () => {
      if (typeof onChangeHandler === "function") onChangeHandler(t.id);
    });
    el.appendChild(btn);
    btns.push(btn);
  }

  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    const idx = btns.findIndex(
      (b) => b === document.activeElement,
    );
    const current = idx < 0 ? 0 : idx;
    const nextIdx =
      ev.key === "ArrowRight"
        ? (current + 1) % btns.length
        : (current - 1 + btns.length) % btns.length;
    const nextBtn = btns[nextIdx];
    try { nextBtn.focus(); } catch (_err) { /* no-op */ }
    if (typeof onChangeHandler === "function") {
      onChangeHandler(nextBtn.dataset.tabId);
    }
  });

  function setActive(id) {
    for (const btn of btns) {
      const isActive = btn.dataset.tabId === id;
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
      btn.setAttribute("tabindex", isActive ? "0" : "-1");
      btn.classList.toggle("admin-tab--active", isActive);
    }
  }

  function setOnChange(fn) {
    onChangeHandler = typeof fn === "function" ? fn : null;
  }

  return { el, setActive, setOnChange };
}

/* =================================================================
 * Tab panels container
 * ================================================================= */

function buildPanels() {
  const el = document.createElement("div");
  el.className = "admin-tab-panels";

  const form = document.createElement("section");
  form.className = "admin-tab-panel admin-tab-panel--form";
  form.id = "admin-feedback-panel-form";
  form.setAttribute("role", "tabpanel");
  form.setAttribute("aria-labelledby", "admin-feedback-tab-form");
  form.setAttribute("tabindex", "0");

  const results = document.createElement("section");
  results.className = "admin-tab-panel admin-tab-panel--results";
  results.id = "admin-feedback-panel-results";
  results.setAttribute("role", "tabpanel");
  results.setAttribute("aria-labelledby", "admin-feedback-tab-results");
  results.setAttribute("tabindex", "0");

  el.append(form, results);

  function setActive(id) {
    form.hidden = id !== "form";
    results.hidden = id !== "results";
  }

  return { el, form, results, setActive };
}

/* =================================================================
 * Results tab — aggregation cards
 * ================================================================= */

function buildResultCard(question, allResponses) {
  const card = document.createElement("article");
  card.className = "admin-result-card";
  card.dataset.questionId = question.id;
  card.dataset.questionType = question.type;

  const header = document.createElement("header");
  header.className = "admin-result-card__header";
  const title = document.createElement("h3");
  title.className = "admin-result-card__title";
  title.textContent = question.text || "(Untitled question)";
  const typeChip = document.createElement("span");
  typeChip.className = "admin-result-card__type-chip";
  typeChip.textContent = QUESTION_TYPE_LABELS[question.type] || question.type;
  header.append(title, typeChip);
  card.appendChild(header);

  const answers = collectAnswersFor(question, allResponses);

  if (answers.length === 0) {
    const empty = document.createElement("p");
    empty.className = "admin-result-card__empty";
    empty.textContent = "No responses collected for this question yet.";
    card.appendChild(empty);
    return card;
  }

  if (question.type === "rating") {
    card.appendChild(buildRatingChart(answers));
  } else if (question.type === "short") {
    card.appendChild(buildTextList(answers, { max: 50, variant: "short" }));
  } else {
    card.appendChild(buildTextList(answers, { max: 20, variant: "long" }));
  }

  return card;
}

/**
 * Horizontal bar chart with one bar per 1-5 rating. Each bar's width is
 * proportional to that bar's share of the top-count bucket (so the
 * largest bar fills the row). The average is appended below the chart
 * at one decimal place.
 */
function buildRatingChart(answers) {
  const buckets = [0, 0, 0, 0, 0];
  let sum = 0;
  let count = 0;
  for (const a of answers) {
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= 5) {
      buckets[n - 1] += 1;
      sum += n;
      count += 1;
    }
  }
  const maxBucket = Math.max(1, ...buckets);
  const avg = count > 0 ? sum / count : 0;

  const chart = document.createElement("div");
  chart.className = "admin-rating-chart";
  chart.setAttribute("role", "img");
  chart.setAttribute(
    "aria-label",
    `Rating distribution. ${count} ${count === 1 ? "response" : "responses"}. Average ${avg.toFixed(1)}.`,
  );

  for (let i = 5; i >= 1; i--) {
    const bucketCount = buckets[i - 1];
    const pct = Math.round((bucketCount / maxBucket) * 100);

    const row = document.createElement("div");
    row.className = "admin-rating-bar-row";

    const label = document.createElement("span");
    label.className = "admin-rating-bar__label";
    label.textContent = `${i} \u2605`;
    label.setAttribute("aria-hidden", "true");

    const barWrap = document.createElement("div");
    barWrap.className = "admin-rating-bar-track";
    const bar = document.createElement("div");
    bar.className = "admin-rating-bar";
    bar.style.width = `${pct}%`;
    barWrap.appendChild(bar);

    const countEl = document.createElement("span");
    countEl.className = "admin-rating-bar__count";
    countEl.textContent = String(bucketCount);

    row.append(label, barWrap, countEl);
    chart.appendChild(row);
  }

  const avgEl = document.createElement("p");
  avgEl.className = "admin-rating-average";
  avgEl.textContent = `Average rating: ${avg.toFixed(1)} (across ${count} ${count === 1 ? "response" : "responses"})`;
  chart.appendChild(avgEl);

  return chart;
}

/**
 * Scrollable list of text answers. `max` caps the rendered row count;
 * extra rows beyond the cap collapse to a muted "and X more\u2026".
 * The `long` variant adds a 3-line clamp with an Expand toggle; the
 * `short` variant renders each answer on a single line.
 */
function buildTextList(answers, { max, variant }) {
  const trimmed = answers
    .map((a) => (typeof a === "string" ? a.trim() : ""))
    .filter((s) => s.length > 0);
  const shown = trimmed.slice(0, max);
  const overflow = trimmed.length - shown.length;

  const list = document.createElement("div");
  list.className = `admin-text-response-list admin-text-response-list--${variant}`;

  for (const value of shown) {
    const row = document.createElement("div");
    row.className = `admin-text-response-row admin-text-response-row--${variant}`;

    const body = document.createElement("p");
    body.className = "admin-text-response-row__body";
    body.textContent = value;
    row.appendChild(body);

    if (variant === "long") {
      body.classList.add("admin-text-response-row__body--clamped");
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "btn-link admin-text-response-row__more";
      toggle.textContent = "Expand";
      toggle.setAttribute("aria-expanded", "false");
      toggle.addEventListener("click", () => {
        const expanded = body.classList.toggle(
          "admin-text-response-row__body--expanded",
        );
        if (expanded) {
          body.classList.remove("admin-text-response-row__body--clamped");
          toggle.textContent = "Collapse";
          toggle.setAttribute("aria-expanded", "true");
        } else {
          body.classList.add("admin-text-response-row__body--clamped");
          toggle.textContent = "Expand";
          toggle.setAttribute("aria-expanded", "false");
        }
      });
      row.appendChild(toggle);
    }

    list.appendChild(row);
  }

  if (overflow > 0) {
    const more = document.createElement("p");
    more.className = "admin-text-response-list__more";
    more.textContent = `and ${overflow} more\u2026`;
    list.appendChild(more);
  }

  return list;
}

/**
 * Collect every submitted answer for a question across all responses.
 * Returns an array of numeric ratings or non-empty strings, depending
 * on the question type. Responses that lack an answer for the given
 * questionId are skipped (not counted as blanks).
 */
function collectAnswersFor(question, responses) {
  const out = [];
  for (const r of responses || []) {
    const answers = Array.isArray(r?.answers) ? r.answers : [];
    const match = answers.find((a) => a?.questionId === question.id);
    if (!match) continue;
    if (question.type === "rating") {
      const n = Number(match.value);
      if (Number.isInteger(n) && n >= 1 && n <= 5) out.push(n);
    } else {
      if (typeof match.value === "string") out.push(match.value);
    }
  }
  return out;
}

function latestResponseTimestamp(responses) {
  let bestMs = -Infinity;
  let best = null;
  for (const r of responses || []) {
    const t = Date.parse(r?.submittedAt);
    if (!Number.isNaN(t) && t > bestMs) {
      bestMs = t;
      best = r.submittedAt;
    }
  }
  return best;
}

/* =================================================================
 * CSV export
 * ================================================================= */

function exportCsv(questions, responses) {
  const headerCols = ["submittedAt", ...questions.map((q) => truncateHeader(q.text || ""))];
  const rows = [headerCols.map(csvEscape).join(",")];

  // Order responses newest-first for a slightly nicer sheet; a stable
  // sort by submittedAt descending matches what the admin sees in the
  // Results summary.
  const sorted = (responses || []).slice().sort((a, b) => {
    const ta = Date.parse(a?.submittedAt) || 0;
    const tb = Date.parse(b?.submittedAt) || 0;
    return tb - ta;
  });

  for (const r of sorted) {
    const cells = [csvEscape(typeof r?.submittedAt === "string" ? r.submittedAt : "")];
    const answers = Array.isArray(r?.answers) ? r.answers : [];
    for (const q of questions) {
      const match = answers.find((a) => a?.questionId === q.id);
      if (!match) {
        cells.push("");
        continue;
      }
      if (q.type === "rating") {
        const n = Number(match.value);
        cells.push(
          Number.isInteger(n) && n >= 1 && n <= 5 ? String(n) : "",
        );
      } else {
        cells.push(csvEscape(typeof match.value === "string" ? match.value : ""));
      }
    }
    rows.push(cells.join(","));
  }

  const csv = rows.join("\r\n") + "\r\n";
  // Prefix the UTF-8 BOM so Excel on Windows opens non-ASCII correctly.
  const blob = new Blob(["\uFEFF", csv], {
    type: "text/csv;charset=utf-8",
  });
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const filename = `vendor-day-2027-feedback-${yyyy}-${mm}-${dd}.csv`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // Defer revocation so Safari has the Blob around long enough to kick
  // off the download, then clean up.
  setTimeout(() => {
    document.body.removeChild(a);
    try { URL.revokeObjectURL(url); } catch (_err) { /* no-op */ }
  }, 0);
}

/**
 * CSV-escape a cell: double-quote-wrap any cell containing a comma,
 * quote, carriage return, or newline, and double any embedded quotes.
 * All other cells pass through unchanged.
 */
function csvEscape(value) {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Truncate a question text to 60 chars with an ellipsis for the CSV header. */
function truncateHeader(text) {
  const s = String(text).trim();
  if (s.length <= CSV_HEADER_MAX) return s;
  return `${s.slice(0, CSV_HEADER_MAX - 1)}\u2026`;
}

/* =================================================================
 * Question list helpers
 * ================================================================= */

/** @typedef {{ id: string, type: "rating" | "short" | "long", text: string, required: boolean, order: number }} Question */

/**
 * Filter + sort incoming questions so the editor always works with a
 * well-formed list. Unknown types are coerced to "short" (the simplest
 * form of a text answer) so a half-saved doc from an older build still
 * renders; the admin can repair the type via the dropdown and save.
 */
function normalizeQuestions(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const normalized = [];
  for (const q of arr) {
    if (!q || typeof q !== "object") continue;
    const id = typeof q.id === "string" && q.id.trim() ? q.id.trim() : null;
    if (!id) continue;
    const type = QUESTION_TYPES.includes(q.type) ? q.type : "short";
    const text = typeof q.text === "string" ? q.text : "";
    const required = q.required === true;
    const order = Number.isFinite(Number(q.order)) ? Number(q.order) : 0;
    normalized.push({ id, type, text, required, order });
  }
  normalized.sort((a, b) => a.order - b.order);
  // Rewrite `order` to a dense 1..N so downstream reorder swaps are
  // predictable regardless of what the server stored.
  for (let i = 0; i < normalized.length; i++) {
    normalized[i].order = i + 1;
  }
  return normalized;
}

function cloneQuestions(questions) {
  return (questions || []).map((q) => ({
    id: q.id,
    type: q.type,
    text: q.text,
    required: q.required === true,
    order: q.order,
  }));
}

/**
 * Serialize a question list for cheap dirty-checking. Trimmed text so
 * trailing whitespace doesn't register as a change the admin can't see.
 * `order` is normalized by position so swapping two rows that were
 * already adjacent still registers as dirty via the id sequence.
 */
function serializeQuestions(questions) {
  return (questions || [])
    .map(
      (q, idx) =>
        `${q.id}|${q.type}|${(q.text || "").trim()}|${q.required === true ? 1 : 0}|${idx + 1}`,
    )
    .join("\n");
}

function createBlankQuestion() {
  return {
    id: newQuestionId(),
    type: "rating",
    text: "",
    required: false,
    order: 0,
  };
}

function newQuestionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* =================================================================
 * sessionStorage helpers for the active tab
 * ================================================================= */

function readActiveTab() {
  try {
    const value = sessionStorage.getItem(ACTIVE_TAB_KEY);
    if (value === "form" || value === "results") return value;
  } catch (_err) { /* no-op */ }
  return "form";
}

function writeActiveTab(id) {
  try {
    sessionStorage.setItem(ACTIVE_TAB_KEY, id);
  } catch (_err) { /* no-op */ }
}
