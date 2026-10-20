// views/agenda-detail.js — Session detail view (Task 9).
//
// Fetches `agenda/<id>` once per mount — no polling here, the list view
// owns that for the group. The "Add to calendar" link builds an RFC 5545
// ICS blob client-side and triggers a download; the ICS helpers are inline
// below so the view ships as a single file.
//
// Back navigation uses `router.navigate("#/agenda")` instead of
// `history.back()` so a deep-link visit (QR code, push notification tap)
// still has a reasonable destination.
"use strict";

import { initFirestore, getDoc } from "../firebase.js";
import * as router from "../router.js";
import * as ui from "../ui.js";

/**
 * Render the Session detail view into `host`.
 * @param {HTMLElement} host  typically `#view-root`.
 * @param {{ id: string }} params  from the hash route `#/agenda/<id>`.
 */
export async function renderAgendaDetail(host, { id } = {}) {
  host.innerHTML = "";

  const sticky = buildBackHeader();
  const content = document.createElement("section");
  content.className = "agenda-detail";
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
    console.warn("[agenda-detail] /api/config load failed:", err);
  }

  // Fetch session + settings in parallel. Settings is best-effort; if it
  // fails we fall through with `{}` so the ICS LOCATION and the date suffix
  // simply omit the venue.
  const settingsPromise = getDoc("appSettings/singleton").catch((err) => {
    console.warn("[agenda-detail] appSettings read failed:", err);
    return null;
  });

  let session = null;
  let fetchErr = null;
  try {
    session = await getDoc(`agenda/${id}`);
  } catch (err) {
    fetchErr = err;
    console.warn("[agenda-detail] session fetch failed:", err);
  }

  const settings = (await settingsPromise) || {};

  if (fetchErr) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      ui.showOfflineBanner();
    } else {
      ui.toast("error", "Couldn't load this session.");
    }
    renderErrorState(content, () => renderAgendaDetail(host, { id }));
    document.title = "Session \u2014 Vendor Day 2027";
    return;
  }

  if (!session) {
    renderNotFoundState(content);
    document.title = "Session not found \u2014 Vendor Day 2027";
    return;
  }

  renderDetailContent(content, session, settings);
  document.title = `${session.title || "Session"} \u2014 Vendor Day 2027`;
}

export default renderAgendaDetail;

/* ---------------- Sticky back header ---------------- */

function buildBackHeader() {
  const el = document.createElement("header");
  el.className = "agenda-sticky-header agenda-sticky-header--detail";
  el.setAttribute("role", "banner");
  el.innerHTML = `
    <button type="button" class="agenda-back" data-back aria-label="Back to Agenda">
      <span aria-hidden="true">\u2190</span>
      <span class="sr-only">Back</span>
    </button>
    <h2 class="agenda-sticky-header__title">Session</h2>
  `;
  el.querySelector("[data-back]").addEventListener("click", () => {
    // Spec: use router.navigate so deep-link visits land somewhere sensible.
    router.navigate("/agenda");
  });
  return el;
}

/* ---------------- States ---------------- */

function renderDetailSkeleton(host) {
  host.innerHTML = `
    <div class="agenda-detail-section">
      <div class="skeleton-row" style="height: 32px; width: 70%;"></div>
      <div class="skeleton-row" style="width: 50%;"></div>
    </div>
    <div class="agenda-detail-section">
      <div class="skeleton-row" style="width: 90%;"></div>
      <div class="skeleton-row" style="width: 85%;"></div>
      <div class="skeleton-row" style="width: 60%;"></div>
    </div>
    <div class="agenda-detail-section">
      <div class="skeleton-row" style="width: 95%;"></div>
      <div class="skeleton-row" style="width: 80%;"></div>
    </div>
  `;
}

function renderNotFoundState(host) {
  host.innerHTML = `
    <div class="placeholder-card">
      <h2>Session not found</h2>
      <p>This session isn't on the agenda. It may have been removed or the link is incorrect.</p>
      <a class="btn-secondary" href="#/agenda">Back to Agenda</a>
    </div>
  `;
}

function renderErrorState(host, onRetry) {
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't load this session.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

/* ---------------- Content render ---------------- */

function renderDetailContent(host, session, settings) {
  const title = session.title || "Untitled session";
  const timeRange = formatTimeRange(session.startAt, session.endAt);
  const eventDate = typeof settings?.eventDate === "string" && settings.eventDate.trim()
    ? formatEventDate(settings.eventDate)
    : null;
  const whenLine = [timeRange, eventDate].filter(Boolean).join(", ");

  const room = typeof session.room === "string" ? session.room.trim() : "";
  const speaker =
    session.speaker && typeof session.speaker === "object" ? session.speaker : null;
  const speakerName =
    speaker && typeof speaker.name === "string" ? speaker.name.trim() : "";
  const speakerBio =
    speaker && typeof speaker.bio === "string" ? speaker.bio.trim() : "";
  const description =
    typeof session.description === "string" ? session.description.trim() : "";

  const parts = [];

  parts.push(`
    <header class="agenda-detail-section agenda-detail-header">
      <h1 class="agenda-detail-title">${escapeHtml(title)}</h1>
      ${whenLine ? `<p class="agenda-detail-when">${escapeHtml(whenLine)}</p>` : ""}
      ${room ? `<p class="agenda-detail-room"><strong>Room:</strong> ${escapeHtml(room)}</p>` : ""}
    </header>
  `);

  if (speakerName || speakerBio) {
    parts.push(`
      <section class="agenda-detail-section agenda-detail-speaker">
        <h2 class="agenda-detail-section-title">Speaker</h2>
        ${speakerName ? `<p class="agenda-detail-speaker-name">${escapeHtml(speakerName)}</p>` : ""}
        ${speakerBio ? `<p class="agenda-detail-speaker-bio">${escapeHtml(speakerBio)}</p>` : ""}
      </section>
    `);
  }

  if (description) {
    parts.push(`
      <section class="agenda-detail-section">
        <h2 class="agenda-detail-section-title">About this session</h2>
        <p class="agenda-detail-description">${escapeHtml(description)}</p>
      </section>
    `);
  }

  // Add to calendar: anchor styled as a secondary button, click-handled to
  // build the ICS Blob and trigger a download. Keeping it as a real anchor
  // means right-click → "Save link as" also works.
  parts.push(`
    <div class="calendar-link-row">
      <a
        href="#"
        class="btn-secondary calendar-link"
        data-add-calendar
        role="button"
      >
        <span class="calendar-link__icon" aria-hidden="true">\uD83D\uDCC5</span>
        Add to calendar
      </a>
    </div>
  `);

  host.innerHTML = parts.join("");

  const addBtn = host.querySelector("[data-add-calendar]");
  if (addBtn) {
    addBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      try {
        downloadIcsForSession(session, settings);
      } catch (err) {
        console.warn("[agenda-detail] ICS build failed:", err);
        ui.toast("error", "Could not create calendar file.");
      }
    });
  }
}

/* ---------------- Add to calendar / ICS ---------------- */

function downloadIcsForSession(session, settings) {
  const title = session.title || "Session";
  const description = typeof session.description === "string" ? session.description : "";
  const room = typeof session.room === "string" ? session.room.trim() : "";
  const venueName = typeof settings?.venueName === "string" ? settings.venueName.trim() : "";
  const location = [venueName, room].filter(Boolean).join(", ");

  const year = (() => {
    const start = Date.parse(session.startAt);
    if (!Number.isNaN(start)) return new Date(start).getUTCFullYear();
    return new Date().getUTCFullYear();
  })();

  const ics = buildIcs({
    id: session.id || "session",
    title,
    description,
    startAt: session.startAt,
    endAt: session.endAt,
    location,
    year,
  });

  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slugify(title)}.ics`;
  // Appending to the DOM is required for the click to fire in Firefox.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Build an RFC 5545 ICS string. Lines are CRLF-joined and the final
 * document ends with CRLF. Values are escaped per section 3.3.11 and long
 * lines are folded per section 3.1.
 *
 * @param {{
 *   id: string,
 *   title: string,
 *   description: string,
 *   startAt: string,
 *   endAt: string,
 *   location: string,
 *   year: number
 * }} params
 */
function buildIcs({ id, title, description, startAt, endAt, location, year }) {
  // Deterministic UID: a second ICS download for the same session + year
  // overrides the first import rather than creating a duplicate event.
  const uid = `vendor-day-${year}-${id}@gatewayscte.org`;
  const dtstamp = formatIcsDate(new Date());
  const dtstart = formatIcsDate(new Date(startAt));
  const dtend = formatIcsDate(new Date(endAt));

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SCTE Gateway Chapter//Vendor Day 2027//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(uid)}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `SUMMARY:${escapeIcsText(title)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  if (location) lines.push(`LOCATION:${escapeIcsText(location)}`);
  lines.push("ORGANIZER:MAILTO:gatewayscte@gmail.com");
  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  // Fold every line, then CRLF-join and terminate with CRLF so Outlook and
  // Apple Calendar both accept the file.
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

/**
 * RFC 5545 line folding: a logical line longer than 75 octets must be split
 * into physical lines joined by CRLF + a single leading whitespace. We
 * count UTF-8 byte length rather than character length because the spec
 * measures in octets.
 */
function foldIcsLine(line) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(line);
  if (bytes.length <= 75) return line;

  const chunks = [];
  let current = "";
  let currentBytes = 0;
  // First physical line can take 75 bytes; continuation lines carry a
  // leading space which counts toward the 75-byte budget, so they get 74.
  const firstLimit = 75;
  const contLimit = 74;
  for (const ch of line) {
    const chBytes = encoder.encode(ch).length;
    const limit = chunks.length === 0 ? firstLimit : contLimit;
    if (currentBytes + chBytes > limit) {
      chunks.push(current);
      current = ch;
      currentBytes = chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  if (current.length) chunks.push(current);
  return chunks.join("\r\n ");
}

/**
 * ICS TEXT value escaping (RFC 5545 § 3.3.11). Order matters: escape the
 * backslash first so later-inserted backslashes don't get re-escaped.
 */
function escapeIcsText(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** UTC date formatted as `YYYYMMDDTHHMMSSZ` per RFC 5545 § 3.3.5. */
function formatIcsDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/* ---------------- Formatters ---------------- */

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

function slugify(s) {
  const slug = String(s || "session")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "session";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
