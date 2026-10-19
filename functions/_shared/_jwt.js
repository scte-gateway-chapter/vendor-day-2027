// Internal shared helper for signing and verifying the admin JWT.
//
// NOT routed as a URL. Cloudflare Pages Functions skips any file or directory
// whose name starts with an underscore when mapping functions to routes. The
// enclosing `_shared/` directory already satisfies that rule; the leading
// underscore on this filename is defensive clarity in case someone later
// renames the directory.
"use strict";

import { SignJWT, jwtVerify } from "jose";

const JWT_ALG = "HS256";
const JWT_EXPIRY_SEC = 12 * 60 * 60; // 12 hours per design section 6

function decodeSecret(env) {
  const raw = env?.ADMIN_JWT_SECRET;
  if (!raw) {
    throw new Error("ADMIN_JWT_SECRET env var is not set");
  }
  // scripts/hash-passphrase.js writes the secret as 32 random bytes encoded as
  // base64. Decode back to the raw bytes used as the HS256 key.
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Sign an admin JWT with HS256 and a 12-hour expiry.
 * @param {Object} env Cloudflare Pages Function env binding.
 * @param {Object} [payload] Additional claims to merge with the default sub.
 * @returns {Promise<string>} The compact JWT string.
 */
export async function signAdminJwt(env, payload = {}) {
  const now = Math.floor(Date.now() / 1000);
  const key = decodeSecret(env);
  return await new SignJWT({ sub: "admin", ...payload })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + JWT_EXPIRY_SEC)
    .sign(key);
}

/**
 * Verify an admin JWT. Throws on missing, bad signature, or expired tokens.
 * @param {Object} env Cloudflare Pages Function env binding.
 * @param {string} token The compact JWT string.
 * @returns {Promise<Object>} The decoded payload.
 */
export async function verifyAdminJwt(env, token) {
  if (!token) throw new Error("Missing token");
  const { payload } = await jwtVerify(token, decodeSecret(env), {
    algorithms: [JWT_ALG],
  });
  return payload;
}

/**
 * Extract the token from an `Authorization: Bearer <token>` request header.
 * @param {Request} request
 * @returns {string|null}
 */
export function extractBearer(request) {
  const header =
    request.headers.get("Authorization") || request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
