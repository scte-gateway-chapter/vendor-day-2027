// collision-check.js — soft collision-safeguard helper (Task 17).
//
// Scaffolded in Task 17; Tasks 18-24 (every admin editor) consume all
// three exports exactly as described in design section 6:
//
//   snapshotEditingTimestamp(doc) — snapshot the `updatedAt` the editor
//                                   saw when it opened the modal.
//   hasConflict(latestDoc, snap)  — just before save, re-read the doc
//                                   and pass it here with the stored
//                                   snapshot; a `true` return means
//                                   someone else saved in the interim
//                                   and the caller should render the
//                                   Overwrite / Reload banner.
//   formatLastEditedPhrase(doc)   — "updated 2h ago by Board member A",
//                                   used verbatim by the dashboard
//                                   cards (Task 17) and by every editor's
//                                   "Last edited X by Y" header
//                                   (Tasks 18-24).
//
// Pure utility — no fetches, no DOM, no module-level state.
"use strict";

import { relativeTime } from "/js/utils/time.js";

/**
 * Snapshot the `updatedAt` an editor saw when it opened a doc. Returns
 * `null` for new docs (no `updatedAt` yet) and for a missing doc.
 * @param {object | null | undefined} docOrNull
 * @returns {string | null}
 */
export function snapshotEditingTimestamp(docOrNull) {
  return docOrNull?.updatedAt ?? null;
}

/**
 * Non-blocking collision check. Returns `true` when the latest server
 * copy of the doc has an `updatedAt` that differs from the snapshot the
 * editor stashed on open — i.e. someone else saved while this editor was
 * open. Returns `false` when the snapshot is null (new doc, or opened
 * before the doc had an `updatedAt`) or when the server doc has no
 * `updatedAt` yet (the editor is the first to write to it).
 * @param {object | null | undefined} latestDoc
 * @param {string | null | undefined} snapshot
 * @returns {boolean}
 */
export function hasConflict(latestDoc, snapshot) {
  if (!snapshot) return false;
  const latest = latestDoc?.updatedAt;
  if (!latest) return false;
  return latest !== snapshot;
}

/**
 * "updated 2h ago by Board member A" — the dashboard cards (Task 17)
 * and every editor's "Last edited X by Y" header (Tasks 18-24) call
 * this verbatim. A null doc, a missing `updatedAt`, or a value
 * `relativeTime` cannot parse all collapse to the sentinel "never
 * edited" so the UI never shows a dangling "updated  ago by —".
 * @param {object | null | undefined} doc
 * @returns {string}
 */
export function formatLastEditedPhrase(doc) {
  if (!doc || !doc.updatedAt) return "never edited";
  const when = relativeTime(doc.updatedAt);
  if (!when) return "never edited";
  const who = typeof doc.updatedBy === "string" && doc.updatedBy.trim()
    ? doc.updatedBy.trim()
    : "admin";
  return `updated ${when} by ${who}`;
}
