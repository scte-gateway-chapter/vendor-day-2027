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

/** @type {{ firebaseProjectId: string, firebaseWebApiKey: string, oneSignalAppId: string, assetsBaseUrl: string | null, signInWebhookUrl: string | null } | null} */
let config = null;
/** @type {Promise<void> | null} */
let initPromise = null;

/**
 * Fetch `/api/config` and prime the module-level config cache. Safe to call
 * multiple times — subsequent calls return the same resolved promise.
 * @returns {Promise<{ firebaseProjectId: string, firebaseWebApiKey: string, oneSignalAppId: string, assetsBaseUrl: string | null, signInWebhookUrl: string | null }>}
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

/** @returns {{ firebaseProjectId: string, firebaseWebApiKey: string, oneSignalAppId: string, assetsBaseUrl: string | null, signInWebhookUrl: string | null }} */
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
    const err = new Error(`getDoc(${path}) failed: ${res.status} ${res.statusText}`);
    // Attach the raw status so callers can distinguish, e.g., 403 (rule
    // denied the read — used by the Attendees detail view to treat an
    // opted-out doc as "not available" without revealing why).
    err.status = res.status;
    throw err;
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

/**
 * Convert a plain JS value to a Firestore REST typed value. Mirrors the
 * server-side `firestorePayloadFromObject` in `_google-auth.js`: supports
 * string, boolean, finite number (int vs double by `Number.isInteger`),
 * `null`/`undefined`, arrays, and plain objects. ISO date strings pass
 * through as `stringValue` (Firestore accepts strings; v1 writes feedback
 * `submittedAt` as an ISO string per the schema in design section 5).
 * @param {*} v
 * @returns {object} Firestore typed value
 */
export function jsToFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error("Non-finite numbers are not supported by Firestore REST");
    }
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(jsToFirestoreValue) } };
  if (typeof v === "object") {
    const fields = {};
    for (const [k, inner] of Object.entries(v)) fields[k] = jsToFirestoreValue(inner);
    return { mapValue: { fields } };
  }
  throw new Error(`Unsupported Firestore value type: ${typeof v}`);
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
        value: jsToFirestoreValue(where.value),
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

/**
 * Create a new Firestore document at `<collectionPath>/<uuid>` with a
 * client-generated id (`crypto.randomUUID`). The call goes DIRECT to the
 * Firestore REST endpoint — not through the admin broker — so
 * `firestore.rules` must grant `allow create` for the target collection.
 * v1 uses this only for `feedbackResponses` (anonymous, create-only).
 * On success returns the created doc converted via `firestoreDocToJs`.
 * On non-2xx throws an Error with the Firestore error text and attaches
 * `status` so callers can branch (e.g., 403 = rule denial, 429 = quota).
 * Lazily primes `/api/config` via `initFirestore()` for first-time callers.
 * @param {string} collectionPath e.g. "feedbackResponses"
 * @param {object} data Plain JS object; nested objects/arrays supported.
 * @returns {Promise<object>}
 */
export async function createDoc(collectionPath, data) {
  if (!collectionPath || typeof collectionPath !== "string") {
    throw new Error("createDoc requires a non-empty collection path");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("createDoc requires a plain object `data`");
  }
  if (!config) await initFirestore();
  const { firebaseProjectId, firebaseWebApiKey } = getConfig();

  const docId = (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    ? crypto.randomUUID()
    : fallbackUuid();

  const fields = {};
  for (const [k, v] of Object.entries(data)) fields[k] = jsToFirestoreValue(v);

  const encodedCollection = collectionPath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  const url =
    `${BASE}/projects/${firebaseProjectId}/databases/(default)/documents/${encodedCollection}` +
    `?documentId=${encodeURIComponent(docId)}&key=${encodeURIComponent(firebaseWebApiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ fields }),
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch (_err) { /* non-JSON surfaced below */ }
  }
  if (!res.ok) {
    const message = parsed?.error?.message
      || (typeof parsed === "string" ? parsed : null)
      || text
      || `createDoc failed with ${res.status}`;
    const err = new Error(`createDoc(${collectionPath}) failed: ${message}`);
    err.status = res.status;
    throw err;
  }
  return firestoreDocToJs(parsed);
}

/** RFC 4122 v4 fallback for environments without `crypto.randomUUID`
 *  (older iOS Safari on insecure contexts). */
function fallbackUuid() {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
