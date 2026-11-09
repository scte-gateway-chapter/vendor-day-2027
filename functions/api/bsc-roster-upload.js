// POST /api/bsc-roster-upload
//
// Admin-authenticated multipart broker that imports the Broadband Skills
// Challenge pre-registration roster from a Google-Sheets-exported CSV
// into Firestore `bscPreReg/{emailLowered}`. Each row is upserted via
// `PATCH ...?updateMask.fieldPaths=...` (semantically equivalent to the
// Admin SDK's `set({...}, { merge: true })` — see design "Vocabulary
// bridge"). Known columns are projected into the schema fields;
// unexpected columns are ignored. Rows with missing name or email are
// skipped and reported in `errors[]`; one bad row never aborts the
// whole import.
//
// After the row loop the Function paginates `GET bscPreReg?pageSize=1000`
// to count the collection (the Firestore `:runAggregationQuery` custom
// method cannot be invoked through the shared `firestoreRequest` helper
// — the URL shape is `.../documents/path` which produces a stray slash
// before the colon). The count + an ISO timestamp are PATCHed onto
// `appSettings/singleton` via `updateMask` so other singleton fields
// (eventTitle, signInEnabled, …) are preserved.
//
// Auth posture + CORS mirror `functions/api/firestore-write.js` verbatim.
// Multipart handling (file.size cap, allowed content types, formData()
// error branch) mirrors `functions/api/upload.js`.
"use strict";

import { extractBearer, verifyAdminJwt } from "../_shared/_jwt.js";
import {
  firestoreRequest,
  firestorePayloadFromObject,
  firestoreCountCollection,
} from "../_shared/_google-auth.js";
import { parseCsv, normalizeHeader } from "../_shared/_csv.js";

const MAX_BYTES = 1 * 1024 * 1024; // 1 MB — the 41-row 2026 roster is ~5 KB.
const ALLOWED_CONTENT_TYPES = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
]);

// Canonical (lowercase, single-space, trimmed) header labels mapped to
// the Firestore field names on `bscPreReg/{email}`. Admin-authored CSVs
// may vary trivial capitalization / whitespace; `normalizeHeader` folds
// those variants onto these keys. Unknown headers map to undefined and
// are ignored during row projection.
const HEADER_MAP = {
  "competitor name": "attendee_name",
  "email address": "email",
  "company": "company",
  "office location": "office_location",
  "job role / title": "job_role",
  "supervisor / manager name": "supervisor_name",
  "supervisor / manager email": "supervisor_email",
  "supervisor / manager phone": "supervisor_phone",
  "scte member id": "scte_member_id",
  "reference id": "reference_id",
  "submitted at": "submitted_at",
};

// Labels that MUST appear in the CSV header row (normalized form). The
// human-readable error message uses the original Google Sheet label.
const REQUIRED_HEADERS = [
  { key: "competitor name", label: "Competitor name" },
  { key: "email address", label: "Email address" },
];

function sameOriginCors(request) {
  const origin = request.headers.get("Origin");
  const expected = new URL(request.url).origin;
  if (origin && origin !== expected) return null;
  return {
    "Access-Control-Allow-Origin": expected,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function emptyResultError(message) {
  return { imported: 0, skipped: 0, errors: [message] };
}

/** Return true when the uploaded file "looks like" a CSV by either its
 *  filename extension or its browser-set content-type. */
function looksLikeCsv(file) {
  const name = typeof file?.name === "string" ? file.name : "";
  if (/\.csv$/i.test(name)) return true;
  const type = (file?.type || "").toLowerCase();
  if (!type) return false;
  return ALLOWED_CONTENT_TYPES.has(type);
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();

  const cors = sameOriginCors(request);
  if (cors === null) return jsonResponse({ error: "Forbidden" }, 403);
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (method !== "POST") {
    return jsonResponse(
      { error: "Method Not Allowed" },
      405,
      { ...cors, Allow: "POST" },
    );
  }

  const token = extractBearer(request);
  if (!token) {
    return jsonResponse({ error: "Unauthorized" }, 401, cors);
  }
  try {
    await verifyAdminJwt(env, token);
  } catch (_err) {
    return jsonResponse({ error: "Unauthorized" }, 401, cors);
  }

  let form;
  try {
    form = await request.formData();
  } catch (_err) {
    return jsonResponse(
      emptyResultError("Invalid multipart/form-data body"),
      400,
      cors,
    );
  }

  const file = form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    return jsonResponse(emptyResultError("Missing file field"), 400, cors);
  }
  if (file.size === 0) {
    return jsonResponse(emptyResultError("File is empty"), 400, cors);
  }
  if (file.size > MAX_BYTES) {
    return jsonResponse(
      emptyResultError(`File exceeds ${MAX_BYTES} bytes`),
      413,
      cors,
    );
  }
  if (!looksLikeCsv(file)) {
    return jsonResponse(
      emptyResultError("Unsupported file type (expected .csv)"),
      415,
      cors,
    );
  }

  let text;
  try {
    text = await file.text();
  } catch (_err) {
    return jsonResponse(
      emptyResultError("Could not read the uploaded file"),
      400,
      cors,
    );
  }

  let parsed;
  try {
    parsed = parseCsv(text);
  } catch (_err) {
    return jsonResponse(
      emptyResultError("Could not parse CSV"),
      400,
      cors,
    );
  }

  const headers = (parsed.headers || []).map(normalizeHeader);
  if (headers.length === 0) {
    return jsonResponse(
      emptyResultError("CSV has no header row"),
      400,
      cors,
    );
  }

  // Validate required headers up-front; one 400 per missing required
  // column (concatenated into the `errors` array) is friendlier than a
  // generic "bad CSV" for an admin troubleshooting a renamed column.
  const missingHeaderErrors = [];
  for (const required of REQUIRED_HEADERS) {
    if (!headers.includes(required.key)) {
      missingHeaderErrors.push(`Required column missing: ${required.label}`);
    }
  }
  if (missingHeaderErrors.length > 0) {
    return jsonResponse(
      { imported: 0, skipped: 0, errors: missingHeaderErrors },
      400,
      cors,
    );
  }

  // Build an index from each normalized header to its column position so
  // row projection is a single lookup per field.
  const columnIndex = {};
  headers.forEach((h, idx) => {
    const field = HEADER_MAP[h];
    if (field) columnIndex[field] = idx;
  });

  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  let imported = 0;
  let skipped = 0;
  const errors = [];
  // Distinct lowercased emails that successfully wrote. The within-CSV
  // duplicate count surfaced in the admin UI is `imported - uniqueEmails.size`
  // — two rows with the same email each PATCH the same `bscPreReg/{email}`
  // doc, so `imported` counts both while `uniqueEmails` counts one.
  const uniqueEmails = new Set();
  const importedAt = new Date().toISOString();

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 1; // 1-based for human-readable messages.
    const raw = rows[i];
    const cells = Array.isArray(raw) ? raw : [];

    // Project the row into the schema fields, trimming every known cell.
    const projected = {};
    for (const [field, idx] of Object.entries(columnIndex)) {
      const value = idx < cells.length ? cells[idx] : "";
      projected[field] = typeof value === "string" ? value.trim() : "";
    }

    const name = projected.attendee_name || "";
    let email = projected.email || "";
    if (!name || !email) {
      skipped++;
      errors.push(`Row ${rowNumber}: missing name or email`);
      continue;
    }
    email = email.toLowerCase();
    projected.email = email;

    const payloadObject = { ...projected, importedAt };
    const maskParams = Object.keys(payloadObject).map(
      (k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`,
    );
    const path =
      `bscPreReg/${encodeURIComponent(email)}?${maskParams.join("&")}`;

    try {
      await firestoreRequest(env, {
        method: "PATCH",
        path,
        body: firestorePayloadFromObject(payloadObject),
      });
      imported++;
      uniqueEmails.add(email);
    } catch (err) {
      skipped++;
      const status = err?.status ? err.status : "unknown";
      errors.push(`Row ${rowNumber}: Firestore write failed (${status})`);
      console.warn("[bsc-roster-upload] row failed:", rowNumber, err);
    }
  }

  // Post-import bookkeeping. Both legs are best-effort — a failure here
  // only appends to `errors[]` and still returns 200 so the primary
  // import outcome is reported honestly to the admin UI.
  let rosterCount = null;
  try {
    rosterCount = await firestoreCountCollection(env, "bscPreReg");
  } catch (err) {
    console.warn("[bsc-roster-upload] count refresh failed:", err);
    errors.push(`Count refresh failed: ${err?.message || "unknown error"}`);
  }

  if (rosterCount !== null) {
    try {
      const bookkeepingBody = firestorePayloadFromObject({
        bscRosterCount: rosterCount,
        bscRosterLastImportedAt: new Date().toISOString(),
      });
      await firestoreRequest(env, {
        method: "PATCH",
        path:
          "appSettings/singleton" +
          "?updateMask.fieldPaths=bscRosterCount" +
          "&updateMask.fieldPaths=bscRosterLastImportedAt",
        body: bookkeepingBody,
      });
    } catch (err) {
      console.warn("[bsc-roster-upload] appSettings bookkeeping failed:", err);
      errors.push(
        `appSettings bookkeeping failed: ${err?.message || "unknown error"}`,
      );
    }
  }

  // `rosterCount` is the post-upload total; `uniqueEmails` lets the
  // client compute within-CSV duplicates without a second call. Both
  // may be omitted if the count refresh failed above (best-effort).
  const response = { imported, skipped, errors, uniqueEmails: uniqueEmails.size };
  if (rosterCount !== null) response.rosterCount = rosterCount;
  return jsonResponse(response, 200, cors);
}
