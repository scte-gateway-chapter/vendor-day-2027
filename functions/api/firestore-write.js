// POST /api/firestore-write
//
// Admin-authenticated broker for Firestore writes. Firestore security rules
// deny all client writes, so admin editors in the PWA route here. The handler
// validates the HS256 admin JWT, enforces an allow-list of collection names
// and a strict docId regex, server-stamps `updatedAt` / `updatedBy`, and then
// calls the Firestore REST API with a Google OAuth2 access token minted from
// the service account private key.
"use strict";

import { extractBearer, verifyAdminJwt } from "../_shared/_jwt.js";
import {
  firestoreRequest,
  firestorePayloadFromObject,
} from "../_shared/_google-auth.js";

const ALLOWED_COLLECTIONS = new Set([
  "agenda",
  "sponsors",
  "announcements",
  "attendees",
  "feedbackConfig",
  "recap",
  "appSettings",
]);
const DOC_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ALLOWED_OPS = new Set(["set", "update", "delete"]);

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
  let adminPayload;
  try {
    adminPayload = await verifyAdminJwt(env, token);
  } catch (_err) {
    return jsonResponse({ error: "Unauthorized" }, 401, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch (_err) {
    return jsonResponse({ error: "Invalid JSON body" }, 400, cors);
  }

  const { collection, docId, data, op } = body || {};
  if (typeof collection !== "string" || !ALLOWED_COLLECTIONS.has(collection)) {
    return jsonResponse(
      { error: "Invalid or disallowed collection" },
      400,
      cors,
    );
  }
  if (typeof docId !== "string" || !DOC_ID_RE.test(docId)) {
    return jsonResponse({ error: "Invalid docId" }, 400, cors);
  }
  if (typeof op !== "string" || !ALLOWED_OPS.has(op)) {
    return jsonResponse(
      { error: "Invalid op (must be set, update, or delete)" },
      400,
      cors,
    );
  }
  if (
    (op === "set" || op === "update") &&
    (data === null || typeof data !== "object" || Array.isArray(data))
  ) {
    return jsonResponse(
      { error: "Invalid data (must be an object for set/update)" },
      400,
      cors,
    );
  }

  const path = `${collection}/${encodeURIComponent(docId)}`;

  try {
    if (op === "delete") {
      await firestoreRequest(env, { method: "DELETE", path });
      return jsonResponse(
        { ok: true, deleted: `${collection}/${docId}` },
        200,
        cors,
      );
    }

    // Server-stamp updatedAt / updatedBy. The design doc models updatedBy as
    // a per-admin display name ("Board member A/B/C"). We only have the JWT
    // `sub` ("admin") today — multi-admin named sessions are future work.
    // TODO: once named sessions exist, accept an optional `admin` display
    // name on the request body and prefer it over the JWT sub.
    const stamped = {
      ...data,
      updatedAt: new Date().toISOString(),
      updatedBy:
        typeof adminPayload?.sub === "string" ? adminPayload.sub : "admin",
    };
    const payload = firestorePayloadFromObject(stamped);

    if (op === "set") {
      // Firestore REST does not expose a one-shot create-or-overwrite verb at
      // a known docId path. Using `PATCH` without an `updateMask` overwrites
      // the document in place (and creates it if absent), which is the
      // semantics we want for `set`. Keeps the request shape identical to
      // `update` other than the mask.
      const result = await firestoreRequest(env, {
        method: "PATCH",
        path,
        body: payload,
      });
      return jsonResponse(result, 200, cors);
    }

    // op === "update": partial write via updateMask listing the writable keys.
    const maskParams = Object.keys(stamped).map(
      (k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`,
    );
    const result = await firestoreRequest(env, {
      method: "PATCH",
      path: `${path}?${maskParams.join("&")}`,
      body: payload,
    });
    return jsonResponse(result, 200, cors);
  } catch (err) {
    const status =
      typeof err?.status === "number" && err.status >= 400 && err.status < 600
        ? err.status
        : 502;
    return jsonResponse(
      { error: err?.message || "Firestore request failed" },
      status,
      cors,
    );
  }
}
