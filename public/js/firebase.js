// firebase.js — read-only Firestore client over the REST API.
//
// We talk to Firestore via the public REST endpoint rather than the npm
// `firebase` SDK: the SDK's auth model is more than we need (public reads
// are gated by firestore.rules, not by signed-in users) and shipping zero
// npm runtime deps keeps the PWA bundle tiny.
//
// Project id + web API key are PUBLIC values, pulled at runtime from the
// `/api/config` Pages Function so they stay in Cloudflare env vars rather
// than in the committed source. firestore.rules enforces access control.
//
// Realtime: Firestore's true snapshot listeners require the SDK's gRPC
// channel, which we are not shipping. 15-second polling is a pragmatic
// stand-in for an event audience of a few hundred attendees and well within
// the Spark free quota (50k reads/day).
"use strict";

const BASE = "https://firestore.googleapis.com/v1";

/** @type {{ firebaseProjectId: string, firebaseWebApiKey: string, oneSignalAppId: string, assetsBaseUrl: string | null } | null} */
let config = null;
/** @type {Promise<void> | null} */
let initPromise = null;

/**
 * Fetch `/api/config` and prime the module-level config cache. Safe to call
 * multiple times — subsequent calls return the same resolved promise.
 * @returns {Promise<{ firebaseProjectId: string, firebaseWebApiKey: string, oneSignalAppId: string, assetsBaseUrl: string | null }>}
 */
export function initFirestore() {
  if (config) return Promise.resolve(config);
  if (initPromise) return initPromise.then(() => config);
  initPromise = (async () => {
    const res = await fetch("/api/config", { headers: { Accept: "application/json" } });
    if (!res.ok) {
      initPromise = null;
      throw new Error(`Could not load /api/config (status ${res.status})`);
    }
    const body = await res.json();
    if (!body?.firebaseProjectId || !body?.firebaseWebApiKey) {
      initPromise = null;
      throw new Error("/api/config did not return the required Firebase values");
    }
    config = body;
  })();
  return initPromise.then(() => config);
}

/** @returns {{ firebaseProjectId: string, firebaseWebApiKey: string, oneSignalAppId: string, assetsBaseUrl: string | null }} */
export function getConfig() {
  if (!config) {
    throw new Error("Firestore client not initialized — call initFirestore() first");
  }
  return config;
}

/**
 * Return the Cloudflare R2 public base URL (`https://pub-<hash>.r2.dev`) for
 * user-uploaded assets, or `null` when the deploy has not yet set
 * `R2_PUBLIC_URL`. v1 stores absolute URLs in Firestore docs, so view code
 * typically does not need this — exposed here for future callers that want
 * to resolve a bare object key.
 * @returns {string | null}
 */
export function getAssetsBaseUrl() {
  return config?.assetsBaseUrl ?? null;
}

/**
 * Convert one Firestore REST typed value (e.g. `{ stringValue: "x" }`) into
 * a plain JS value. Unknown value shapes fall through to `null`.
 * @param {object} v
 */
export function firestoreValueToJs(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) {
    // REST serializes 64-bit ints as strings; Number loses precision above 2^53.
    const n = Number(v.integerValue);
    return Number.isSafeInteger(n) ? n : v.integerValue;
  }
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return Boolean(v.booleanValue);
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue; // ISO 8601 string
  if ("bytesValue" in v) return v.bytesValue;
  if ("referenceValue" in v) return v.referenceValue;
  if ("geoPointValue" in v) return v.geoPointValue;
  if ("arrayValue" in v) {
    const values = Array.isArray(v.arrayValue?.values) ? v.arrayValue.values : [];
    return values.map(firestoreValueToJs);
  }
  if ("mapValue" in v) {
    return firestoreFieldsToJs(v.mapValue?.fields || {});
  }
  return null;
}

/**
 * Convert a Firestore `fields` map (`{ title: { stringValue }, ... }`) into
 * a plain JS object.
 * @param {Record<string, object>} fields
 */
export function firestoreFieldsToJs(fields) {
  const out = {};
  for (const [k, raw] of Object.entries(fields || {})) {
    out[k] = firestoreValueToJs(raw);
  }
  return out;
}

/**
 * Convert a full Firestore document (`{ name, fields, createTime, updateTime }`)
 * into a plain JS object. Adds a convenience `id` field derived from the
 * document's resource name.
 * @param {object} doc
 */
export function firestoreDocToJs(doc) {
  if (!doc) return null;
  const out = firestoreFieldsToJs(doc.fields || {});
  if (typeof doc.name === "string") {
    const idx = doc.name.lastIndexOf("/");
    if (idx >= 0) out.id = decodeURIComponent(doc.name.slice(idx + 1));
  }
  return out;
}

function docUrl(path) {
  const { firebaseProjectId, firebaseWebApiKey } = getConfig();
  const encoded = path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `${BASE}/projects/${firebaseProjectId}/databases/(default)/documents/${encoded}?key=${encodeURIComponent(firebaseWebApiKey)}`;
}

function parentAndCollection(path) {
  // Expects an odd-segment path (collection). Returns the parent document
  // path (empty for top-level collections) and the trailing collection id.
  const parts = path.split("/").filter(Boolean);
  if (parts.length % 2 === 0) {
    throw new Error(`getCollection path must point at a collection (odd segments): ${path}`);
  }
  const collectionId = parts[parts.length - 1];
  const parent = parts.slice(0, -1).map(encodeURIComponent).join("/");
  return { parent, collectionId };
}

/**
 * Read a single Firestore document. Returns `null` if the document does not
 * exist (404). Throws on any other non-OK status.
 * @param {string} path  "appSettings/singleton", "agenda/<id>", etc.
 * @returns {Promise<object | null>}
 */
export async function getDoc(path) {
  const res = await fetch(docUrl(path), { headers: { Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`getDoc(${path}) failed: ${res.status} ${res.statusText}`);
  }
  const doc = await res.json();
  return firestoreDocToJs(doc);
}

const OP_MAP = {
  "==": "EQUAL",
  "!=": "NOT_EQUAL",
  "<": "LESS_THAN",
  "<=": "LESS_THAN_OR_EQUAL",
  ">": "GREATER_THAN",
  ">=": "GREATER_THAN_OR_EQUAL",
  "in": "IN",
  "not-in": "NOT_IN",
  "array-contains": "ARRAY_CONTAINS",
  "array-contains-any": "ARRAY_CONTAINS_ANY",
};

function jsValueToFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(jsValueToFirestoreValue) } };
  if (typeof v === "object") {
    const fields = {};
    for (const [k, inner] of Object.entries(v)) fields[k] = jsValueToFirestoreValue(inner);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

/**
 * Read a collection with optional single `where`, single `orderBy`, and limit.
 * Simple reads (no where/orderBy) use the collection GET endpoint; filtered
 * reads use `runQuery` with a StructuredQuery.
 * @param {string} path
 * @param {{ where?: { field: string, op: string, value: any }, orderBy?: { field: string, direction?: "asc"|"desc" }, limit?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function getCollection(path, opts = {}) {
  const { where, orderBy, limit } = opts;
  const { firebaseProjectId, firebaseWebApiKey } = getConfig();

  if (!where && !orderBy) {
    const url = new URL(
      `${BASE}/projects/${firebaseProjectId}/databases/(default)/documents/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`,
    );
    url.searchParams.set("key", firebaseWebApiKey);
    if (typeof limit === "number" && limit > 0) url.searchParams.set("pageSize", String(limit));
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`getCollection(${path}) failed: ${res.status} ${res.statusText}`);
    }
    const body = await res.json();
    return (body.documents || []).map(firestoreDocToJs);
  }

  const { parent, collectionId } = parentAndCollection(path);
  const query = { from: [{ collectionId }] };
  if (where) {
    const op = OP_MAP[where.op];
    if (!op) throw new Error(`Unsupported where op: ${where.op}`);
    query.where = {
      fieldFilter: {
        field: { fieldPath: where.field },
        op,
        value: jsValueToFirestoreValue(where.value),
      },
    };
  }
  if (orderBy) {
    query.orderBy = [
      {
        field: { fieldPath: orderBy.field },
        direction: (orderBy.direction || "asc").toLowerCase() === "desc" ? "DESCENDING" : "ASCENDING",
      },
    ];
  }
  if (typeof limit === "number" && limit > 0) query.limit = limit;

  const runUrl = `${BASE}/projects/${firebaseProjectId}/databases/(default)/documents${parent ? `/${parent}` : ""}:runQuery?key=${encodeURIComponent(firebaseWebApiKey)}`;
  const res = await fetch(runUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ structuredQuery: query }),
  });
  if (!res.ok) {
    throw new Error(`getCollection(${path}) runQuery failed: ${res.status} ${res.statusText}`);
  }
  const rows = await res.json();
  // runQuery returns an array where each entry is `{ document, readTime }`
  // except for an empty result which comes back as `[{ readTime }]`.
  return (rows || [])
    .filter((r) => r && r.document)
    .map((r) => firestoreDocToJs(r.document));
}

/**
 * Poll a document or collection path at `intervalMs` and call `callback` with
 * the latest value. Returns `unsubscribe()`.
 *
 * This is a 15-second polling loop — Firestore true snapshot listeners
 * require the SDK's gRPC channel. For a few hundred attendees this comfortably
 * fits the Spark free tier (50k reads/day).
 *
 * @param {string} path  Document path (even segments) OR collection path (odd segments)
 * @param {(data: object | object[] | null, err?: Error) => void} callback
 * @param {{ intervalMs?: number, where?: object, orderBy?: object, limit?: number }} [opts]
 * @returns {() => void} unsubscribe
 */
export function onSnapshot(path, callback, opts = {}) {
  const { intervalMs = 15000, where, orderBy, limit } = opts;
  const parts = path.split("/").filter(Boolean);
  const isDoc = parts.length % 2 === 0;
  let cancelled = false;
  let timer = null;

  async function tick() {
    if (cancelled) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      // Skip the fetch while offline; the loop resumes when connectivity returns.
      schedule();
      return;
    }
    try {
      const data = isDoc
        ? await getDoc(path)
        : await getCollection(path, { where, orderBy, limit });
      if (!cancelled) callback(data);
    } catch (err) {
      if (!cancelled) callback(null, err instanceof Error ? err : new Error(String(err)));
    } finally {
      schedule();
    }
  }
  function schedule() {
    if (cancelled) return;
    timer = setTimeout(tick, intervalMs);
  }

  // Initial read runs immediately so views can render first paint without
  // waiting for the first interval.
  tick();
  return function unsubscribe() {
    cancelled = true;
    if (timer != null) clearTimeout(timer);
  };
}
