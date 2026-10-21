// csv-parse.js — hand-rolled CSV parser for the attendee importer (Task 22).
//
// Vendor Day ships zero npm runtime deps, so no PapaParse. The parser only
// needs to cope with what Google Sheets' "Download as .csv" produces for
// the chapter's registration sheet, plus the robustness bar in Task 22:
//   - comma delimiter (semicolons are intentionally out of scope),
//   - double-quoted fields with `""` as an escaped quote inside,
//   - embedded newlines inside quoted fields,
//   - mixed line endings (`\n`, `\r\n`, `\r`),
//   - empty fields and a trailing newline,
//   - leading UTF-8 BOM (Sheets exports occasionally include one).
//
// The parser is a tiny state machine with one boolean (`inQuotes`) plus
// `field` / `row` accumulators. It never allocates ahead for the full
// token set, so a 500-row CSV costs ~1 pass over the string.
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
  let input = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

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
 * Trim whitespace from every cell in a row. The importer calls this
 * before validating so "  Alice  " and "Alice" are treated as equal.
 * @param {string[]} row
 * @returns {string[]}
 */
export function trimRow(row) {
  if (!Array.isArray(row)) return [];
  return row.map((c) => (typeof c === "string" ? c.trim() : ""));
}
