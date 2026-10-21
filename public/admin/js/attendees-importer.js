// attendees-importer.js — admin Attendee importer view (Task 22).
//
// Mounts into #admin-view-root. Unlike the agenda / sponsors / announcement
// editors which keep a live 15-second poll going, the attendee importer is
// a one-shot workflow: fetch the current directory once on mount for the
// summary + merge key lookup, let the admin stage a CSV + per-row toggles,
// then commit via /api/firestore-write one row at a time. After a successful
// commit the view re-reads the directory to refresh the summary and the
// merge-lookup cache.
//
// Why serial writes rather than parallel: /api/firestore-write writes a
// single doc per call and Cloudflare Pages Functions have a modest
// concurrency budget. A couple hundred attendees commit in a few seconds
// serially and the progress bar reads honestly; parallel bursts hit the
// Function's own quota and the Firestore write-per-second ceiling faster
// than they finish.
//
// Merge composite key is name + "|" + company, both trimmed to lowercase
// with internal whitespace collapsed to single spaces. The attendee
// schema in design section 5 has no email, so composite is the best we
// can do without changing the data model.
//
// Opt-out preservation on merge:
//   - If the admin ticked the per-row Opt-out box in the preview, the
//     write sets optedOut: true (overrides the existing state).
//   - If the admin did NOT tick Opt-out, we preserve the existing doc's
//     optedOut field — so a row the chapter previously marked opt-out at
//     check-in stays opted-out through re-imports.
//
// `importedAt`: set to the current ISO timestamp on new rows and on
// existing rows whose name/company/title/opt-out actually changed. Rows
// re-imported with no field changes keep their original `importedAt` so
// the sticky-header "updated X ago by Y" doesn't lie about a stale import.
"use strict";

import { initFirestore, getCollection } from "/js/firebase.js";
import * as ui from "/js/ui.js";
import { installFocusTrap } from "/js/utils/focus-trap.js";
import { adminFetch } from "./admin-fetch.js";
import { registerAdminViewCleanup } from "./admin.js";
import { formatLastEditedPhrase } from "./collision-check.js";
import { parseCsv, trimRow } from "./csv-parse.js";

const NAME_MAX = 120;
const COMPANY_MAX = 120;
const TITLE_MAX = 120;
const OFFLINE_TOOLTIP = "You're offline \u2014 admin changes require connectivity.";

// Expected column header labels, lowercased for case-insensitive matching.
const EXPECTED = {
  name: ["name", "full name", "attendee", "attendee name"],
  company: ["company", "organization", "org", "employer"],
  title: ["title", "job title", "role"],
};

// Optional. If the chapter decides to pin the Google Sheet URL in the
// app code at some future point, set this const. For v1 we leave it
// empty and the view inlines the admin runbook guidance instead (so the
// sheet URL stays in `docs/admin-runbook.md` rather than shipping to
// every admin visitor's browser).
const GOOGLE_SHEET_URL = "";

/**
 * Render the admin Attendee importer into `host`.
 * @param {HTMLElement} host  typically `#admin-view-root`.
 * @returns {Promise<void>}
 */
export default async function renderAttendeesImporter(host) {
  host.innerHTML = "";

  const container = document.createElement("section");
  container.className = "admin-attendees-importer";
  container.setAttribute("aria-label", "Admin Attendees importer");
  host.appendChild(container);

  const header = buildStickyHeader();
  const offlineBanner = buildOfflineBanner();
  const summarySection = document.createElement("div");
  summarySection.className = "admin-attendees-summary";
  summarySection.setAttribute("aria-live", "polite");

  const uploadSection = document.createElement("div");
  uploadSection.className = "admin-upload-card";

  const previewSection = document.createElement("div");
  previewSection.className = "admin-preview-wrap";
  previewSection.hidden = true;

  container.append(
    header.el,
    offlineBanner.el,
    summarySection,
    uploadSection,
    previewSection,
  );

  // Prime /api/config; cached inside firebase.js after the first call.
  const configReady = initFirestore().catch((err) => {
    console.warn("[admin-attendees] /api/config load failed:", err);
    return null;
  });

  let online = typeof navigator === "undefined" || navigator.onLine !== false;

  /** @type {object[] | null} */
  let currentDirectory = null;
  /** @type {Error | null} */
  let directoryErr = null;

  // Parsed CSV state. Null while nothing is staged.
  /** @type {ParsedState | null} */
  let parsed = null;

  // Any open overlay (progress / confirm). Only one at a time.
  /** @type {{ close: () => void } | null} */
  let activeOverlay = null;

  async function refreshDirectory() {
    try { await configReady; } catch (_err) { /* non-fatal */ }
    try {
      // Unfiltered read — the importer needs opted-out rows too for the
      // "Y opted out" count and so a merge can preserve their state.
      const list = await getCollection("attendees");
      currentDirectory = Array.isArray(list) ? list : [];
      directoryErr = null;
    } catch (err) {
      console.warn("[admin-attendees] directory load failed:", err);
      directoryErr = err;
      currentDirectory = null;
    }
    renderSummary();
    renderHeaderMeta();
  }

  function renderSummary() {
    summarySection.innerHTML = "";
    if (directoryErr && !currentDirectory) {
      const el = document.createElement("div");
      el.className = "status-error";
      el.setAttribute("role", "alert");
      el.innerHTML = `
        <p>Couldn't load the current attendee directory.</p>
        <button type="button" class="btn-secondary" data-retry>Retry</button>
      `;
      el.querySelector("[data-retry]").addEventListener("click", () => {
        refreshDirectory();
      });
      summarySection.appendChild(el);
      return;
    }
    const list = currentDirectory || [];
    const total = list.length;
    const optedOut = list.filter((a) => a?.optedOut === true).length;
    const el = document.createElement("p");
    el.className = "admin-attendees-summary__text";
    if (total === 0) {
      el.textContent =
        "No attendees in the directory yet. Upload a CSV below to get started.";
    } else {
      const noun = total === 1 ? "attendee" : "attendees";
      el.textContent = `${total} ${noun} currently listed (${optedOut} opted out).`;
    }
    summarySection.appendChild(el);
  }

  function renderHeaderMeta() {
    header.setLastEdited(mostRecentlyImported(currentDirectory || []));
  }

  function renderUploadCard() {
    uploadSection.innerHTML = "";

    const dropzone = document.createElement("div");
    dropzone.className = "admin-upload-dropzone";
    dropzone.setAttribute("role", "button");
    dropzone.setAttribute("tabindex", "0");
    dropzone.setAttribute("aria-label", "CSV file dropzone");
    dropzone.innerHTML = `
      <p class="admin-upload-dropzone__title">Drop a CSV file here or tap Choose CSV.</p>
      <div class="admin-upload-dropzone__row">
        <button type="button" class="btn-primary admin-upload-choose-btn" data-choose>Choose CSV\u2026</button>
        <p class="admin-upload-dropzone__filename" data-filename aria-live="polite"></p>
      </div>
    `;

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".csv,text/csv";
    fileInput.className = "admin-upload-file-input";
    fileInput.setAttribute("aria-label", "CSV file to import");
    dropzone.appendChild(fileInput);

    const helpNote = document.createElement("p");
    helpNote.className = "admin-upload-help";
    const sheetFragment = GOOGLE_SHEET_URL
      ? `the <a href="${escapeAttr(GOOGLE_SHEET_URL)}" target="_blank" rel="noopener">registration Google Sheet</a>`
      : "the registration Google Sheet";
    helpNote.innerHTML = `
      Export ${sheetFragment} as CSV (File \u2192 Download \u2192 Comma-separated values)
      and drop it here. Expected columns: name, company, title. Extra columns are ignored.
    `;

    uploadSection.append(dropzone, helpNote);

    const chooseBtn = dropzone.querySelector("[data-choose]");
    const filenameEl = dropzone.querySelector("[data-filename]");

    chooseBtn.addEventListener("click", () => fileInput.click());
    // Keyboard activation on the dropzone itself (Enter / Space) opens
    // the picker — the whole surface reads as a drop target.
    dropzone.addEventListener("keydown", (ev) => {
      if (ev.target !== dropzone) return;
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        fileInput.click();
      }
    });

    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      filenameEl.textContent = file.name;
      handleFile(file);
    });

    // Drag-and-drop. Prevent-default on dragover so the drop event fires.
    dropzone.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      dropzone.classList.add("admin-upload-dropzone--active");
    });
    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("admin-upload-dropzone--active");
    });
    dropzone.addEventListener("drop", (ev) => {
      ev.preventDefault();
      dropzone.classList.remove("admin-upload-dropzone--active");
      const file = ev.dataTransfer?.files?.[0];
      if (!file) return;
      filenameEl.textContent = file.name;
      handleFile(file);
    });
  }

  async function handleFile(file) {
    // Minimal size + type guard. The expected CSVs are a few KB per
    // hundred attendees so a 5 MB cap is plenty of headroom.
    if (!/\.csv$/i.test(file.name) && file.type && !/csv/i.test(file.type)) {
      ui.toast("error", "Please choose a .csv file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      ui.toast("error", "That CSV is unusually large. Max 5 MB.");
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch (err) {
      console.warn("[admin-attendees] file.text() failed:", err);
      ui.toast("error", "Couldn't read the file. Try choosing it again.");
      return;
    }
    let result;
    try {
      result = parseCsv(text);
    } catch (err) {
      console.warn("[admin-attendees] parseCsv threw:", err);
      ui.toast("error", "Couldn't parse that CSV. Check the file and try again.");
      return;
    }
    if (!result.headers.length || !result.rows.length) {
      ui.toast("error", "That CSV has no rows.");
      return;
    }

    parsed = buildParsedState(result);
    renderPreview();
  }

  /** @typedef {{
   *   headers: string[],
   *   rawRows: string[][],
   *   mapping: { name: number | -1, company: number | -1, title: number | -1 },
   *   rows: PreviewRow[],
   *   failed: Array<{ row: PreviewRow, error: string }>,
   * }} ParsedState */

  /** @typedef {{
   *   id: string,          // local-only row id (preview re-render)
   *   index: number,       // 1-based CSV row #
   *   name: string,
   *   company: string,
   *   title: string,
   *   include: boolean,
   *   optOut: boolean,
   *   invalidReason: string | null,
   * }} PreviewRow */

  function buildParsedState(result) {
    const headers = result.headers.map((h) => (typeof h === "string" ? h.trim() : ""));
    const mapping = autoMapHeaders(headers);
    const state = {
      headers,
      rawRows: result.rows,
      mapping,
      rows: [],
      failed: [],
    };
    rebuildPreviewRows(state);
    return state;
  }

  function rebuildPreviewRows(state) {
    const { rawRows, mapping } = state;
    const rows = [];
    for (let i = 0; i < rawRows.length; i++) {
      const trimmed = trimRow(rawRows[i]);
      const name = mapping.name >= 0 ? trimmed[mapping.name] || "" : "";
      const company = mapping.company >= 0 ? trimmed[mapping.company] || "" : "";
      const title = mapping.title >= 0 ? trimmed[mapping.title] || "" : "";
      const invalid = validateRow({ name, company, title });
      rows.push({
        id: `row-${i}`,
        index: i + 1,
        name,
        company,
        title,
        include: invalid == null, // invalid rows cannot be imported
        optOut: false,
        invalidReason: invalid,
      });
    }
    state.rows = rows;
  }

  function renderPreview() {
    previewSection.hidden = false;
    previewSection.innerHTML = "";

    if (!parsed) return;

    // Mapping block — always rendered so the admin can revisit it even
    // when auto-detect found all three columns. Required columns show
    // their resolved state at the top.
    const mappingBlock = buildMappingBlock(parsed, () => {
      rebuildPreviewRows(parsed);
      renderPreview();
    });
    previewSection.appendChild(mappingBlock);

    const requiredResolved = parsed.mapping.name >= 0 && parsed.mapping.company >= 0;

    const validCount = parsed.rows.filter((r) => r.invalidReason == null).length;
    const invalidCount = parsed.rows.length - validCount;
    const optOutCount = parsed.rows.filter((r) => r.optOut && r.invalidReason == null).length;

    const counts = document.createElement("p");
    counts.className = "admin-preview-counts";
    counts.setAttribute("aria-live", "polite");
    counts.textContent = `${validCount} valid rows, ${invalidCount} invalid rows, ${optOutCount} marked for opt-out.`;
    previewSection.appendChild(counts);

    if (!requiredResolved) {
      const warn = document.createElement("p");
      warn.className = "admin-preview-mapping-warning";
      warn.setAttribute("role", "status");
      warn.textContent = "Pick which columns are Name and Company before you can import.";
      previewSection.appendChild(warn);
    }

    const tableWrap = document.createElement("div");
    tableWrap.className = "admin-preview-table-wrap";
    tableWrap.innerHTML = `
      <table class="admin-preview-table">
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Name</th>
            <th scope="col">Company</th>
            <th scope="col">Title</th>
            <th scope="col">Include</th>
            <th scope="col">Opt out</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody data-preview-body></tbody>
      </table>
    `;
    const tbody = tableWrap.querySelector("[data-preview-body]");
    for (const row of parsed.rows) {
      tbody.appendChild(renderPreviewRow(row, counts));
    }
    previewSection.appendChild(tableWrap);

    // Commit buttons.
    const commitRow = document.createElement("div");
    commitRow.className = "admin-commit-buttons";

    const commitDisabled = !requiredResolved || validCount === 0 || !online;
    const offlineAttr = !online ? ` title="${escapeAttr(OFFLINE_TOOLTIP)}"` : "";

    commitRow.innerHTML = `
      <button type="button" class="btn-destructive" data-commit="replace" ${commitDisabled ? "disabled aria-disabled=\"true\"" : ""}${offlineAttr}>
        Replace directory
      </button>
      <button type="button" class="btn-primary" data-commit="merge" ${commitDisabled ? "disabled aria-disabled=\"true\"" : ""}${offlineAttr}>
        Merge
      </button>
    `;
    commitRow.querySelector('[data-commit="replace"]').addEventListener("click", () => {
      commit("replace");
    });
    commitRow.querySelector('[data-commit="merge"]').addEventListener("click", () => {
      commit("merge");
    });
    previewSection.appendChild(commitRow);
  }

  function renderPreviewRow(row, countsEl) {
    const tr = document.createElement("tr");
    tr.className = "admin-preview-row";
    tr.dataset.rowId = row.id;
    if (row.invalidReason) tr.classList.add("admin-preview-row--invalid");
    if (row.optOut && row.invalidReason == null) {
      tr.classList.add("admin-preview-row--opted-out");
    }

    const statusCell = row.invalidReason
      ? `<span class="admin-preview-status admin-preview-status--invalid">Invalid: ${escapeHtml(row.invalidReason)}</span>`
      : `<span class="admin-preview-status admin-preview-status--ok">OK</span>`;

    const includeDisabled = row.invalidReason != null;

    tr.innerHTML = `
      <td class="admin-preview-cell admin-preview-cell--index">${row.index}</td>
      <td class="admin-preview-cell admin-preview-cell--name">${escapeHtml(row.name) || "<span class=\"admin-preview-empty\">(empty)</span>"}</td>
      <td class="admin-preview-cell admin-preview-cell--company">${escapeHtml(row.company) || "<span class=\"admin-preview-empty\">(empty)</span>"}</td>
      <td class="admin-preview-cell admin-preview-cell--title">${row.title ? escapeHtml(row.title) : "<span class=\"admin-preview-empty\">(none)</span>"}</td>
      <td class="admin-preview-cell admin-preview-cell--include">
        <label class="sr-only" for="${row.id}-include">Include row ${row.index}</label>
        <input id="${row.id}-include" type="checkbox" data-include ${row.include ? "checked" : ""} ${includeDisabled ? "disabled" : ""} />
      </td>
      <td class="admin-preview-cell admin-preview-cell--optout">
        <label class="sr-only" for="${row.id}-optout">Opt out row ${row.index}</label>
        <input id="${row.id}-optout" type="checkbox" data-optout ${row.optOut ? "checked" : ""} ${includeDisabled ? "disabled" : ""} />
      </td>
      <td class="admin-preview-cell admin-preview-cell--status">${statusCell}</td>
    `;

    const includeInput = tr.querySelector("[data-include]");
    includeInput.addEventListener("change", () => {
      row.include = includeInput.checked;
      updateCountsAndButtons(countsEl);
    });

    const optOutInput = tr.querySelector("[data-optout]");
    optOutInput.addEventListener("change", () => {
      row.optOut = optOutInput.checked;
      tr.classList.toggle("admin-preview-row--opted-out", row.optOut && row.invalidReason == null);
      updateCountsAndButtons(countsEl);
    });

    return tr;
  }

  function updateCountsAndButtons(countsEl) {
    if (!parsed) return;
    const validCount = parsed.rows.filter((r) => r.invalidReason == null).length;
    const invalidCount = parsed.rows.length - validCount;
    const optOutCount = parsed.rows.filter((r) => r.optOut && r.invalidReason == null).length;
    if (countsEl) {
      countsEl.textContent = `${validCount} valid rows, ${invalidCount} invalid rows, ${optOutCount} marked for opt-out.`;
    }
    // Commit buttons: enabled only when at least one Include-checked, valid row exists.
    const anyIncluded = parsed.rows.some(
      (r) => r.invalidReason == null && r.include === true,
    );
    const requiredResolved = parsed.mapping.name >= 0 && parsed.mapping.company >= 0;
    const commitDisabled = !requiredResolved || !anyIncluded || !online;
    for (const btn of previewSection.querySelectorAll("[data-commit]")) {
      btn.disabled = commitDisabled;
      if (commitDisabled) btn.setAttribute("aria-disabled", "true");
      else btn.removeAttribute("aria-disabled");
      if (!online) btn.setAttribute("title", OFFLINE_TOOLTIP);
      else btn.removeAttribute("title");
    }
  }

  /* ---------------- Commit flow ---------------- */

  async function commit(mode) {
    if (!parsed) return;
    if (!online) return;
    const rowsToCommit = parsed.rows.filter(
      (r) => r.invalidReason == null && r.include === true,
    );
    if (rowsToCommit.length === 0) {
      ui.toast("error", "No valid rows are selected for import.");
      return;
    }

    const confirmed = await confirmDialog(buildConfirmProps(mode, rowsToCommit.length));
    if (!confirmed) return;

    const overlay = createProgressOverlay();
    activeOverlay = overlay;

    try {
      if (mode === "replace") {
        await commitReplace(rowsToCommit, overlay);
      } else {
        await commitMerge(rowsToCommit, overlay);
      }
    } finally {
      activeOverlay = null;
      overlay.close();
    }
  }

  function buildConfirmProps(mode, count) {
    if (mode === "replace") {
      return {
        title: "Replace the directory?",
        body:
          `Replace the full attendee directory with ${count} row${count === 1 ? "" : "s"}? ` +
          "This deletes all current attendees including any opt-outs the chapter has recorded. " +
          "This cannot be undone.",
        confirmLabel: "Replace directory",
        destructive: true,
      };
    }
    return {
      title: "Merge into the directory?",
      body:
        `Merge ${count} row${count === 1 ? "" : "s"} into the directory? ` +
        "New attendees will be added; existing ones with matching name + company will be updated. " +
        "Attendees not in the CSV are kept.",
      confirmLabel: "Merge",
      destructive: false,
    };
  }

  async function commitReplace(rowsToCommit, overlay) {
    const existing = currentDirectory ? currentDirectory.slice() : [];
    const failed = [];

    // Phase 1 — delete every existing attendee doc, serially.
    overlay.setPhase("Clearing existing directory\u2026");
    overlay.setProgress(0, existing.length);
    for (let i = 0; i < existing.length; i++) {
      const doc = existing[i];
      overlay.setProgress(i, existing.length);
      overlay.setLabel(`Clearing existing directory\u2026 ${i + 1} of ${existing.length}.`);
      try {
        await adminFetch("/api/firestore-write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            collection: "attendees",
            docId: doc.id,
            op: "delete",
          }),
        });
      } catch (err) {
        if (err?.code === "session-expired") return;
        console.warn("[admin-attendees] delete failed:", err);
        failed.push({ kind: "delete", id: doc.id, name: doc.name || "(unknown)", error: friendlyErr(err) });
      }
    }
    overlay.setProgress(existing.length, existing.length);

    // Phase 2 — write every new row with a fresh UUID.
    overlay.setPhase(`Importing ${rowsToCommit.length} of ${rowsToCommit.length} rows\u2026`);
    overlay.setProgress(0, rowsToCommit.length);
    const nowIso = new Date().toISOString();
    const succeededRows = [];
    const failedRows = [];
    for (let i = 0; i < rowsToCommit.length; i++) {
      const row = rowsToCommit[i];
      overlay.setProgress(i, rowsToCommit.length);
      overlay.setLabel(`Importing ${i + 1} of ${rowsToCommit.length} rows\u2026`);
      try {
        await adminFetch("/api/firestore-write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            collection: "attendees",
            docId: newDocId(),
            op: "set",
            data: {
              name: row.name,
              company: row.company,
              title: row.title ? row.title : null,
              optedOut: row.optOut === true,
              importedAt: nowIso,
            },
          }),
        });
        succeededRows.push(row);
      } catch (err) {
        if (err?.code === "session-expired") return;
        console.warn("[admin-attendees] set failed:", err);
        failedRows.push({ row, error: friendlyErr(err) });
      }
    }
    overlay.setProgress(rowsToCommit.length, rowsToCommit.length);

    await refreshDirectory();
    overlay.renderSummary({
      mode: "replace",
      total: rowsToCommit.length,
      imported: succeededRows.length,
      deleteFailures: failed,
      rowFailures: failedRows,
      onRetry: failedRows.length
        ? () => retryRows(failedRows.map((f) => f.row), "replace")
        : null,
      onClose: () => overlay.close(),
    });

    if (!failed.length && !failedRows.length) {
      ui.toast("success", `Imported ${succeededRows.length} attendee${succeededRows.length === 1 ? "" : "s"}.`);
      parsed = null;
      renderUploadCard();
      previewSection.hidden = true;
      previewSection.innerHTML = "";
    }
  }

  async function commitMerge(rowsToCommit, overlay) {
    const existing = currentDirectory ? currentDirectory.slice() : [];
    const byKey = new Map();
    for (const doc of existing) {
      const key = compositeKey(doc?.name, doc?.company);
      if (key) byKey.set(key, doc);
    }

    overlay.setPhase(`Importing ${rowsToCommit.length} of ${rowsToCommit.length} rows\u2026`);
    overlay.setProgress(0, rowsToCommit.length);
    const nowIso = new Date().toISOString();
    const succeededRows = [];
    const failedRows = [];

    for (let i = 0; i < rowsToCommit.length; i++) {
      const row = rowsToCommit[i];
      overlay.setProgress(i, rowsToCommit.length);
      overlay.setLabel(`Importing ${i + 1} of ${rowsToCommit.length} rows\u2026`);

      const key = compositeKey(row.name, row.company);
      const match = key ? byKey.get(key) : null;

      try {
        if (match) {
          // Admin explicitly ticked Opt-out → override; otherwise preserve
          // the existing optedOut state so a prior opt-out survives re-imports.
          const nextOptedOut = row.optOut === true ? true : match.optedOut === true;
          const titleValue = row.title ? row.title : null;
          const existingTitle = typeof match.title === "string" ? match.title : null;
          const fieldChanged =
            (match.name || "") !== row.name ||
            (match.company || "") !== row.company ||
            (existingTitle || null) !== titleValue ||
            (match.optedOut === true) !== nextOptedOut;
          const importedAt = fieldChanged
            ? nowIso
            : (typeof match.importedAt === "string" ? match.importedAt : nowIso);
          await adminFetch("/api/firestore-write", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              collection: "attendees",
              docId: match.id,
              op: "update",
              data: {
                name: row.name,
                company: row.company,
                title: titleValue,
                optedOut: nextOptedOut,
                importedAt,
              },
            }),
          });
        } else {
          await adminFetch("/api/firestore-write", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              collection: "attendees",
              docId: newDocId(),
              op: "set",
              data: {
                name: row.name,
                company: row.company,
                title: row.title ? row.title : null,
                optedOut: row.optOut === true,
                importedAt: nowIso,
              },
            }),
          });
        }
        succeededRows.push(row);
      } catch (err) {
        if (err?.code === "session-expired") return;
        console.warn("[admin-attendees] merge write failed:", err);
        failedRows.push({ row, error: friendlyErr(err) });
      }
    }
    overlay.setProgress(rowsToCommit.length, rowsToCommit.length);

    await refreshDirectory();
    overlay.renderSummary({
      mode: "merge",
      total: rowsToCommit.length,
      imported: succeededRows.length,
      deleteFailures: [],
      rowFailures: failedRows,
      onRetry: failedRows.length
        ? () => retryRows(failedRows.map((f) => f.row), "merge")
        : null,
      onClose: () => overlay.close(),
    });

    if (!failedRows.length) {
      ui.toast("success", `Imported ${succeededRows.length} attendee${succeededRows.length === 1 ? "" : "s"}.`);
      parsed = null;
      renderUploadCard();
      previewSection.hidden = true;
      previewSection.innerHTML = "";
    }
  }

  /**
   * Re-run the failed subset through the same commit path that ran
   * originally. For `replace` the directory was already cleared, so the
   * retry writes fresh `set` rows (a new UUID per row). For `merge` we
   * re-lookup the composite key against the just-refreshed directory so
   * a transient failure that left no doc in place becomes a `set`, and
   * a failure after the first attempt wrote the match becomes an
   * `update` — this avoids double-writing a merged row on retry.
   */
  async function retryRows(rows, mode) {
    if (!rows || rows.length === 0) return;
    const overlay = createProgressOverlay();
    activeOverlay = overlay;
    overlay.setPhase(`Retrying ${rows.length} row${rows.length === 1 ? "" : "s"}\u2026`);
    overlay.setProgress(0, rows.length);

    const nowIso = new Date().toISOString();
    const succeeded = [];
    const stillFailed = [];
    // Build the composite-key lookup from the freshly refreshed directory
    // so a merge retry picks up any row the first attempt did manage to
    // write before the overall batch failed.
    const byKey = new Map();
    if (mode === "merge") {
      for (const doc of currentDirectory || []) {
        const key = compositeKey(doc?.name, doc?.company);
        if (key) byKey.set(key, doc);
      }
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      overlay.setProgress(i, rows.length);
      overlay.setLabel(`Retrying ${i + 1} of ${rows.length}\u2026`);
      try {
        const match = mode === "merge" ? byKey.get(compositeKey(row.name, row.company)) : null;
        if (match) {
          const nextOptedOut = row.optOut === true ? true : match.optedOut === true;
          const titleValue = row.title ? row.title : null;
          await adminFetch("/api/firestore-write", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              collection: "attendees",
              docId: match.id,
              op: "update",
              data: {
                name: row.name,
                company: row.company,
                title: titleValue,
                optedOut: nextOptedOut,
                importedAt: nowIso,
              },
            }),
          });
        } else {
          await adminFetch("/api/firestore-write", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              collection: "attendees",
              docId: newDocId(),
              op: "set",
              data: {
                name: row.name,
                company: row.company,
                title: row.title ? row.title : null,
                optedOut: row.optOut === true,
                importedAt: nowIso,
              },
            }),
          });
        }
        succeeded.push(row);
      } catch (err) {
        if (err?.code === "session-expired") return;
        console.warn(`[admin-attendees] ${mode} retry failed:`, err);
        stillFailed.push({ row, error: friendlyErr(err) });
      }
    }
    overlay.setProgress(rows.length, rows.length);
    await refreshDirectory();
    overlay.renderSummary({
      mode,
      total: rows.length,
      imported: succeeded.length,
      deleteFailures: [],
      rowFailures: stillFailed,
      onRetry: stillFailed.length
        ? () => retryRows(stillFailed.map((f) => f.row), mode)
        : null,
      onClose: () => overlay.close(),
    });
    if (!stillFailed.length) {
      ui.toast("success", `Imported ${succeeded.length} attendee${succeeded.length === 1 ? "" : "s"}.`);
      parsed = null;
      renderUploadCard();
      previewSection.hidden = true;
      previewSection.innerHTML = "";
    }
  }

  /* ---------------- Connectivity + cleanup ---------------- */

  const onOnline = () => {
    online = true;
    offlineBanner.setVisible(false);
    if (parsed) updateCountsAndButtons(previewSection.querySelector(".admin-preview-counts"));
  };
  const onOffline = () => {
    online = false;
    offlineBanner.setVisible(true);
    if (parsed) updateCountsAndButtons(previewSection.querySelector(".admin-preview-counts"));
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  registerAdminViewCleanup(() => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    if (activeOverlay) {
      try { activeOverlay.close(); } catch (_err) { /* no-op */ }
      activeOverlay = null;
    }
  });

  // Initial paint. Load the directory in the background; the upload card
  // is immediately usable while that fetch is in flight.
  offlineBanner.setVisible(!online);
  renderSummary();
  renderUploadCard();
  await refreshDirectory();

  document.title = "Admin \u2014 Attendees \u2014 Vendor Day 2027";
}

/* =================================================================
 * Sticky header + offline banner
 * ================================================================= */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "admin-attendees-header";
  const sheetLink = GOOGLE_SHEET_URL
    ? `<a class="admin-attendees-header__sheet-link" href="${escapeAttr(GOOGLE_SHEET_URL)}" target="_blank" rel="noopener">Open the registration Google Sheet</a>`
    : "";
  el.innerHTML = `
    <div class="admin-attendees-header__row">
      <h2 class="admin-attendees-header__title">Admin \u2014 Attendees</h2>
      ${sheetLink}
    </div>
    <p class="admin-attendees-header__meta" aria-live="polite">never edited</p>
  `;
  const metaEl = el.querySelector(".admin-attendees-header__meta");
  function setLastEdited(doc) {
    metaEl.textContent = formatLastEditedPhrase(doc);
  }
  return { el, setLastEdited };
}

function buildOfflineBanner() {
  const el = document.createElement("div");
  el.className = "admin-view-offline-banner";
  el.setAttribute("role", "status");
  el.textContent = "You're offline \u2014 showing last-saved attendees.";
  el.hidden = true;
  function setVisible(visible) {
    el.hidden = !visible;
  }
  return { el, setVisible };
}

/* =================================================================
 * Header mapping block
 * ================================================================= */

function buildMappingBlock(state, onChange) {
  const wrap = document.createElement("section");
  wrap.className = "admin-header-mapping";
  wrap.setAttribute("aria-label", "CSV header mapping");

  const title = document.createElement("h3");
  title.className = "admin-header-mapping__title";
  title.textContent = "Column mapping";

  const detail = document.createElement("p");
  detail.className = "admin-header-mapping__detail";
  const required = state.mapping.name >= 0 && state.mapping.company >= 0;
  detail.textContent = required
    ? "We matched the expected columns. Adjust below if the match is wrong."
    : "We couldn't find Name or Company in the headers. Pick the right columns to continue.";

  wrap.append(title, detail);

  const rows = [
    { key: "name", label: "Name column", required: true },
    { key: "company", label: "Company column", required: true },
    { key: "title", label: "Title column", required: false },
  ];

  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "admin-header-mapping-row";
    const selectId = `admin-mapping-${r.key}`;
    row.innerHTML = `
      <label class="admin-header-mapping-row__label" for="${selectId}">
        ${escapeHtml(r.label)}
        ${r.required ? `<span class="admin-required-marker" aria-hidden="true">*</span><span class="sr-only">required</span>` : ""}
      </label>
      <select id="${selectId}" class="admin-input admin-header-mapping-row__select" data-key="${r.key}">
        <option value="-1">\u2014 none \u2014</option>
        ${state.headers.map((h, idx) => `<option value="${idx}">${escapeHtml(h)}</option>`).join("")}
      </select>
    `;
    const select = row.querySelector("select");
    select.value = String(state.mapping[r.key]);
    select.addEventListener("change", () => {
      const next = Number.parseInt(select.value, 10);
      state.mapping[r.key] = Number.isFinite(next) ? next : -1;
      onChange();
    });
    wrap.appendChild(row);
  }

  return wrap;
}

function autoMapHeaders(headers) {
  const mapping = { name: -1, company: -1, title: -1 };
  const lowered = headers.map((h) => (typeof h === "string" ? h.toLowerCase() : ""));
  for (const key of Object.keys(mapping)) {
    const candidates = EXPECTED[key];
    for (const cand of candidates) {
      const idx = lowered.indexOf(cand);
      if (idx >= 0) { mapping[key] = idx; break; }
    }
  }
  return mapping;
}

/* =================================================================
 * Validation
 * ================================================================= */

function validateRow({ name, company, title }) {
  if (!name) return "Name is empty.";
  if (name.length > NAME_MAX) return `Name is longer than ${NAME_MAX} characters.`;
  if (!company) return "Company is empty.";
  if (company.length > COMPANY_MAX) return `Company is longer than ${COMPANY_MAX} characters.`;
  if (title && title.length > TITLE_MAX) return `Title is longer than ${TITLE_MAX} characters.`;
  return null;
}

/* =================================================================
 * Progress overlay + summary
 * ================================================================= */

function createProgressOverlay() {
  const overlay = document.createElement("div");
  overlay.className = "admin-modal-overlay admin-modal-overlay--import";
  const modal = document.createElement("div");
  modal.className = "admin-modal admin-modal--import";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "admin-import-progress-title");
  modal.setAttribute("tabindex", "-1");
  modal.innerHTML = `
    <header class="admin-modal__header">
      <h2 class="admin-modal__title" id="admin-import-progress-title">Importing attendees</h2>
    </header>
    <div class="admin-modal__body">
      <p class="admin-import-progress" data-phase>Importing\u2026</p>
      <div class="admin-import-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-bar>
        <div class="admin-import-progress-bar__fill" data-fill></div>
      </div>
      <p class="admin-import-progress-detail" data-label aria-live="polite"></p>
      <div class="admin-import-summary" data-summary hidden></div>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  document.body.classList.add("admin-modal-open");

  const phaseEl = modal.querySelector("[data-phase]");
  const bar = modal.querySelector("[data-bar]");
  const fill = modal.querySelector("[data-fill]");
  const labelEl = modal.querySelector("[data-label]");
  const summaryEl = modal.querySelector("[data-summary]");

  // Progress overlay traps focus so the admin can't tab into the preview
  // table while writes are in flight.
  const uninstall = installFocusTrap(modal, { initialFocus: () => modal });

  function setPhase(text) { phaseEl.textContent = text; }
  function setLabel(text) { labelEl.textContent = text; }
  function setProgress(done, total) {
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    fill.style.width = `${pct}%`;
    bar.setAttribute("aria-valuenow", String(pct));
  }
  function renderSummary({ mode, total, imported, deleteFailures, rowFailures, onRetry, onClose }) {
    summaryEl.hidden = false;
    summaryEl.innerHTML = "";
    const title = document.createElement("h3");
    title.className = "admin-import-summary__title";
    title.textContent =
      rowFailures.length || deleteFailures.length
        ? `Imported ${imported} of ${total} rows.`
        : `Imported ${imported} attendees.`;
    summaryEl.appendChild(title);

    if (deleteFailures.length) {
      const p = document.createElement("p");
      p.className = "admin-import-summary__detail";
      p.textContent = `${deleteFailures.length} existing row${deleteFailures.length === 1 ? "" : "s"} could not be deleted before writing the new set.`;
      summaryEl.appendChild(p);
    }
    if (rowFailures.length) {
      const p = document.createElement("p");
      p.className = "admin-import-summary__detail";
      p.textContent = `${rowFailures.length} row${rowFailures.length === 1 ? "" : "s"} failed.`;
      summaryEl.appendChild(p);
      const list = document.createElement("ul");
      list.className = "admin-import-summary__failed";
      // Show up to 5 failed rows inline; the admin can retry the whole set.
      const sample = rowFailures.slice(0, 5);
      for (const f of sample) {
        const li = document.createElement("li");
        li.textContent = `Row ${f.row?.index ?? "?"} — ${f.row?.name || "(no name)"}, ${f.row?.company || "(no company)"}: ${f.error}`;
        list.appendChild(li);
      }
      if (rowFailures.length > sample.length) {
        const li = document.createElement("li");
        li.textContent = `\u2026 and ${rowFailures.length - sample.length} more.`;
        list.appendChild(li);
      }
      summaryEl.appendChild(list);
    }

    const actions = document.createElement("div");
    actions.className = "admin-import-summary__actions";
    if (typeof onRetry === "function") {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "btn-primary";
      retryBtn.textContent = "Retry failed rows";
      retryBtn.addEventListener("click", () => {
        // Close the current overlay before kicking off the retry so the
        // next progress overlay replaces it cleanly.
        close();
        onRetry();
      });
      actions.appendChild(retryBtn);
    }
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn-secondary";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => {
      if (typeof onClose === "function") onClose();
    });
    actions.appendChild(closeBtn);
    summaryEl.appendChild(actions);
  }
  function close() {
    try { uninstall(); } catch (_err) { /* no-op */ }
    overlay.remove();
    document.body.classList.remove("admin-modal-open");
  }

  return { setPhase, setLabel, setProgress, renderSummary, close };
}

/* =================================================================
 * Generic confirm dialog (mirrors the pattern in sponsors-editor.js)
 * ================================================================= */

function confirmDialog({ title, body, confirmLabel, destructive }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "admin-modal-overlay admin-modal-overlay--confirm";

    const modal = document.createElement("div");
    modal.className = "admin-modal admin-modal--confirm";
    modal.setAttribute("role", "alertdialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "admin-attendees-confirm-title");
    modal.setAttribute("aria-describedby", "admin-attendees-confirm-body");
    modal.setAttribute("tabindex", "-1");

    const confirmClass = destructive ? "btn-destructive" : "btn-primary";
    modal.innerHTML = `
      <header class="admin-modal__header">
        <h2 class="admin-modal__title" id="admin-attendees-confirm-title">${escapeHtml(title)}</h2>
      </header>
      <div class="admin-modal__body" id="admin-attendees-confirm-body">
        <p>${escapeHtml(body)}</p>
      </div>
      <footer class="admin-modal__footer">
        <button type="button" class="btn-secondary" data-cancel>Cancel</button>
        <button type="button" class="${confirmClass}" data-confirm>${escapeHtml(confirmLabel)}</button>
      </footer>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.body.classList.add("admin-modal-open");

    const cancelBtn = modal.querySelector("[data-cancel]");
    const confirmBtn = modal.querySelector("[data-confirm]");

    function close(result) {
      try { uninstall(); } catch (_err) { /* no-op */ }
      overlay.remove();
      document.body.classList.remove("admin-modal-open");
      resolve(result);
    }

    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close(false);
    });

    // Destructive confirms start focus on Cancel so the admin can't
    // accidentally wipe the directory by hammering Enter.
    const initialFocus = destructive ? cancelBtn : confirmBtn;
    const uninstall = installFocusTrap(modal, {
      onEscape: () => close(false),
      initialFocus: () => initialFocus,
    });
  });
}

/* =================================================================
 * Helpers
 * ================================================================= */

/**
 * Normalize `name` + `company` into the composite key used by merge
 * lookups: trim, lowercase, collapse any run of whitespace (including
 * tabs) to a single space. An empty name or empty company returns the
 * empty string so the caller can treat it as "no key" and skip the
 * lookup rather than merging incorrectly.
 */
function compositeKey(nameRaw, companyRaw) {
  const n = (typeof nameRaw === "string" ? nameRaw : "").trim().toLowerCase().replace(/\s+/g, " ");
  const c = (typeof companyRaw === "string" ? companyRaw : "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!n || !c) return "";
  return `${n}|${c}`;
}

/** Pick the attendee with the newest `importedAt` (fallback `updatedAt`). */
function mostRecentlyImported(docs) {
  let best = null;
  let bestMs = -Infinity;
  for (const d of docs || []) {
    const stamp = (typeof d?.importedAt === "string" && d.importedAt)
      ? d.importedAt
      : (typeof d?.updatedAt === "string" ? d.updatedAt : "");
    const t = Date.parse(stamp);
    if (!Number.isNaN(t) && t > bestMs) {
      best = d;
      bestMs = t;
    }
  }
  return best;
}

function newDocId() {
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

function friendlyErr(err) {
  if (!err) return "Unknown error.";
  if (err.code === "rate-limited") return `Rate limited. Retry in ${err.retryAfterSec ?? 60}s.`;
  if (err.code === "network-error") return "Network error.";
  if (typeof err.message === "string" && err.message) return err.message;
  return "Request failed.";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
function escapeAttr(s) {
  return escapeHtml(s);
}
