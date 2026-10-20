// views/announcements.js — attendee Announcements feed view (Task 12).
//
// Subscribes to the `announcements` collection via the 15-second poll from
// firebase.js and renders cards in reverse chronological order. Each card
// pipes its `body` through markdown-mini (which escapes HTML and then
// applies a safe markdown subset) so author-formatted bodies render as
// paragraphs, bold / italic, links, and lists without ever executing a
// `<script>` tag.
//
// The deferred push opt-in card from Requirement 2.1 lives at the top on
// first visit: shown only when the user has not yet made a decision and
// the browser is in a state we can prompt from. iOS Safari pre-install
// renders a different variant that routes to the About & Install page
// instead of prompting (push on iOS requires the installed PWA). After
// any decision (grant, deny, dismiss, iOS install card seen) the result
// is written to localStorage so the card does not re-render.
//
// A separate "notifications are off" banner shows every visit when the
// state is "denied" (browsers block re-prompts after denial).
//
// Unread badge: we track `vendorday2027.announcements.lastViewedAt` in
// localStorage and surface the count on the More tab via ui.updateBadge.
// Opening the view bumps the last-viewed timestamp to `now`, which
// zeroes the badge for the next visit.
//
// This view is also the push-tap landing page: #/announcements/<id>
// scrolls the matching card into view with a brief highlight. A stale
// deep link whose id is no longer present renders the feed normally
// plus an info toast.
//
// OneSignal integration is a Task 12 stub (public/js/onesignal.js);
// Task 25 will replace the stub with the real SDK flow.
"use strict";

import { initFirestore, onSnapshot } from "../firebase.js";
import * as ui from "../ui.js";
import { registerViewCleanup } from "../app.js";
import { renderMarkdown } from "../markdown-mini.js";
import {
  getSubscriptionState,
  requestPermissionAndSubscribe,
} from "../onesignal.js";

const DECISION_KEY = "vendorday2027.push.decision";
const LAST_VIEWED_KEY = "vendorday2027.announcements.lastViewedAt";
const DEFAULT_LAST_VIEWED = "1970-01-01T00:00:00Z";
const HIGHLIGHT_DURATION_MS = 2000;

/** Module-level cleanup slot. Set at the end of each render call. */
let __cleanup = null;

/**
 * Render the Announcements feed into `host`.
 * @param {HTMLElement} host  typically `#view-root`.
 * @param {{ highlightId?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function renderAnnouncements(host, opts = {}) {
  const highlightId = opts && typeof opts.highlightId === "string" ? opts.highlightId : "";

  // Drain prior render handles so retries don't leave two pollers running.
  runCleanup();

  host.innerHTML = "";

  const sticky = buildStickyHeader();
  const optInSlot = document.createElement("div");
  optInSlot.className = "announcements-opt-in-slot";
  const deniedSlot = document.createElement("div");
  deniedSlot.className = "announcements-denied-slot";
  const listSection = document.createElement("section");
  listSection.className = "announcements-list";
  listSection.setAttribute("aria-live", "polite");
  listSection.setAttribute("aria-label", "Announcements");

  host.append(sticky, optInSlot, deniedSlot, listSection);

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    ui.showOfflineBanner();
  }

  // Compute the pre-render lastViewedAt so this render can count unread
  // against it. We bump it to `now` on every render below so the next
  // render shows zero unread.
  const priorLastViewed = readLastViewed();

  // Opt-in card renders in parallel with the first fetch so the user can
  // decide while the feed is still loading. Any decision rerenders the
  // slot to reflect the next state (e.g., hide after grant/deny/dismiss).
  renderOptInSlot(optInSlot, deniedSlot).catch((err) => {
    console.warn("[announcements] opt-in render failed:", err);
  });

  // Prime Firestore config; onSnapshot waits for it on the first tick.
  const configReady = initFirestore().catch((err) => {
    console.warn("[announcements] /api/config load failed:", err);
    return null;
  });

  /** @type {object[] | null} */
  let cachedList = null;
  /** @type {Error | null} */
  let lastErr = null;
  let sawFirstResult = false;
  let staleHighlightToasted = false;

  renderSkeleton(listSection);

  function rerender() {
    if (lastErr && !cachedList) {
      renderErrorNoCache(listSection, () => restartSubscription());
      return;
    }
    if (!sawFirstResult) {
      renderSkeleton(listSection);
      return;
    }
    renderFeed(listSection, cachedList || [], {
      hasError: Boolean(lastErr),
      onRetry: () => restartSubscription(),
      highlightId,
      priorLastViewed,
    });

    // After paint, resolve the highlight target (deep link) and the stale
    // deep-link info toast. Both are no-ops when highlightId is empty.
    if (highlightId) {
      const found = (cachedList || []).some((a) => a && a.id === highlightId);
      if (!found && !staleHighlightToasted) {
        staleHighlightToasted = true;
        ui.toast("info", "That announcement is no longer available.");
      } else if (found) {
        applyHighlight(listSection, highlightId);
      }
    }

    // Badge + lastViewed bookkeeping. The badge count reflects the
    // pre-render snapshot so re-renders within the same visit don't
    // flicker the badge; the stored timestamp advances to now so the
    // next visit sees zero unread.
    const unread = countUnread(cachedList || [], priorLastViewed);
    try {
      ui.updateBadge("more", unread);
    } catch (err) {
      console.warn("[announcements] updateBadge failed:", err);
    }
  }

  /** @type {(() => void) | null} */
  let unsub = null;
  let errorToasted = false;
  let orderByFailed = false;

  async function startSubscription() {
    try { await configReady; } catch (_err) { /* non-fatal */ }
    unsub = onSnapshot(
      "announcements",
      (data, err) => {
        if (err) {
          // Firestore's single-field orderBy doesn't normally need a
          // composite index, but if the runQuery path hiccups (field
          // missing on a doc, index not warmed, etc.) we fall back to a
          // client-side sort. Restart the subscription without orderBy.
          if (!orderByFailed) {
            console.warn(
              "[announcements] orderBy poll failed, falling back to client-side sort:",
              err,
            );
            orderByFailed = true;
            if (unsub) { unsub(); unsub = null; }
            unsub = onSnapshot("announcements", handleResult, { intervalMs: 15000 });
            return;
          }
          console.warn("[announcements] poll failed:", err);
          lastErr = err;
          if (typeof navigator !== "undefined" && navigator.onLine === false) {
            ui.showOfflineBanner();
          } else if (!cachedList && !errorToasted) {
            ui.toast("error", "Couldn't load announcements. Tap Retry to try again.");
            errorToasted = true;
          }
        } else {
          lastErr = null;
          errorToasted = false;
          const rows = Array.isArray(data) ? data.slice() : [];
          rows.sort(sortByPublishedDesc);
          cachedList = rows;
        }
        sawFirstResult = true;
        rerender();
      },
      {
        intervalMs: 15000,
        orderBy: { field: "publishedAt", direction: "desc" },
      },
    );
  }

  function handleResult(data, err) {
    if (err) {
      console.warn("[announcements] fallback poll failed:", err);
      lastErr = err;
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        ui.showOfflineBanner();
      } else if (!cachedList && !errorToasted) {
        ui.toast("error", "Couldn't load announcements. Tap Retry to try again.");
        errorToasted = true;
      }
    } else {
      lastErr = null;
      errorToasted = false;
      const rows = Array.isArray(data) ? data.slice() : [];
      rows.sort(sortByPublishedDesc);
      cachedList = rows;
    }
    sawFirstResult = true;
    rerender();
  }

  function restartSubscription() {
    if (unsub) { unsub(); unsub = null; }
    lastErr = null;
    cachedList = null;
    sawFirstResult = false;
    errorToasted = false;
    orderByFailed = false;
    renderSkeleton(listSection);
    startSubscription();
  }

  startSubscription();

  // Bump lastViewed so the next render / next visit sees zero unread.
  writeLastViewed(new Date().toISOString());

  __cleanup = () => {
    if (unsub) { unsub(); unsub = null; }
  };
  registerViewCleanup(() => runCleanup());

  document.title = "Announcements \u2014 Vendor Day 2027";
}

export default renderAnnouncements;

function runCleanup() {
  if (!__cleanup) return;
  try {
    __cleanup();
  } catch (err) {
    console.warn("[announcements] cleanup failed:", err);
  }
  __cleanup = null;
}

/* ---------------- Sticky header ---------------- */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "view-sticky-header";
  el.setAttribute("role", "banner");
  el.innerHTML = `<h2 class="view-sticky-header__title">Announcements</h2>`;
  return el;
}

/* ---------------- Opt-in card + denied banner ---------------- */

/**
 * Render the top-of-view opt-in card variant (or nothing) and the
 * subtle denied banner (or nothing) based on the current subscription
 * state and prior decision. Rerenders itself after any user action.
 */
async function renderOptInSlot(optInHost, deniedHost) {
  const state = await getSubscriptionState();
  const priorDecision = readDecision();

  optInHost.innerHTML = "";
  deniedHost.innerHTML = "";

  // "Notifications are off" banner — shown on every visit when the
  // browser reports denial, because the user can't be re-prompted and
  // we want them to know the OS-level toggle is the fix.
  if (state === "denied") {
    const banner = document.createElement("div");
    banner.className = "push-denied-banner";
    banner.setAttribute("role", "status");
    banner.textContent =
      "Notifications are turned off. Enable them in your device settings.";
    deniedHost.appendChild(banner);
    return;
  }

  // Hide the opt-in card if a decision was already recorded or the
  // browser's own state is terminal (granted / denied / unsupported).
  if (priorDecision || state === "granted" || state === "unsupported") {
    return;
  }

  if (state === "ios-install-required") {
    optInHost.appendChild(buildIosInstallCard(optInHost, deniedHost));
    return;
  }

  if (state === "not-prompted") {
    optInHost.appendChild(buildSupportedOptInCard(optInHost, deniedHost));
    return;
  }
}

function buildSupportedOptInCard(optInHost, deniedHost) {
  const card = document.createElement("section");
  card.className = "push-opt-in-card";
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", "Enable notifications");
  card.innerHTML = `
    <h3 class="push-opt-in-card__title">Get notified about updates</h3>
    <p class="push-opt-in-card__body">
      Get notified about schedule changes and announcements.
      We will not use this for marketing or non-event messages.
    </p>
    <div class="push-opt-in-card__actions">
      <button type="button" class="btn-primary" data-action="enable">Enable notifications</button>
      <button type="button" class="btn-secondary" data-action="dismiss">Not now</button>
    </div>
  `;

  card.querySelector("[data-action=enable]").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const result = await requestPermissionAndSubscribe();
      if (result === "granted") {
        writeDecision("granted");
        ui.toast("success", "Notifications enabled.");
      } else if (result === "denied") {
        writeDecision("denied");
      } else if (result === "ios-install-required") {
        writeDecision("ios-install-shown");
      } else if (result === "unsupported") {
        // No decision recorded; the opt-in simply hides because the slot
        // will see "unsupported" on next render.
      } else {
        // "default" — user dismissed the native prompt without choosing.
        writeDecision("dismissed");
      }
    } catch (err) {
      console.warn("[announcements] requestPermissionAndSubscribe failed:", err);
      ui.toast("error", "Couldn't enable notifications. Try again from About & Install.");
    } finally {
      btn.disabled = false;
      renderOptInSlot(optInHost, deniedHost).catch((err) =>
        console.warn("[announcements] opt-in rerender failed:", err),
      );
    }
  });

  card.querySelector("[data-action=dismiss]").addEventListener("click", () => {
    writeDecision("dismissed");
    renderOptInSlot(optInHost, deniedHost).catch((err) =>
      console.warn("[announcements] opt-in rerender failed:", err),
    );
  });

  return card;
}

function buildIosInstallCard(optInHost, deniedHost) {
  const card = document.createElement("section");
  card.className = "push-opt-in-card push-opt-in-card--ios";
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", "Install this app to enable notifications");
  card.innerHTML = `
    <h3 class="push-opt-in-card__title">Install to enable notifications</h3>
    <p class="push-opt-in-card__body">
      To receive event notifications on iOS, install this app to your home screen first.
      Open the Share menu and tap Add to Home Screen.
    </p>
    <div class="push-opt-in-card__actions">
      <a class="btn-primary" href="#/about-install" data-action="install">How to install</a>
      <button type="button" class="btn-secondary" data-action="dismiss">Not now</button>
    </div>
  `;

  card.querySelector("[data-action=install]").addEventListener("click", () => {
    // Record so the card does not re-render; routing is handled by the
    // anchor's hashchange. We write the decision regardless of whether
    // the user actually finishes installing.
    writeDecision("ios-install-shown");
  });

  card.querySelector("[data-action=dismiss]").addEventListener("click", () => {
    writeDecision("dismissed");
    renderOptInSlot(optInHost, deniedHost).catch((err) =>
      console.warn("[announcements] opt-in rerender failed:", err),
    );
  });

  return card;
}

/* ---------------- Feed rendering ---------------- */

function renderSkeleton(host) {
  host.innerHTML = `
    <article class="announcement-card skeleton-announcement" aria-hidden="true">
      <div class="skeleton-row" style="height: 22px; width: 55%;"></div>
      <div class="skeleton-row" style="width: 90%;"></div>
      <div class="skeleton-row" style="width: 80%;"></div>
      <div class="skeleton-row" style="width: 35%;"></div>
    </article>
    <article class="announcement-card skeleton-announcement" aria-hidden="true">
      <div class="skeleton-row" style="height: 22px; width: 55%;"></div>
      <div class="skeleton-row" style="width: 90%;"></div>
      <div class="skeleton-row" style="width: 80%;"></div>
      <div class="skeleton-row" style="width: 35%;"></div>
    </article>
    <article class="announcement-card skeleton-announcement" aria-hidden="true">
      <div class="skeleton-row" style="height: 22px; width: 55%;"></div>
      <div class="skeleton-row" style="width: 90%;"></div>
      <div class="skeleton-row" style="width: 80%;"></div>
      <div class="skeleton-row" style="width: 35%;"></div>
    </article>
  `;
}

function renderErrorNoCache(host, onRetry) {
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't load announcements.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

function renderEmptyState(host) {
  const el = document.createElement("div");
  el.className = "placeholder-card";
  el.innerHTML = `
    <h2>No announcements yet</h2>
    <p>We will post schedule changes and reminders here throughout the event.</p>
  `;
  host.appendChild(el);
}

function renderFeed(host, items, { hasError, onRetry, highlightId, priorLastViewed }) {
  host.innerHTML = "";

  if (hasError) {
    const strip = document.createElement("div");
    strip.className = "status-error announcements-error-strip";
    strip.setAttribute("role", "status");
    strip.innerHTML = `
      <span>Couldn't refresh. Showing last-saved announcements.</span>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    `;
    strip.querySelector("[data-retry]").addEventListener("click", onRetry);
    host.appendChild(strip);
  }

  if (!items || items.length === 0) {
    renderEmptyState(host);
    return;
  }

  const priorMs = Date.parse(priorLastViewed || DEFAULT_LAST_VIEWED);
  for (const a of items) {
    host.appendChild(renderAnnouncementCard(a, {
      highlightId,
      priorMs: Number.isNaN(priorMs) ? 0 : priorMs,
    }));
  }
}

function renderAnnouncementCard(a, { highlightId, priorMs }) {
  const article = document.createElement("article");
  article.className = "announcement-card";
  const id = typeof a?.id === "string" ? a.id : "";
  if (id) article.id = `announcement-${cssId(id)}`;
  if (highlightId && id === highlightId) {
    article.classList.add("announcement-highlighted");
  }

  const title = typeof a?.title === "string" && a.title.trim() ? a.title.trim() : "Announcement";
  const publishedIso = typeof a?.publishedAt === "string" ? a.publishedAt : "";
  const publishedMs = Date.parse(publishedIso);
  const isUnread = !Number.isNaN(publishedMs) && publishedMs > priorMs;
  const relTime = relativeTime(publishedIso);
  const bodyHtml = renderMarkdown(typeof a?.body === "string" ? a.body : "");

  const timeInner = publishedIso
    ? `<time class="announcement-card__time" datetime="${escapeAttr(publishedIso)}">${escapeHtml(relTime || publishedIso)}</time>`
    : "";

  article.innerHTML = `
    <header class="announcement-card__header">
      <h2 class="announcement-card__title">${escapeHtml(title)}${
        isUnread ? ` <span class="announcement-card__unread-dot" aria-label="Unread"></span>` : ""
      }</h2>
      <div class="announcement-card__meta">
        <span class="announcement-card__byline">Gateway Chapter Board</span>
        ${timeInner}
      </div>
    </header>
    <section class="announcement-card__body"></section>
  `;
  // Markdown-mini escapes HTML before applying its whitelisted
  // transforms, so this innerHTML assignment is safe.
  article.querySelector(".announcement-card__body").innerHTML = bodyHtml;
  return article;
}

function applyHighlight(host, highlightId) {
  const target = host.querySelector(`#announcement-${cssId(highlightId)}`);
  if (!target) return;
  // Delay so the browser has committed layout before we scroll.
  requestAnimationFrame(() => {
    try {
      target.scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (_err) {
      // Older Safari ignores the options object; fall through to default.
      try { target.scrollIntoView(); } catch (_e) { /* no-op */ }
    }
  });
  target.classList.add("announcement-highlighted");
  setTimeout(() => target.classList.remove("announcement-highlighted"), HIGHLIGHT_DURATION_MS);
}

/* ---------------- Sorting + unread count ---------------- */

function sortByPublishedDesc(a, b) {
  const ma = Date.parse(a?.publishedAt);
  const mb = Date.parse(b?.publishedAt);
  const na = Number.isNaN(ma) ? 0 : ma;
  const nb = Number.isNaN(mb) ? 0 : mb;
  return nb - na;
}

function countUnread(items, lastViewedIso) {
  const since = Date.parse(lastViewedIso || DEFAULT_LAST_VIEWED);
  const sinceMs = Number.isNaN(since) ? 0 : since;
  let count = 0;
  for (const a of items) {
    const ms = Date.parse(a?.publishedAt);
    if (!Number.isNaN(ms) && ms > sinceMs) count++;
  }
  return count;
}

/* ---------------- localStorage access ---------------- */

function readDecision() {
  try {
    return localStorage.getItem(DECISION_KEY);
  } catch (_err) {
    return null;
  }
}

function writeDecision(value) {
  try {
    localStorage.setItem(DECISION_KEY, value);
  } catch (err) {
    console.warn("[announcements] decision write failed:", err);
  }
}

function readLastViewed() {
  try {
    return localStorage.getItem(LAST_VIEWED_KEY) || DEFAULT_LAST_VIEWED;
  } catch (_err) {
    return DEFAULT_LAST_VIEWED;
  }
}

function writeLastViewed(iso) {
  try {
    localStorage.setItem(LAST_VIEWED_KEY, iso);
  } catch (err) {
    console.warn("[announcements] lastViewed write failed:", err);
  }
}

/* ---------------- Formatters + escaping ---------------- */

function relativeTime(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffSec = Math.max(0, (Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Make a value DOM-id-safe: replace anything that isn't a letter, digit,
 *  underscore, or hyphen with a hyphen. The resulting value is used only
 *  inside the view's own namespace so collisions across announcements
 *  with similar ids are not a concern. */
function cssId(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, "-");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function escapeAttr(s) {
  return escapeHtml(s);
}
