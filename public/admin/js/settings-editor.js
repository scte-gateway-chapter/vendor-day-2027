// settings-editor.js — admin Settings page.
//
// Mounts into #admin-view-root. Reads `appSettings/singleton` on open
// and polls on the shared 30-second cadence used by the other admin
// editors. The editor owns two sections today:
//
//   1. Attendee Sign-In — single switch (`signInEnabled`).
//   2. Broadband Skills Challenge — enable switch (`bscEnabled`), waiver
//      mode radio pair (`bscWaiverMode`), waiver text textarea with
//      explicit Save (`bscWaiverText`), roster CSV uploader (POSTs to
//      `/api/bsc-roster-upload`), and a roster status line driven by
//      `bscRosterCount` / `bscRosterLastImportedAt`.
//
// Other fields on the appSettings doc (eventTitle, venueName,
// venueMapUrl, venueMapCaption) are owned by the Venue Map editor and
// the seed script. Writes here use `op: "update"` so those other fields
// are preserved.
//
// Visual pattern reuses `.admin-feedback-toggle` from the Feedback
// editor — same ARIA switch, pill, and copy slot so the admin UI's
// on/off vocabulary stays consistent. The `buildAppSettingsToggle`
// helper is shared between the two switches so the plumbing (write +
// optimistic update + reverting banner) is defined once.
"use strict";

import { initFirestore, getDoc, onSnapshot } from "/js/firebase.js";
import * as ui from "/js/ui.js";
import { adminFetch } from "./admin-fetch.js";
import { registerAdminViewCleanup } from "./admin.js";
import { formatLastEditedPhrase } from "./collision-check.js";
import { relativeTime } from "/js/utils/time.js";

const POLL_INTERVAL_MS = 30_000;
const OFFLINE_TOOLTIP = "You're offline \u2014 admin changes require connectivity.";
const WAIVER_TEXT_MAX = 20000;

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

  /** @type {ToggleHandle[]} Mounted toggles. Each has its own in-flight flag. */
  const toggles = [];

  /** Local draft for the BSC waiver textarea. `null` means "match server". */
  let bscWaiverDraft = null;
  /** Mounted waiver textarea element so we can re-sync on server pushes. */
  /** @type {HTMLTextAreaElement | null} */
  let waiverTextArea = null;
  /** Mounted roster status elements for incremental updates. */
  /** @type {HTMLElement | null} */
  let rosterStatusEl = null;

  function renderPanel() {
    offlineBanner.setVisible(!online);
    header.setLastEdited(serverState);

    if (serverErr && !serverState) {
      renderErrorNoCache(panel, () => restartSubscription());
      toggles.length = 0;
      waiverTextArea = null;
      rosterStatusEl = null;
      return;
    }
    if (!sawFirstResult) {
      renderSkeleton(panel);
      return;
    }
    if (toggles.length === 0) {
      mountEditor();
    } else {
      syncFromServer();
    }
  }

  function mountEditor() {
    panel.innerHTML = "";
    toggles.length = 0;

    // --- Attendee Sign-In section ---
    const signInSection = document.createElement("section");
    signInSection.className = "admin-settings-section";
    signInSection.setAttribute("aria-label", "Attendee Sign-In");

    const signInHeading = document.createElement("h2");
    signInHeading.className = "admin-settings-section__title";
    signInHeading.textContent = "Attendee Sign-In";
    signInSection.appendChild(signInHeading);

    const signInHelper = document.createElement("p");
    signInHelper.className = "admin-settings-section__helper";
    signInHelper.textContent =
      "When enabled, the Sign-In form becomes available to attendees on " +
      "the Welcome screen, Home, and More menu. Attendees who already " +
      "signed in before the toggle was turned off will still see their " +
      "confirmation.";
    signInSection.appendChild(signInHelper);

    const signInToggle = buildAppSettingsToggle({
      field: "signInEnabled",
      inputId: "admin-settings-signin-toggle",
      ariaLabelOn:
        "Attendee Sign-In is on. Turn off to hide sign-in surfaces from attendees.",
      ariaLabelOff:
        "Attendee Sign-In is off. Turn on to open sign-in to attendees.",
      textOn:
        "Attendee Sign-In is LIVE. The Welcome, Home, and More menu entries are visible to attendees.",
      textOff:
        "Attendee Sign-In is OFF. Attendees do not see the Sign-In form from the Welcome, Home, or More menu.",
      successOn: "Attendee Sign-In turned on.",
      successOff: "Attendee Sign-In turned off.",
      failOn: "Could not turn Sign-In on. Try again.",
      failOff: "Could not turn Sign-In off. Try again.",
    });
    toggles.push(signInToggle);
    signInSection.appendChild(signInToggle.wrap);
    panel.appendChild(signInSection);

    // --- Broadband Skills Challenge section ---
    const bscSection = document.createElement("section");
    bscSection.className =
      "admin-settings-section admin-bsc-settings-section";
    bscSection.setAttribute("aria-label", "Broadband Skills Challenge");

    const bscHeading = document.createElement("h2");
    bscHeading.className = "admin-settings-section__title";
    bscHeading.textContent = "Broadband Skills Challenge";
    bscSection.appendChild(bscHeading);

    const bscHelper = document.createElement("p");
    bscHelper.className = "admin-settings-section__helper";
    bscHelper.textContent =
      "Enable the day-of BSC competitor check-in flow. Upload the " +
      "pre-registration roster below so pre-registered competitors are " +
      "recognized automatically; walk-ups follow the same form path with " +
      "a manager-approval attestation.";
    bscSection.appendChild(bscHelper);

    const bscToggle = buildAppSettingsToggle({
      field: "bscEnabled",
      inputId: "admin-settings-bsc-toggle",
      ariaLabelOn:
        "Broadband Skills Challenge check-in is on. Turn off to hide the BSC surfaces from attendees.",
      ariaLabelOff:
        "Broadband Skills Challenge check-in is off. Turn on to open BSC check-in to attendees.",
      textOn:
        "BSC check-in is LIVE. The sign-in form shows the BSC competitor checkbox and the #/bsc route is reachable.",
      textOff:
        "BSC check-in is OFF. No BSC surfaces appear in the attendee app.",
      successOn: "BSC check-in turned on.",
      successOff: "BSC check-in turned off.",
      failOn: "Could not turn BSC on. Try again.",
      failOff: "Could not turn BSC off. Try again.",
    });
    toggles.push(bscToggle);
    bscSection.appendChild(bscToggle.wrap);

    bscSection.appendChild(buildWaiverModeFieldset());
    bscSection.appendChild(buildWaiverTextCard());
    bscSection.appendChild(buildRosterUploadCard());
    bscSection.appendChild(buildRosterStatusLine());

    panel.appendChild(bscSection);

    syncFromServer();
  }

  /* ---------------- Reusable toggle plumbing ---------------- */

  /**
   * @typedef {{
   *   wrap: HTMLElement,
   *   input: HTMLInputElement,
   *   banner: HTMLElement,
   *   sync: () => void,
   *   writeInFlight: { value: boolean },
   *   field: string,
   * }} ToggleHandle
   */

  function buildAppSettingsToggle(opts) {
    const {
      field,
      inputId,
      ariaLabelOn,
      ariaLabelOff,
      textOn,
      textOff,
      successOn,
      successOff,
      failOn,
      failOff,
    } = opts;
    const writeInFlight = { value: false };

    const enabled = serverState?.[field] === true;

    const wrap = document.createElement("div");
    wrap.className =
      `admin-feedback-toggle admin-settings-toggle admin-feedback-toggle--${enabled ? "on" : "off"}`;

    const label = document.createElement("label");
    label.className = "admin-feedback-toggle__label";
    label.htmlFor = inputId;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = inputId;
    input.className = "admin-feedback-toggle__input";
    input.setAttribute("role", "switch");
    input.setAttribute("aria-label", enabled ? ariaLabelOn : ariaLabelOff);
    input.checked = enabled;
    input.disabled = !online || writeInFlight.value;

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
    text.textContent = enabled ? textOn : textOff;
    copy.append(pill, text);

    label.append(input, track, copy);
    wrap.appendChild(label);

    const banner = document.createElement("div");
    banner.className = "status-error admin-feedback-toggle__banner";
    banner.setAttribute("role", "alert");
    banner.hidden = true;
    wrap.appendChild(banner);

    const handle = {
      wrap,
      input,
      banner,
      writeInFlight,
      field,
      sync: () => {
        const current = serverState?.[field] === true;
        wrap.classList.toggle("admin-feedback-toggle--on", current);
        wrap.classList.toggle("admin-feedback-toggle--off", !current);
        input.checked = current;
        input.disabled = !online || writeInFlight.value;
        input.setAttribute("aria-label", current ? ariaLabelOn : ariaLabelOff);
        const pillEl = wrap.querySelector(".admin-feedback-toggle__pill");
        if (pillEl) {
          pillEl.classList.toggle("admin-feedback-toggle__pill--on", current);
          pillEl.classList.toggle("admin-feedback-toggle__pill--off", !current);
          pillEl.textContent = current ? "LIVE" : "OFF";
        }
        const textEl = wrap.querySelector(".admin-feedback-toggle__text");
        if (textEl) textEl.textContent = current ? textOn : textOff;
      },
    };

    input.addEventListener("change", async () => {
      if (writeInFlight.value) return;
      if (!online) {
        input.checked = serverState?.[field] === true; // revert
        return;
      }
      await handleToggleChange(handle, input.checked, {
        successOn,
        successOff,
        failOn,
        failOff,
      });
    });

    return handle;
  }

  async function handleToggleChange(handle, nextEnabled, labels) {
    const { field, input, banner, writeInFlight } = handle;
    const previous = serverState?.[field] === true;
    writeInFlight.value = true;
    input.disabled = true;
    banner.hidden = true;
    banner.textContent = "";

    try {
      await adminFetch("/api/firestore-write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection: "appSettings",
          docId: "singleton",
          op: "update",
          data: { [field]: nextEnabled },
        }),
      });
      ui.toast(
        "success",
        nextEnabled ? labels.successOn : labels.successOff,
      );
      serverState = {
        ...(serverState || {}),
        [field]: nextEnabled,
      };
      syncFromServer();
      nudgeRefresh();
    } catch (err) {
      console.warn(`[admin-settings] ${field} write failed:`, err);
      if (err?.code === "session-expired") return;
      input.checked = previous;
      banner.textContent = nextEnabled ? labels.failOn : labels.failOff;
      banner.hidden = false;
    } finally {
      writeInFlight.value = false;
      input.disabled = !online;
    }
  }

  /* ---------------- BSC waiver mode (radio pair) ---------------- */

  function buildWaiverModeFieldset() {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "admin-bsc-waiver-mode";

    const legend = document.createElement("legend");
    legend.textContent = "Waiver mode";
    fieldset.appendChild(legend);

    const current = serverState?.bscWaiverMode === "electronic" ? "electronic" : "paper";

    const paperRow = buildRadio("bsc-waiver-mode", "paper", current === "paper",
      "Paper (reminder only; attendee signs the paper waiver at the table)");
    const electronicRow = buildRadio("bsc-waiver-mode", "electronic", current === "electronic",
      "Electronic (attendee reads the waiver text below, checks agreement, types their name as signature)");
    fieldset.append(paperRow, electronicRow);

    const banner = document.createElement("div");
    banner.className = "status-error admin-bsc-waiver-mode__banner";
    banner.setAttribute("role", "alert");
    banner.hidden = true;
    fieldset.appendChild(banner);

    const handleChange = async (ev) => {
      const value = ev.target.value;
      if (value !== "paper" && value !== "electronic") return;
      banner.hidden = true;
      banner.textContent = "";
      // Disable both inputs during the write.
      const inputs = fieldset.querySelectorAll('input[name="bsc-waiver-mode"]');
      inputs.forEach((el) => { el.disabled = true; });
      try {
        await adminFetch("/api/firestore-write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            collection: "appSettings",
            docId: "singleton",
            op: "update",
            data: { bscWaiverMode: value },
          }),
        });
        ui.toast(
          "success",
          value === "electronic"
            ? "Waiver mode set to Electronic."
            : "Waiver mode set to Paper.",
        );
        serverState = { ...(serverState || {}), bscWaiverMode: value };
        syncFromServer();
        nudgeRefresh();
      } catch (err) {
        console.warn("[admin-settings] bscWaiverMode write failed:", err);
        if (err?.code === "session-expired") return;
        banner.textContent = "Could not save waiver mode. Try again.";
        banner.hidden = false;
        // Revert the radio selection by re-syncing from the server state.
        syncFromServer();
      } finally {
        inputs.forEach((el) => { el.disabled = !online; });
      }
    };

    paperRow.querySelector("input").addEventListener("change", handleChange);
    electronicRow.querySelector("input").addEventListener("change", handleChange);

    return fieldset;
  }

  function buildRadio(name, value, checked, labelText) {
    const row = document.createElement("label");
    row.className = "admin-bsc-waiver-mode__option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = value;
    input.checked = checked;
    input.disabled = !online;
    const span = document.createElement("span");
    span.textContent = labelText;
    row.append(input, span);
    return row;
  }

  /* ---------------- BSC waiver text (textarea + Save) ---------------- */

  function buildWaiverTextCard() {
    const card = document.createElement("div");
    card.className = "admin-bsc-waiver-text-field";

    const warning = document.createElement("div");
    warning.className = "status-error admin-bsc-waiver-text-field__warning";
    warning.setAttribute("role", "alert");
    warning.hidden = true;
    warning.textContent =
      "Electronic mode is selected but the waiver text is empty. " +
      "The attendee flow will fall back to paper mode until this is filled in.";
    card.appendChild(warning);

    const label = document.createElement("label");
    label.className = "admin-bsc-waiver-text-field__label";
    label.htmlFor = "admin-settings-bsc-waiver-text";
    label.textContent = "Waiver text";
    card.appendChild(label);

    const textarea = document.createElement("textarea");
    textarea.id = "admin-settings-bsc-waiver-text";
    textarea.className = "admin-bsc-waiver-text-field__textarea admin-input";
    textarea.rows = 10;
    textarea.maxLength = WAIVER_TEXT_MAX;
    textarea.placeholder =
      "Paste your legal-approved waiver text here. Required when waiver mode is set to Electronic.";
    const initialText = typeof serverState?.bscWaiverText === "string"
      ? serverState.bscWaiverText
      : "";
    textarea.value = initialText;
    textarea.disabled = !online;
    waiverTextArea = textarea;

    const actions = document.createElement("div");
    actions.className = "admin-bsc-waiver-text-field__actions";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn-primary admin-bsc-waiver-text-field__save";
    saveBtn.textContent = "Save waiver text";
    saveBtn.disabled = true;

    const banner = document.createElement("div");
    banner.className = "status-error admin-bsc-waiver-text-field__banner";
    banner.setAttribute("role", "alert");
    banner.hidden = true;

    actions.append(saveBtn, banner);

    function syncDirty() {
      const serverText =
        typeof serverState?.bscWaiverText === "string"
          ? serverState.bscWaiverText
          : "";
      const dirty = textarea.value !== serverText;
      bscWaiverDraft = dirty ? textarea.value : null;
      saveBtn.disabled = !dirty || !online;
      updateWaiverModeWarning(warning);
    }

    textarea.addEventListener("input", () => {
      syncDirty();
    });

    saveBtn.addEventListener("click", async () => {
      if (saveBtn.disabled) return;
      const value = textarea.value;
      saveBtn.disabled = true;
      textarea.disabled = true;
      banner.hidden = true;
      banner.textContent = "";
      try {
        await adminFetch("/api/firestore-write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            collection: "appSettings",
            docId: "singleton",
            op: "update",
            data: { bscWaiverText: value },
          }),
        });
        ui.toast("success", "Waiver text saved.");
        serverState = { ...(serverState || {}), bscWaiverText: value };
        bscWaiverDraft = null;
        syncFromServer();
        nudgeRefresh();
      } catch (err) {
        console.warn("[admin-settings] bscWaiverText write failed:", err);
        if (err?.code === "session-expired") return;
        banner.textContent = "Could not save waiver text. Try again.";
        banner.hidden = false;
      } finally {
        textarea.disabled = !online;
        syncDirty();
      }
    });

    // Prime dirty state + warning on first mount.
    syncDirty();

    // Expose a sync hook on the card for the global syncFromServer()
    // path to re-run after a server poll.
    card._syncWaiverTextCard = () => {
      // If the admin has a dirty draft, don't clobber it.
      if (bscWaiverDraft !== null) {
        syncDirty();
        return;
      }
      const serverText =
        typeof serverState?.bscWaiverText === "string"
          ? serverState.bscWaiverText
          : "";
      if (textarea.value !== serverText) textarea.value = serverText;
      textarea.disabled = !online;
      syncDirty();
    };

    card.append(textarea, actions);
    return card;
  }

  function updateWaiverModeWarning(warningEl) {
    const mode = serverState?.bscWaiverMode === "electronic" ? "electronic" : "paper";
    const effectiveText =
      waiverTextArea ? waiverTextArea.value :
      typeof serverState?.bscWaiverText === "string" ? serverState.bscWaiverText : "";
    const shouldWarn = mode === "electronic" && effectiveText.trim() === "";
    warningEl.hidden = !shouldWarn;
  }

  /* ---------------- BSC roster CSV upload ---------------- */

  function buildRosterUploadCard() {
    const card = document.createElement("div");
    card.className = "admin-bsc-upload-card";

    const heading = document.createElement("h3");
    heading.className = "admin-bsc-upload-card__title";
    heading.textContent = "Pre-registration roster";
    card.appendChild(heading);

    const helper = document.createElement("p");
    helper.className = "admin-bsc-upload-card__helper";
    helper.textContent =
      "Export the Broadband Skills Challenge Registrations Google Sheet " +
      "as CSV (File \u2192 Download \u2192 Comma-separated values) and " +
      "upload it here. Re-uploading merges by email; existing rows are " +
      "updated in place.";
    card.appendChild(helper);

    const actionsRow = document.createElement("div");
    actionsRow.className = "admin-bsc-upload-card__actions";

    const uploadBtn = document.createElement("button");
    uploadBtn.type = "button";
    uploadBtn.className = "btn-primary admin-bsc-upload-card__btn";
    uploadBtn.textContent = "Upload BSC roster (CSV)";
    uploadBtn.disabled = !online;

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".csv,text/csv";
    fileInput.className = "admin-bsc-upload-card__file";
    fileInput.hidden = true;
    fileInput.setAttribute("aria-label", "Roster CSV file");

    const spinner = document.createElement("span");
    spinner.className = "admin-bsc-upload-card__spinner";
    spinner.setAttribute("aria-hidden", "true");
    spinner.hidden = true;

    actionsRow.append(uploadBtn, fileInput, spinner);
    card.appendChild(actionsRow);

    const resultLine = document.createElement("p");
    resultLine.className = "admin-bsc-upload-card__result";
    resultLine.setAttribute("aria-live", "polite");
    resultLine.hidden = true;
    card.appendChild(resultLine);

    const errorPanel = document.createElement("details");
    errorPanel.className = "admin-bsc-upload-card__errors";
    errorPanel.hidden = true;
    const errorSummary = document.createElement("summary");
    errorSummary.textContent = "Row-level errors";
    const errorList = document.createElement("ul");
    errorList.className = "admin-bsc-upload-card__error-list";
    errorPanel.append(errorSummary, errorList);
    card.appendChild(errorPanel);

    const banner = document.createElement("div");
    banner.className = "status-error admin-bsc-upload-card__banner";
    banner.setAttribute("role", "alert");
    banner.hidden = true;
    card.appendChild(banner);

    uploadBtn.addEventListener("click", () => {
      if (uploadBtn.disabled) return;
      fileInput.click();
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      // Reset the input so re-choosing the same file still fires change.
      fileInput.value = "";
      if (!file) return;
      banner.hidden = true;
      banner.textContent = "";
      resultLine.hidden = true;
      resultLine.textContent = "";
      errorPanel.hidden = true;
      errorList.innerHTML = "";

      uploadBtn.disabled = true;
      spinner.hidden = false;
      try {
        const form = new FormData();
        form.append("file", file);
        // IMPORTANT: do NOT set Content-Type here; the browser must
        // set multipart/form-data boundary itself.
        const response = await adminFetch("/api/bsc-roster-upload", {
          method: "POST",
          body: form,
        });
        const imported = Number.isFinite(response?.imported) ? response.imported : 0;
        const skipped = Number.isFinite(response?.skipped) ? response.skipped : 0;
        const errors = Array.isArray(response?.errors) ? response.errors : [];
        resultLine.textContent =
          `Imported ${imported} competitor${imported === 1 ? "" : "s"}. ${skipped} skipped.`;
        resultLine.hidden = false;
        if (errors.length > 0) {
          for (const msg of errors) {
            const li = document.createElement("li");
            li.textContent = String(msg);
            errorList.appendChild(li);
          }
          errorPanel.hidden = false;
        }
        ui.toast("success", "Roster upload complete.");
        nudgeRefresh();
      } catch (err) {
        console.warn("[admin-settings] bsc roster upload failed:", err);
        if (err?.code === "session-expired") return;
        banner.textContent =
          err?.message || "Could not upload the roster. Try again.";
        banner.hidden = false;
      } finally {
        spinner.hidden = true;
        uploadBtn.disabled = !online;
      }
    });

    return card;
  }

  /* ---------------- BSC roster status line ---------------- */

  function buildRosterStatusLine() {
    const el = document.createElement("p");
    el.className = "admin-bsc-settings-section__status";
    el.setAttribute("aria-live", "polite");
    rosterStatusEl = el;
    renderRosterStatus(el);
    return el;
  }

  function renderRosterStatus(el) {
    const count = Number.isFinite(serverState?.bscRosterCount)
      ? serverState.bscRosterCount
      : 0;
    const lastAt = serverState?.bscRosterLastImportedAt;
    if (!lastAt || count === 0) {
      el.textContent = "No roster uploaded yet.";
      el.removeAttribute("title");
      return;
    }
    const when = relativeTime(lastAt) || "just now";
    el.textContent =
      `${count} competitor${count === 1 ? "" : "s"} in roster \u00B7 Last imported ${when}`;
    try { el.title = String(lastAt); } catch (_err) { /* ignore */ }
  }

  /* ---------------- Server-state sync ---------------- */

  function syncFromServer() {
    toggles.forEach((t) => t.sync());
    // Waiver mode radios: re-sync by looking up both inputs on their panel.
    const paperRadio = panel.querySelector('input[name="bsc-waiver-mode"][value="paper"]');
    const electronicRadio = panel.querySelector('input[name="bsc-waiver-mode"][value="electronic"]');
    if (paperRadio && electronicRadio) {
      const current = serverState?.bscWaiverMode === "electronic" ? "electronic" : "paper";
      paperRadio.checked = current === "paper";
      electronicRadio.checked = current === "electronic";
      paperRadio.disabled = !online;
      electronicRadio.disabled = !online;
    }
    // Waiver text card: respect in-progress draft.
    const waiverCard = panel.querySelector(".admin-bsc-waiver-text-field");
    if (waiverCard && typeof waiverCard._syncWaiverTextCard === "function") {
      waiverCard._syncWaiverTextCard();
    }
    // Warning banner.
    const warningEl = panel.querySelector(".admin-bsc-waiver-text-field__warning");
    if (warningEl) updateWaiverModeWarning(warningEl);
    // Roster status.
    if (rosterStatusEl) renderRosterStatus(rosterStatusEl);
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
    toggles.length = 0;
    waiverTextArea = null;
    rosterStatusEl = null;
    bscWaiverDraft = null;
    renderSkeleton(panel);
    startSubscription();
  }

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
    renderPanel();
  };
  const onOffline = () => {
    online = false;
    toggles.forEach((t) => {
      t.input.disabled = true;
      t.input.setAttribute("title", OFFLINE_TOOLTIP);
    });
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
