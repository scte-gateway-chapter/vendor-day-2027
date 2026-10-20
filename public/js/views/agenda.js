// views/agenda.js — attendee Agenda list view (Task 9).
//
// Subscribes to the `agenda` collection via a 15-second poll (see
// firebase.js onSnapshot) and renders sessions grouped by their starting
// time slot. Each session row is an <a href="#/agenda/<id>"> so right-click
// / middle-click behave naturally. The "Happening now" badge recomputes on
// every poll and on `document.visibilitychange` so a session that just
// crossed its start boundary flips without a reload.
//
// Cleanup follows the Task 8 pattern: a module-level __cleanup slot stops
// the agenda poll and removes the visibility listener. The router's
// beforeEach hook (via registerViewCleanup in app.js) drains it before
// mounting the next view.
"use strict";

import { initFirestore, getDoc, onSnapshot } from "../firebase.js";
import * as ui from "../ui.js";
import { registerViewCleanup } from "../app.js";

/** Module-level cleanup slot. Set at the end of each renderAgenda call. */
let __cleanup = null;

/**
 * Render the Agenda list view into `host`.
 * @param {HTMLElement} host  typically `#view-root`.
 * @returns {Promise<void>}
 */
export async function renderAgenda(host) {
  // Drain any prior render's handles so retries don't leave two pollers
  // running against the same view root.
  runCleanup();

  host.innerHTML = "";

  const sticky = buildStickyHeader();
  const listSection = document.createElement("section");
  listSection.className = "agenda-list";
  listSection.setAttribute("aria-live", "polite");
  listSection.setAttribute("aria-label", "Agenda sessions");

  host.append(sticky.el, listSection);

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    ui.showOfflineBanner();
  }

  // /api/config is cached on the Firestore client so this is a no-op after
  // the first bootstrap. We still await it before the first poll so the
  // initial fetch doesn't race the config load.
  const configReady = initFirestore().catch((err) => {
    console.warn("[agenda] /api/config load failed:", err);
    return null;
  });

  sticky.load(configReady);

  // State: cachedSessions is the last successful snapshot (null during
  // the first load); lastErr is the most recent error (null when a poll
  // succeeded). Both drive what rerender() paints.
  /** @type {object[] | null} */
  let cachedSessions = null;
  /** @type {Error | null} */
  let lastErr = null;
  let sawFirstResult = false;

  renderSkeleton(listSection);

  function rerender() {
    if (lastErr && !cachedSessions) {
      renderErrorNoCache(listSection, () => restartSubscription());
      return;
    }
    if (!sawFirstResult) {
      renderSkeleton(listSection);
      return;
    }
    renderSessionList(listSection, cachedSessions || [], {
      hasError: Boolean(lastErr),
      onRetry: () => restartSubscription(),
    });
  }

  /** @type {(() => void) | null} */
  let unsub = null;
  // Fire the "could not load" toast only once per subscription lifetime so a
  // flaky connection doesn't stack a toast on every 15-second tick.
  let errorToasted = false;
  async function startSubscription() {
    try { await configReady; } catch (_err) { /* non-fatal */ }
    unsub = onSnapshot(
      "agenda",
      (data, err) => {
        if (err) {
          console.warn("[agenda] poll failed:", err);
          lastErr = err;
          if (typeof navigator !== "undefined" && navigator.onLine === false) {
            ui.showOfflineBanner();
          } else if (!cachedSessions && !errorToasted) {
            ui.toast("error", "Couldn't load the agenda. Tap Retry to try again.");
            errorToasted = true;
          }
        } else {
          lastErr = null;
          errorToasted = false;
          const sessions = Array.isArray(data) ? data.slice().sort(sortSessions) : [];
          cachedSessions = sessions;
        }
        sawFirstResult = true;
        rerender();
      },
      { intervalMs: 15000 },
    );
  }

  function restartSubscription() {
    if (unsub) { unsub(); unsub = null; }
    lastErr = null;
    cachedSessions = null;
    sawFirstResult = false;
    errorToasted = false;
    renderSkeleton(listSection);
    startSubscription();
  }

  startSubscription();

  // Re-render on tab focus so a session that crossed its start/end boundary
  // while we were backgrounded flips its "Happening now" badge without a
  // fresh fetch. The next poll (<=15s away) will refresh content.
  const onVisibility = () => {
    if (document.visibilityState !== "visible") return;
    rerender();
  };
  document.addEventListener("visibilitychange", onVisibility);

  __cleanup = () => {
    if (unsub) { unsub(); unsub = null; }
    document.removeEventListener("visibilitychange", onVisibility);
  };
  registerViewCleanup(() => runCleanup());

  document.title = "Agenda \u2014 Vendor Day 2027";
}

export default renderAgenda;

function runCleanup() {
  if (!__cleanup) return;
  try {
    __cleanup();
  } catch (err) {
    console.warn("[agenda] cleanup failed:", err);
  }
  __cleanup = null;
}

/* ---------------- Sticky secondary header ---------------- */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "agenda-sticky-header";
  el.setAttribute("role", "banner");
  el.innerHTML = `<h2 class="agenda-sticky-header__title">Agenda</h2>`;

  async function load(configReady) {
    try {
      if (configReady) await configReady;
      const settings = await getDoc("appSettings/singleton");
      const dateText = settings && typeof settings.eventDate === "string" && settings.eventDate.trim()
        ? formatEventDate(settings.eventDate)
        : null;
      if (dateText) {
        el.innerHTML = `
          <h2 class="agenda-sticky-header__title">
            Agenda <span class="agenda-sticky-header__date">\u2014 ${escapeHtml(dateText)}</span>
          </h2>
        `;
      }
    } catch (err) {
      // Non-fatal: leave the bare "Agenda" title visible.
      console.warn("[agenda] appSettings read failed:", err);
    }
  }

  return { el, load };
}

/* ---------------- Rendering states ---------------- */

function renderSkeleton(host) {
  // 4 shimmer rows per spec; each row is a card-height block to match the
  // real session card footprint so the list doesn't jump on first paint.
  host.innerHTML = `
    <div class="agenda-group" aria-hidden="true">
      <div class="skeleton-row agenda-group-label-skeleton" style="height: 20px; width: 40%;"></div>
      <div class="skeleton-card"></div>
      <div class="skeleton-card"></div>
    </div>
    <div class="agenda-group" aria-hidden="true">
      <div class="skeleton-row agenda-group-label-skeleton" style="height: 20px; width: 40%;"></div>
      <div class="skeleton-card"></div>
      <div class="skeleton-card"></div>
    </div>
  `;
}

function renderErrorNoCache(host, onRetry) {
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't load the agenda.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

function renderEmptyState(host) {
  const el = document.createElement("div");
  el.className = "placeholder-card";
  el.innerHTML = `
    <h2>Agenda coming soon</h2>
    <p>Check back closer to the event.</p>
  `;
  host.appendChild(el);
}

/**
 * Render the full session list (or empty state) with an optional stale/error
 * strip at the top if the latest poll failed but we have a cached list to
 * show beneath it.
 */
function renderSessionList(host, sessions, { hasError, onRetry }) {
  host.innerHTML = "";

  if (hasError) {
    const strip = document.createElement("div");
    strip.className = "status-error agenda-error-strip";
    strip.setAttribute("role", "status");
    strip.innerHTML = `
      <span>Couldn't refresh. Showing last-saved agenda.</span>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    `;
    strip.querySelector("[data-retry]").addEventListener("click", onRetry);
    host.appendChild(strip);
  }

  if (!sessions || sessions.length === 0) {
    renderEmptyState(host);
    return;
  }

  const groups = groupByStart(sessions);
  for (const group of groups) {
    host.appendChild(renderGroup(group));
  }
}

function renderGroup(sessions) {
  const first = sessions[0];
  const label = formatTimeRange(first.startAt, first.endAt);

  const section = document.createElement("section");
  section.className = "agenda-group";

  const h3 = document.createElement("h3");
  h3.className = "agenda-group-label";
  h3.textContent = label || "Time to be announced";
  section.appendChild(h3);

  const now = Date.now();
  for (const s of sessions) {
    section.appendChild(renderSessionCard(s, now));
  }
  return section;
}

/**
 * Build a session card as an anchor. Right/middle-click behavior comes from
 * the anchor href; the hash router handles the plain left-click too so no
 * explicit click handler is needed.
 */
function renderSessionCard(session, now) {
  const start = Date.parse(session.startAt);
  const end = Date.parse(session.endAt);
  const isActive =
    !Number.isNaN(start) &&
    !Number.isNaN(end) &&
    start <= now &&
    now <= end;

  const id = typeof session.id === "string" ? session.id : "";
  const title = session.title || "Untitled session";
  const speaker =
    session.speaker && typeof session.speaker === "object" && typeof session.speaker.name === "string"
      ? session.speaker.name.trim()
      : "";
  const room = typeof session.room === "string" ? session.room.trim() : "";

  const a = document.createElement("a");
  a.className = "agenda-session-card";
  a.href = `#/agenda/${encodeURIComponent(id)}`;
  a.setAttribute("aria-label", title);
  a.innerHTML = `
    ${isActive ? `<span class="agenda-happening-now-badge">Happening now</span>` : ""}
    <div class="agenda-session-card__body">
      <h4 class="agenda-session-title line-clamp-1">${escapeHtml(title)}</h4>
      ${speaker ? `<p class="agenda-session-meta">${escapeHtml(speaker)}</p>` : ""}
      ${room ? `<p class="agenda-session-meta">${escapeHtml(room)}</p>` : ""}
    </div>
    <span class="agenda-chevron" aria-hidden="true">\u203A</span>
  `;
  return a;
}

/* ---------------- Grouping + sorting ---------------- */

/**
 * Primary sort by startAt ascending. Ties fall through to endAt ascending so
 * two sessions with the same start render in a stable order inside a group,
 * then to `order` as the last-resort tiebreaker.
 */
function sortSessions(a, b) {
  const sa = Date.parse(a?.startAt);
  const sb = Date.parse(b?.startAt);
  const saN = Number.isNaN(sa) ? Infinity : sa;
  const sbN = Number.isNaN(sb) ? Infinity : sb;
  if (saN !== sbN) return saN - sbN;
  const ea = Date.parse(a?.endAt);
  const eb = Date.parse(b?.endAt);
  const eaN = Number.isNaN(ea) ? Infinity : ea;
  const ebN = Number.isNaN(eb) ? Infinity : eb;
  if (eaN !== ebN) return eaN - ebN;
  const oa = Number(a?.order) || 0;
  const ob = Number(b?.order) || 0;
  return oa - ob;
}

/**
 * Group sessions by their startAt. Sessions sharing a startAt land in the
 * same group (so two sessions that start at the same moment share a slot
 * label), ordered within the group by the sort above (endAt asc, then
 * `order` asc).
 */
function groupByStart(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const key = typeof s?.startAt === "string" ? s.startAt : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return Array.from(groups.values());
}

/* ---------------- Formatters ---------------- */

/**
 * Format a start/end ISO pair as `9:00 AM \u2013 10:00 AM` using the browser
 * locale. Returns an empty string if either side fails to parse.
 */
function formatTimeRange(startIso, endIso) {
  const start = formatTime(startIso);
  const end = formatTime(endIso);
  if (!start || !end) return "";
  return `${start} \u2013 ${end}`;
}

function formatTime(iso) {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Format an ISO 8601 date (date-only or full timestamp) as, e.g.,
 * "Thursday, June 5, 2027". Appends a `T12:00:00` suffix for date-only
 * strings so a timezone west of UTC doesn't bump the display back a day.
 */
function formatEventDate(iso) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = new Date(dateOnly ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
