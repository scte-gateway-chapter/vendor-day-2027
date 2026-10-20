// markdown-mini.js — tiny, SAFE markdown subset for announcement bodies.
//
// Design rules:
//   1. HTML-escape the source first, then transform the whitelisted markdown
//      syntax on the escaped text. Because `*`, `_`, `[`, `(`, `` ` ``, `-`
//      are not HTML characters, markdown transforms still work after escape;
//      any raw `<`, `>`, `&`, `"`, `'` the author typed survives as literal
//      text (`<script>` lands as `&lt;script&gt;` in the output).
//   2. Links accept only `https:`, `http:`, and `mailto:` schemes. Any
//      other scheme (notably `javascript:` and `data:`) causes the match
//      to render as plain text with the brackets intact.
//   3. Links always get `rel="noopener noreferrer"` and `target="_blank"`.
//   4. Code spans are processed first and parked under placeholder tokens
//      so their contents don't participate in bold / italic / link
//      transforms (`**` inside a code span stays literal).
//
// Supported syntax:
//   - Paragraphs separated by one or more blank lines
//   - Single newline inside a paragraph becomes `<br>`
//   - **bold** or __bold__
//   - *italic* or _italic_
//   - `inline code`
//   - [label](https://example.com)   (http:, https:, mailto: only)
//   - `-` / `*` lines  → <ul><li>
//   - `1.` / `2.` ...  → <ol><li>
"use strict";

/**
 * Render a markdown subset to safe HTML.
 * @param {string} src
 * @returns {string}
 */
export function renderMarkdown(src) {
  if (typeof src !== "string" || src.length === 0) return "";

  // Normalize CRLF → LF so block splitting is predictable, then escape.
  const escaped = escapeHtml(src.replace(/\r\n?/g, "\n"));

  const blocks = escaped.split(/\n{2,}/);
  const out = [];
  for (const raw of blocks) {
    const block = raw.replace(/^\n+|\n+$/g, "");
    if (!block) continue;
    const lines = block.split("\n");

    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      const items = lines
        .map((l) => renderInline(l.replace(/^\s*[-*]\s+/, "")))
        .map((inner) => `<li>${inner}</li>`)
        .join("");
      out.push(`<ul>${items}</ul>`);
      continue;
    }

    if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
      const items = lines
        .map((l) => renderInline(l.replace(/^\s*\d+\.\s+/, "")))
        .map((inner) => `<li>${inner}</li>`)
        .join("");
      out.push(`<ol>${items}</ol>`);
      continue;
    }

    out.push(`<p>${lines.map(renderInline).join("<br>")}</p>`);
  }
  return out.join("");
}

export default renderMarkdown;

/* ---------------- Inline formatting ---------------- */

const ALLOWED_SCHEME = /^(https?:|mailto:)/i;

function renderInline(text) {
  // 1. Park code spans under placeholder tokens so their contents are
  // immune to the bold / italic / link transforms below. The tokens use
  // characters that cannot appear in HTML-escaped text so they survive
  // all later regex passes.
  const codeSlots = [];
  let s = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = codeSlots.length;
    codeSlots.push(code);
    return `\u0001CODE${idx}\u0001`;
  });

  // 2. Links. The URL and label are already HTML-escaped, so the href
  // interpolation is attribute-safe. Non-whitelisted schemes fall
  // through to the match itself so the brackets render as plain text.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    if (!ALLOWED_SCHEME.test(url)) return match;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // 3. Bold before italic so `**x**` is not consumed as `*(*x*)*`.
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");

  // 4. Italic. Guard the leading boundary so a standalone `*` or `_`
  // (e.g. the remnant of a `**` run or `_` inside `snake_case`) does
  // not trigger a bogus match.
  s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>");

  // 5. Restore the code spans. The code bodies are already HTML-escaped.
  s = s.replace(/\u0001CODE(\d+)\u0001/g, (_m, idx) => `<code>${codeSlots[Number(idx)]}</code>`);
  return s;
}

/* ---------------- Escaping ---------------- */

/**
 * HTML-escape a string so it is safe to interpolate into element text or
 * attribute values. Exported so other views can share this one copy
 * instead of pasting the same five-character map everywhere.
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
