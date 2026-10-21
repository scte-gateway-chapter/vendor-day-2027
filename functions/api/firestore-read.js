// GET /api/firestore-read
//
// Admin-authenticated broker for Firestore reads. Mirrors the shape of
// `firestore-write.js` but for GETs. Firestore security rules deny client
// reads of a few collections (feedbackResponses outright; attendees unless
// `optedOut == false`), so admin UIs that need the unfiltered set — the
// Attendees importer dedup lookup, the Feedback results view — route here.
// The handler validates the HS256 admin JWT and performs the read with the
// same Google OAuth2 access token used by the write broker.
"use strict";

import { extractBearer, verifyAdminJwt } from "../_shared/_jwt.js";
import {
  firestoreRequest,
  firestoreDocToPlain,
} from "../_shared/_google-auth.js";

const ALLOWED_COLLECTIONS = new Set([
  "agenda",
  "sponsors",
  "announcements",
  "attendees",
  "feedbackResponses",
  "feedbackConfig",
  "recap",
  "appSettings",
]);
const DOC_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

function sameOriginCors(request) {
  const origin = request.headers.get("Origin");
  const expected = new URL(request.url).origin;
  if (origin && origin !== expected) return null;
  return {
    "Access-Control-Allow-Origin": expected,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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
  if (method !== "GET") {
    return jsonResponse(
      { error: "Method Not Allowed" },
      405,
      { ...cors, Allow: "GET" },
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

  const url = new URL(request.url);
  const collection = url.searchParams.get("collection");
  const docId = url.searchParams.get("docId");
  const limitRaw = url.searchParams.get("limit");

  if (typeof collection !== "string" || !ALLOWED_COLLECTIONS.has(collection)) {
    return jsonResponse(
      { error: "Invalid or disallowed collection" },
      400,
      cors,
    );
  }
  if (docId !== null && !DOC_ID_RE.test(docId)) {
    return jsonResponse({ error: "Invalid docId" }, 400, cors);
  }
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null && limitRaw !== "") {
    const parsed = Number.parseInt(limitRaw, 10);
    if (
      !Number.isFinite(parsed) ||
      String(parsed) !== limitRaw.trim() ||
      parsed < 1 ||
      parsed > MAX_LIMIT
    ) {
      return jsonResponse(
        {
          error: `Invalid limit (must be an integer between 1 and ${MAX_LIMIT})`,
        },
        400,
        cors,
      );
    }
    limit = parsed;
  }

  try {
    if (docId) {
      const path = `${collection}/${encodeURIComponent(docId)}`;
      try {
        const result = await firestoreRequest(env, { method: "GET", path });
        return jsonResponse({ doc: firestoreDocToPlain(result) }, 200, cors);
      } catch (err) {
        if (err?.status === 404) {
          return jsonResponse({ doc: null }, 200, cors);
        }
        throw err;
      }
    }

    // Collection list. Follow `nextPageToken` until we hit `limit` docs or
    // the server runs out of pages. `pageSize` is capped at `MAX_LIMIT` per
    // call so Firestore never has to materialize more than 1000 docs at once.
    const docs = [];
    let pageToken = null;
    while (docs.length < limit) {
      const remaining = limit - docs.length;
      const pageSize = Math.min(remaining, MAX_LIMIT);
      const query = { pageSize: String(pageSize) };
      if (pageToken) query.pageToken = pageToken;
      const result = await firestoreRequest(env, {
        method: "GET",
        path: collection,
        query,
      });
      const page = Array.isArray(result?.documents) ? result.documents : [];
      for (const doc of page) {
        if (docs.length >= limit) break;
        docs.push(firestoreDocToPlain(doc));
      }
      pageToken =
        typeof result?.nextPageToken === "string" && result.nextPageToken
          ? result.nextPageToken
          : null;
      if (!pageToken || page.length === 0) break;
    }
    return jsonResponse({ docs }, 200, cors);
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
