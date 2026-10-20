// views/sponsors-detail.js — Sponsor detail view (Task 10).
//
// Fetches `sponsors/<id>` once per mount — no polling here, the list view
// owns that for the collection. Back navigation uses router.navigate so a
// deep-link visit (QR code, direct URL) still has a reasonable destination.
"use strict";

import { initFirestore, getDoc } from "../firebase.js";
import * as router from "../router.js";
import * as ui from "../ui.js";

const LOGO_PLACEHOLDER = "/assets/placeholders/logo-placeholder.svg";

const TIER_LABELS = {
  platinum: "Platinum",
  gold: "Gold",
  silver: "Silver",
  supporter: "Supporter",
};

/**
 * Render the Sponsor detail view into `host`.
 * @param {HTMLElement} host  typically `#view-root`.
 * @param {{ id: string }} params  from the hash route `#/sponsors/<id>`.
 */
export async function renderSponsorDetail(host, { id } = {}) {
  host.innerHTML = "";

  const sticky = buildBackHeader();
  const content = document.createElement("section");
  content.className = "sponsor-detail";
  content.setAttribute("aria-live", "polite");
  renderDetailSkeleton(content);

  host.append(sticky, content);

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    ui.showOfflineBanner();
  }

  // Prime config. If it fails the subsequent getDoc call fails too — we
  // surface a single error there rather than a chain of nested banners.
  try {
    await initFirestore();
  } catch (err) {
    console.warn("[sponsors-detail] /api/config load failed:", err);
  }

  let sponsor = null;
  let fetchErr = null;
  try {
    sponsor = await getDoc(`sponsors/${id}`);
  } catch (err) {
    fetchErr = err;
    console.warn("[sponsors-detail] sponsor fetch failed:", err);
  }

  if (fetchErr) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      ui.showOfflineBanner();
    } else {
      ui.toast("error", "Couldn't load this sponsor.");
    }
    renderErrorState(content, () => renderSponsorDetail(host, { id }));
    document.title = "Sponsor \u2014 Vendor Day 2027";
    return;
  }

  if (!sponsor) {
    renderNotFoundState(content);
    document.title = "Sponsor not found \u2014 Vendor Day 2027";
    return;
  }

  renderDetailContent(content, sponsor);
  document.title = `${sponsor.name || "Sponsor"} \u2014 Vendor Day 2027`;
}

export default renderSponsorDetail;

/* ---------------- Sticky back header ---------------- */

function buildBackHeader() {
  const el = document.createElement("header");
  el.className = "view-sticky-header view-sticky-header--detail";
  el.setAttribute("role", "banner");
  el.innerHTML = `
    <button type="button" class="view-back-button" data-back aria-label="Back to Sponsors">
      <span aria-hidden="true">\u2190</span>
      <span class="sr-only">Back</span>
    </button>
    <h2 class="view-sticky-header__title">Sponsor</h2>
  `;
  el.querySelector("[data-back]").addEventListener("click", () => {
    router.navigate("/sponsors");
  });
  return el;
}

/* ---------------- States ---------------- */

function renderDetailSkeleton(host) {
  host.innerHTML = `
    <div class="sponsor-detail-section sponsor-detail-skeleton-head">
      <div class="skeleton-row sponsor-detail-skeleton-logo"></div>
      <div class="sponsor-detail-skeleton-head-text">
        <div class="skeleton-row" style="height: 20px; width: 40%;"></div>
        <div class="skeleton-row" style="height: 28px; width: 80%;"></div>
      </div>
    </div>
    <div class="sponsor-detail-section">
      <div class="skeleton-row" style="width: 95%;"></div>
      <div class="skeleton-row" style="width: 90%;"></div>
      <div class="skeleton-row" style="width: 60%;"></div>
    </div>
    <div class="sponsor-detail-section">
      <div class="skeleton-row" style="width: 70%;"></div>
      <div class="skeleton-row" style="width: 55%;"></div>
    </div>
  `;
}

function renderNotFoundState(host) {
  host.innerHTML = `
    <div class="placeholder-card">
      <h2>Sponsor not found</h2>
      <p>This sponsor isn't on the directory. It may have been removed or the link is incorrect.</p>
      <a class="btn-secondary" href="#/sponsors">Back to Sponsors</a>
    </div>
  `;
}

function renderErrorState(host, onRetry) {
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't load this sponsor.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

/* ---------------- Content render ---------------- */

function renderDetailContent(host, sponsor) {
  const name = typeof sponsor.name === "string" && sponsor.name.trim()
    ? sponsor.name.trim()
    : "Untitled sponsor";
  const logoUrl = typeof sponsor.logoUrl === "string" && sponsor.logoUrl.trim()
    ? sponsor.logoUrl.trim()
    : LOGO_PLACEHOLDER;
  const tierRaw = typeof sponsor.tier === "string" ? sponsor.tier.toLowerCase() : "";
  const tierKey = TIER_LABELS[tierRaw] ? tierRaw : "";
  const tierLabel = tierKey ? TIER_LABELS[tierKey] : "";
  const description = typeof sponsor.description === "string" ? sponsor.description.trim() : "";
  const website = typeof sponsor.website === "string" ? sponsor.website.trim() : "";
  const boothNumber = typeof sponsor.boothNumber === "string" ? sponsor.boothNumber.trim() : "";
  const email = typeof sponsor.email === "string" ? sponsor.email.trim() : "";

  const parts = [];

  // Head: logo + tier chip + name. The logo image stays decorative (alt="")
  // because the h1 immediately beside it carries the sponsor name.
  parts.push(`
    <header class="sponsor-detail-section sponsor-detail-head">
      <img
        class="sponsor-detail-logo"
        src="${escapeAttr(logoUrl)}"
        alt=""
        width="128"
        height="128"
      />
      <div class="sponsor-detail-head-text">
        ${tierLabel ? `<span class="sponsor-tier-chip sponsor-tier-chip--${tierKey}">${escapeHtml(tierLabel)}</span>` : ""}
        <h1 class="sponsor-detail-title">${escapeHtml(name)}</h1>
      </div>
    </header>
  `);

  if (description) {
    parts.push(`
      <section class="sponsor-detail-section">
        <p class="sponsor-detail-description">${escapeHtml(description)}</p>
      </section>
    `);
  }

  // Build the "info" block: website, booth + find on map, email. Each line
  // is only rendered when its field is present on the document.
  const infoLines = [];
  if (website) {
    infoLines.push(`
      <p class="sponsor-detail-line">
        <a
          class="sponsor-website-link"
          href="${escapeAttr(website)}"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Visit website (opens in a new tab)"
        >
          Visit website
          <span class="sponsor-external-icon" aria-hidden="true">\u2197</span>
        </a>
      </p>
    `);
  }
  if (boothNumber) {
    infoLines.push(`
      <p class="sponsor-detail-line sponsor-detail-booth">
        <span>Booth ${escapeHtml(boothNumber)}</span>
        <a class="sponsor-find-on-map" href="#/map">Find on map</a>
      </p>
    `);
  }
  if (email) {
    infoLines.push(`
      <p class="sponsor-detail-line">
        <a href="mailto:${escapeAttr(email)}">${escapeHtml(email)}</a>
      </p>
    `);
  }

  if (infoLines.length) {
    parts.push(`
      <section class="sponsor-detail-section sponsor-detail-info">
        ${infoLines.join("")}
      </section>
    `);
  }

  host.innerHTML = parts.join("");
}

/* ---------------- Escaping ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function escapeAttr(s) {
  return escapeHtml(s);
}
