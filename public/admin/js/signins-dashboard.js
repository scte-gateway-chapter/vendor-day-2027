// signins-dashboard.js — admin live Sign-Ins dashboard (Phase 1).
//
// Mounts into #admin-view-root. Mirrors public/admin/js/bsc-checkins.js
// in shape: 30-second poll gated on document.visibilityState, cached
// rows preserved on poll failure, inline retry banner above the table,
// 1000-row cap, in-memory sort/filter/search, "Download CSV" button in
// the sticky header.
//
// Reads via adminReadCollection("signIns", { limit: 1000 }) — the
// admin broker uses the service account under the hood so public rule
// denial of list queries does not block admin reads.
//
// CSS strategy: reuses the existing `.admin-bsc-dashboard__*` class
// block directly rather than introducing a per-dashboard duplicate.
// The chrome (sticky header, segmented controls, search, table) is
// identical by design.
"use strict";

import * as ui from "/js/ui.js";
import { relativeTime } from "/js/utils/time.js";
import { adminReadCollection } from "./admin-fetch.js";
import { registerAdminViewCleanup } from "./admin.js";
import { toCsv, downloadCsv, buildCsvFilename } from "/js/utils/csv-export.js";
import { pushDebugLog } from "/js/debug-log.js";

const POLL_INTERVAL_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Canonical column list for the Sign-Ins view. Single source of truth
 * for both the on-screen table (filtered to 9 visible columns) and the
 * CSV export (full list). Any field added here flows to both without
 * a second edit.
 */
export const SIGNINS_COLUMNS = [
  { key: "attendee_name",      label: "Name" },
  { key: "company",            label: "Company" },
  { key: "office_location",    label: "Office location" },
  { key: "email",              label: "Email" },
  { key: "phone",              label: "Phone" },
  { key: "scte_member_number", label: "SCTE member #" },
  { key: "signed_in_at",       label: "Sign-in time" }, // CSV only; display uses createdAt via relativeTime()
  { key: "bsc_competitor",     label: "BSC Competitor" },
  { key: "source",             label: "Source" },
  { key: "createdAt",          label: "createdAt" },
  { key: "updatedAt",          label: "updatedAt" },
];

// Column keys the on-screen table renders. The CSV uses the full list.
const SIGNINS_HEADER_KEYS = [
  "attendee_name",
  "company",
  "office_location",
  "email",
  "phone",
  "scte_member_number",
  "signed_in_at",
  "bsc_competitor",
  "source",
];

// Fails loudly in local/preview if a future refactor forgets to update
// the shared column constant when renaming a displayed field.
for (const k of SIGNINS_HEADER_KEYS) {
  if (!SIGNINS_COLUMNS.find((c) => c.key === k)) {
    console.warn(`[signins] column drift: '${k}' missing from SIGNINS_COLUMNS`);
  }
}

/** Local-day comparison on Date components. See design: slicing an ISO
 *  UTC string by its first 10 chars yields the UTC date, not the
 *  admin's local date, so late-evening Central-time sign-ins would be
 *  mis-counted. Parsing + comparing components fixes that. */
function isToday(iso) {
  if (!iso) return false;
  const t = new Date(iso);
  const n = new Date();
  return (
    t.getFullYear() === n.getFullYear() &&
    t.getMonth() === n.getMonth() &&
    t.getDate() === n.getDate()
  );
}

/**
 * Render the admin Sign-Ins dashboard into `host`.
 * @param {HTMLElement} host  typically `#admin-view-root`.
 * @returns {Promise<void>}
 */
export default async function renderSignInsDashboard(host) {
  host.innerHTML = "";

  const container = document.createElement("section");
  container.className = "admin-bsc-dashboard";
  container.setAttribute("aria-label", "Admin Sign-Ins");
  host.appendChild(container);

  const header = buildStickyHeader(() => downloadCurrent());
  container.appendChild(header.el);

  const offlineBanner = buildOfflineBanner();
  container.appendChild(offlineBanner.el);

  document.title = "Admin \u2014 Sign-Ins \u2014 Vendor Day 2027";

  /* ---------------- State ---------------- */

  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  /** @type {object[]} Last-known rows (preserved across poll failures). */
  let rows = [];
  let sawFirstResult = false;
  /** @type {Error | null} */
  let lastErr = null;
  let lastRefreshedAt = null;

  let filterBsc = "all"; // "all" | "yes" | "no"
  let searchQuery = "";
  let searchDebounceTimer = null;

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
        label: "BSC Competitor",
        value: () => filterBsc,
        options: [
          { value: "all", label: "All" },
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
        onChange: (v) => { filterBsc = v; renderTable(); updateClearButton(); },
      }),
    );

    const searchWrap = document.createElement("div");
    searchWrap.className = "admin-bsc-dashboard__search";
    const searchLabel = document.createElement("label");
    searchLabel.className = "sr-only";
    searchLabel.htmlFor = "admin-signins-search";
    searchLabel.textContent = "Search sign-ins";
    const searchInput = document.createElement("input");
    searchInput.id = "admin-signins-search";
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
      filterBsc = "all";
      searchQuery = "";
      searchInput.value = "";
      renderActive();
    });
    wrap.appendChild(clearBtn);

    wrap._searchInput = searchInput;
    wrap._clearBtn = clearBtn;
    return wrap;
  }

  function updateClearButton() {
    const anyActive = filterBsc !== "all" || searchQuery !== "";
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
    for (const btn of controlsRow.querySelectorAll(".admin-bsc-dashboard__segmented-btn")) {
      const parent = btn.closest(".admin-bsc-dashboard__segmented");
      if (!parent) continue;
      const label = parent.getAttribute("aria-label");
      let current = "all";
      if (label === "BSC Competitor") current = filterBsc;
      btn.setAttribute("aria-pressed", btn.dataset.value === current ? "true" : "false");
    }
    if (controlsRow._searchInput && controlsRow._searchInput.value !== searchQuery) {
      controlsRow._searchInput.value = searchQuery;
    }
    updateClearButton();
  }

  function renderSummary() {
    summaryStrip.innerHTML = "";
    if (!sawFirstResult) {
      summaryStrip.textContent = "Loading sign-ins\u2026";
      return;
    }
    const total = rows.length;
    const todayCount = rows.filter((r) => isToday(r.createdAt)).length;
    const line = document.createElement("p");
    line.className = "admin-bsc-dashboard__summary-line";
    line.textContent =
      `${total} sign-in${total === 1 ? "" : "s"} \u00B7 ` +
      `${todayCount} today`;
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
    msg.textContent = "Couldn't refresh sign-ins. Showing last-loaded.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn-secondary admin-bsc-dashboard__error-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => { refresh(); });
    errorBanner.append(msg, retry);
  }

  function renderTable() {
    const filtered = filterRows(rows, { bsc: filterBsc, search: searchQuery });
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
        h.textContent = "No sign-ins yet";
        p.textContent =
          "Rows appear here as attendees submit the Sign-In form.";
      } else {
        h.textContent = "No sign-ins match your filters";
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

    const labelByKey = Object.fromEntries(
      SIGNINS_COLUMNS.map((c) => [c.key, c.label]),
    );
    const sortableKeys = new Set(["attendee_name", "signed_in_at"]);
    // Map the sortable column keys to the sort state key the row sort
    // actually uses (sign-in time sorts on `createdAt`, not `signed_in_at`).
    const sortStateKey = { attendee_name: "name", signed_in_at: "createdAt" };

    for (const key of SIGNINS_HEADER_KEYS) {
      const label = labelByKey[key] || key;
      const th = document.createElement("th");
      th.scope = "col";
      if (sortableKeys.has(key)) {
        const stateKey = sortStateKey[key];
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "admin-bsc-dashboard__sort-btn";
        btn.textContent = label;
        if (sortKey === stateKey) {
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
          if (sortKey === stateKey) {
            sortDirection = sortDirection === "asc" ? "desc" : "asc";
          } else {
            sortKey = stateKey;
            sortDirection = stateKey === "createdAt" ? "desc" : "asc";
          }
          renderTable();
        });
        th.appendChild(btn);
      } else {
        th.textContent = label;
      }
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    return thead;
  }

  function buildTableRow(row) {
    const tr = document.createElement("tr");

    appendCell(tr, row.attendee_name || "");
    appendCell(tr, row.company || "");
    appendCell(tr, row.office_location || "");
    appendCell(tr, row.email || "");
    appendCell(tr, row.phone || "");
    appendCell(tr, row.scte_member_number || "");

    // Sign-in time cell: relativeTime(createdAt) + ISO title.
    const createdTd = document.createElement("td");
    const createdAt = row.createdAt || "";
    createdTd.textContent = relativeTime(createdAt) || createdAt || "";
    if (createdAt) createdTd.title = createdAt;
    tr.appendChild(createdTd);

    // BSC Competitor badge.
    if (row.bsc_competitor === "yes") {
      appendChipCell(tr, "\u2713 Yes", "admin-bsc-chip admin-bsc-chip--yes");
    } else if (row.bsc_competitor === "no") {
      appendChipCell(tr, "No", "admin-bsc-chip admin-bsc-chip--no");
    } else if (row.bsc_competitor) {
      appendChipCell(tr, String(row.bsc_competitor), "admin-bsc-chip");
    } else {
      appendCell(tr, "");
    }

    // Source badge. `app` renders green; anything else renders neutral
    // with the raw string (per design: Phase 3 will emit "godaddy").
    const source = row.source || "";
    if (source === "app") {
      appendChipCell(tr, "App", "admin-bsc-chip admin-bsc-chip--pre-registered");
    } else if (source) {
      appendChipCell(tr, source, "admin-bsc-chip");
    } else {
      appendCell(tr, "");
    }

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

  function filterRows(input, { bsc, search }) {
    const q = typeof search === "string" ? search.trim().toLowerCase() : "";
    return input.filter((r) => {
      if (bsc !== "all" && r.bsc_competitor !== bsc) return false;
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
      // Tie-breaker: attendee_name ASC regardless of primary direction
      // so the ordering is deterministic across browsers whose
      // Array.prototype.sort is not spec-stable.
      const nameA = String(a.attendee_name || "");
      const nameB = String(b.attendee_name || "");
      return nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
    });
    return copy;
  }

  /* ---------------- CSV export ---------------- */

  async function downloadCurrent() {
    try {
      const list = await adminReadCollection("signIns", { limit: 1000 });
      const data = Array.isArray(list) ? list : [];
      const csv = toCsv(data, SIGNINS_COLUMNS);
      const filename = buildCsvFilename("signIns");
      await downloadCsv(filename, csv);
      ui.toast("success", `Exported ${data.length} row${data.length === 1 ? "" : "s"} to ${filename}.`);
      // NOTE (deferred from Phase 1, review iteration 3 NIT #2): pushDebugLog
      // writes to the shared debug-log ring buffer, but admin.js does not
      // currently mount the debug overlay. The toast above is the admin-
      // visible receipt; this log line is here so a future patch that mounts
      // the overlay in admin surfaces this event retroactively in that session.
      pushDebugLog("csv-export", "signIns", { count: data.length, filename });
    } catch (err) {
      if (err?.code === "session-expired") return;
      console.warn("[admin-signins] CSV export failed:", err);
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
      const list = await adminReadCollection("signIns", { limit: 1000 });
      rows = Array.isArray(list) ? list : [];
      lastErr = null;
      lastRefreshedAt = new Date().toISOString();
    } catch (err) {
      if (err?.code === "session-expired") return;
      console.warn("[admin-signins] fetch failed:", err);
      lastErr = err;
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
 * Sticky secondary header (with Download CSV button)
 * ================================================================= */

function buildStickyHeader(onDownload) {
  const el = document.createElement("header");
  el.className = "admin-bsc-dashboard__header";
  const row = document.createElement("div");
  row.className = "admin-bsc-dashboard__header-row";
  const title = document.createElement("h2");
  title.className = "admin-bsc-dashboard__header-title";
  title.textContent = "Admin \u2014 Sign-Ins";
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
