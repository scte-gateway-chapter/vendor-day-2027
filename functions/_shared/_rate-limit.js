// Internal admin-login rate limiter backed by a Cloudflare Workers KV
// namespace bound as `env.ADMIN_LOGIN_RATE`. Fails open (allows the login) if
// the binding is missing — this is defensive so local `wrangler pages dev`
// sessions without the KV bound still work, with a console warning so the
// omission is visible.
//
// NOT routed as a URL — see _jwt.js header for the Pages routing rule.
"use strict";

const MAX_ATTEMPTS = 5;
const WINDOW_SECONDS = 600; // 10 minutes per design section 6
const KEY_PREFIX = "vendorday2027:login-fail:";

function kv(env) {
  const ns = env?.ADMIN_LOGIN_RATE;
  if (!ns) {
    console.warn(
      "ADMIN_LOGIN_RATE KV binding is missing — admin login rate limiting is disabled (fail-open). " +
        "Bind the ADMIN_LOGIN_RATE KV namespace under Cloudflare Pages → Project → Settings → " +
        "Functions → KV namespace bindings before going live.",
    );
    return null;
  }
  return ns;
}

/**
 * Check whether the given IP is allowed to attempt an admin login right now.
 * @param {Object} env
 * @param {string} ip
 * @returns {Promise<{ok: true} | {ok: false, retryAfterSec: number}>}
 */
export async function checkLoginRate(env, ip) {
  const ns = kv(env);
  if (!ns) return { ok: true };
  const raw = await ns.get(KEY_PREFIX + ip);
  const count = raw ? Number.parseInt(raw, 10) : 0;
  if (Number.isFinite(count) && count >= MAX_ATTEMPTS) {
    // Workers KV `.get` does not surface the remaining TTL. Return the full
    // window as a conservative Retry-After; the counter will reset on its own
    // when the KV TTL expires.
    return { ok: false, retryAfterSec: WINDOW_SECONDS };
  }
  return { ok: true };
}

/**
 * Increment the failure counter for the given IP and set/refresh its TTL.
 */
export async function recordLoginFailure(env, ip) {
  const ns = kv(env);
  if (!ns) return;
  const key = KEY_PREFIX + ip;
  const raw = await ns.get(key);
  const next = (raw ? Number.parseInt(raw, 10) : 0) + 1;
  await ns.put(key, String(next), { expirationTtl: WINDOW_SECONDS });
}

/**
 * Clear the failure counter for the given IP on a successful login.
 */
export async function resetLoginAttempts(env, ip) {
  const ns = kv(env);
  if (!ns) return;
  await ns.delete(KEY_PREFIX + ip);
}
