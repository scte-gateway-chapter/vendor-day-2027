// POST /api/admin-login
//
// Validates a submitted admin passphrase against the PBKDF2-SHA-256 hash stored
// in `env.ADMIN_PASSPHRASE_HASH` (produced by `scripts/hash-passphrase.js`).
// On success, returns a 12-hour HS256 JWT signed with `env.ADMIN_JWT_SECRET`.
// Applies a Cloudflare KV-backed rate limit of 5 failures per 10 minutes per IP.
"use strict";

import { signAdminJwt } from "../_shared/_jwt.js";
import {
  checkLoginRate,
  recordLoginFailure,
  resetLoginAttempts,
} from "../_shared/_rate-limit.js";

const JWT_EXPIRY_SEC = 12 * 60 * 60;

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

function base64DecodeToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64EncodeBytes(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// XOR-fold byte comparison. Length-mismatch returns false but still iterates
// the full compare path so the branch does not leak timing.
function constantTimeStringEqual(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

async function derivePbkdf2(passphrase, salt, iterations, keyLengthBytes) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    keyLengthBytes * 8,
  );
  return new Uint8Array(bits);
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();

  const cors = sameOriginCors(request);
  if (cors === null) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }
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

  let payload;
  try {
    payload = await request.json();
  } catch (_err) {
    return jsonResponse({ error: "Invalid JSON body" }, 400, cors);
  }

  const passphrase =
    typeof payload?.passphrase === "string" ? payload.passphrase : "";
  if (!passphrase) {
    return jsonResponse({ error: "Missing passphrase" }, 400, cors);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

  const rate = await checkLoginRate(env, ip);
  if (!rate.ok) {
    return jsonResponse(
      { error: "Too many attempts", retryAfterSec: rate.retryAfterSec },
      429,
      { ...cors, "Retry-After": String(rate.retryAfterSec) },
    );
  }

  const stored = env.ADMIN_PASSPHRASE_HASH;
  if (!stored) {
    console.error("ADMIN_PASSPHRASE_HASH env var is not set");
    return jsonResponse({ error: "Server misconfigured" }, 500, cors);
  }
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") {
    console.error("ADMIN_PASSPHRASE_HASH has unexpected format");
    return jsonResponse({ error: "Server misconfigured" }, 500, cors);
  }
  const iterations = Number.parseInt(parts[2], 10);
  if (!Number.isFinite(iterations) || iterations < 1) {
    console.error("ADMIN_PASSPHRASE_HASH iterations field is invalid");
    return jsonResponse({ error: "Server misconfigured" }, 500, cors);
  }
  let salt;
  let expectedBytes;
  try {
    salt = base64DecodeToBytes(parts[3]);
    expectedBytes = base64DecodeToBytes(parts[4]);
  } catch (_err) {
    console.error("ADMIN_PASSPHRASE_HASH salt or hash is not valid base64");
    return jsonResponse({ error: "Server misconfigured" }, 500, cors);
  }

  const keyLen = expectedBytes.length > 0 ? expectedBytes.length : 32;
  const derived = await derivePbkdf2(passphrase, salt, iterations, keyLen);
  const derivedB64 = base64EncodeBytes(derived);

  if (!constantTimeStringEqual(derivedB64, parts[4])) {
    await recordLoginFailure(env, ip);
    return jsonResponse({ error: "Incorrect passphrase" }, 401, cors);
  }

  await resetLoginAttempts(env, ip);
  const token = await signAdminJwt(env, {});
  const expiresAt = new Date(
    (Math.floor(Date.now() / 1000) + JWT_EXPIRY_SEC) * 1000,
  ).toISOString();
  return jsonResponse({ token, expiresAt }, 200, cors);
}
