// views/attendees.js — attendee Attendee Directory list view (Task 13).
//
// Subscribes to the `attendees` collection via the 15-second poll from
// firebase.js, filtered server-side with `where("optedOut", "==", false)`.
// firestore.rules REQUIRES that filter on list reads (see design section 13),
// so when the filtered query cannot be issued (e.g., a legacy build or a
// transient structured-query failure) we fall back to a bare collection
// read and filter client-side — the Firestore rules still hide opted-out
// rows from the response, so the fallback stays safe. The client-side
// filter is defense in depth.
//
// Each row is `<a href="#/attendees/<id>">` for natural right-click /
// middle-click behavior. Clicking the row flips `__navigatedFromList` to
// `true` so the detail modal can use `history.back()` on close (which
// preserves the list's scroll position) rather than a fresh navigation.
//
// Search is client-side only — a case-insensitive substring match on
// `name` OR `company`, debounced 150ms. On debounce the list body
// re-renders; the sticky header + search area never re-renders so the
// input's focus and selection are preserved while the user types.
//
// Opt-out invariant: the sticky-header count ALWAYS reflects what the
// user is seeing (filtered when the search field has content; otherwise
// the full visible set). We never reveal that a specific attendee opted
// out — opted-out rows are simply absent from the list.
//
// Cleanup follows the Tasks 7-12 pattern: a module-level __cleanup slot
// stops the attendees poll. The router.beforeEach hook (via
// registerViewCleanup in app.js) drains it before mounting the next view.
"use strict";

import { initFirestore, onSnapshot } from "../firebase.js";
import * as ui from "../ui.js";
import { registerViewCleanup } from "../app.js";

const SEARCH_DEBOUNCE_MS = 150;

/** Module-level cleanup slot. Set at the end of each render call. */
let __cleanup = null;

/** Latest known attendees snapshot (filtered to optedOut: false).
 *  Exposed via getCachedAttendee so the detail view can fall back on
 *  this when offline and the Firestore read fails. */
let __cachedList = null;

/** True when the user clicked a row in this view since the list last
 *  mounted. The detail view reads this to decide whether `history.back()`
 *  is safe (list is in the browser's back stack) or whether it should
 *  navigate forward to `#/attendees`. Reset on every list mount. */
let __navigatedFromList = false;

/**
 * Return the latest cached attendee for `id` if the list view has run
 * since page load, otherwise `null`. The detail view uses this as a
 * best-effort offline fallback.
 * @param {string} id
 * @returns {object | null}
 */
export function getCachedAttendee(id) {
  if (!Array.isArray(__cachedList) || !id) return null;
  return __cachedList.find((a) => a && a.id === id) || null;
}

/**
 * Return whether the detail view can safely use `history.back()` to
 * return to the list (i.e., the user came from the list this session).
 * @returns {boolean}
 */
export function navigatedFromList() {
  return __navigatedFromList === true;
}

/**
 * Render the Attendee Directory list view into `host`.
 * @param {HTMLElement} host  typically `#view-root`.
 * @returns {Promise<void>}
 */
export async function renderAttendees(host) {
  // Drain prior render handles so retries don't leave two pollers running.
  runCleanup();

  // Reset the "came from list" flag — any future navigation to detail
  // from this mount will set it back to true via the row click handler.
  __navigatedFromList = false;

  host.innerHTML = "";

  const stickyWrap = document.createElement("section");
  stickyWrap.className = "attendees-sticky-wrap";

  const stickyHeader = document.createElement("header");
  stickyHeader.className = "view-sticky-header";
  stickyHeader.setAttribute("role", "banner");
  stickyHeader.innerHTML = `
    <h2 class="view-sticky-header__title">Attendees</h2>
    <span class="attendee-count-live" data-count aria-live="polite" aria-atomic="true"></span>
  `;

  const stickySearch = document.createElement("div");
  stickySearch.className = "attendees-sticky-search";
  stickySearch.innerHTML = `
    <label class="sr-only" for="attendees-search-input">Search attendees</label>
    <div class="attendee-search-field">
      <input
        id="attendees-search-input"
        type="search"
        class="attendee-search-input"
        placeholder="Search by name or company"
        aria-label="Search attendees"
        autocomplete="off"
        autocapitalize="words"
      />
      <button
        type="button"
        class="attendee-search-clear"
        data-clear
        aria-label="Clear search"
        hidden
      >&times;</button>
    </div>
  `;

  stickyWrap.append(stickyHeader, stickySearch);

  const listSection = document.createElement("section");
  listSection.className = "attendees-list";
  listSection.setAttribute("aria-label", "Attendees");

  host.append(stickyWrap, listSection);

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    ui.showOfflineBanner();
  }

  // /api/config is cached inside firebase.js after the first bootstrap, so
  // this is a no-op after the first page load. We still await it before
  // the first poll so the initial fetch doesn't race the config load.
  const configReady = initFirestore().catch((err) => {
    console.warn("[attendees] /api/config load failed:", err);
    return null;
  });

  const countEl = stickyHeader.querySelector("[data-count]");
  const searchInput = stickySearch.querySelector("#attendees-search-input");
  const clearButton = stickySearch.querySelector("[data-clear]");

  /** @type {object[] | null} */
  let cachedList = null;
  /** @type {Error | null} */
  let lastErr = null;
  let sawFirstResult = false;
  /** The current search query, trimmed. */
  let searchQuery = "";

  renderSkeleton(listSection);
  updateCount(countEl, null, false);

  function rerender() {
    if (lastErr && !cachedList) {
      renderErrorNoCache(listSection, () => restartSubscription());
      updateCount(countEl, null, false);
      return;
    }
    if (!sawFirstResult) {
      renderSkeleton(listSection);
      updateCount(countEl, null, false);
      return;
    }
    const filtered = filterAttendees(cachedList || [], searchQuery);
    renderList(listSection, filtered, {
      hasError: Boolean(lastErr),
      hasAnyAttendees: (cachedList || []).length > 0,
      isSearching: searchQuery.length > 0,
      onRetry: () => restartSubscription(),
      onRowClick: () => markNavigatedFromList(),
      onClearSearch: () => clearSearch(),
    });
    updateCount(countEl, filtered.length, searchQuery.length > 0);
  }

  function clearSearch() {
    searchQuery = "";
    searchInput.value = "";
    clearButton.hidden = true;
    rerender();
    searchInput.focus();
  }

  /** @type {(() => void) | null} */
  let unsub = null;
  // Fire the "could not load" toast only once per subscription lifetime so a
  // flaky connection doesn't stack a toast on every 15-second tick.
  let errorToasted = false;
  // Track whether we've already fallen back from the where-filtered query
  // to a bare collection read. The fallback is for defense in depth —
  // security rules filter opted-out rows for bare reads too, so the
  // visible result is identical.
  let whereFallbackApplied = false;

  function handleResult(data, err) {
    if (err) {
      console.warn("[attendees] poll failed:", err);
      lastErr = err;
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        ui.showOfflineBanner();
      } else if (!cachedList && !errorToasted) {
        ui.toast("error", "Couldn't load attendees. Tap Retry to try again.");
        errorToasted = true;
      }
    } else {
      lastErr = null;
      errorToasted = false;
      const rows = Array.isArray(data) ? data.slice() : [];
      // Defense-in-depth: strip any lingering optedOut === true rows.
      // Security rules already enforce this on the server, but a bare
      // read fallback would still rely on rules; this double-checks.
      const safeRows = rows.filter((r) => r && r.optedOut !== true);
      safeRows.sort(sortAttendees);
      cachedList = safeRows;
      __cachedList = safeRows;
    }
    sawFirstResult = true;
    rerender();
  }

  async function startSubscription() {
    try { await configReady; } catch (_err) { /* non-fatal */ }
    // First attempt: filter server-side via a `where` clause. firestore.rules
    // requires it, so this is the normal path.
    unsub = onSnapshot(
      "attendees",
      (data, err) => {
        if (err && !whereFallbackApplied) {
          // The structured-query path hiccuped (missing index, transient
          // runQuery issue, legacy build without where support). Fall back
          // to the bare collection read; rules will still filter server-
          // side so we never see opted-out rows in either path.
          console.warn(
            "[attendees] where poll failed, falling back to bare collection read:",
            err,
          );
          whereFallbackApplied = true;
          if (unsub) { unsub(); unsub = null; }
          unsub = onSnapshot("attendees", handleResult, { intervalMs: 15000 });
          return;
        }
        handleResult(data, err);
      },
      {
        intervalMs: 15000,
        where: { field: "optedOut", op: "==", value: false },
      },
    );
  }

  function restartSubscription() {
    if (unsub) { unsub(); unsub = null; }
    lastErr = null;
    cachedList = null;
    sawFirstResult = false;
    errorToasted = false;
    whereFallbackApplied = false;
    renderSkeleton(listSection);
    updateCount(countEl, null, false);
    startSubscription();
  }

  startSubscription();

  // Debounced search handler. 150ms is snappy without re-rendering on
  // every keystroke; we toggle the clear-button eagerly so the UI still
  // feels immediate even while the debounce timer is in flight.
  const runSearch = debounce((value) => {
    searchQuery = value.trim();
    rerender();
  }, SEARCH_DEBOUNCE_MS);

  searchInput.addEventListener("input", (ev) => {
    const raw = ev.target.value || "";
    clearButton.hidden = raw.length === 0;
    runSearch(raw);
  });

  // Escape in the search input clears it — a pleasant keyboard shortcut
  // and the same behavior as the on-screen clear button.
  searchInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && searchInput.value) {
      ev.preventDefault();
      clearSearch();
    }
  });

  clearButton.addEventListener("click", () => clearSearch());

  __cleanup = () => {
    if (unsub) { unsub(); unsub = null; }
  };
  registerViewCleanup(() => runCleanup());

  document.title = "Attendees \u2014 Vendor Day 2027";
}

export default renderAttendees;

function runCleanup() {
  if (!__cleanup) return;
  try {
    __cleanup();
  } catch (err) {
    console.warn("[attendees] cleanup failed:", err);
  }
  __cleanup = null;
}

function markNavigatedFromList() {
  __navigatedFromList = true;
}

/* ---------------- Rendering states ---------------- */

function renderSkeleton(host) {
  // 6 shimmer rows per spec. Explicit height keeps the row footprint
  // close to the real attendee row so the list doesn't jump on first paint.
  const rows = Array.from({ length: 6 })
    .map(() => `<div class="skeleton-row attendee-row-skeleton" style="height: 56px;"></div>`)
    .join("");
  host.innerHTML = rows;
  host.setAttribute("aria-busy", "true");
}

function renderErrorNoCache(host, onRetry) {
  host.removeAttribute("aria-busy");
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't load attendees.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

function renderEmptyState(host) {
  host.removeAttribute("aria-busy");
  const el = document.createElement("div");
  el.className = "placeholder-card";
  el.innerHTML = `
    <h2>No attendees yet</h2>
    <p>Attendee list will populate as registrations finalize.</p>
  `;
  host.appendChild(el);
}

function renderEmptySearchState(host, onClear) {
  host.removeAttribute("aria-busy");
  const el = document.createElement("div");
  el.className = "placeholder-card attendees-empty-search";
  el.innerHTML = `
    <h2>No matches</h2>
    <p>No attendees match your search.</p>
    <button type="button" class="btn-secondary" data-clear-search>Clear search</button>
  `;
  el.querySelector("[data-clear-search]").addEventListener("click", onClear);
  host.appendChild(el);
}

/**
 * Render the attendee rows (or the appropriate empty-state) with an
 * optional error strip at the top if the latest poll failed but we still
 * have a cached list to show beneath it.
 */
function renderList(
  host,
  rows,
  { hasError, hasAnyAttendees, isSearching, onRetry, onRowClick, onClearSearch },
) {
  host.innerHTML = "";
  host.removeAttribute("aria-busy");

  if (hasError) {
    const strip = document.createElement("div");
    strip.className = "status-error attendees-error-strip";
    strip.setAttribute("role", "status");
    strip.innerHTML = `
      <span>Couldn't refresh. Showing last-saved attendees.</span>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    `;
    strip.querySelector("[data-retry]").addEventListener("click", onRetry);
    host.appendChild(strip);
  }

  if (!hasAnyAttendees) {
    renderEmptyState(host);
    return;
  }

  if (rows.length === 0 && isSearching) {
    renderEmptySearchState(host, onClearSearch);
    return;
  }

  for (const a of rows) {
    host.appendChild(renderAttendeeRow(a, onRowClick));
  }
}

/**
 * Build a single attendee row as an anchor. The accessible name is the
 * attendee's full name plus (when present) the "company — title" meta
 * line read as a single phrase. The chevron is `aria-hidden` so screen
 * readers do not announce it.
 */
function renderAttendeeRow(attendee, onRowClick) {
  const id = typeof attendee.id === "string" ? attendee.id : "";
  const name = typeof attendee.name === "string" && attendee.name.trim()
    ? attendee.name.trim()
    : "Unnamed attendee";
  const company = typeof attendee.company === "string" ? attendee.company.trim() : "";
  const title = typeof attendee.title === "string" ? attendee.title.trim() : "";

  let metaText = "";
  if (company && title) metaText = `${company} \u2014 ${title}`;
  else if (company) metaText = company;
  else if (title) metaText = title;

  const a = document.createElement("a");
  a.className = "attendee-row";
  a.href = `#/attendees/${encodeURIComponent(id)}`;
  a.setAttribute("aria-label", metaText ? `${name}, ${metaText}` : name);
  // Row click handler flips the "came from list" flag so the detail
  // modal can use history.back() on close. We attach a plain click
  // listener (not navigation prevention) so the anchor's hash change
  // still drives the route.
  a.addEventListener("click", () => {
    if (typeof onRowClick === "function") onRowClick();
  });
  a.innerHTML = `
    <div class="attendee-row__body">
      <span class="attendee-row__name line-clamp-1">${escapeHtml(name)}</span>
      ${metaText ? `<span class="attendee-row__meta line-clamp-1">${escapeHtml(metaText)}</span>` : ""}
    </div>
    <span class="attendee-row__chevron" aria-hidden="true">\u203A</span>
  `;
  return a;
}

/* ---------------- Count label ---------------- */

/**
 * Update the sticky-header count label. `count === null` renders a
 * neutral "Loading attendees" so the aria-live region never flashes a
 * misleading zero before the first poll. `isSearching === true` with
 * zero results shows "No matches" (the matching empty-search card
 * below carries the longer wording).
 */
function updateCount(el, count, isSearching) {
  if (!el) return;
  let text;
  if (count === null) text = "Loading attendees";
  else if (count === 0 && isSearching) text = "No matches";
  else if (count === 0) text = "No attendees yet";
  else if (count === 1) text = "1 attendee";
  else text = `${count} attendees`;
  if (el.textContent !== text) el.textContent = text;
}

/* ---------------- Filtering + sorting ---------------- */

/**
 * Case-insensitive substring match on `name` OR `company`. No fuzzy
 * matching — predictable is better than clever for a directory.
 */
function filterAttendees(list, query) {
  if (!query) return list;
  const q = query.toLowerCase();
  return list.filter((a) => {
    const name = typeof a?.name === "string" ? a.name.toLowerCase() : "";
    const company = typeof a?.company === "string" ? a.company.toLowerCase() : "";
    return name.includes(q) || company.includes(q);
  });
}

/**
 * Sort by `name` ascending (locale-aware), with `company` ascending as
 * the tiebreaker so two attendees with the same name land in a stable
 * order between renders.
 */
function sortAttendees(a, b) {
  const na = typeof a?.name === "string" ? a.name : "";
  const nb = typeof b?.name === "string" ? b.name : "";
  const nameCmp = na.localeCompare(nb, undefined, { sensitivity: "base" });
  if (nameCmp !== 0) return nameCmp;
  const ca = typeof a?.company === "string" ? a.company : "";
  const cb = typeof b?.company === "string" ? b.company : "";
  return ca.localeCompare(cb, undefined, { sensitivity: "base" });
}

/* ---------------- Debounce helper ---------------- */

function debounce(fn, ms) {
  let timer = null;
  return function debounced(...args) {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}

/* ---------------- Escaping ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
