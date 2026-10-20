// views/home.js — attendee Home view (Task 8).
//
// Four stacked sections in a mobile-first vertical column:
//   (a) Welcome card         — reads appSettings/singleton once per render.
//   (b) Happening now strip  — subscribes to the `agenda` collection via
//                              onSnapshot (15s poll) and recomputes current /
//                              next / empty state client-side.
//   (c) Latest announcement  — one-off read of the newest announcement doc,
//                              refreshed on `visibilitychange`.
//   (d) Quick actions row    — three secondary buttons that route to Agenda,
//                              Venue map, and Sponsors.
//
// Cleanup: `renderHome` sets a module-level `__cleanup` function and
// registers it with app.js's view-cleanup hook so routing away stops the
// background agenda poll and removes the visibility listener.
"use strict";

import { initFirestore, getDoc, getCollection, onSnapshot } from "../firebase.js";
import * as router from "../router.js";
import * as ui from "../ui.js";
import { registerViewCleanup } from "../app.js";
import { relativeTime } from "../utils/time.js";

const FALLBACK_EVENT_TITLE = "SCTE Gateway Chapter Vendor Day 2027";

/** Module-level cleanup slot. Set at the end of each renderHome call so the
 *  router's beforeEach hook (via registerViewCleanup in app.js) can tear down
 *  subscriptions when the user navigates away. */
let __cleanup = null;

/**
 * Render the Home view into `host`.
 * @param {HTMLElement} host  typically `#view-root`.
 * @returns {Promise<void>}
 */
export async function renderHome(host) {
  // Re-renders (retry buttons, hot-reload during dev) clear any prior cleanup
  // so we never leave two agenda pollers running against the same view root.
  runCleanup();

  host.innerHTML = "";

  const welcome = buildWelcomeCard();
  const happening = buildHappeningNow();
  const announcement = buildAnnouncementCard();
  const quickActions = buildQuickActions();

  host.append(welcome.el, happening.el, announcement.el, quickActions);

  // If we're already offline when Home mounts, surface the shared banner.
  // The global online/offline listeners in app.js keep it in sync afterwards.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    ui.showOfflineBanner();
  }

  // Prime the Firestore config in parallel with the first paints so the
  // skeletons replace themselves as data lands. initFirestore() caches the
  // promise so this is a no-op if app.js already fired it.
  const configReady = initFirestore().catch((err) => {
    console.warn("[home] /api/config load failed:", err);
    return null;
  });

  welcome.load(configReady);
  announcement.load(configReady);
  happening.start(configReady);

  // On tab regain focus, trigger a one-off refresh so returning attendees
  // see the latest "happening now" and newest announcement without waiting
  // for the next 15-second tick.
  const onVisibility = () => {
    if (document.visibilityState !== "visible") return;
    happening.refresh();
    announcement.load(configReady);
  };
  document.addEventListener("visibilitychange", onVisibility);

  __cleanup = () => {
    happening.stop();
    document.removeEventListener("visibilitychange", onVisibility);
  };
  registerViewCleanup(() => runCleanup());

  document.title = "Home \u2014 Vendor Day 2027";
}

export default renderHome;

function runCleanup() {
  if (!__cleanup) return;
  try {
    __cleanup();
  } catch (err) {
    console.warn("[home] cleanup failed:", err);
  }
  __cleanup = null;
}

/* ---------------- (a) Welcome card ---------------- */

function buildWelcomeCard() {
  const el = document.createElement("section");
  el.className = "card home-welcome-card";
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-label", "Event summary");
  renderWelcomeSkeleton(el);

  async function load(configReady) {
    renderWelcomeSkeleton(el);
    try {
      if (configReady) await configReady;
      const settings = await getDoc("appSettings/singleton");
      renderWelcomeContent(el, settings || {});
    } catch (err) {
      console.warn("[home] appSettings read failed:", err);
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        ui.showOfflineBanner();
      }
      renderWelcomeError(el, () => load(configReady));
    }
  }

  return { el, load };
}

function renderWelcomeSkeleton(host) {
  host.innerHTML = `
    <div class="skeleton-row" style="height: 28px; width: 70%;"></div>
    <div class="skeleton-row" style="width: 85%;"></div>
    <div class="skeleton-row" style="width: 55%;"></div>
    <div class="skeleton-row" style="width: 40%;"></div>
  `;
}

function renderWelcomeContent(host, settings) {
  const title = settings.eventTitle || FALLBACK_EVENT_TITLE;
  const venueLine = [settings.venueName, settings.venueAddress]
    .filter((v) => typeof v === "string" && v.trim())
    .join(", ");
  const hasDate = typeof settings.eventDate === "string" && settings.eventDate.trim();
  const dateText = hasDate ? formatEventDate(settings.eventDate) : null;

  host.innerHTML = `
    <h2 class="home-welcome-card__title">${escapeHtml(title)}</h2>
    ${venueLine ? `<p class="home-welcome-card__venue">${escapeHtml(venueLine)}</p>` : ""}
    ${
      dateText
        ? `<p class="home-welcome-card__date">${escapeHtml(dateText)}</p>`
        : `<p class="home-welcome-card__date text-muted">Date to be announced</p>`
    }
    <p class="home-welcome-card__attribution">Hosted by the SCTE Gateway Chapter Board.</p>
  `;
}

function renderWelcomeError(host, retry) {
  host.innerHTML = `
    <h2 class="home-welcome-card__title">${escapeHtml(FALLBACK_EVENT_TITLE)}</h2>
    <p class="home-welcome-card__error">Couldn't load event details.</p>
    <button type="button" class="btn-secondary" data-retry>Retry</button>
  `;
  host.querySelector("[data-retry]").addEventListener("click", retry);
}

/**
 * Format an ISO 8601 date (date-only or full timestamp) as, e.g.,
 * "Thursday, June 5, 2027". Appends a `T12:00:00` suffix for date-only
 * strings so a timezone west of UTC doesn't bump the display back a day.
 * @param {string} iso
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

/* ---------------- (b) Happening now strip ---------------- */

function buildHappeningNow() {
  const el = document.createElement("section");
  el.className = "home-happening-now";
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-label", "What's happening now");
  renderHappeningSkeleton(el);

  /** @type {object[] | null} */
  let sessions = null;
  /** @type {Error | null} */
  let error = null;
  /** @type {(() => void) | null} */
  let unsub = null;

  function render() {
    if (error) {
      renderHappeningError(el, refresh);
      return;
    }
    if (sessions == null) {
      renderHappeningSkeleton(el);
      return;
    }
    renderHappeningState(el, sessions);
  }

  async function start(configReady) {
    if (configReady) {
      try {
        await configReady;
      } catch (err) {
        // configReady resolves even on failure; this branch is defensive.
      }
    }
    unsub = onSnapshot(
      "agenda",
      (data, err) => {
        if (err) {
          console.warn("[home] agenda poll failed:", err);
          error = err;
          sessions = null;
        } else {
          error = null;
          sessions = Array.isArray(data) ? data : [];
        }
        render();
      },
      { intervalMs: 15000 },
    );
  }

  function stop() {
    if (unsub) {
      unsub();
      unsub = null;
    }
  }

  /** Stop the current subscription and immediately restart; onSnapshot runs
   *  its initial tick synchronously so this gives us a fresh fetch. */
  function refresh() {
    stop();
    sessions = null;
    error = null;
    renderHappeningSkeleton(el);
    start();
  }

  return { el, start, stop, refresh };
}

function renderHappeningSkeleton(host) {
  host.innerHTML = `<div class="skeleton-row" style="height: 20px; width: 70%;"></div>`;
}

function renderHappeningError(host, onRetry) {
  host.innerHTML = `
    <button
      type="button"
      class="home-happening-now__retry"
      data-retry
    >Agenda couldn't load \u2014 tap to retry.</button>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

function renderHappeningState(host, sessions) {
  const now = Date.now();

  const active = sessions.find((s) => {
    const start = Date.parse(s?.startAt);
    const end = Date.parse(s?.endAt);
    return !Number.isNaN(start) && !Number.isNaN(end) && start <= now && now <= end;
  });

  if (active) {
    const room = typeof active.room === "string" && active.room.trim()
      ? ` in ${active.room.trim()}`
      : "";
    host.innerHTML = `
      <p class="home-happening-now__content">
        <span class="home-happening-now__label">Happening now:</span>
        ${escapeHtml(active.title || "Untitled session")}${escapeHtml(room)}
      </p>
    `;
    return;
  }

  const upcoming = sessions
    .filter((s) => {
      const start = Date.parse(s?.startAt);
      return !Number.isNaN(start) && start > now;
    })
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));

  if (upcoming[0]) {
    const next = upcoming[0];
    const timeStr = new Date(next.startAt).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    host.innerHTML = `
      <p class="home-happening-now__content">
        <span class="home-happening-now__label">Starts at ${escapeHtml(timeStr)}:</span>
        ${escapeHtml(next.title || "Untitled session")}
      </p>
    `;
    return;
  }

  host.innerHTML = `
    <p class="home-happening-now__content home-happening-now__empty">
      No sessions scheduled right now.
    </p>
  `;
}

/* ---------------- (c) Latest announcement card ---------------- */

function buildAnnouncementCard() {
  const el = document.createElement("article");
  el.className = "card home-announcement-card";
  el.setAttribute("aria-labelledby", "home-announcement-title");
  renderAnnouncementSkeleton(el);

  async function load(configReady) {
    renderAnnouncementSkeleton(el);
    try {
      if (configReady) await configReady;
      let docs = null;
      try {
        docs = await getCollection("announcements", {
          orderBy: { field: "publishedAt", direction: "desc" },
          limit: 1,
        });
      } catch (err) {
        // Firestore orderBy on a single field doesn't need a composite index,
        // but we fall back to a client-side sort if anything about the
        // runQuery path hiccups (missing field, index not warmed, etc.).
        console.warn("[home] announcements orderBy failed; falling back to client sort:", err);
        const all = await getCollection("announcements");
        docs = (all || [])
          .slice()
          .sort((a, b) => (Date.parse(b?.publishedAt) || 0) - (Date.parse(a?.publishedAt) || 0))
          .slice(0, 1);
      }
      const latest = Array.isArray(docs) && docs[0] ? docs[0] : null;
      if (!latest) {
        renderAnnouncementEmpty(el);
      } else {
        renderAnnouncementContent(el, latest);
      }
    } catch (err) {
      console.warn("[home] announcements read failed:", err);
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        ui.showOfflineBanner();
      }
      renderAnnouncementError(el, () => load(configReady));
    }
  }

  return { el, load };
}

function renderAnnouncementSkeleton(host) {
  host.innerHTML = `
    <div class="skeleton-row" style="height: 22px; width: 55%;"></div>
    <div class="skeleton-row" style="width: 95%;"></div>
    <div class="skeleton-row" style="width: 85%;"></div>
    <div class="skeleton-row" style="width: 35%;"></div>
  `;
}

function renderAnnouncementEmpty(host) {
  host.innerHTML = `
    <header><h2 id="home-announcement-title" class="home-announcement-card__title">Latest announcement</h2></header>
    <p class="home-announcement-card__empty">No announcements yet.</p>
  `;
}

function renderAnnouncementContent(host, announcement) {
  const title = announcement.title || "Announcement";
  const body = typeof announcement.body === "string" ? announcement.body : "";
  const timeStr = relativeTime(announcement.publishedAt);
  host.innerHTML = `
    <header><h2 id="home-announcement-title" class="home-announcement-card__title">${escapeHtml(title)}</h2></header>
    <p class="home-announcement-card__body line-clamp-2">${escapeHtml(body)}</p>
    <div class="home-announcement-card__meta">
      <span class="home-announcement-card__byline">Gateway Chapter Board</span>
      ${timeStr ? `<span class="relative-time" aria-label="Posted ${escapeHtml(timeStr)}">${escapeHtml(timeStr)}</span>` : ""}
    </div>
  `;
}

function renderAnnouncementError(host, retry) {
  host.innerHTML = `
    <header><h2 id="home-announcement-title" class="home-announcement-card__title">Latest announcement</h2></header>
    <p class="home-announcement-card__error">Couldn't load the latest announcement.</p>
    <button type="button" class="home-announcement-card__retry" data-retry>Retry</button>
  `;
  host.querySelector("[data-retry]").addEventListener("click", retry);
}

/* ---------------- (d) Quick actions row ---------------- */

function buildQuickActions() {
  const el = document.createElement("nav");
  el.className = "home-quick-actions";
  el.setAttribute("aria-label", "Quick actions");
  el.innerHTML = `
    <button type="button" class="btn-secondary" data-target="#/agenda">Agenda</button>
    <button type="button" class="btn-secondary" data-target="#/map">Venue map</button>
    <button type="button" class="btn-secondary" data-target="#/sponsors">Sponsors</button>
  `;
  el.querySelectorAll("[data-target]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-target");
      if (target) router.navigate(target);
    });
  });
  return el;
}

/* ---------------- helpers ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
