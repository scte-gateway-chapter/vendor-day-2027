// POST /api/upload
//
// Admin-authenticated broker that writes user-uploaded assets (sponsor logos,
// the venue map image, recap photos) into the Cloudflare R2 bucket bound at
// `env.ASSETS_BUCKET`. We moved off Firebase Storage because the Firebase
// policy change in 2026 requires the Blaze pay-as-you-go plan for Storage;
// R2's free tier (10 GB storage, 1M writes/mo, 10M reads/mo, zero egress) is
// a clean replacement and keeps everything inside Cloudflare.
//
// The handler expects `multipart/form-data` with:
//   - `file`  — the image bytes (required, non-empty, <= 5 MB)
//   - `kind`  — one of `sponsor`, `venue-map`, `recap` (required)
//   - `id`    — required for `sponsor` and `recap`; ignored for `venue-map`
// It validates the content-type, picks an object key per the convention in
// design section 2, writes to R2, and returns `{ url, key, size, contentType }`.
// The public URL is composed from `env.R2_PUBLIC_URL` (the `pub-<hash>.r2.dev`
// hostname Cloudflare assigns when public access is enabled on the bucket).
"use strict";

import { extractBearer, verifyAdminJwt } from "../_shared/_jwt.js";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per design section 4 (map uploader)
const ALLOWED_KINDS = new Set(["sponsor", "venue-map", "recap"]);
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

// Content-type allow-list. SVG is only accepted for sponsor logos.
//
// Security note: SVG files are XML and can carry embedded <script> or
// `onload=` XSS payloads. For v1 this is acceptable because logo uploads
// come from the ~3 Gateway Chapter board admins (gated by the admin JWT)
// and the files are rendered inside `<img src>` tags, where browsers
// execute SVG script only when the SVG is loaded as a top-level document
// or via `<object>`/`<iframe>`. If we ever let non-admin users upload SVG
// or inline it with `<svg>`, we must sanitize first (e.g. svg-sanitizer).
const COMMON_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const SPONSOR_EXTRA_TYPES = new Set(["image/svg+xml"]);

const CONTENT_TYPE_TO_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

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

function pickExtension(fileName, contentType) {
  if (typeof fileName === "string") {
    const dot = fileName.lastIndexOf(".");
    if (dot >= 0 && dot < fileName.length - 1) {
      const ext = fileName.slice(dot + 1).toLowerCase();
      // Keep the ext simple; reject anything that would make a weird key.
      if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
    }
  }
  return CONTENT_TYPE_TO_EXT[contentType] || "bin";
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();

  const cors = sameOriginCors(request);
  if (cors === null) return jsonResponse({ error: "Forbidden" }, 403);
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405, { ...cors, Allow: "POST" });
  }

  const token = extractBearer(request);
  if (!token) return jsonResponse({ error: "Unauthorized" }, 401, cors);
  let adminPayload;
  try {
    adminPayload = await verifyAdminJwt(env, token);
  } catch (_err) {
    return jsonResponse({ error: "Unauthorized" }, 401, cors);
  }

  if (!env.ASSETS_BUCKET) {
    console.error("ASSETS_BUCKET R2 binding is not set");
    return jsonResponse({ error: "Storage not configured" }, 500, cors);
  }
  const publicBase = typeof env.R2_PUBLIC_URL === "string" ? env.R2_PUBLIC_URL.trim() : "";
  if (!publicBase || !/^https:\/\//i.test(publicBase)) {
    console.error("R2_PUBLIC_URL env var is missing or malformed");
    return jsonResponse({ error: "Storage URL not configured" }, 500, cors);
  }

  let form;
  try {
    form = await request.formData();
  } catch (_err) {
    return jsonResponse({ error: "Invalid multipart/form-data body" }, 400, cors);
  }

  const kind = typeof form.get("kind") === "string" ? form.get("kind") : "";
  if (!ALLOWED_KINDS.has(kind)) {
    return jsonResponse(
      { error: "Invalid kind (must be sponsor, venue-map, or recap)" }, 400, cors,
    );
  }

  const file = form.get("file");
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
    return jsonResponse({ error: "Missing file field" }, 400, cors);
  }
  if (file.size === 0) {
    return jsonResponse({ error: "File is empty" }, 400, cors);
  }
  if (file.size > MAX_BYTES) {
    return jsonResponse({ error: `File exceeds ${MAX_BYTES} bytes` }, 413, cors);
  }

  const contentType = (file.type || "").toLowerCase();
  const allowed =
    COMMON_IMAGE_TYPES.has(contentType) ||
    (kind === "sponsor" && SPONSOR_EXTRA_TYPES.has(contentType));
  if (!allowed) {
    return jsonResponse({ error: "Unsupported file type" }, 415, cors);
  }

  const idRaw = form.get("id");
  const id = typeof idRaw === "string" ? idRaw : "";
  if (kind === "sponsor" || kind === "recap") {
    if (!ID_RE.test(id)) {
      return jsonResponse({ error: "Invalid id" }, 400, cors);
    }
  }

  const ext = pickExtension(file.name, contentType);
  let key;
  if (kind === "sponsor") {
    key = `sponsors/${id}/${Date.now()}.${ext}`;
  } else if (kind === "venue-map") {
    key = `venue-map/${Date.now()}.${ext}`;
  } else {
    // recap: stable key per photo id so an admin re-uploading replaces the
    // previous photo in place. Display order lives on the recap document.
    key = `recap/${id}.${ext}`;
  }

  try {
    await env.ASSETS_BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType },
      customMetadata: {
        kind,
        uploadedAt: new Date().toISOString(),
        uploadedBy:
          typeof adminPayload?.sub === "string" ? adminPayload.sub : "admin",
      },
    });
  } catch (err) {
    console.error("R2 put failed:", err?.message || err);
    return jsonResponse({ error: "Upload failed" }, 502, cors);
  }

  // Key is split on `/` so each path segment is encoded independently —
  // encodeURIComponent would otherwise turn the slashes into `%2F`.
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const url = `${publicBase.replace(/\/$/, "")}/${encodedKey}`;
  return jsonResponse({ url, key, size: file.size, contentType }, 200, cors);
}
