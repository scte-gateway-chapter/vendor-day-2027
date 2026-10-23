#!/usr/bin/env node
/**
 * build-sw.js — stamp the current BUILD_ID AND inject the pre-cache
 * manifest into public/sw.js.
 *
 * Cloudflare Pages injects BUILD_ID at build time; locally we fall back
 * to Date.now() so each build still produces a unique cache namespace.
 *
 * The service worker ships with `__BUILD_ID__` tokens in its cache name
 * constants and its `BUILD_ID` string, plus a `PRECACHE_MANIFEST`
 * initializer wrapped in `/* PRECACHE_MANIFEST_START *\/ ... /* ..._END *\/`
 * marker comments. This script replaces both so the second build on the
 * same tree still produces a fresh id and a current manifest.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const SW_PATH = path.join(PUBLIC_DIR, "sw.js");

// Shell asset allow-list. Anything else (uploaded images, OneSignal's
// worker file, source maps, binary blobs) is skipped.
const SHELL_EXT = new Set([".html", ".css", ".js", ".svg", ".png", ".webmanifest", ".woff2"]);
const SKIP_FILES = new Set(["sw.js", "OneSignalSDKWorker.js", ".gitkeep", ".DS_Store"]);
const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MB

// Matches shell-v__BUILD_ID__, content-v1234567, images-vabc_123, etc.
const CACHE_NAME_PATTERN = /(shell-v|content-v|images-v)[A-Za-z0-9_]+/g;
const BUILD_ID_CONST_PATTERN = /const\s+BUILD_ID\s*=\s*"[^"]*";/;
const MANIFEST_PATTERN = /\/\* PRECACHE_MANIFEST_START \*\/[\s\S]*?\/\* PRECACHE_MANIFEST_END \*\//;

const buildId = (process.env.BUILD_ID && process.env.BUILD_ID.trim()) || Date.now().toString();

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, acc);
    else if (entry.isFile()) acc.push(abs);
  }
  return acc;
}

function toUrl(abs) {
  return "/" + path.relative(PUBLIC_DIR, abs).split(path.sep).join("/");
}

const assets = walk(PUBLIC_DIR, []).filter((abs) => {
  const base = path.basename(abs);
  if (SKIP_FILES.has(base)) return false;
  const ext = path.extname(abs).toLowerCase();
  if (!SHELL_EXT.has(ext)) return false;
  if (fs.statSync(abs).size > MAX_FILE_BYTES) return false;
  return true;
}).map(toUrl);

// Add "/" and "/admin/" directory URLs so navigation requests for the
// shell entry points resolve from the cache without the explicit filename.
const manifestSet = new Set(assets);
if (manifestSet.has("/index.html")) manifestSet.add("/");
if (manifestSet.has("/admin/index.html")) manifestSet.add("/admin/");
const manifest = Array.from(manifestSet).sort();

const original = fs.readFileSync(SW_PATH, "utf8");

if (!CACHE_NAME_PATTERN.test(original)) {
  console.error(`[build-sw] no cache-name constants found in ${SW_PATH}`);
  process.exit(1);
}
// Reset lastIndex after the test() above (CACHE_NAME_PATTERN is /g).
CACHE_NAME_PATTERN.lastIndex = 0;

if (!MANIFEST_PATTERN.test(original)) {
  console.error("[build-sw] PRECACHE_MANIFEST markers not found in sw.js");
  process.exit(1);
}

let stamped = original.replace(CACHE_NAME_PATTERN, (_m, prefix) => `${prefix}${buildId}`);
stamped = stamped.replace(BUILD_ID_CONST_PATTERN, `const BUILD_ID = "${buildId}";`);
stamped = stamped.replace(
  MANIFEST_PATTERN,
  `/* PRECACHE_MANIFEST_START */ ${JSON.stringify(manifest)} /* PRECACHE_MANIFEST_END */`,
);

fs.writeFileSync(SW_PATH, stamped);

console.log(`[build-sw] BUILD_ID=${buildId}, pre-cached ${manifest.length} shell asset(s) in ${path.relative(process.cwd(), SW_PATH)}`);
