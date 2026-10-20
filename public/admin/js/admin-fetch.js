// admin-fetch.js — thin fetch wrapper for admin API calls (Task 16).
//
// Attaches `Authorization: Bearer <jwt>` from the stored session, defaults
// `credentials: "same-origin"`, and translates the three admin-specific
// response paths into Error instances with a stable `.code` property so
// callers can branch without re-parsing the body.
//
// Error codes thrown:
//   "no-session"      — no JWT in sessionStorage; the request was never sent
//   "session-expired" — server returned 401; the local session was cleared
//                       and a full-page redirect to /admin/?reason=expired
//                       is already in flight by the time this throws
//   "rate-limited"    — server returned 429; `.retryAfterSec` carries the
//                       lockout seconds (body first, then Retry-After header)
//   "http-error"      — any other non-2xx; `.status` carries the HTTP code
//   "network-error"   — fetch rejected before a response arrived (DNS,
//                       TCP, CORS). `.cause` carries the original error.
"use strict";

import { getAdminJwt, onSessionExpired } from "./admin-auth.js";

/**
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<any>} parsed JSON body, or null for 204/empty responses.
 */
export async function adminFetch(url, options = {}) {
  const token = getAdminJwt();
  if (!token) {
    const err = new Error("No admin session");
    err.code = "no-session";
    throw err;
  }

  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);

  let response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers,
    });
  } catch (cause) {
    const err = new Error("Network request failed");
    err.code = "network-error";
    err.cause = cause;
    throw err;
  }

  if (response.status === 401) {
    // Fire-and-forget: onSessionExpired triggers a full-page navigation.
    // Still throw so the caller unwinds cleanly before the reload lands.
    onSessionExpired("expired");
    const err = new Error("Admin session expired");
    err.code = "session-expired";
    throw err;
  }

  if (response.status === 429) {
    const body = await safeJson(response);
    const headerVal = response.headers.get("Retry-After");
    const headerSec = headerVal ? Number.parseInt(headerVal, 10) : NaN;
    const bodySec =
      body && Number.isFinite(Number(body.retryAfterSec))
        ? Number(body.retryAfterSec)
        : NaN;
    const retryAfterSec = Number.isFinite(bodySec)
      ? bodySec
      : Number.isFinite(headerSec)
      ? headerSec
      : 60;
    const err = new Error(body?.error || "Too many attempts");
    err.code = "rate-limited";
    err.retryAfterSec = retryAfterSec;
    throw err;
  }

  if (!response.ok) {
    const body = await safeJson(response);
    const err = new Error(
      body?.error || `Request failed with status ${response.status}`,
    );
    err.code = "http-error";
    err.status = response.status;
    throw err;
  }

  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_err) {
    // Non-JSON 2xx — surface the raw text so the caller can decide.
    return text;
  }
}

async function safeJson(response) {
  try {
    return await response.clone().json();
  } catch (_err) {
    return null;
  }
}
