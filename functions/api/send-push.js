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

// OneSignal's built-in "all subscribers" segment has had three different
// labels across their app generations: legacy "All", current "Subscribed
// Users" for Web apps, and "Total Subscriptions" for apps provisioned via
// their 2024+ onboarding. OneSignal's REST API ignores segment names it
// doesn't recognize, so listing all three guarantees the push lands on
// whatever the current OneSignal account actually has provisioned.
const DEFAULT_SEGMENTS = ["Subscribed Users", "All", "Total Subscriptions"];

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
    const msg = err?.message || String(err);
    result.firestoreError = msg;
    console.warn("Firestore healthcheck failed:", msg);
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
    if (!appId) throw new Error("ONESIGNAL_APP_ID env var is not set");
    if (!key) throw new Error("ONESIGNAL_REST_API_KEY env var is not set");
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
      const bodyText = (await res.text()) || "";
      result.onesignalError = `${res.status} ${res.statusText}: ${bodyText.slice(0, 300)}`;
      console.warn("OneSignal healthcheck non-2xx:", result.onesignalError);
    }
  } catch (err) {
    const msg = err?.message || String(err);
    result.onesignalError = msg;
    console.warn("OneSignal healthcheck failed:", msg);
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

  // `announcementId` is required when the push should deep-link into a
  // specific announcement AND when we want the broker to stamp
  // `pushSent` / `pushSentAt` on the announcement doc. For the Recap
  // push (Task 24) the caller passes an explicit `url` (pointing at
  // `#/recap`) and omits `announcementId`; in that mode the secondary
  // Firestore stamping below is skipped so we don't pollute the
  // `announcements` collection with a bogus doc.
  const announcementId = trimmedStr(body?.announcementId, 1, 80);
  const title = trimmedStr(body?.title, 1, 120);
  const bodyPreview = trimmedStr(body?.bodyPreview, 1, 120);
  const explicitUrl =
    typeof body?.url === "string" && body.url.trim() ? body.url.trim() : "";
  if (!title || !bodyPreview) {
    return jsonResponse(
      {
        error:
          "Missing or invalid title or bodyPreview (both are 1-120 chars)",
      },
      400,
      cors,
    );
  }
  if (!announcementId && !explicitUrl) {
    return jsonResponse(
      {
        error:
          "Request must include announcementId (to deep-link an announcement) or an explicit url",
      },
      400,
      cors,
    );
  }
  const url =
    explicitUrl
      || `${APP_PUBLIC_ORIGIN}/#/announcements/${encodeURIComponent(announcementId)}`;

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
    included_segments: DEFAULT_SEGMENTS,
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
  // Only applies when the push is bound to an announcement doc (Task 21).
  // Recap pushes (Task 24) omit `announcementId` because there is no
  // announcement to stamp — skip the secondary write in that case so we
  // don't pollute the announcements collection.
  // If this fails we still return success to the client — the primary send
  // already landed, and the admin can mark it manually from the dashboard.
  if (announcementId) {
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
