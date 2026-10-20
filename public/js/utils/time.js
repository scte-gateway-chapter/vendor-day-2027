// utils/time.js — shared time formatters used by views.
//
// Hoisted out of home.js so views that share the same relative-time
// vocabulary (Home card timestamps, the Feedback confirmation card) read
// the same strings. The announcements view still carries its own inline
// copy for now; a future dedupe pass can import this from there too.
"use strict";

/**
 * Humanize an ISO 8601 timestamp (typically Firestore's `timestampValue`).
 *   < 60s     \u2192 "just now"
 *   < 60m     \u2192 "X minute(s) ago"
 *   < 24h     \u2192 "X hour(s) ago"
 *   < 7d      \u2192 "X day(s) ago"
 *   otherwise \u2192 the full date, e.g. "May 15, 2027"
 * @param {string | null | undefined} iso
 * @returns {string}
 */
export function relativeTime(iso) {
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
