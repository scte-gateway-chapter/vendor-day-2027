// bsc-checkins.js — admin Broadband Skills Challenge check-ins dashboard.
//
// Mounts into #admin-view-root. Reads `appSettings/singleton` once on
// mount (fail-closed on error); when `bscEnabled === false` the view
// renders a disabled shell with a link back to `#/settings` and does
// NOT fetch `bscCheckins` rows. When enabled, it fetches the collection
// on mount and on each 30-second poll gated by document visibility,
// preserves the last-rendered rows on poll failure, and surfaces a
// retryable inline banner above the table.
//
// Columns (10, in design order):
//   1 Name            attendee_name              plain
//   2 Email           email                      plain
//   3 Company         company                    plain
//   4 Office location office_location            plain
//   5 Pre-reg status  entry_type                 chip
//   6 Manager approval manager_approved           chip (— for pre-reg)
//   7 Waiver mode     waiver_mode                chip
//   8 Waiver signed   waiver_mode + waiver_signed_at relativeTime/At table
//   9 Signature name  waiver_signature           plain (empty for paper)
//  10 Check-in time   createdAt                  relativeTime + ISO title
//
// Default sort is `createdAt` DESC with `reference_id` ASC as a
// tie-breaker (handles near-simultaneous waiver submits whose client
// clocks collide at millisecond resolution, and also keeps identical-
// Name sort order stable across browsers whose `Array.prototype.sort`
// is not spec-stable). Only Name and Check-in time column headers are
// clickable sort buttons.
"use strict";

import { initFirestore, getDoc } from "/js/firebase.js";
import * as ui from "/js/ui.js";
import { relativeTime } from "/js/utils/time.js";
import { isBscEnabled } from "/js/app-settings.js";
import { adminFetch, adminReadCollection } from "./admin-fetch.js";
import { registerAdminViewCleanup } from "./admin.js";
import { toCsv, downloadCsv, buildCsvFilename } from "/js/utils/csv-export.js";
import { pushDebugLog } from "/js/debug-log.js";

const POLL_INTERVAL_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 150;

/**
 * Canonical column list for the BSC Check-Ins view. Single source of
 * truth for both the on-screen table (filtered to visible columns)
 * and the CSV export (full list). Any field added here flows to both
 * without a second edit.
 */
export const BSC_CHECKINS_COLUMNS = [
  { key: "attendee_name",    label: "Name" },
  { key: "email",            label: "Email" },
  { key: "company",          label: "Company" },
  { key: "office_location",  label: "Office location" },
  { key: "job_role",         label: "Job role" },
  { key: "supervisor_name",  label: "Supervisor name" },
  { key: "supervisor_email", label: "Supervisor email" },
  { key: "supervisor_phone", label: "Supervisor phone" },
  { key: "scte_member_id",   label: "SCTE member #" },
  { key: "reference_id",     label: "Reference ID" },
  { key: "submitted_at",     label: "Submitted at" },
  { key: "entry_type",       label: "Pre-reg status" },
  { key: "manager_approved", label: "Manager approval" },
  { key: "waiver_mode",      label: "Waiver mode" },
  { key: "waiver_signature", label: "Signature name" },
  { key: "waiver_signed_at", label: "Waiver signed at" },
  { key: "createdAt",        label: "Check-in time" },
];

const BSC_CHECKINS_HEADER_KEYS = [
  "attendee_name",
  "email",
  "company",
  "office_location",
  "entry_type",
  "manager_approved",
  "waiver_mode",
  "waiver_signed_at",
  "waiver_signature",
  "createdAt",
];

// Fails loudly in local/preview if a future refactor forgets to update
// the shared column constant when renaming a displayed field.
for (const k of BSC_CHECKINS_HEADER_KEYS) {
  if (!BSC_CHECKINS_COLUMNS.find((c) => c.key === k)) {
    console.warn(`[bsc-checkins] column drift: '${k}' missing from BSC_CHECKINS_COLUMNS`);
  }
}

/**
 * Render the admin BSC check-ins view into `host`.
 * @param {HTMLElement} host  typically `#admin-view-root`.
 * @returns {Promise<void>}
 */
export default async function renderBscCheckinsEditor(host) {
  host.innerHTML = "";

  const container = document.createElement("section");
  container.className = "admin-bsc-dashboard";
  container.setAttribute("aria-label", "Admin BSC Check-Ins");
  host.appendChild(container);

  const header = buildStickyHeader(() => downloadCurrent());
  container.appendChild(header.el);

  const offlineBanner = buildOfflineBanner();
  container.appendChild(offlineBanner.el);

  document.title = "Admin \u2014 BSC Check-Ins \u2014 Vendor Day 2027";

  // Prime /api/config so Firestore reads work for the appSettings check.
  try {
    await initFirestore();
  } catch (err) {
    console.warn("[admin-bsc-checkins] /api/config load failed:", err);
    renderDisabledShell(container, "Could not reach the server. Try again later.");
    return;
  }

  // Fail-closed: read appSettings once to confirm the feature is enabled.
  // isBscEnabled() reads the shared cache; we also prime it with a direct
  // getDoc so this view works even when the attendee shell's loadAppSettings
  // has not run (admin pages do not import that cache primer).
  let appSettings = null;
  try {
    appSettings = await getDoc("appSettings/singleton");
  } catch (err) {
    console.warn("[admin-bsc-checkins] appSettings read failed:", err);
    renderDisabledShell(container, "Could not read admin settings. Try again later.");
    return;
  }

  const bscOn = appSettings?.bscEnabled === true || isBscEnabled();
  if (!bscOn) {
    renderDisabledShell(container);
    registerAdminViewCleanup(() => { /* nothing to tear down */ });
    return;
  }

  /* ---------------- State ---------------- */

  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  /** @type {object[]} Last-known rows (preserved across poll failures). */
  let rows = [];
  let sawFirstResult = false;
  /** @type {Error | null} */
  let lastErr = null;
  let lastRefreshedAt = null;

  // Filters.
  let filterPreReg = "all"; // "all" | "pre-registered" | "walk-up"
  let filterApproval = "all"; // "all" | "yes" | "no" | "na"
  let filterWaiver = "all"; // "all" | "paper" | "electronic"
  let searchQuery = "";
  let searchDebounceTimer = null;

  // Sort.
  let sortKey = "createdAt"; // "name" | "createdAt"
  let sortDirection = "desc"; // "asc" | "desc"

  /* ---------------- DOM scaffolding ---------------- */

  const summaryStrip = document.createElement("div");
  summaryStrip.className = "admin-bsc-dashboard__summary";
  summaryStrip.setAttribute("aria-live", "polite");
  container.appendChild(summaryStrip);

  const errorBanner = document.createElement("div");
  errorBanner.className = "status-error admin-bsc-dashboard__error";
  errorBanner.setAttribute("role", "alert");
  errorBanner.hidden = true;
  container.appendChild(errorBanner);

  const controlsRow = buildControlsRow();
  container.appendChild(controlsRow);

  const tableWrap = document.createElement("div");
  tableWrap.className = "admin-bsc-dashboard__table-wrap";
  container.appendChild(tableWrap);

  function buildControlsRow() {
    const wrap = document.createElement("div");
    wrap.className = "admin-bsc-dashboard__controls";

    wrap.appendChild(
      buildSegmented({
        label: "Pre-reg status",
        value: () => filterPreReg,
        options: [
          { value: "all", label: "All" },
          { value: "pre-registered", label: "Pre-registered" },
          { value: "walk-up", label: "Walk-up" },
        ],
        onChange: (v) => { filterPreReg = v; renderTable(); updateClearButton(); },
      }),
    );
    wrap.appendChild(
      buildSegmented({
        label: "Manager approval",
        value: () => filterApproval,
        options: [
          { value: "all", label: "All" },
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
          { value: "na", label: "N/A" },
        ],
        onChange: (v) => { filterApproval = v; renderTable(); updateClearButton(); },
      }),
    );
    wrap.appendChild(
      buildSegmented({
        label: "Waiver mode",
        value: () => filterWaiver,
        options: [
          { value: "all", label: "All" },
          { value: "paper", label: "Paper" },
          { value: "electronic", label: "Electronic" },
        ],
        onChange: (v) => { filterWaiver = v; renderTable(); updateClearButton(); },
      }),
    );

    const searchWrap = document.createElement("div");
    searchWrap.className = "admin-bsc-dashboard__search";
    const searchLabel = document.createElement("label");
    searchLabel.className = "sr-only";
    searchLabel.htmlFor = "admin-bsc-search";
    searchLabel.textContent = "Search check-ins";
    const searchInput = document.createElement("input");
    searchInput.id = "admin-bsc-search";
    searchInput.type = "search";
    searchInput.placeholder = "Search name or email";
    searchInput.className = "admin-input admin-bsc-dashboard__search-input";
    searchInput.addEventListener("input", () => {
      if (searchDebounceTimer != null) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = window.setTimeout(() => {
        searchQuery = searchInput.value.trim().toLowerCase();
        renderTable();
        updateClearButton();
      }, SEARCH_DEBOUNCE_MS);
    });
    searchWrap.append(searchLabel, searchInput);
    wrap.appendChild(searchWrap);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn-secondary admin-bsc-dashboard__clear";
    clearBtn.textContent = "Clear filters";
    clearBtn.hidden = true;
    clearBtn.addEventListener("click", () => {
      filterPreReg = "all";
      filterApproval = "all";
      filterWaiver = "all";
      searchQuery = "";
      searchInput.value = "";
      // Reset each segmented control's visual state by re-rendering.
      renderActive();
    });
    wrap.appendChild(clearBtn);

    wrap._searchInput = searchInput;
    wrap._clearBtn = clearBtn;
    return wrap;
  }

  function updateClearButton() {
    const anyActive =
      filterPreReg !== "all" ||
      filterApproval !== "all" ||
      filterWaiver !== "all" ||
      searchQuery !== "";
    controlsRow._clearBtn.hidden = !anyActive;
  }

  function buildSegmented({ label, value, options, onChange }) {
    const group = document.createElement("div");
    group.className = "admin-bsc-dashboard__segmented";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    const legend = document.createElement("span");
    legend.className = "admin-bsc-dashboard__segmented-label";
    legend.textContent = label;
    group.appendChild(legend);
    const buttonsWrap = document.createElement("div");
    buttonsWrap.className = "admin-bsc-dashboard__segmented-buttons";
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "admin-bsc-dashboard__segmented-btn";
      btn.dataset.value = opt.value;
      btn.textContent = opt.label;
      btn.setAttribute("aria-pressed", value() === opt.value ? "true" : "false");
      btn.addEventListener("click", () => {
        onChange(opt.value);
        buttonsWrap.querySelectorAll("button").forEach((b) => {
          b.setAttribute("aria-pressed", b.dataset.value === opt.value ? "true" : "false");
        });
      });
      buttonsWrap.appendChild(btn);
    }
    group.appendChild(buttonsWrap);
    return group;
  }

  /* ---------------- Rendering ---------------- */

  function renderActive() {
    offlineBanner.setVisible(!online);
    renderSummary();
    renderTable();
    renderErrorBanner();
    // Re-sync segmented control visuals + search input if we reset state.
    for (const btn of controlsRow.querySelectorAll(".admin-bsc-dashboard__segmented-btn")) {
      const parent = btn.closest(".admin-bsc-dashboard__segmented");
      if (!parent) continue;
      const label = parent.getAttribute("aria-label");
      let current = "all";
      if (label === "Pre-reg status") current = filterPreReg;
      else if (label === "Manager approval") current = filterApproval;
      else if (label === "Waiver mode") current = filterWaiver;
      btn.setAttribute("aria-pressed", btn.dataset.value === current ? "true" : "false");
    }
    if (controlsRow._searchInput && controlsRow._searchInput.value !== searchQuery) {
      controlsRow._searchInput.value = searchQuery;
    }
    updateClearButton();
  }

  function renderSummary() {
    const total = rows.length;
    const walkUps = rows.filter((r) => r.entry_type === "walk-up").length;
    const noApproval = rows.filter(
      (r) => r.entry_type === "walk-up" && r.manager_approved === "no",
    ).length;
    summaryStrip.innerHTML = "";
    if (!sawFirstResult) {
      summaryStrip.textContent = "Loading check-ins\u2026";
      return;
    }
    const line = document.createElement("p");
    line.className = "admin-bsc-dashboard__summary-line";
    line.textContent =
      `${total} check-in${total === 1 ? "" : "s"} \u00B7 ` +
      `${walkUps} walk-up${walkUps === 1 ? "" : "s"} \u00B7 ` +
      `${noApproval} without manager approval`;
    summaryStrip.appendChild(line);
    if (lastRefreshedAt) {
      const refreshed = document.createElement("p");
      refreshed.className = "admin-bsc-dashboard__summary-refreshed";
      const when = relativeTime(lastRefreshedAt) || "just now";
      refreshed.textContent = `Last update: ${when}`;
      refreshed.title = String(lastRefreshedAt);
      summaryStrip.appendChild(refreshed);
    }
  }

  function renderErrorBanner() {
    if (!lastErr || !sawFirstResult) {
      errorBanner.hidden = true;
      errorBanner.innerHTML = "";
      return;
    }
    errorBanner.hidden = false;
    errorBanner.innerHTML = "";
    const msg = document.createElement("span");
    msg.textContent = "Couldn't refresh check-ins. Showing last-loaded.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn-secondary admin-bsc-dashboard__error-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => { refresh(); });
    errorBanner.append(msg, retry);
  }

  function renderTable() {
    const filtered = filterRows(rows, {
      preReg: filterPreReg,
      approval: filterApproval,
      waiver: filterWaiver,
      search: searchQuery,
    });
    const sorted = sortRows(filtered, sortKey, sortDirection);

    tableWrap.innerHTML = "";
    if (!sawFirstResult) {
      const skel = document.createElement("div");
      skel.className = "skeleton-card";
      skel.setAttribute("aria-hidden", "true");
      skel.style.minHeight = "160px";
      tableWrap.appendChild(skel);
      return;
    }
    if (sorted.length === 0) {
      const empty = document.createElement("div");
      empty.className = "placeholder-card";
      const h = document.createElement("h2");
      const p = document.createElement("p");
      if (rows.length === 0) {
        h.textContent = "No BSC check-ins yet";
        p.textContent =
          "Rows appear here as competitors arrive and complete the waiver.";
      } else {
        h.textContent = "No check-ins match your filters";
        p.textContent = "Clear or adjust the filters above to see more rows.";
      }
      empty.append(h, p);
      tableWrap.appendChild(empty);
      return;
    }

    const table = document.createElement("table");
    table.className = "admin-bsc-dashboard__table";
    table.appendChild(buildTableHead());
    const tbody = document.createElement("tbody");
    for (const row of sorted) tbody.appendChild(buildTableRow(row));
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  function buildTableHead() {
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");
    // Column labels are derived from the shared BSC_CHECKINS_COLUMNS so
    // the CSV header and the on-screen header stay in lockstep.
    const labelByKey = Object.fromEntries(
      BSC_CHECKINS_COLUMNS.map((c) => [c.key, c.label]),
    );
    const label = (key, fallback) => labelByKey[key] || fallback;
    // Overrides for columns whose on-screen heading differs from the
    // CSV-centric label (e.g. "Waiver signed" vs "Waiver signed at").
    const DISPLAY_OVERRIDE = {
      waiver_signed_at: "Waiver signed",
    };
    const text = (key, fallback) => DISPLAY_OVERRIDE[key] || label(key, fallback);
    const columns = [
      { key: "name", label: text("attendee_name", "Name"), sortable: true },
      { key: null, label: text("email", "Email") },
      { key: null, label: text("company", "Company") },
      { key: null, label: text("office_location", "Office location") },
      { key: null, label: text("entry_type", "Pre-reg status") },
      { key: null, label: text("manager_approved", "Manager approval") },
      { key: null, label: text("waiver_mode", "Waiver mode") },
      { key: null, label: text("waiver_signed_at", "Waiver signed") },
      { key: null, label: text("waiver_signature", "Signature name") },
      { key: "createdAt", label: text("createdAt", "Check-in time"), sortable: true },
    ];
    for (const col of columns) {
      const th = document.createElement("th");
      th.scope = "col";
      if (col.sortable) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "admin-bsc-dashboard__sort-btn";
        btn.textContent = col.label;
        if (sortKey === col.key) {
          th.setAttribute("aria-sort", sortDirection === "asc" ? "ascending" : "descending");
          const arrow = document.createElement("span");
          arrow.className = "admin-bsc-dashboard__sort-arrow";
          arrow.setAttribute("aria-hidden", "true");
          arrow.textContent = sortDirection === "asc" ? " \u2191" : " \u2193";
          btn.appendChild(arrow);
        } else {
          th.setAttribute("aria-sort", "none");
        }
        btn.addEventListener("click", () => {
          if (sortKey === col.key) {
            sortDirection = sortDirection === "asc" ? "desc" : "asc";
          } else {
            sortKey = col.key;
            sortDirection = col.key === "createdAt" ? "desc" : "asc";
          }
          renderTable();
        });
        th.appendChild(btn);
      } else {
        th.textContent = col.label;
      }
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    return thead;
  }

  function buildTableRow(row) {
    const tr = document.createElement("tr");
    const isWalkUpNoApproval =
      row.entry_type === "walk-up" && row.manager_approved === "no";
    if (isWalkUpNoApproval) {
      tr.classList.add("admin-bsc-row--warning");
      tr.setAttribute("aria-label", "Walk-up without manager approval");
    }

    appendCell(tr, row.attendee_name || "");
    appendCell(tr, row.email || "");
    appendCell(tr, row.company || "");
    appendCell(tr, row.office_location || "");

    // Pre-reg status chip.
    appendChipCell(
      tr,
      row.entry_type === "pre-registered" ? "\u2713 Pre-registered" : "Walk-up",
      row.entry_type === "pre-registered"
        ? "admin-bsc-chip admin-bsc-chip--pre-registered"
        : "admin-bsc-chip admin-bsc-chip--walk-up",
    );

    // Manager approval.
    if (row.entry_type === "pre-registered" || !row.manager_approved) {
      appendCell(tr, "\u2014");
    } else if (row.manager_approved === "yes") {
      appendChipCell(tr, "\u2713 Yes", "admin-bsc-chip admin-bsc-chip--yes");
    } else if (row.manager_approved === "no") {
      appendChipCell(tr, "\u2717 No", "admin-bsc-chip admin-bsc-chip--no");
    } else {
      appendCell(tr, String(row.manager_approved));
    }

    // Waiver mode.
    if (row.waiver_mode === "electronic") {
      appendChipCell(tr, "Electronic", "admin-bsc-chip admin-bsc-chip--electronic");
    } else {
      appendChipCell(tr, "Paper", "admin-bsc-chip admin-bsc-chip--paper");
    }

    // Waiver signed.
    const signedTd = document.createElement("td");
    if (row.waiver_mode === "electronic") {
      const signedAt = row.waiver_signed_at || "";
      signedTd.textContent = relativeTime(signedAt) || signedAt || "";
      if (signedAt) signedTd.title = signedAt;
    } else {
      signedTd.textContent = "At table";
    }
    tr.appendChild(signedTd);

    // Signature name.
    appendCell(tr, row.waiver_mode === "electronic" ? (row.waiver_signature || "") : "");

    // Check-in time.
    const createdTd = document.createElement("td");
    const createdAt = row.createdAt || "";
    createdTd.textContent = relativeTime(createdAt) || createdAt || "";
    if (createdAt) createdTd.title = createdAt;
    tr.appendChild(createdTd);

    return tr;
  }

  function appendCell(tr, text) {
    const td = document.createElement("td");
    td.textContent = text;
    tr.appendChild(td);
  }

  function appendChipCell(tr, text, className) {
    const td = document.createElement("td");
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    td.appendChild(span);
    tr.appendChild(td);
  }

  /* ---------------- Filtering + sorting ---------------- */

  function filterRows(input, { preReg, approval, waiver, search }) {
    const q = typeof search === "string" ? search.trim().toLowerCase() : "";
    return input.filter((r) => {
      if (preReg !== "all" && r.entry_type !== preReg) return false;
      if (approval !== "all") {
        if (approval === "na") {
          // "N/A" matches pre-registered rows OR empty manager_approved.
          if (!(r.entry_type === "pre-registered" || !r.manager_approved)) return false;
        } else if (r.manager_approved !== approval) {
          return false;
        }
      }
      if (waiver !== "all" && r.waiver_mode !== waiver) return false;
      if (q) {
        const name = String(r.attendee_name || "").toLowerCase();
        const email = String(r.email || "").toLowerCase();
        if (!name.includes(q) && !email.includes(q)) return false;
      }
      return true;
    });
  }

  function sortRows(input, key, direction) {
    const copy = input.slice();
    const dir = direction === "asc" ? 1 : -1;
    copy.sort((a, b) => {
      let primary = 0;
      if (key === "name") {
        primary = String(a.attendee_name || "").localeCompare(
          String(b.attendee_name || ""),
          undefined,
          { sensitivity: "base" },
        );
      } else {
        const aVal = String(a.createdAt || "");
        const bVal = String(b.createdAt || "");
        primary = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      }
      if (primary !== 0) return primary * dir;
      // Tie-breaker: reference_id ASC regardless of primary direction so
      // the ordering is deterministic across browsers whose sort is not
      // spec-stable (older WebViews that may ship on field devices).
      const refA = String(a.reference_id || "");
      const refB = String(b.reference_id || "");
      return refA < refB ? -1 : refA > refB ? 1 : 0;
    });
    return copy;
  }

  /* ---------------- CSV export ---------------- */

  async function downloadCurrent() {
    try {
      const list = await adminReadCollection("bscCheckins", { limit: 1000 });
      const data = Array.isArray(list) ? list : [];
      const csv = toCsv(data, BSC_CHECKINS_COLUMNS);
      const filename = buildCsvFilename("bscCheckins");
      await downloadCsv(filename, csv);
      ui.toast("success", `Exported ${data.length} row${data.length === 1 ? "" : "s"} to ${filename}.`);
      // NOTE (deferred from Phase 1, review iteration 3 NIT #2): pushDebugLog
      // writes to the shared debug-log ring buffer, but admin.js does not
      // currently mount the debug overlay. The toast above is the admin-
      // visible receipt; this log line is here so a future patch that mounts
      // the overlay in admin surfaces this event retroactively in that session.
      pushDebugLog("csv-export", "bscCheckins", { count: data.length, filename });
    } catch (err) {
      if (err?.code === "session-expired") return;
      console.warn("[admin-bsc-checkins] CSV export failed:", err);
      ui.toast("error", "Couldn't build the CSV. Try again.");
    }
  }

  /* ---------------- Fetch loop ---------------- */

  let pollTimer = null;
  let refreshInFlight = false;

  async function refresh() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      const list = await adminReadCollection("bscCheckins", { limit: 1000 });
      rows = Array.isArray(list) ? list : [];
      lastErr = null;
      lastRefreshedAt = new Date().toISOString();
    } catch (err) {
      if (err?.code === "session-expired") return;
      console.warn("[admin-bsc-checkins] fetch failed:", err);
      lastErr = err;
      // Preserve the last-rendered rows; only toast once per view mount.
    } finally {
      refreshInFlight = false;
      sawFirstResult = true;
      renderActive();
    }
  }

  function startPoll() {
    stopPoll();
    pollTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refresh();
    }, POLL_INTERVAL_MS);
  }

  function stopPoll() {
    if (pollTimer != null) { clearInterval(pollTimer); pollTimer = null; }
  }

  /* ---------------- Connectivity + visibility ---------------- */

  const onOnline = () => {
    online = true;
    renderActive();
    refresh();
  };
  const onOffline = () => {
    online = false;
    renderActive();
  };
  const onVisibility = () => {
    if (document.visibilityState !== "visible") return;
    refresh();
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  document.addEventListener("visibilitychange", onVisibility);

  registerAdminViewCleanup(() => {
    stopPoll();
    if (searchDebounceTimer != null) clearTimeout(searchDebounceTimer);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onVisibility);
    rows = [];
  });

  renderActive();
  await refresh();
  startPoll();
}

/* =================================================================
 * Sticky secondary header
 * ================================================================= */

function buildStickyHeader(onDownload) {
  const el = document.createElement("header");
  el.className = "admin-bsc-dashboard__header";
  const row = document.createElement("div");
  row.className = "admin-bsc-dashboard__header-row";
  const title = document.createElement("h2");
  title.className = "admin-bsc-dashboard__header-title";
  title.textContent = "Admin \u2014 BSC Check-Ins";
  const downloadBtn = document.createElement("button");
  downloadBtn.type = "button";
  downloadBtn.className = "btn-secondary";
  downloadBtn.textContent = "Download CSV";
  downloadBtn.addEventListener("click", () => {
    if (typeof onDownload === "function") onDownload();
  });
  row.append(title, downloadBtn);
  el.appendChild(row);
  return { el };
}

/* =================================================================
 * Offline banner
 * ================================================================= */

function buildOfflineBanner() {
  const el = document.createElement("div");
  el.className = "admin-view-offline-banner";
  el.setAttribute("role", "status");
  el.textContent = "You're offline \u2014 live refreshes are paused.";
  el.hidden = true;
  function setVisible(visible) { el.hidden = !visible; }
  return { el, setVisible };
}

/* =================================================================
 * Disabled shell
 * ================================================================= */

function renderDisabledShell(host, override) {
  const section = document.createElement("section");
  section.className = "placeholder-card";
  section.setAttribute("aria-live", "polite");
  const h = document.createElement("h2");
  h.textContent = "BSC check-in is currently disabled";
  const p = document.createElement("p");
  p.textContent = override || "Enable it from the admin Settings page to start seeing check-ins here.";
  const linkWrap = document.createElement("p");
  const link = document.createElement("a");
  link.href = "#/settings";
  link.textContent = "Open Settings";
  linkWrap.appendChild(link);
  section.append(h, p, linkWrap);
  host.appendChild(section);
}

// `adminFetch` and `ui` are imported for parity with the sibling admin
// editor modules and for future dashboard affordances (manual row
// corrections, toast surfacing). Keeping the import graph stable here
// avoids edit churn when FEAT-002 lands additional dashboard behavior.
void adminFetch;
void ui;
