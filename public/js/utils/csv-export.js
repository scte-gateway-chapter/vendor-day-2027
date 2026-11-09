// csv-export.js — shared RFC-4180 CSV serializer + download trigger.
//
// `toCsv` is a pure function (no DOM, no side effects, no BOM). The
// `downloadCsv` helper prepends the UTF-8 BOM and triggers the browser
// download; keeping the two apart lets admin modules reuse `toCsv` as
// a pure value and lets the tests (if a harness ever lands) assert the
// CSV body without a jsdom shim.
"use strict";

/**
 * Build a UTF-8 CSV string from `rows` with the given column list.
 *
 * - First row is the header, taken verbatim from `columns[].key` so
 *   admin dashboards and the exported CSV share one source of column
 *   naming (per design "Shared-constant pattern").
 * - Every cell is RFC-4180 quoted: a field containing a comma,
 *   double-quote, CR, or LF is wrapped in double quotes with inner
 *   quotes doubled. Fields with none of those characters are emitted
 *   bare.
 * - Line terminator is CRLF per RFC 4180.
 * - Cells read `row[col.key]`. null / undefined / false emit an empty
 *   cell. Boolean true emits "true". Numbers use String(n). Dates /
 *   anything else runs through String().
 * - BOM is NOT prepended here — downloadCsv() adds it so toCsv()
 *   stays a pure string function.
 *
 * @param {Array<object>} rows
 * @param {Array<{key: string}>} columns
 * @returns {string} RFC-4180 CSV body, no BOM.
 */
export function toCsv(rows, columns) {
  const cols = Array.isArray(columns) ? columns : [];
  const header = cols.map((c) => quoteCell(c?.key)).join(",");
  const body = (Array.isArray(rows) ? rows : [])
    .map((row) =>
      cols
        .map((c) => quoteCell(formatValue(row ? row[c?.key] : "")))
        .join(","),
    )
    .join("\r\n");
  return body ? `${header}\r\n${body}` : header;
}

/**
 * Trigger a browser download of `csv` as `filename` with
 * `text/csv;charset=utf-8` and a leading UTF-8 BOM so Excel on
 * Windows reads non-ASCII content correctly. Resolves after the
 * `<a download>` click + revokeObjectURL cleanup.
 *
 * @param {string} filename  e.g. "signIns-20270607-143022.csv"
 * @param {string} csv       output of toCsv()
 * @returns {Promise<void>}
 */
export async function downloadCsv(filename, csv) {
  const BOM = "\uFEFF";
  const blob = new Blob([BOM + (typeof csv === "string" ? csv : "")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "export.csv";
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Defer the revoke so Safari has a tick to pick up the blob URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Build the standard filename for a collection export.
 * Shape: `<collection>-<YYYYMMDD-HHMMSS>.csv` using the device's local
 * time (not UTC) so the file is identifiable in the admin's own
 * calendar frame of reference. `collection` is passed verbatim — e.g.
 * "signIns", "bscCheckins", "bscPreReg", "attendees" — so the
 * filename shows the same casing as the Firestore collection id.
 *
 * @param {string} collection
 * @param {Date}   [now]
 * @returns {string}
 */
export function buildCsvFilename(collection, now) {
  const d = now instanceof Date ? now : new Date();
  const y = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const da = pad2(d.getDate());
  const h = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const s = pad2(d.getSeconds());
  const name = typeof collection === "string" && collection ? collection : "export";
  return `${name}-${y}${mo}${da}-${h}${mi}${s}.csv`;
}

/* ---------------- Internal ---------------- */

function formatValue(v) {
  if (v === null || v === undefined || v === false) return "";
  if (v === true) return "true";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return String(v);
}

function quoteCell(input) {
  const s = typeof input === "string" ? input : input == null ? "" : String(input);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
