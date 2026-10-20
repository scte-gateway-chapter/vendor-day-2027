// views/sponsors.js — attendee Sponsor Directory list view (Task 10).
//
// Subscribes to the `sponsors` collection via the 15-second poll from
// firebase.js and renders rows grouped by tier (Platinum, Gold, Silver,
// Supporter, then Other for any out-of-enum value). Within a tier rows are
// ordered by `order` ascending with `name` as the tiebreaker.
//
// The row itself is an <a href="#/sponsors/<id>"> so right-click /
// middle-click behave naturally. Each row's accessible name comes from a
// visible `<span>` carrying the company text; the logo image uses alt=""
// so the surrounding anchor name is not duplicated by screen readers.
//
// Cleanup follows the Task 9 pattern: a module-level __cleanup slot stops
// the sponsors poll. The router.beforeEach hook (via registerViewCleanup
// in app.js) drains it before mounting the next view.
"use strict";

import { initFirestore, onSnapshot } from "../firebase.js";
import * as ui from "../ui.js";
import { registerViewCleanup } from "../app.js";

const LOGO_PLACEHOLDER = "/assets/placeholders/logo-placeholder.svg";

// Tiers in display order. `null` tier (or any value not in this list) goes
// in a trailing "Other" group so unexpected data still renders somewhere
// instead of being silently dropped.
const TIER_ORDER = ["platinum", "gold", "silver", "supporter"];
const TIER_LABELS = {
  platinum: "Platinum",
  gold: "Gold",
  silver: "Silver",
  supporter: "Supporter",
  other: "Other",
};

/** Module-level cleanup slot. Set at the end of each renderSponsors call. */
let __cleanup = null;

/**
 * Render the Sponsor Directory list view into `host`.
 * @param {HTMLElement} host  typically `#view-root`.
 * @returns {Promise<void>}
 */
export async function renderSponsors(host) {
  // Drain any prior render's handles so retries don't leave two pollers
  // running against the same view root.
  runCleanup();

  host.innerHTML = "";

  const sticky = buildStickyHeader();
  const listSection = document.createElement("section");
  listSection.className = "sponsors-list";
  listSection.setAttribute("aria-live", "polite");
  listSection.setAttribute("aria-label", "Sponsors");

  host.append(sticky, listSection);

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    ui.showOfflineBanner();
  }

  // /api/config is cached on the Firestore client so this is a no-op after
  // the first bootstrap. We still await it before the first poll so the
  // initial fetch doesn't race the config load.
  const configReady = initFirestore().catch((err) => {
    console.warn("[sponsors] /api/config load failed:", err);
    return null;
  });

  // State: cachedSponsors is the last successful snapshot (null during the
  // first load); lastErr is the most recent error (null when a poll
  // succeeded). Both drive what rerender() paints.
  /** @type {object[] | null} */
  let cachedSponsors = null;
  /** @type {Error | null} */
  let lastErr = null;
  let sawFirstResult = false;

  renderSkeleton(listSection);

  function rerender() {
    if (lastErr && !cachedSponsors) {
      renderErrorNoCache(listSection, () => restartSubscription());
      return;
    }
    if (!sawFirstResult) {
      renderSkeleton(listSection);
      return;
    }
    renderSponsorList(listSection, cachedSponsors || [], {
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
      "sponsors",
      (data, err) => {
        if (err) {
          console.warn("[sponsors] poll failed:", err);
          lastErr = err;
          if (typeof navigator !== "undefined" && navigator.onLine === false) {
            ui.showOfflineBanner();
          } else if (!cachedSponsors && !errorToasted) {
            ui.toast("error", "Couldn't load sponsors. Tap Retry to try again.");
            errorToasted = true;
          }
        } else {
          lastErr = null;
          errorToasted = false;
          cachedSponsors = Array.isArray(data) ? data.slice() : [];
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
    cachedSponsors = null;
    sawFirstResult = false;
    errorToasted = false;
    renderSkeleton(listSection);
    startSubscription();
  }

  startSubscription();

  __cleanup = () => {
    if (unsub) { unsub(); unsub = null; }
  };
  registerViewCleanup(() => runCleanup());

  document.title = "Sponsors \u2014 Vendor Day 2027";
}

export default renderSponsors;

function runCleanup() {
  if (!__cleanup) return;
  try {
    __cleanup();
  } catch (err) {
    console.warn("[sponsors] cleanup failed:", err);
  }
  __cleanup = null;
}

/* ---------------- Sticky secondary header ---------------- */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "view-sticky-header";
  el.setAttribute("role", "banner");
  el.innerHTML = `<h2 class="view-sticky-header__title">Sponsors</h2>`;
  return el;
}

/* ---------------- Rendering states ---------------- */

function renderSkeleton(host) {
  // 4 shimmer rows per spec. Explicit height keeps the row footprint close
  // to the real sponsor card so the list doesn't jump on first paint.
  host.innerHTML = `
    <div class="sponsor-tier-group" aria-hidden="true">
      <div class="skeleton-row sponsor-tier-label-skeleton" style="height: 20px; width: 30%;"></div>
      <div class="skeleton-row sponsor-row-skeleton" style="height: 72px;"></div>
      <div class="skeleton-row sponsor-row-skeleton" style="height: 72px;"></div>
    </div>
    <div class="sponsor-tier-group" aria-hidden="true">
      <div class="skeleton-row sponsor-tier-label-skeleton" style="height: 20px; width: 30%;"></div>
      <div class="skeleton-row sponsor-row-skeleton" style="height: 72px;"></div>
      <div class="skeleton-row sponsor-row-skeleton" style="height: 72px;"></div>
    </div>
  `;
}

function renderErrorNoCache(host, onRetry) {
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't load sponsors.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

function renderEmptyState(host) {
  const el = document.createElement("div");
  el.className = "placeholder-card";
  el.innerHTML = `
    <h2>Sponsor list coming soon</h2>
    <p>Sponsors will be listed as the event approaches.</p>
  `;
  host.appendChild(el);
}

/**
 * Render the full tier-grouped sponsor list (or empty state) with an
 * optional stale/error strip at the top if the latest poll failed but we
 * have a cached list to show beneath it.
 */
function renderSponsorList(host, sponsors, { hasError, onRetry }) {
  host.innerHTML = "";

  if (hasError) {
    const strip = document.createElement("div");
    strip.className = "status-error sponsors-error-strip";
    strip.setAttribute("role", "status");
    strip.innerHTML = `
      <span>Couldn't refresh. Showing last-saved sponsors.</span>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    `;
    strip.querySelector("[data-retry]").addEventListener("click", onRetry);
    host.appendChild(strip);
  }

  if (!sponsors || sponsors.length === 0) {
    renderEmptyState(host);
    return;
  }

  const groups = groupByTier(sponsors);
  for (const group of groups) {
    host.appendChild(renderTierGroup(group.tier, group.sponsors));
  }
}

function renderTierGroup(tier, sponsors) {
  const section = document.createElement("section");
  section.className = `sponsor-tier-group sponsor-tier-group--${tier}`;

  const h3 = document.createElement("h3");
  h3.className = "sponsor-tier-label";
  h3.textContent = TIER_LABELS[tier] || TIER_LABELS.other;
  section.appendChild(h3);

  for (const s of sponsors) {
    section.appendChild(renderSponsorCard(s));
  }
  return section;
}

/**
 * Build a sponsor card as an anchor. The company name sits in a visible
 * span and provides the accessible name for the row via aria-label on the
 * anchor; the logo image is decorative (alt="") because labeling it would
 * duplicate speech output.
 */
function renderSponsorCard(sponsor) {
  const id = typeof sponsor.id === "string" ? sponsor.id : "";
  const name = typeof sponsor.name === "string" && sponsor.name.trim()
    ? sponsor.name.trim()
    : "Untitled sponsor";
  const logoUrl = typeof sponsor.logoUrl === "string" && sponsor.logoUrl.trim()
    ? sponsor.logoUrl.trim()
    : LOGO_PLACEHOLDER;
  const booth = typeof sponsor.boothNumber === "string" ? sponsor.boothNumber.trim() : "";

  const a = document.createElement("a");
  a.className = "sponsor-card";
  a.href = `#/sponsors/${encodeURIComponent(id)}`;
  a.setAttribute("aria-label", booth ? `${name}, booth ${booth}` : name);
  a.innerHTML = `
    <img
      class="sponsor-logo"
      src="${escapeAttr(logoUrl)}"
      alt=""
      width="64"
      height="64"
      loading="lazy"
    />
    <div class="sponsor-card__body">
      <span class="sponsor-name line-clamp-1">${escapeHtml(name)}</span>
      ${booth ? `<span class="sponsor-meta">Booth ${escapeHtml(booth)}</span>` : ""}
    </div>
    <span class="sponsor-chevron" aria-hidden="true">\u203A</span>
  `;
  return a;
}

/* ---------------- Grouping + sorting ---------------- */

/**
 * Group sponsors by tier in the display order declared in TIER_ORDER.
 * Unknown tier values (missing, misspelled, future enum additions) fall
 * through to a trailing "other" group so no sponsor is dropped silently.
 * Empty tiers are not emitted so the UI only shows headers that have at
 * least one row beneath them.
 */
function groupByTier(sponsors) {
  const buckets = new Map();
  for (const t of TIER_ORDER) buckets.set(t, []);
  buckets.set("other", []);

  for (const s of sponsors) {
    const raw = typeof s?.tier === "string" ? s.tier.toLowerCase() : "";
    const key = TIER_ORDER.includes(raw) ? raw : "other";
    buckets.get(key).push(s);
  }

  const result = [];
  for (const tier of [...TIER_ORDER, "other"]) {
    const rows = buckets.get(tier);
    if (!rows || rows.length === 0) continue;
    rows.sort(sortSponsors);
    result.push({ tier, sponsors: rows });
  }
  return result;
}

/**
 * Primary sort by `order` ascending (missing/invalid → Infinity so they
 * sink to the bottom of their tier), tiebreaking by `name` ascending.
 */
function sortSponsors(a, b) {
  const oa = toOrderNumber(a?.order);
  const ob = toOrderNumber(b?.order);
  if (oa !== ob) return oa - ob;
  const na = typeof a?.name === "string" ? a.name : "";
  const nb = typeof b?.name === "string" ? b.name : "";
  return na.localeCompare(nb, undefined, { sensitivity: "base" });
}

function toOrderNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : Infinity;
}

/* ---------------- Escaping ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/** Same as escapeHtml — kept as a separate symbol so attribute vs. text
 *  intent reads at the call site. */
function escapeAttr(s) {
  return escapeHtml(s);
}
