// router.js — tiny hash-based router.
//
// Routes are registered with a path pattern like `#/agenda/<id>`; the pattern
// compiler converts `<name>` placeholders to a capture group and remembers the
// placeholder name so the handler receives `{ id: "abc" }` as `params`.
//
// Hash routing was chosen over the History API so the app serves from a flat
// static bundle (no server rewrites) and keeps working offline from the cache.
"use strict";

/** @typedef {(params: Record<string,string>) => void | Promise<void>} RouteHandler */

/** @type {{ path: string, pattern: RegExp, keys: string[], handler: RouteHandler }[]} */
const routes = [];
/** @type {RouteHandler | null} */
let fallbackHandler = null;
/** @type {Array<(ctx: {path: string, params: Record<string,string>}) => void | Promise<void>>} */
const beforeHooks = [];
/** @type {Array<(ctx: {path: string, params: Record<string,string>}) => void | Promise<void>>} */
const afterHooks = [];

let started = false;
/** @type {{ path: string, params: Record<string,string> } | null} */
let active = null;

/**
 * Compile a route pattern (e.g. `#/agenda/<id>`) into a RegExp and a list of
 * placeholder names. Non-placeholder segments are escaped so `.` in a route is
 * matched literally.
 * @param {string} pattern
 */
function compile(pattern) {
  const keys = [];
  const body = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(
    /<([A-Za-z_][A-Za-z0-9_]*)>/g,
    (_m, name) => {
      keys.push(name);
      return "([^/]+)";
    },
  );
  return { pattern: new RegExp(`^${body}$`), keys };
}

/**
 * Register a route handler. Pattern `"*"` registers the 404 fallback.
 * @param {string} path
 * @param {RouteHandler} handler
 */
export function register(path, handler) {
  if (typeof handler !== "function") {
    throw new TypeError("router.register requires a handler function");
  }
  if (path === "*") {
    fallbackHandler = handler;
    return;
  }
  const { pattern, keys } = compile(path);
  routes.push({ path, pattern, keys, handler });
}

/** @param {(ctx: {path: string, params: Record<string,string>}) => void | Promise<void>} fn */
export function beforeEach(fn) {
  beforeHooks.push(fn);
}

/** @param {(ctx: {path: string, params: Record<string,string>}) => void | Promise<void>} fn */
export function afterEach(fn) {
  afterHooks.push(fn);
}

function currentHash() {
  // Normalize empty hash to "#/" so the home route always matches.
  const h = window.location.hash || "#/";
  return h.startsWith("#") ? h : `#${h}`;
}

async function resolve() {
  const hash = currentHash();
  for (const r of routes) {
    const m = hash.match(r.pattern);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1]);
    });
    active = { path: r.path, params };
    for (const h of beforeHooks) await h(active);
    await r.handler(params);
    for (const h of afterHooks) await h(active);
    return;
  }
  // Nothing matched — invoke the 404 fallback if registered.
  active = { path: "*", params: { hash } };
  for (const h of beforeHooks) await h(active);
  if (fallbackHandler) await fallbackHandler(active.params);
  for (const h of afterHooks) await h(active);
}

function onHashChange() {
  // Fire-and-forget; handler errors are logged but not thrown so a bad view
  // never breaks subsequent navigation.
  resolve().catch((err) => console.warn("[router] route handler failed:", err));
}

/** Begin listening for hashchange and dispatch the current hash. Idempotent. */
export function start() {
  if (started) {
    onHashChange();
    return;
  }
  started = true;
  window.addEventListener("hashchange", onHashChange);
  onHashChange();
}

/**
 * Programmatic navigation. Setting `location.hash` triggers `hashchange` which
 * runs the registered handler, so this is a one-liner by design.
 * @param {string} path
 */
export function navigate(path) {
  const target = path.startsWith("#") ? path : `#${path.startsWith("/") ? path : `/${path}`}`;
  if (currentHash() === target) {
    // Same hash — browsers suppress hashchange, so re-resolve manually.
    onHashChange();
    return;
  }
  window.location.hash = target;
}

/** @returns {{ path: string, params: Record<string,string> } | null} */
export function currentRoute() {
  return active;
}
