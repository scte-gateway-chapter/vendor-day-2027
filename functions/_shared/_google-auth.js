// Internal helper that mints a short-lived Google OAuth2 access token from the
// Firebase service account private key and exposes a small `firestoreRequest`
// wrapper around the Firestore REST API.
//
// Why this exists: Cloudflare Pages Functions run on the Workers runtime,
// where the `firebase-admin` npm package historically needed the `nodejs_compat`
// flag and ships a sizeable bundle. Our server-side work here is small — a
// handful of Firestore reads and writes per admin action — so we skip
// `firebase-admin` at runtime entirely and talk to the Firestore REST API with
// a service-account-signed JWT exchanged for a Google OAuth2 access token (the
// standard RFC 7523 JWT bearer flow). `firebase-admin` stays in
// devDependencies, used only by `scripts/seed-app-settings.js` from a
// developer laptop.
//
// NOT routed as a URL — see _jwt.js header for the Pages routing rule.
"use strict";

import { SignJWT, importPKCS8 } from "jose";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/datastore",
  "https://www.googleapis.com/auth/cloud-platform",
].join(" ");
const JWT_LIFETIME_SEC = 3600; // Google caps the assertion at 1 hour
const TOKEN_CACHE_SEC = 55 * 60; // Refresh with 5 minutes of headroom

// Opportunistic in-isolate cache. Cloudflare isolates persist across requests
// within the same isolate, so this avoids re-signing a JWT on every call. Not
// shared across isolates — a fresh isolate just mints a new token.
let cached = null;

function parseServiceAccount(env) {
  const raw = env?.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON env var is not set");
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: " + err.message,
    );
  }
  const { client_email, private_key, project_id } = obj;
  if (!client_email || !private_key || !project_id) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is missing one of client_email, private_key, or project_id",
    );
  }
  // Service account JSON stores the key with literal \n sequences when pasted
  // as a one-line env var. Normalize so jose can parse the PEM.
  const pem = private_key.includes("\\n")
    ? private_key.replace(/\\n/g, "\n")
    : private_key;
  return { client_email, private_key: pem, project_id };
}

/**
 * Mint (or return a cached) Google OAuth2 access token suitable for Firestore
 * and Firebase Storage REST calls. The token is good for ~55 minutes.
 */
export async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt > now + 60) {
    return cached.accessToken;
  }
  const sa = parseServiceAccount(env);
  const privateKey = await importPKCS8(sa.private_key, "RS256");
  const assertion = await new SignJWT({ scope: SCOPES })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + JWT_LIFETIME_SEC)
    .sign(privateKey);

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  if (!data?.access_token) {
    throw new Error("Google token exchange returned no access_token");
  }
  const lifetime = Number(data.expires_in);
  cached = {
    accessToken: data.access_token,
    expiresAt:
      now +
      Math.min(TOKEN_CACHE_SEC, Number.isFinite(lifetime) ? lifetime - 60 : TOKEN_CACHE_SEC),
  };
  return cached.accessToken;
}

/**
 * Return the Firebase project id from the service account JSON.
 */
export function getProjectId(env) {
  return parseServiceAccount(env).project_id;
}

/**
 * Thin fetch helper around the Firestore REST API. The caller provides a path
 * relative to `.../documents/` (for example `agenda/<docId>` or `appSettings`).
 * Doc ids with reserved characters must be URL-encoded by the caller.
 *
 * @param {Object} env
 * @param {Object} opts
 * @param {"GET"|"POST"|"PATCH"|"DELETE"} opts.method
 * @param {string} opts.path Relative path; `""` targets `.../documents` itself.
 * @param {Object} [opts.body] JSON body, already shaped as a Firestore
 *   `Document` (see `firestorePayloadFromObject`).
 * @param {Record<string,string>} [opts.query] Extra URL query params.
 * @returns {Promise<any>} Parsed JSON response body (may be `null` on 204).
 */
export async function firestoreRequest(env, { method, path, body, query }) {
  const projectId = getProjectId(env);
  const token = await getAccessToken(env);
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const url = path ? `${base}/${path}${qs}` : `${base}${qs}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (_err) {
      // Non-JSON responses are left as-is for logging below.
    }
  }
  if (!res.ok) {
    const message =
      parsed?.error?.message ||
      (typeof parsed === "string" ? parsed : null) ||
      text ||
      `Firestore request failed with ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = parsed ?? text;
    throw err;
  }
  return parsed;
}

/**
 * Convert a plain JS object into Firestore's typed document shape:
 * `{ fields: { foo: { stringValue: "..." }, bar: { integerValue: "42" }, ... } }`.
 *
 * Supports string, finite number (integer vs double), boolean, null, Date
 * (serialized as ISO string), Array, and plain object (map). Unknown values
 * throw.
 */
export function firestorePayloadFromObject(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("firestorePayloadFromObject expects a plain object");
  }
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    fields[key] = toFirestoreValue(value);
  }
  return { fields };
}

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error("Non-finite numbers are not supported by Firestore REST");
    }
    return Number.isInteger(v)
      ? { integerValue: String(v) }
      : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toFirestoreValue) } };
  }
  if (typeof v === "object") {
    const inner = {};
    for (const [k, val] of Object.entries(v)) inner[k] = toFirestoreValue(val);
    return { mapValue: { fields: inner } };
  }
  throw new Error(`Unsupported Firestore value type: ${typeof v}`);
}
