#!/usr/bin/env node
/**
 * build-sw.js — stamp the current BUILD_ID into public/sw.js.
 *
 * Cloudflare Pages injects BUILD_ID at build time (via the dashboard build
 * command or a Pages env var). Locally, we fall back to Date.now() so each
 * local build still produces a unique cache namespace.
 *
 * The service worker ships with cache-name constants containing the literal
 * token `__BUILD_ID__` (e.g. `shell-v__BUILD_ID__`). This script replaces
 * both the first-build token form AND any already-stamped id so the second
 * build on the same working tree still produces a fresh id.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SW_PATH = path.join(__dirname, "..", "public", "sw.js");
// Matches shell-v__BUILD_ID__, content-v1234567, images-vabc_123, etc.
const CACHE_NAME_PATTERN = /(shell-v|content-v|images-v)[A-Za-z0-9_]+/g;

const buildId = (process.env.BUILD_ID && process.env.BUILD_ID.trim()) || Date.now().toString();

const original = fs.readFileSync(SW_PATH, "utf8");
const matches = original.match(CACHE_NAME_PATTERN) || [];
if (matches.length === 0) {
  console.error(`[build-sw] no cache-name constants found in ${SW_PATH}`);
  process.exit(1);
}

const stamped = original.replace(CACHE_NAME_PATTERN, (_m, prefix) => `${prefix}${buildId}`);
fs.writeFileSync(SW_PATH, stamped);

console.log(`[build-sw] stamped BUILD_ID=${buildId} across ${matches.length} cache name(s) in ${path.relative(process.cwd(), SW_PATH)}`);
