// POST /api/bsc-register
//
// Public (no admin JWT) upsert endpoint for the standalone BSC
// pre-registration form at `#/pre-register-bsc`. Validates 9 fields,
// rate-limits by IP via the shared `ADMIN_LOGIN_RATE` KV binding with
// a distinct key prefix, scans `bscPreReg` for `reference_id`
// collisions (regenerating with a 4-char hex suffix on hit), then
// PATCHes `bscPreReg/{emailLowered}` with set+merge semantics using
// per-field `updateMask`. Best-effort bookkeeping refreshes
// `appSettings/singleton.bscRosterCount` + `.bscRosterLastImportedAt`
// after the primary upsert.
//
// Same-origin CORS mirrors `functions/api/signin-mark-bsc.js`.
"use strict";

import {
  firestoreRequest,
  firestorePayloadFromObject,
  firestoreCountCollection,
  firestoreRunQuery,
} from "../_shared/_google-auth.js";
import { checkAndRecordRate } from "../_shared/_rate-limit.js";

const RATE_KEY_PREFIX = "vendorday2027:bsc-register:";
const RATE_MAX = 10;
const RATE_WINDOW_SEC = 3600;

const HANDLER_TIMEOUT_MS = 10_000;
const MAX_FIELD_LEN = 200;
const MAX_COLLISION_SCANS = 3; // initial scan + 2 suffixed retries

// Mirrors `isLikelyEmail` / `isLikelyPhone` on the client side.
// Pages Functions do not import from `public/` (different runtime
// surface), so the server inlines the regex + digit check per design.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function sameOriginCors(request) {
  const origin = request.headers.get("Origin");
  const expected = new URL(request.url).origin;
  if (origin && origin !== expected) return null;
  return {
    "Access-Control-Allow-Origin": expected,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => {
        const err = new Error("handler timeout");
        err.code = "handler-timeout";
        reject(err);
      }, ms),
    ),
  ]);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Build a `BSC-YYYYMMDD-HHMMSS` reference id from `now`. Uses the
 * Function's local wall clock.
 */
function buildBaseReferenceId(now) {
  // KNOWN LIMITATION (deferred from Phase 1): Workers runs with TZ=UTC,
  // so late-evening Central-time submits get a next-day date in the
  // reference_id. See admin-runbook.md > "BSC pre-registration page"
  // for the user-facing note. A future phase can swap this for an
  // Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', ... })
  // pass if the chapter grows beyond a single-timezone footprint.
  const y = now.getFullYear();
  const mo = pad2(now.getMonth() + 1);
  const d = pad2(now.getDate());
  const h = pad2(now.getHours());
  const mi = pad2(now.getMinutes());
  const s = pad2(now.getSeconds());
  return `BSC-${y}${mo}${d}-${h}${mi}${s}`;
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

  try {
    return await withTimeout(run(request, env, cors), HANDLER_TIMEOUT_MS);
  } catch (err) {
    if (err?.code === "handler-timeout") {
      console.warn("[bsc-register] handler timed out");
      return jsonResponse({ ok: false, reason: "timeout" }, 504, cors);
    }
    console.warn("[bsc-register] unexpected error:", err);
    return jsonResponse({ ok: false, reason: "server-error" }, 500, cors);
  }
}

async function run(request, env, cors) {
  // Rate limit by IP first — reject before we parse the body so a
  // flood of malformed submits still consumes the counter.
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const limit = await checkAndRecordRate(env, {
    ip,
    keyPrefix: RATE_KEY_PREFIX,
    max: RATE_MAX,
    windowSec: RATE_WINDOW_SEC,
  });
  if (!limit.ok) {
    return jsonResponse(
      { ok: false, reason: "rate-limited", retryAfterSec: limit.retryAfterSec },
      429,
      { ...cors, "Retry-After": String(limit.retryAfterSec) },
    );
  }

  let form;
  try {
    form = await request.formData();
  } catch (_err) {
    return jsonResponse({ ok: false, reason: "invalid-body" }, 400, cors);
  }

  const raw = {
    attendee_name: readField(form, "attendee_name"),
    email: readField(form, "email"),
    company: readField(form, "company"),
    office_location: readField(form, "office_location"),
    job_role: readField(form, "job_role"),
    supervisor_name: readField(form, "supervisor_name"),
    supervisor_email: readField(form, "supervisor_email"),
    supervisor_phone: readField(form, "supervisor_phone"),
    scte_member_id: readField(form, "scte_member_id"),
  };

  const validation = validate(raw);
  if (!validation.ok) {
    return jsonResponse({ ok: false, reason: validation.reason }, 400, cors);
  }
  const projected = validation.projected;

  // Reference id generation + collision scan.
  const now = new Date();
  const nowIso = now.toISOString();
  const baseCandidate = buildBaseReferenceId(now);
  let candidate = baseCandidate;
  let scans = 0;
  let collided = true;
  while (scans < MAX_COLLISION_SCANS) {
    scans++;
    let hit = false;
    try {
      const result = await firestoreRunQuery(env, {
        from: [{ collectionId: "bscPreReg" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "reference_id" },
            op: "EQUAL",
            value: { stringValue: candidate },
          },
        },
        limit: 1,
      });
      hit = Array.isArray(result) && result.some((r) => r && r.document);
    } catch (err) {
      console.warn("[bsc-register] reference_id collision scan failed:", err);
      // Treat scan failure as "no collision" so a transient Firestore
      // hiccup does not block the submit. The primary PATCH below will
      // surface a real upstream failure on its own.
      hit = false;
    }
    if (!hit) {
      collided = false;
      break;
    }
    // Build "<xx><xx>" from two random bytes using only Workers builtins.
    // crypto.randomBytes is Node-only and is NOT available in the Workers
    // runtime; crypto.getRandomValues is the correct choice here.
    const suffix = Array.from(
      crypto.getRandomValues(new Uint8Array(2)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    candidate = `${baseCandidate}-${suffix}`;
  }
  if (collided) {
    // KNOWN LIMITATION (deferred from Phase 1): if all three scans collide,
    // we proceed with a reference_id that already exists on another
    // bscPreReg doc (different email). CSV exports can then show two
    // rows with the same reference_id. Birthday-collision probability
    // across 2 same-second scans with 16-bit entropy is ~2^-30 which is
    // effectively zero for our scale, but a future phase could switch
    // to a longer random suffix or append a -dup<N> marker here.
    console.warn(
      "[bsc-register] reference_id collided on all scans; proceeding with suffixed value",
      { candidate },
    );
  }
  const referenceId = candidate;

  const email = projected.email;
  const payloadObject = {
    ...projected,
    reference_id: referenceId,
    submitted_at: nowIso,
    importedAt: nowIso,
  };
  const maskKeys = Object.keys(payloadObject);
  const maskParams = maskKeys
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join("&");
  const path = `bscPreReg/${encodeURIComponent(email)}?${maskParams}`;

  try {
    await firestoreRequest(env, {
      method: "PATCH",
      path,
      body: firestorePayloadFromObject(payloadObject),
    });
  } catch (err) {
    console.warn("[bsc-register] bscPreReg PATCH failed:", err);
    return jsonResponse({ ok: false, reason: "upstream" }, 502, cors);
  }

  // Best-effort bookkeeping — failures do NOT fail the primary upsert.
  const errors = [];
  let rosterCount = null;
  try {
    rosterCount = await firestoreCountCollection(env, "bscPreReg");
  } catch (err) {
    console.warn("[bsc-register] count refresh failed:", err);
    errors.push(`count refresh failed: ${err?.message || "unknown error"}`);
  }
  if (rosterCount !== null) {
    try {
      await firestoreRequest(env, {
        method: "PATCH",
        path:
          "appSettings/singleton" +
          "?updateMask.fieldPaths=bscRosterCount" +
          "&updateMask.fieldPaths=bscRosterLastImportedAt",
        body: firestorePayloadFromObject({
          bscRosterCount: rosterCount,
          bscRosterLastImportedAt: new Date().toISOString(),
        }),
      });
    } catch (err) {
      console.warn("[bsc-register] appSettings bookkeeping failed:", err);
      errors.push(
        `appSettings bookkeeping failed: ${err?.message || "unknown error"}`,
      );
    }
  }

  const response = { ok: true, reference_id: referenceId, email };
  if (errors.length > 0) response.errors = errors;
  return jsonResponse(response, 200, cors);
}

function readField(form, name) {
  const v = form.get(name);
  if (typeof v !== "string") return "";
  return v;
}

function validate(raw) {
  // Required text fields: trim, non-empty, maxLength.
  const requiredText = [
    "attendee_name",
    "company",
    "office_location",
    "job_role",
    "supervisor_name",
  ];
  const projected = {};
  for (const field of requiredText) {
    const trimmed = (raw[field] || "").trim();
    if (!trimmed) return { ok: false, reason: `${field} required` };
    if (trimmed.length > MAX_FIELD_LEN) {
      return { ok: false, reason: `${field} invalid` };
    }
    projected[field] = trimmed;
  }

  // Emails: trim, lowercase, regex.
  const email = (raw.email || "").trim().toLowerCase();
  if (!email) return { ok: false, reason: "email required" };
  if (email.length > MAX_FIELD_LEN || !EMAIL_RE.test(email)) {
    return { ok: false, reason: "email invalid" };
  }
  projected.email = email;

  const supervisorEmail = (raw.supervisor_email || "").trim().toLowerCase();
  if (!supervisorEmail) {
    return { ok: false, reason: "supervisor_email required" };
  }
  if (supervisorEmail.length > MAX_FIELD_LEN || !EMAIL_RE.test(supervisorEmail)) {
    return { ok: false, reason: "supervisor_email invalid" };
  }
  projected.supervisor_email = supervisorEmail;

  // Phone: trim, maxLength on the raw formatted string, ≥7 digits.
  const phoneRaw = (raw.supervisor_phone || "").trim();
  if (!phoneRaw) return { ok: false, reason: "supervisor_phone required" };
  if (phoneRaw.length > MAX_FIELD_LEN) {
    return { ok: false, reason: "supervisor_phone invalid" };
  }
  const digits = phoneRaw.replace(/[^\d]/g, "");
  if (digits.length < 7) {
    return { ok: false, reason: "supervisor_phone invalid" };
  }
  projected.supervisor_phone = phoneRaw;

  // Optional SCTE member id.
  const scteId = (raw.scte_member_id || "").trim();
  if (scteId.length > MAX_FIELD_LEN) {
    return { ok: false, reason: "scte_member_id invalid" };
  }
  projected.scte_member_id = scteId;

  return { ok: true, projected };
}
