// _csv.js — hand-rolled CSV parser for the BSC roster upload Function.
//
// This file is a near-verbatim port of `public/admin/js/csv-parse.js`.
// The admin importer's client-side parser cannot be imported from a
// Cloudflare Pages Function: the two files run in different runtimes
// (browser ES modules served from `public/` vs. the Workers runtime that
// loads `functions/`), and the Pages build process does not bundle any
// `public/`-sourced module into Function code. Keeping a dedicated
// server-side copy here avoids introducing a bundler just to share one
// pure parser.
//
// The parsing behavior is intentionally identical to the client parser:
//   - comma delimiter,
//   - double-quoted fields with `""` as an escaped quote inside,
//   - embedded newlines inside quoted fields,
//   - mixed line endings (`\n`, `\r\n`, `\r`),
//   - empty fields and trailing newlines,
//   - leading UTF-8 BOM dropped so a round-tripped Google Sheets export
//     doesn't poison the first header cell.
//
// The additional `normalizeHeader(s)` helper lives here (and NOT in the
// client parser) because header-key canonicalization is a server-side
// concern for the roster upload Function (admin-authored CSVs may have
// varied capitalization / whitespace in their column labels).
//
// NOT routed as a URL — the `_` prefix follows the Pages routing
// convention (see `functions/_shared/_jwt.js` header).
"use strict";

/**
 * Parse a CSV string. The first non-empty row is returned as `headers`,
 * every following row as a cell array in `rows`. Trailing blank rows
 * (common from a dangling newline) are dropped. An empty input returns
 * `{ headers: [], rows: [] }`.
 * @param {string} text
 * @returns {{ headers: string[], rows: string[][] }}
 */
export function parseCsv(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { headers: [], rows: [] };
  }

  // Strip the UTF-8 BOM so the first header cell doesn't carry a stray
  // U+FEFF the admin can't see but a case-insensitive `name` match misses.
  const input = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

  const out = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const len = input.length;

  for (let i = 0; i < len; i++) {
    const c = input[i];

    if (inQuotes) {
      if (c === '"') {
        // `""` inside a quoted field = literal quote; otherwise end of quote.
        if (i + 1 < len && input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
        continue;
      }
      field += c;
      continue;
    }

    // Unquoted state.
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\r" || c === "\n") {
      row.push(field);
      out.push(row);
      row = [];
      field = "";
      // Consume the matching half of a \r\n pair so it reads as one break.
      if (c === "\r" && i + 1 < len && input[i + 1] === "\n") i++;
      continue;
    }
    field += c;
  }

  // Flush whatever's left. An unterminated final record (no trailing
  // newline) still produces a row; a trailing newline leaves `field === ""`
  // and `row === []` which is dropped below.
  if (field !== "" || row.length > 0) {
    row.push(field);
    out.push(row);
  }

  // Drop trailing single-empty-cell rows produced by a dangling newline.
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last.length === 1 && last[0] === "") out.pop();
    else break;
  }

  if (out.length === 0) return { headers: [], rows: [] };
  const [headers, ...rows] = out;
  return { headers, rows };
}

/**
 * Trim whitespace from every cell in a row. Mirrors the client parser's
 * helper so a caller that pipes rows through `trimRow` before validating
 * doesn't need to re-implement the same loop.
 * @param {string[]} row
 * @returns {string[]}
 */
export function trimRow(row) {
  if (!Array.isArray(row)) return [];
  return row.map((c) => (typeof c === "string" ? c.trim() : ""));
}

/**
 * Canonicalize a CSV header label so the Function's HEADER_MAP lookup is
 * tolerant of trivial capitalization / whitespace variance. Lowercase the
 * string, collapse any run of whitespace to a single space, trim. The
 * roster-upload Function stores HEADER_MAP keys already in this canonical
 * form so lookups are a direct `map[normalizeHeader(h)]`.
 * @param {string} s
 * @returns {string}
 */
export function normalizeHeader(s) {
  if (typeof s !== "string") return "";
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
