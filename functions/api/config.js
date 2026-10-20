// GET /api/config
//
// Returns the small set of PUBLIC configuration values the browser needs to
// talk to Firestore and OneSignal. These values are safe to expose:
//
//   - firebaseProjectId   : Firestore REST base path component
//   - firebaseWebApiKey   : Web API key gated by firestore.rules (public read only)
//   - oneSignalAppId      : OneSignal Web Push app id, loaded on Announcements
//   - assetsBaseUrl       : Public Cloudflare R2 bucket URL (pub-<hash>.r2.dev)
//                           for sponsor logos, venue map, and recap photos.
//                           Null when the R2_PUBLIC_URL env var is not set
//                           (e.g. preview deploys before the binding exists).
//
// Secret keys (service-account JSON, OneSignal REST key, admin JWT secret,
// admin passphrase hash) are NEVER returned here — they stay server-side.
"use strict";

function sameOriginCors(request) {
  const origin = request.headers.get("Origin");
  const expected = new URL(request.url).origin;
  if (origin && origin !== expected) return null;
  return {
    "Access-Control-Allow-Origin": expected,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Public, low-churn — fine to cache for a minute at the edge/browser so
      // the first render is fast on cold loads but a rotation lands quickly.
      "Cache-Control": "public, max-age=60",
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

  const firebaseProjectId = env.FIREBASE_PROJECT_ID || "";
  const firebaseWebApiKey = env.FIREBASE_WEB_API_KEY || "";
  const oneSignalAppId = env.ONESIGNAL_APP_ID || "";

  if (!firebaseProjectId || !firebaseWebApiKey) {
    // The client can still render the shell, but Firestore reads will fail.
    // Surface a 500 so devtools makes the misconfiguration obvious during QA.
    console.error(
      "FIREBASE_PROJECT_ID or FIREBASE_WEB_API_KEY env var is not set",
    );
    return jsonResponse(
      { error: "Server misconfigured: Firebase env vars missing" },
      500,
      cors,
    );
  }

  const assetsBaseUrl = env.R2_PUBLIC_URL || null;

  return jsonResponse(
    { firebaseProjectId, firebaseWebApiKey, oneSignalAppId, assetsBaseUrl },
    200,
    cors,
  );
}
