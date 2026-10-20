// admin-auth.js — admin session storage helpers (Task 16).
//
// sessionStorage keys (so closing the tab clears the session):
//   vendorday2027.admin.jwt       — the HS256 token returned by /api/admin-login
//   vendorday2027.admin.expiresAt — the token's ISO 8601 expiry
//
// The expiry check is a client-side convenience to short-circuit requests
// we already know will be rejected; the server is the authority on
// signature + expiry (see functions/_shared/_jwt.js). Any 401 at request
// time still triggers the expired-redirect via onSessionExpired().
"use strict";

const JWT_KEY = "vendorday2027.admin.jwt";
const EXP_KEY = "vendorday2027.admin.expiresAt";

/** @returns {string|null} */
export function getAdminJwt() {
  try {
    return sessionStorage.getItem(JWT_KEY);
  } catch (_err) {
    // Private-mode / blocked storage: treat as logged out so the login
    // screen is the next thing the user sees.
    return null;
  }
}

/** @returns {string|null} */
export function getAdminExpiresAt() {
  try {
    return sessionStorage.getItem(EXP_KEY);
  } catch (_err) {
    return null;
  }
}

/**
 * @returns {boolean} true if a JWT exists in sessionStorage and the stored
 *   expiry is in the future.
 */
export function isAdminAuthenticated() {
  const token = getAdminJwt();
  if (!token) return false;
  const exp = getAdminExpiresAt();
  if (!exp) return false;
  const t = Date.parse(exp);
  if (!Number.isFinite(t)) return false;
  return t > Date.now();
}

/**
 * Persist the admin session to sessionStorage.
 * @param {{ token: string, expiresAt: string }} session
 */
export function storeAdminSession({ token, expiresAt } = {}) {
  if (!token || !expiresAt) {
    throw new Error("storeAdminSession requires both token and expiresAt");
  }
  try {
    sessionStorage.setItem(JWT_KEY, token);
    sessionStorage.setItem(EXP_KEY, expiresAt);
  } catch (err) {
    // If sessionStorage is unavailable the next request will throw with
    // code "no-session"; surface a warning so devtools shows what happened.
    console.warn("[admin-auth] failed to persist admin session:", err);
  }
}

/** Remove the stored JWT and expiry. Safe to call when nothing is stored. */
export function clearAdminSession() {
  try {
    sessionStorage.removeItem(JWT_KEY);
    sessionStorage.removeItem(EXP_KEY);
  } catch (err) {
    console.warn("[admin-auth] failed to clear admin session:", err);
  }
}

/**
 * Clear the stored session and reload at /admin/ with a `?reason=` flag so
 * the login screen can surface the appropriate banner. Called from the
 * fetch wrapper on 401 and from any caller that detects a bad token.
 * @param {"expired"|"invalid"} [reason]
 */
export function onSessionExpired(reason) {
  const r = reason === "invalid" ? "invalid" : "expired";
  clearAdminSession();
  // Full-page navigation so the admin shell boots from a clean state.
  // The login screen reads ?reason from the URL on first paint and clears
  // it via history.replaceState so a reload does not re-show the banner.
  window.location.href = `/admin/?reason=${r}`;
}
