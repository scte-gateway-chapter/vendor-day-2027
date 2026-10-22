// dashboard.js — admin Dashboard view (Task 17).
//
// Three stacked sections inside #admin-view-root:
//   (a) Health strip — compact pills for Firestore + OneSignal reachability.
//                      Polls /api/send-push?healthcheck=1 every 60s (admin-
//                      authenticated GET). Rate-limited and network-error
//                      paths render dedicated messages per the task spec;
//                      session-expired is handled by the fetch wrapper.
//   (b) Content-area cards — one card per writable area (Agenda, Sponsors,
//                      Venue Map, Announcements, Attendees, Feedback,
//                      Recap). Each card renders a status line and the
//                      shared `formatLastEditedPhrase(doc)` meta line.
//                      Fetched once on mount, then on visibilitychange
//                      and every 30s. Per-card retry on error.
//   (c) Recent push sends — last 10 announcements with pushSent === true,
//                      sorted by pushSentAt desc. Shared 30s refresh with
//                      the cards.
//
// All content reads go through the attendee Firestore client (every doc
// the dashboard needs is publicly readable per firestore.rules). The one
// admin-authed call is the health check against /api/send-push.
"use strict";

import { initFirestore, getDoc, getCollection } from "/js/firebase.js";
import { adminFetch } from "./admin-fetch.js";
import { registerAdminViewCleanup } from "./admin.js";
import { relativeTime } from "/js/utils/time.js";
import { formatLastEditedPhrase } from "./collision-check.js";

const HEALTH_INTERVAL_MS = 60_000;
const CARD_INTERVAL_MS = 30_000;
const RECENT_PUSH_LIMIT = 10;

/**
 * Mount the admin dashboard into `host` (typically #admin-view-root).
 * Returns a Promise that resolves once the first paint has mounted;
 * polling continues in the background until the view-cleanup hook fires.
 * @param {HTMLElement} host
 * @returns {Promise<void>}
 */
export default async function renderAdminDashboard(host) {
  host.innerHTML = "";

  const container = document.createElement("section");
  container.className = "admin-dashboard";
  container.setAttribute("aria-label", "Admin dashboard");
  host.appendChild(container);

  const health = buildHealthStrip();
  const cards = buildCardsSection();
  const recent = buildRecentPushesSection();
  container.append(health.el, cards.el, recent.el);

  // Prime /api/config so the Firestore client can read collections. The
  // promise is cached inside firebase.js so this is a no-op if the admin
  // shell has already warmed it earlier.
  const configReady = initFirestore().catch((err) => {
    console.warn("[admin-dashboard] /api/config load failed:", err);
    return null;
  });

  health.start();
  cards.start(configReady);
  recent.start(configReady);

  // On tab regain focus, trigger a one-off refresh so returning admins
  // see fresh data without waiting for the next 30s tick. Health keeps
  // its own 60s cadence (and already runs on an immediate first tick).
  const onVisibility = () => {
    if (document.visibilityState !== "visible") return;
    cards.refreshAll();
    recent.refresh();
  };
  document.addEventListener("visibilitychange", onVisibility);

  registerAdminViewCleanup(() => {
    health.stop();
    cards.stop();
    recent.stop();
    document.removeEventListener("visibilitychange", onVisibility);
  });

  document.title = "Admin \u2014 Dashboard \u2014 Vendor Day 2027";
}

/* ---------------- Health strip ---------------- */

function buildHealthStrip() {
  const el = document.createElement("section");
  el.className = "admin-health-strip";
  el.setAttribute("aria-label", "System health");
  el.innerHTML = `
    <span class="admin-health-pill admin-health-pill--pending" data-pill="firestore">
      <span class="admin-health-pill__dot" aria-hidden="true"></span>
      <span class="admin-health-pill__label">Firestore: checking\u2026</span>
    </span>
    <span class="admin-health-pill admin-health-pill--pending" data-pill="onesignal">
      <span class="admin-health-pill__dot" aria-hidden="true"></span>
      <span class="admin-health-pill__label">OneSignal: checking\u2026</span>
    </span>
  `;

  let timer = null;
  let stopped = false;

  function setPill(name, state, label) {
    const pill = el.querySelector(`[data-pill="${name}"]`);
    if (!pill) return;
    pill.classList.remove(
      "admin-health-pill--ok",
      "admin-health-pill--fail",
      "admin-health-pill--pending",
    );
    pill.classList.add(`admin-health-pill--${state}`);
    const lbl = pill.querySelector(".admin-health-pill__label");
    if (lbl) lbl.textContent = label;
  }

  async function tick() {
    if (stopped) return;
    try {
      const data = await adminFetch("/api/send-push?healthcheck=1", { method: "GET" });
      const firestoreOk = data?.firestore === "ok";
      const onesignalOk = data?.onesignal === "ok";
      setPill(
        "firestore",
        firestoreOk ? "ok" : "fail",
        firestoreOk ? "Firestore reachable" : "Firestore unreachable",
      );
      setPill(
        "onesignal",
        onesignalOk ? "ok" : "fail",
        onesignalOk ? "OneSignal reachable" : "OneSignal unreachable",
      );
      scheduleNext(HEALTH_INTERVAL_MS);
      return;
    } catch (err) {
      if (err?.code === "session-expired") {
        // Fetch wrapper is already redirecting; nothing more to do.
        return;
      }
      if (err?.code === "rate-limited") {
        const sec = Math.max(1, Number(err.retryAfterSec) || 60);
        const label = `Health check rate-limited (retry in ${sec}s).`;
        setPill("firestore", "pending", label);
        setPill("onesignal", "pending", label);
        scheduleNext(sec * 1000);
        return;
      }
      if (err?.code === "network-error") {
        setPill("firestore", "fail", "Firestore: no connection");
        setPill("onesignal", "fail", "OneSignal: no connection");
      } else {
        // http-error, no-session, or anything else — surface a plain
        // "unreachable" state. no-session shouldn't happen on the
        // dashboard (we gated the route on isAdminAuthenticated), but
        // staying defensive keeps a stale JWT from blanking the strip.
        setPill("firestore", "fail", "Firestore unreachable");
        setPill("onesignal", "fail", "OneSignal unreachable");
      }
      scheduleNext(HEALTH_INTERVAL_MS);
    }
  }

  function scheduleNext(ms) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
  }

  function start() {
    stopped = false;
    tick();
  }
  function stop() {
    stopped = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { el, start, stop };
}

/* ---------------- Content-area cards ---------------- */

const CARD_SPECS = [
  { id: "agenda", title: "Agenda", href: "#/agenda", fetch: fetchAgendaSummary },
  { id: "sponsors", title: "Sponsors", href: "#/sponsors", fetch: fetchSponsorsSummary },
  { id: "map", title: "Venue Map", href: "#/map", fetch: fetchVenueMapSummary },
  { id: "announcements", title: "Announcements", href: "#/announcements", fetch: fetchAnnouncementsSummary },
  { id: "attendees", title: "Attendees", href: "#/attendees", fetch: fetchAttendeesSummary },
  { id: "feedback", title: "Feedback", href: "#/feedback", fetch: fetchFeedbackSummary },
  { id: "recap", title: "Recap", href: "#/recap", fetch: fetchRecapSummary },
];

function buildCardsSection() {
  const el = document.createElement("section");
  el.className = "admin-cards-grid";
  el.setAttribute("aria-label", "Content areas");

  const cards = CARD_SPECS.map((spec) => {
    const card = createCard(spec);
    el.appendChild(card.el);
    return card;
  });

  function start(configReady) {
    for (const c of cards) c.start(configReady);
  }
  function stop() {
    for (const c of cards) c.stop();
  }
  function refreshAll() {
    for (const c of cards) c.refresh();
  }

  return { el, start, stop, refreshAll };
}

function createCard(spec) {
  const el = document.createElement("article");
  el.className = "admin-card admin-card--loading";
  renderCardSkeleton(el, spec);

  let timer = null;
  let stopped = false;
  let configReady = null;

  async function load() {
    try {
      if (configReady) await configReady;
      const { statusText, metaDoc } = await spec.fetch();
      renderCardLoaded(el, spec, { statusText, metaDoc });
    } catch (err) {
      console.warn(`[admin-dashboard] ${spec.id} card load failed:`, err);
      renderCardError(el, spec, load);
    }
  }

  async function tick() {
    if (stopped) return;
    await load();
    if (stopped) return;
    timer = setTimeout(tick, CARD_INTERVAL_MS);
  }

  function start(configReadyPromise) {
    configReady = configReadyPromise;
    stopped = false;
    tick();
  }
  function stop() {
    stopped = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }
  async function refresh() {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    await load();
    if (!stopped) timer = setTimeout(tick, CARD_INTERVAL_MS);
  }

  return { el, start, stop, refresh };
}

function renderCardSkeleton(el, spec) {
  el.classList.remove("admin-card--error", "admin-card--loaded");
  el.classList.add("admin-card--loading");
  el.innerHTML = `
    <h3 class="admin-card__title">${escapeHtml(spec.title)}</h3>
    <div class="skeleton-row" style="width: 70%;"></div>
    <div class="skeleton-row" style="width: 45%;"></div>
    <span class="btn-secondary admin-card__action" aria-hidden="true">Edit\u2026</span>
  `;
}

function renderCardLoaded(el, spec, { statusText, metaDoc }) {
  el.classList.remove("admin-card--loading", "admin-card--error");
  el.classList.add("admin-card--loaded");
  const meta = formatLastEditedPhrase(metaDoc);
  const titleId = `admin-card-${spec.id}-title`;
  el.innerHTML = `
    <a class="admin-card__link" href="${escapeAttr(spec.href)}" aria-labelledby="${titleId}">
      <h3 class="admin-card__title" id="${titleId}">${escapeHtml(spec.title)}</h3>
      <p class="admin-card__status">${escapeHtml(statusText)}</p>
      <p class="admin-card__meta">${escapeHtml(meta)}</p>
      <span class="btn-secondary admin-card__action" aria-hidden="true">Edit\u2026</span>
    </a>
  `;
}

function renderCardError(el, spec, retry) {
  el.classList.remove("admin-card--loading", "admin-card--loaded");
  el.classList.add("admin-card--error");
  el.innerHTML = `
    <h3 class="admin-card__title">${escapeHtml(spec.title)}</h3>
    <p class="admin-card__status">Could not load \u2014 retry.</p>
    <button type="button" class="btn-secondary admin-card__retry" data-retry>Retry</button>
  `;
  el.querySelector("[data-retry]").addEventListener("click", retry);
}

/* ---------------- Card fetchers ---------------- */

async function fetchAgendaSummary() {
  const docs = await getCollection("agenda");
  return summarizeCollection(docs, {
    singular: "session",
    plural: "sessions",
    emptyText: "No sessions yet",
  });
}

async function fetchSponsorsSummary() {
  const docs = await getCollection("sponsors");
  return summarizeCollection(docs, {
    singular: "sponsor",
    plural: "sponsors",
    emptyText: "No sponsors yet",
  });
}

async function fetchVenueMapSummary() {
  const doc = await getDoc("appSettings/singleton");
  const hasMap = typeof doc?.venueMapUrl === "string" && doc.venueMapUrl.trim().length > 0;
  const statusText = hasMap ? "Map image uploaded" : "Map image not uploaded";
  return { statusText, metaDoc: doc };
}

async function fetchAnnouncementsSummary() {
  const docs = await getCollection("announcements");
  const list = Array.isArray(docs) ? docs : [];
  const pushedCount = list.filter((d) => d?.pushSent === true).length;
  let statusText;
  if (list.length === 0) {
    statusText = "No announcements yet";
  } else {
    const total = `${list.length} announcement${list.length === 1 ? "" : "s"}`;
    statusText = pushedCount > 0 ? `${total}, ${pushedCount} pushed` : total;
  }
  return { statusText, metaDoc: findLatestByUpdatedAt(list) };
}

async function fetchAttendeesSummary() {
  // Firestore rules require clients to filter attendees by `optedOut == false`
  // on list queries (see firestore.rules). The dashboard count therefore
  // mirrors the attendee-facing directory, which is the useful number for
  // "how many names are visible to attendees right now".
  const docs = await getCollection("attendees", {
    where: { field: "optedOut", op: "==", value: false },
  });
  const list = Array.isArray(docs) ? docs : [];
  const statusText = list.length === 0
    ? "No attendees imported yet"
    : `${list.length} attendee${list.length === 1 ? "" : "s"} listed`;
  return { statusText, metaDoc: findLatestAttendee(list) };
}

async function fetchFeedbackSummary() {
  const doc = await getDoc("feedbackConfig/singleton");
  const active = doc?.active === true;
  const statusText = active ? "Feedback form active" : "Feedback form inactive";
  return { statusText, metaDoc: doc };
}

async function fetchRecapSummary() {
  const doc = await getDoc("recap/singleton");
  const published = doc?.published === true;
  const statusText = published ? "Recap published" : "Recap not published";
  return { statusText, metaDoc: doc };
}

/**
 * Compute the status line + the doc whose `updatedAt` wins for the
 * "updated X ago by Y" meta line.
 * @param {object[]|null|undefined} docs
 * @param {{ singular: string, plural: string, emptyText: string }} opts
 */
function summarizeCollection(docs, { singular, plural, emptyText }) {
  const list = Array.isArray(docs) ? docs : [];
  const statusText = list.length === 0
    ? emptyText
    : `${list.length} ${list.length === 1 ? singular : plural}`;
  return { statusText, metaDoc: findLatestByUpdatedAt(list) };
}

/** Return the doc with the greatest parseable `updatedAt`, or null. */
function findLatestByUpdatedAt(docs) {
  let best = null;
  let bestMs = -Infinity;
  for (const d of docs || []) {
    const t = Date.parse(d?.updatedAt);
    if (!Number.isNaN(t) && t > bestMs) {
      best = d;
      bestMs = t;
    }
  }
  return best;
}

/**
 * Attendees carry `importedAt` (CSV import stamp) and may also carry
 * `updatedAt` (per-row admin edit from Task 22). Treat whichever is
 * most recent as the attendee's effective updatedAt so the dashboard
 * meta line surfaces the last touch regardless of path. The returned
 * synthetic doc only exists to feed `formatLastEditedPhrase`.
 */
function findLatestAttendee(docs) {
  let bestDoc = null;
  let bestMs = -Infinity;
  for (const d of docs || []) {
    const u = Date.parse(d?.updatedAt);
    const i = Date.parse(d?.importedAt);
    const t = Math.max(
      Number.isNaN(u) ? -Infinity : u,
      Number.isNaN(i) ? -Infinity : i,
    );
    if (Number.isFinite(t) && t > bestMs) {
      bestDoc = d;
      bestMs = t;
    }
  }
  if (!bestDoc) return null;
  return {
    updatedAt: new Date(bestMs).toISOString(),
    updatedBy: typeof bestDoc.updatedBy === "string" && bestDoc.updatedBy.trim()
      ? bestDoc.updatedBy
      : "admin",
  };
}

/* ---------------- Recent push sends ---------------- */

function buildRecentPushesSection() {
  const el = document.createElement("section");
  el.className = "admin-recent-pushes";
  el.setAttribute("aria-label", "Recent push sends");
  el.innerHTML = `
    <h3 class="admin-recent-pushes__title">Recent push sends</h3>
    <div class="admin-recent-pushes__body" data-content></div>
  `;

  const content = el.querySelector("[data-content]");
  renderPushesSkeleton(content);

  let timer = null;
  let stopped = false;
  let configReady = null;

  async function load() {
    try {
      if (configReady) await configReady;
      // Fetch the whole collection and filter + sort client-side rather
      // than issuing a where + orderBy on different fields (which would
      // need a composite index). Announcements volume is in the tens
      // for a one-day event, so the extra bytes are not a concern.
      const docs = await getCollection("announcements");
      const list = Array.isArray(docs) ? docs : [];
      const pushed = list
        .filter((d) => d?.pushSent === true && typeof d?.pushSentAt === "string")
        .sort((a, b) => (Date.parse(b.pushSentAt) || 0) - (Date.parse(a.pushSentAt) || 0))
        .slice(0, RECENT_PUSH_LIMIT);
      renderPushesList(content, pushed);
    } catch (err) {
      console.warn("[admin-dashboard] recent pushes load failed:", err);
      renderPushesError(content, load);
    }
  }

  async function tick() {
    if (stopped) return;
    await load();
    if (stopped) return;
    timer = setTimeout(tick, CARD_INTERVAL_MS);
  }

  function start(configReadyPromise) {
    configReady = configReadyPromise;
    stopped = false;
    tick();
  }
  function stop() {
    stopped = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }
  async function refresh() {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    await load();
    if (!stopped) timer = setTimeout(tick, CARD_INTERVAL_MS);
  }

  return { el, start, stop, refresh };
}

function renderPushesSkeleton(host) {
  host.innerHTML = `
    <div class="skeleton-row" style="height: 20px; width: 92%;"></div>
    <div class="skeleton-row" style="height: 20px; width: 85%;"></div>
    <div class="skeleton-row" style="height: 20px; width: 88%;"></div>
  `;
}

function renderPushesList(host, items) {
  if (!items.length) {
    host.innerHTML = `<p class="admin-recent-pushes__empty">No push notifications sent yet.</p>`;
    return;
  }
  host.innerHTML = items
    .map((d) => {
      const title = typeof d?.title === "string" && d.title.trim()
        ? d.title.trim()
        : "Announcement";
      const timeIso = typeof d?.pushSentAt === "string" ? d.pushSentAt : "";
      const timeStr = relativeTime(timeIso) || timeIso || "";
      const timeNode = timeIso
        ? `<time class="admin-recent-push-row__time" datetime="${escapeAttr(timeIso)}">${escapeHtml(timeStr)}</time>`
        : "";
      return `
        <article class="admin-recent-push-row">
          <div class="admin-recent-push-row__body">
            <p class="admin-recent-push-row__title">${escapeHtml(title)}</p>
            <p class="admin-recent-push-row__byline">Gateway Chapter Board</p>
          </div>
          ${timeNode}
        </article>
      `;
    })
    .join("");
}

function renderPushesError(host, retry) {
  host.innerHTML = `
    <div class="status-error admin-recent-pushes__error" role="alert">
      <span>Could not load recent push sends.</span>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", retry);
}

/* ---------------- Escapers ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function escapeAttr(s) {
  return escapeHtml(s);
}
