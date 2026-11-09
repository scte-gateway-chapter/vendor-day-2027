// POST /api/signin-mark-bsc
//
// Public (no admin JWT) endpoint called by the attendee app when a
// signer accepts the retroactive BSC pre-reg prompt. Validates that
// `docId` + `email` match a row in Firestore `signIns`, then PATCHes
// `bsc_competitor: "yes"` + `updatedAt` on that row via the service
// account. Rules deny direct client updates, so this broker is the
// only sanctioned path for the flip.
//
// Same-origin CORS mirrors `functions/api/firestore-write.js`. The
// endpoint is deliberately unauthenticated: the brute-force surface is
// bounded by the 10-60 char doc-id regex + an email ownership check,
// and a successful discovery only flips a boolean on a public-create
// record. See design "No rate limiting on this endpoint".
"use strict";

import {
  firestoreRequest,
  firestorePayloadFromObject,
} from "../_shared/_google-auth.js";

const DOC_ID_RE = /^[A-Za-z0-9_-]{10,60}$/;
const HANDLER_TIMEOUT_MS = 5000;

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
      console.warn("[signin-mark-bsc] handler timed out");
      return jsonResponse({ ok: false, reason: "timeout" }, 504, cors);
    }
    console.warn("[signin-mark-bsc] unexpected error:", err);
    return jsonResponse({ ok: false, reason: "server-error" }, 500, cors);
  }
}

async function run(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch (_err) {
    return jsonResponse({ ok: false, reason: "invalid-input" }, 400, cors);
  }

  const docId = typeof body?.docId === "string" ? body.docId : "";
  const rawEmail = typeof body?.email === "string" ? body.email : "";
  const email = rawEmail.trim().toLowerCase();

  if (!DOC_ID_RE.test(docId) || !email) {
    return jsonResponse({ ok: false, reason: "invalid-input" }, 400, cors);
  }

  let doc;
  try {
    doc = await firestoreRequest(env, {
      method: "GET",
      path: `signIns/${encodeURIComponent(docId)}`,
    });
  } catch (err) {
    if (err?.status === 404) {
      // Not-found and email-mismatch both return the same shape so
      // doc-id scanning reveals nothing about which real ids exist.
      return jsonResponse({ ok: false, reason: "not-found" }, 404, cors);
    }
    console.warn("[signin-mark-bsc] GET signIns failed:", err);
    return jsonResponse({ ok: false, reason: "upstream" }, 502, cors);
  }

  const storedEmail =
    typeof doc?.fields?.email?.stringValue === "string"
      ? doc.fields.email.stringValue.trim().toLowerCase()
      : "";
  if (storedEmail !== email) {
    return jsonResponse({ ok: false, reason: "not-found" }, 404, cors);
  }

  try {
    await firestoreRequest(env, {
      method: "PATCH",
      path:
        `signIns/${encodeURIComponent(docId)}` +
        "?updateMask.fieldPaths=bsc_competitor" +
        "&updateMask.fieldPaths=updatedAt",
      body: firestorePayloadFromObject({
        bsc_competitor: "yes",
        updatedAt: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.warn("[signin-mark-bsc] PATCH signIns failed:", err);
    return jsonResponse({ ok: false, reason: "upstream" }, 502, cors);
  }

  return jsonResponse({ ok: true }, 200, cors);
}
