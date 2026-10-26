// views/recap.js — attendee Post-event Recap view (Task 15).
//
// Reads `recap/singleton` and renders either the published recap
// content (thanks + acknowledgments markdown + photo gallery) or the
// pre-publish placeholder ("The event recap will be published after
// Vendor Day. Check back soon.") when the doc does not exist or has
// `published !== true`.
//
// Polling runs at 30s — slower than the view-level cadences for Agenda
// / Sponsors / Announcements / Feedback because recap content changes
// infrequently once published. A separate app-lifetime poll in app.js
// drives the More-menu visibility at 60s, so even if an admin flips
// `published` while no one has the Recap view open, the entry still
// appears in the menu within a minute.
//
// Content layout:
//   - Sticky secondary header: "Recap"
//   - thanksMessage                     (<section>, plain paragraph)
//   - acknowledgments (markdown-mini)   (<section>, markdown body)
//   - photos sorted by order ascending  (figure + lazy-loaded <img>)
//   - metadata footer: publishedAt + attribution
//
// Each content block is omitted entirely when its field is empty, so an
// admin can publish a text-only or photo-only recap and the view still
// reads cleanly.
"use strict";

import { initFirestore, onSnapshot } from "../firebase.js";
import * as ui from "../ui.js";
import { registerViewCleanup } from "../app.js";
import { renderMarkdown, escapeHtml } from "../markdown-mini.js";
import { relativeTime } from "../utils/time.js";

const POLL_INTERVAL_MS = 30000;

/** Module-level cleanup slot. Set at the end of each render call. */
let __cleanup = null;

/**
 * Render the Recap view into `host`.
 * @param {HTMLElement} host  typically `#view-root`.
 * @returns {Promise<void>}
 */
export async function renderRecap(host) {
  // Drain prior render handles so retries don't leave two pollers running.
  runCleanup();

  host.innerHTML = "";

  const sticky = buildStickyHeader();
  const bodySection = document.createElement("section");
  bodySection.className = "recap-view";
  bodySection.setAttribute("aria-live", "polite");
  bodySection.setAttribute("aria-label", "Recap");

  host.append(sticky, bodySection);

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    ui.showOfflineBanner();
  }

  document.title = "Recap \u2014 Vendor Day 2027";

  // Prime /api/config so the first poll tick doesn't race it.
  const configReady = initFirestore().catch((err) => {
    console.warn("[recap] /api/config load failed:", err);
    return null;
  });

  /** @type {object | null} */
  let recap = null;
  /** @type {Error | null} */
  let lastErr = null;
  let sawFirstResult = false;

  renderSkeleton(bodySection);

  function rerender() {
    if (lastErr && !recap) {
      renderErrorNoCache(bodySection, () => restartSubscription());
      return;
    }
    if (!sawFirstResult) {
      renderSkeleton(bodySection);
      return;
    }
    if (!recap || recap.published !== true) {
      renderPlaceholder(bodySection);
      return;
    }
    renderRecapContent(bodySection, recap, {
      hasError: Boolean(lastErr),
      onRetry: () => restartSubscription(),
    });
  }

  /** @type {(() => void) | null} */
  let unsub = null;
  let errorToasted = false;

  async function startSubscription() {
    try { await configReady; } catch (_err) { /* non-fatal */ }
    unsub = onSnapshot(
      "recap/singleton",
      (data, err) => {
        if (err) {
          console.warn("[recap] poll failed:", err);
          lastErr = err;
          if (typeof navigator !== "undefined" && navigator.onLine === false) {
            ui.showOfflineBanner();
          } else if (!recap && !errorToasted) {
            ui.toast("error", "Couldn't load the recap. Tap Retry to try again.");
            errorToasted = true;
          }
        } else {
          lastErr = null;
          errorToasted = false;
          recap = data;
        }
        sawFirstResult = true;
        rerender();
      },
      { intervalMs: POLL_INTERVAL_MS },
    );
  }

  function restartSubscription() {
    if (unsub) { unsub(); unsub = null; }
    lastErr = null;
    recap = null;
    sawFirstResult = false;
    errorToasted = false;
    renderSkeleton(bodySection);
    startSubscription();
  }

  startSubscription();

  __cleanup = () => {
    if (unsub) { unsub(); unsub = null; }
  };
  registerViewCleanup(() => runCleanup());
}

export default renderRecap;

function runCleanup() {
  if (!__cleanup) return;
  try {
    __cleanup();
  } catch (err) {
    console.warn("[recap] cleanup failed:", err);
  }
  __cleanup = null;
}

/* ---------------- Sticky header ---------------- */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "view-sticky-header";
  // No ARIA role: the shell <header id="app-header"> is the single
  // page-level banner. A duplicate banner landmark fails Lighthouse's
  // "landmark-no-duplicate-banner" rule.
  el.innerHTML = `<h2 class="view-sticky-header__title">Recap</h2>`;
  return el;
}

/* ---------------- Loading / error / placeholder states ---------------- */

function renderSkeleton(host) {
  // Text block (title + two body rows) followed by three photo frames in
  // the same grid layout the real gallery uses, so the first paint stays
  // close to the published footprint.
  host.innerHTML = `
    <section class="recap-section skeleton-recap-section" aria-hidden="true">
      <div class="skeleton-row" style="height: 22px; width: 50%;"></div>
      <div class="skeleton-row" style="width: 95%;"></div>
      <div class="skeleton-row" style="width: 90%;"></div>
      <div class="skeleton-row" style="width: 60%;"></div>
    </section>
    <div class="recap-photos" aria-hidden="true">
      <div class="recap-photo-skeleton"></div>
      <div class="recap-photo-skeleton"></div>
      <div class="recap-photo-skeleton"></div>
    </div>
  `;
}

function renderErrorNoCache(host, onRetry) {
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't load the recap.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

function renderPlaceholder(host) {
  host.innerHTML = `
    <div class="placeholder-card">
      <h2>Recap is on its way</h2>
      <p>The event recap will be published after Vendor Day. Check back soon.</p>
    </div>
  `;
}

/* ---------------- Published content rendering ---------------- */

function renderRecapContent(host, recap, { hasError, onRetry }) {
  host.innerHTML = "";

  if (hasError) {
    const strip = document.createElement("div");
    strip.className = "status-error recap-error-strip";
    strip.setAttribute("role", "status");
    strip.innerHTML = `
      <span>Couldn't refresh. Showing last-saved recap.</span>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    `;
    strip.querySelector("[data-retry]").addEventListener("click", onRetry);
    host.appendChild(strip);
  }

  const thanks = typeof recap.thanksMessage === "string" ? recap.thanksMessage.trim() : "";
  if (thanks) {
    host.appendChild(buildThanksSection(thanks));
  }

  const acks = typeof recap.acknowledgments === "string" ? recap.acknowledgments.trim() : "";
  if (acks) {
    host.appendChild(buildAcknowledgmentsSection(acks));
  }

  const photos = sortPhotos(Array.isArray(recap.photos) ? recap.photos : []);
  if (photos.length > 0) {
    host.appendChild(buildPhotoGallery(photos));
  }

  host.appendChild(buildFooter(recap));
}

function buildThanksSection(text) {
  const section = document.createElement("section");
  section.className = "recap-section recap-thanks";
  section.setAttribute("aria-label", "Thank-you message");
  // Preserve author line breaks the same way admin-authored plain text
  // reads in the editor. HTML escape before interpolating.
  section.innerHTML = `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
  return section;
}

function buildAcknowledgmentsSection(markdownSrc) {
  const section = document.createElement("section");
  section.className = "recap-section recap-acknowledgments";
  section.setAttribute("aria-label", "Acknowledgments");
  // Markdown-mini escapes HTML before applying its whitelisted transforms,
  // so this innerHTML assignment is safe.
  section.innerHTML = renderMarkdown(markdownSrc);
  return section;
}

function buildPhotoGallery(photos) {
  const gallery = document.createElement("section");
  gallery.className = "recap-photos";
  gallery.setAttribute("aria-label", "Event photos");
  for (const photo of photos) {
    gallery.appendChild(buildPhotoFigure(photo));
  }
  return gallery;
}

function buildPhotoFigure(photo) {
  const figure = document.createElement("figure");
  figure.className = "recap-photo";

  const url = typeof photo?.url === "string" ? photo.url : "";
  const caption = typeof photo?.caption === "string" ? photo.caption : "";
  // Alt text falls back to an empty string so decorative photos read
  // cleanly to screen readers; a non-empty caption serves as the alt
  // text for photos that carry meaningful content.
  figure.innerHTML = `
    <img src="${escapeHtml(url)}" alt="${escapeHtml(caption)}" loading="lazy" />
    ${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}
  `;
  return figure;
}

function buildFooter(recap) {
  const footer = document.createElement("footer");
  footer.className = "recap-footer";
  const publishedIso = typeof recap.publishedAt === "string" ? recap.publishedAt : "";
  const when = publishedIso ? (relativeTime(publishedIso) || publishedIso) : "";
  const timeFragment = publishedIso
    ? `<time class="recap-footer__time" datetime="${escapeHtml(publishedIso)}">Published ${escapeHtml(when)}</time>`
    : "";
  footer.innerHTML = `
    ${timeFragment}
    <p class="recap-footer__attribution">Published by the Gateway Chapter Board</p>
  `;
  return footer;
}

/* ---------------- Sorting ---------------- */

function sortPhotos(photos) {
  const safe = photos.slice();
  // Order ascending; ties keep insertion order via a stable sort (ES2019+).
  safe.sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0));
  // Defensive filter — a photo without a url can't be rendered.
  return safe.filter((p) => p && typeof p.url === "string" && p.url);
}
