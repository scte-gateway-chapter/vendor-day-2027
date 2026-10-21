// /api/send-push
//
// POST  — admin-authenticated. Broadcasts a push notification via the OneSignal
//         REST API, then (best-effort) stamps `pushSent` / `pushSentAt` on the
//         announcement document in Firestore.
// GET  ?healthcheck=1 — admin-authenticated. Lightweight reachability check
//         for the admin dashboard health strip (Task 17): verifies the
//         Firestore service account and the OneSignal REST key both respond.
"use strict";

import { extractBearer, verifyAdminJwt } from "../_shared/_jwt.js";
import {
  firestoreRequest,
  firestorePayloadFromObject,
} from "../_shared/_google-auth.js";

// Current OneSignal REST base. OneSignal's current docs standardize on
// `api.onesignal.com` without the `/v1/` prefix for the Create Notification
// endpoint; the legacy host `onesignal.com/api/v1/...` still works but is not
// the maintained URL. Swap this constant if OneSignal ever retires the current
// endpoint.
const ONESIGNAL_BASE = "https://api.onesignal.com";

// Current segment name per OneSignal docs. Older OneSignal docs targeted the
// built-in segment `All`; `Subscribed Users` is the maintained name for new
// apps and is what the OneSignal dashboard creates for a fresh Web app.
const DEFAULT_SEGMENT = "Subscribed Users";

const APP_PUBLIC_ORIGIN = "https://2027vendorday.gatewayscte.org";

function sameOriginCors(request) {
  const origin = request.headers.get("Origin");
  const expected = new URL(request.url).origin;
  if (origin && origin !== expected) return null;
  return {
    "Access-Control-Allow-Origin": expected,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

function trimmedStr(v, min, max) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length < min || t.length > max) return null;
  return t;
}

async function authorize(env, request, cors) {
  const token = extractBearer(request);
  if (!token) {
    return { response: jsonResponse({ error: "Unauthorized" }, 401, cors) };
  }
  try {
    const payload = await verifyAdminJwt(env, token);
    return { payload };
  } catch (_err) {
    return { response: jsonResponse({ error: "Unauthorized" }, 401, cors) };
  }
}

async function runHealthcheck(env, cors) {
  const result = { firestore: "fail", onesignal: "fail" };

  // Firestore reachability: list a tiny slice of `appSettings`. A 200 (even if
  // empty) proves the service account can mint a token and reach Firestore.
  try {
    await firestoreRequest(env, {
      method: "GET",
      path: "appSettings",
      query: { pageSize: "1" },
    });
    result.firestore = "ok";
  } catch (err) {
    console.warn("Firestore healthcheck failed:", err?.message || err);
  }

  // OneSignal reachability: GET /notifications?app_id=<id>&limit=1. Using the
  // app-level REST API key only grants access to app-scoped endpoints such as
  // `/notifications` and `/players`; the `/apps/<id>` endpoint requires the
  // organization-level User Auth Key which the chapter does not have. A GET
  // against the notifications collection returns 200 regardless of whether
  // any notifications exist and proves the REST key is valid for the app.
  try {
    const appId = env.ONESIGNAL_APP_ID;
    const key = env.ONESIGNAL_REST_API_KEY;
    if (!appId || !key) throw new Error("Missing OneSignal env vars");
    const res = await fetch(
      `${ONESIGNAL_BASE}/notifications?app_id=${encodeURIComponent(appId)}&limit=1`,
      {
        headers: {
          Authorization: `Basic ${key}`,
          "Content-Type": "application/json",
        },
      },
    );
    if (res.ok) {
      result.onesignal = "ok";
    } else {
      console.warn(
        "OneSignal healthcheck non-2xx:",
        res.status,
        await res.text(),
      );
    }
  } catch (err) {
    console.warn("OneSignal healthcheck failed:", err?.message || err);
  }

  return jsonResponse(result, 200, cors);
}

async function sendPush(env, request, cors, authPayload) {
  let body;
  try {
    body = await request.json();
  } catch (_err) {
    return jsonResponse({ error: "Invalid JSON body" }, 400, cors);
  }

  const announcementId = trimmedStr(body?.announcementId, 1, 80);
  const title = trimmedStr(body?.title, 1, 120);
  const bodyPreview = trimmedStr(body?.bodyPreview, 1, 120);
  if (!announcementId || !title || !bodyPreview) {
    return jsonResponse(
      {
        error:
          "Missing or invalid announcementId, title, or bodyPreview (title and bodyPreview are 1-120 chars)",
      },
      400,
      cors,
    );
  }
  const url =
    typeof body?.url === "string" && body.url.trim()
      ? body.url.trim()
      : `${APP_PUBLIC_ORIGIN}/#/announcements/${encodeURIComponent(announcementId)}`;

  const appId = env.ONESIGNAL_APP_ID;
  const key = env.ONESIGNAL_REST_API_KEY;
  if (!appId || !key) {
    console.error(
      "ONESIGNAL_APP_ID or ONESIGNAL_REST_API_KEY env var is not set",
    );
    return jsonResponse({ error: "Server misconfigured" }, 500, cors);
  }

  // OneSignal's current docs show `Authorization: Key <REST API key>` for keys
  // created in the newer app settings; legacy keys still use `Basic <key>` and
  // that is what the task spec and design doc call for. Switch to `Key` if the
  // chapter rotates to a newer-style key.
  const notification = {
    app_id: appId,
    included_segments: [DEFAULT_SEGMENT],
    headings: { en: title },
    contents: { en: bodyPreview },
    url,
  };

  let oneSignalRes;
  try {
    oneSignalRes = await fetch(`${ONESIGNAL_BASE}/notifications`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(notification),
    });
  } catch (err) {
    return jsonResponse(
      { error: `OneSignal request failed: ${err?.message || err}` },
      502,
      cors,
    );
  }

  const oneSignalText = await oneSignalRes.text();
  let oneSignalBody = null;
  if (oneSignalText) {
    try {
      oneSignalBody = JSON.parse(oneSignalText);
    } catch (_err) {
      // Non-JSON OneSignal body — pass the raw text in the error path below.
    }
  }

  if (!oneSignalRes.ok) {
    const raw =
      oneSignalBody?.errors?.[0] ||
      oneSignalBody?.error ||
      oneSignalText ||
      "OneSignal error";
    const message = typeof raw === "string" ? raw : JSON.stringify(raw);
    return jsonResponse({ error: message }, oneSignalRes.status, cors);
  }

  // Best-effort follow-up: flip pushSent / pushSentAt on the announcement doc.
  // If this fails we still return success to the client — the primary send
  // already landed, and the admin can mark it manually from the dashboard.
  try {
    const now = new Date().toISOString();
    const stamped = {
      pushSent: true,
      pushSentAt: now,
      updatedAt: now,
      updatedBy:
        typeof authPayload?.sub === "string" ? authPayload.sub : "admin",
    };
    const mask = Object.keys(stamped)
      .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
      .join("&");
    await firestoreRequest(env, {
      method: "PATCH",
      path: `announcements/${encodeURIComponent(announcementId)}?${mask}`,
      body: firestorePayloadFromObject(stamped),
    });
  } catch (err) {
    console.warn(
      "Secondary Firestore write (pushSent flag) failed:",
      err?.message || err,
    );
  }

  return jsonResponse({ ok: true, oneSignal: oneSignalBody }, 200, cors);
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();

  const cors = sameOriginCors(request);
  if (cors === null) return jsonResponse({ error: "Forbidden" }, 403);
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (method === "GET") {
    const url = new URL(request.url);
    if (url.searchParams.get("healthcheck") !== "1") {
      return jsonResponse(
        { error: "Method Not Allowed" },
        405,
        { ...cors, Allow: "POST, GET" },
      );
    }
    // Healthcheck is admin-only so the OneSignal app id and Firestore service
    // account are never probed by anonymous callers.
    const auth = await authorize(env, request, cors);
    if (auth.response) return auth.response;
    return await runHealthcheck(env, cors);
  }

  if (method !== "POST") {
    return jsonResponse(
      { error: "Method Not Allowed" },
      405,
      { ...cors, Allow: "POST, GET" },
    );
  }

  const auth = await authorize(env, request, cors);
  if (auth.response) return auth.response;
  return await sendPush(env, request, cors, auth.payload);
}
