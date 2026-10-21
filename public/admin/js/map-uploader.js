// map-uploader.js — admin Venue Map uploader view (Task 20).
//
// Mounts into #admin-view-root. Unlike the Agenda (Task 18) and Sponsors
// (Task 19) editors, this view operates on a single singleton document
// (`appSettings/singleton`), so there is no list — the whole view is the
// editor. The view owns:
//   - a sticky secondary header ("Admin — Venue Map" + the document's
//     "updated X ago by Y" meta line),
//   - a single image preview that renders the current `venueMapUrl` or
//     the shipped SVG placeholder when the field is null, with an
//     overlay badge for the empty state and for a pending (unsaved)
//     file,
//   - a "Replace image" file picker scoped to PNG/JPEG/WebP (SVG is
//     intentionally excluded for the venue map per the design doc — the
//     map is a visual floor plan, not a logo) with a 5 MB client-side
//     cap mirroring the server limit in /api/upload,
//   - a caption textarea bound to `venueMapCaption`, editable at any
//     time independent of the file selection,
//   - a Save button enabled only when a file is pending OR the caption
//     has changed from the stored value,
//   - the design-section 6 collision soft-safeguard (banner at the top
//     of the view with Overwrite / Reload actions — not a modal — since
//     this view has no modal of its own).
//
// Save flow:
//   1. Re-fetch appSettings/singleton; if its updatedAt differs from the
//      snapshot captured on open, surface the collision banner at the
//      top of the view and abort.
//   2. If a pending file exists, POST it to /api/upload via adminFetch
//      with FormData fields: file (Blob), kind ("venue-map"). The `id`
//      field is intentionally omitted — the upload Function ignores it
//      for this kind and stores to R2 under `venue-map/<timestamp>.<ext>`.
//      The response is { url, key, size, contentType }.
//   3. POST /api/firestore-write with op:"update" so only `venueMapUrl`
//      and `venueMapCaption` are touched. `op:"set"` would overwrite the
//      whole appSettings document, clobbering the other fields on the
//      singleton (eventTitle, venueName, etc.).
//   4. On success, show a success toast, clear the pending file state,
//      and nudge an off-cycle poll so the view reflects the save without
//      waiting out the 30s interval.
"use strict";

import { initFirestore, getDoc, onSnapshot } from "/js/firebase.js";
import * as ui from "/js/ui.js";
import { adminFetch } from "./admin-fetch.js";
import { registerAdminViewCleanup } from "./admin.js";
import {
  snapshotEditingTimestamp,
  hasConflict,
  formatLastEditedPhrase,
} from "./collision-check.js";

const POLL_INTERVAL_MS = 30_000;
const OFFLINE_TOOLTIP = "You're offline — admin changes require connectivity.";
const PLACEHOLDER_IMG = "/assets/placeholders/venue-map-placeholder.svg";
const MAX_BYTES = 5 * 1024 * 1024; // mirrors /api/upload's cap
// NOTE: SVG is intentionally omitted — the map is a visual floor plan,
// not a logo. /api/upload also rejects image/svg+xml for kind=venue-map.
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const CAPTION_MAX = 1000;

/**
 * Render the admin Venue Map uploader into `host`.
 * @param {HTMLElement} host  typically `#admin-view-root`.
 * @returns {Promise<void>}
 */
export default async function renderMapUploader(host) {
  host.innerHTML = "";

  const container = document.createElement("section");
  container.className = "admin-map-uploader";
  container.setAttribute("aria-label", "Admin Venue Map uploader");
  host.appendChild(container);

  const header = buildStickyHeader();
  const conflictBanner = buildConflictBanner();
  const offlineBanner = buildOfflineBanner();
  const body = document.createElement("div");
  body.className = "admin-map-body";

  container.append(header.el, conflictBanner.el, offlineBanner.el, body);

  // Prime /api/config; cached inside firebase.js after the first call.
  const configReady = initFirestore().catch((err) => {
    console.warn("[admin-map] /api/config load failed:", err);
    return null;
  });

  /** Last successful appSettings snapshot (null during first load). */
  /** @type {object | null} */
  let cachedSettings = null;
  /** @type {Error | null} */
  let lastErr = null;
  let sawFirstResult = false;
  let errorToasted = false;
  let online = typeof navigator === "undefined" || navigator.onLine !== false;

  // Editor state that lives across polls. The snapshot timestamp is set
  // the first time we see appSettings; `pendingFile` and the caption
  // textarea's value are preserved across refresh cycles so a 30s poll
  // doesn't blow away unsaved admin work.
  //
  // `editorInitialized` guards the one-time seed of `currentCaption` and
  // `openedSnapshotTs` from the first successful poll. We can't rely on
  // `openedSnapshotTs === null` alone because `snapshotEditingTimestamp`
  // legitimately returns null when the server doc has no `updatedAt`
  // yet, and re-running the seed on every subsequent poll would clobber
  // whatever the admin is typing into the caption field.
  let editorInitialized = false;
  /** @type {string | null} */
  let openedSnapshotTs = null;
  /** @type {File | null} */
  let pendingFile = null;
  /** @type {string | null} Blob URL for the pending preview (needs revoking). */
  let pendingPreviewUrl = null;
  // Current caption textarea value. Mirrored to the DOM in renderEditor;
  // the textarea's `input` event syncs back into this variable so a poll
  // repaint preserves what the admin is typing.
  let currentCaption = "";
  // The caption value we last observed on the server. Compared against
  // `currentCaption` to decide whether Save is enabled.
  let serverCaption = "";

  function rerender() {
    offlineBanner.setVisible(!online);
    header.setOnline(online);

    if (lastErr && !cachedSettings) {
      renderErrorNoCache(body, () => restartSubscription());
      return;
    }
    if (!sawFirstResult) {
      renderSkeleton(body);
      return;
    }

    // First render after the initial fetch: capture the snapshot timestamp
    // and seed the caption from the server. Subsequent polls update
    // `serverCaption` (used by `isDirty()` to re-enable Save when the
    // server copy caught up to the admin's edits) but never overwrite
    // whatever the admin has typed in the textarea.
    if (!editorInitialized && cachedSettings) {
      openedSnapshotTs = snapshotEditingTimestamp(cachedSettings);
      const initial = typeof cachedSettings.venueMapCaption === "string"
        ? cachedSettings.venueMapCaption
        : "";
      currentCaption = initial;
      serverCaption = initial;
      editorInitialized = true;
    } else if (cachedSettings) {
      const latest = typeof cachedSettings.venueMapCaption === "string"
        ? cachedSettings.venueMapCaption
        : "";
      serverCaption = latest;
    }

    header.setLastEdited(cachedSettings);
    renderEditor(body, cachedSettings || {}, {
      hasError: Boolean(lastErr),
      online,
      currentCaption,
      pendingFile,
      pendingPreviewUrl,
      isDirty: computeDirty(),
      onRetry: () => restartSubscription(),
      onPickFile: (file, previewUrl) => {
        setPendingFile(file, previewUrl);
      },
      onCancelPending: () => {
        setPendingFile(null, null);
      },
      onCaptionInput: (value) => {
        currentCaption = value;
        updateSaveEnabled();
      },
      onSave: () => save(),
    });
  }

  function computeDirty() {
    if (pendingFile) return true;
    if (currentCaption !== serverCaption) return true;
    return false;
  }

  /**
   * Flip the pending-file state and the preview URL. Revokes any prior
   * blob URL so repeated picks within one editor lifetime don't leak.
   */
  function setPendingFile(file, previewUrl) {
    if (pendingPreviewUrl && pendingPreviewUrl !== previewUrl) {
      try { URL.revokeObjectURL(pendingPreviewUrl); } catch (_err) { /* no-op */ }
    }
    pendingFile = file;
    pendingPreviewUrl = previewUrl;
    rerender();
  }

  /**
   * Lightweight save-button toggle so a stroke in the caption textarea
   * doesn't trigger a full editor repaint on every keystroke (which
   * would steal focus and reset the caret).
   */
  function updateSaveEnabled() {
    const btn = body.querySelector("[data-save-btn]");
    if (!btn) return;
    const dirty = computeDirty();
    if (!dirty || !online) {
      btn.disabled = true;
      if (!online) {
        btn.setAttribute("title", OFFLINE_TOOLTIP);
        btn.setAttribute("aria-disabled", "true");
      } else {
        btn.removeAttribute("title");
        btn.removeAttribute("aria-disabled");
      }
    } else {
      btn.disabled = false;
      btn.removeAttribute("title");
      btn.removeAttribute("aria-disabled");
    }
  }

  /* ---------------- Subscription plumbing ---------------- */

  /** @type {(() => void) | null} */
  let unsub = null;
  async function startSubscription() {
    try { await configReady; } catch (_err) { /* non-fatal */ }
    unsub = onSnapshot(
      "appSettings/singleton",
      (data, err) => {
        if (err) {
          console.warn("[admin-map] poll failed:", err);
          lastErr = err;
          if (!cachedSettings && !errorToasted) {
            ui.toast("error", "Couldn't load the venue map. Tap Retry to try again.");
            errorToasted = true;
          }
        } else {
          lastErr = null;
          errorToasted = false;
          cachedSettings = data || {};
        }
        sawFirstResult = true;
        rerender();
      },
      { intervalMs: POLL_INTERVAL_MS },
    );
  }

  function restartSubscription() {
    if (unsub) { unsub(); unsub = null; }
    lastErr = null;
    cachedSettings = null;
    sawFirstResult = false;
    errorToasted = false;
    // Resetting the snapshot timestamp lets the first fresh poll re-prime
    // the editor state cleanly. Any pending caption edits survive via
    // currentCaption; the pending file is dropped alongside the view
    // reset because a reload is also what the collision Reload button
    // uses to abandon unsaved work.
    editorInitialized = false;
    openedSnapshotTs = null;
    setPendingFile(null, null);
    currentCaption = "";
    serverCaption = "";
    renderSkeleton(body);
    startSubscription();
  }

  /**
   * Trigger an off-cycle poll right now so the view reflects a just-saved
   * write without waiting out the 30s interval. Keeps the cached settings
   * visible until the fresh poll resolves so the UI doesn't flash a
   * skeleton over the admin's own write.
   */
  function nudgeRefresh() {
    if (unsub) { unsub(); unsub = null; }
    lastErr = null;
    errorToasted = false;
    startSubscription();
  }

  startSubscription();

  /* ---------------- Save ---------------- */

  let saving = false;
  async function save({ bypassConflictCheck = false } = {}) {
    if (saving) return;
    if (!online) return; // button is disabled; defense-in-depth
    const dirty = computeDirty();
    if (!dirty) return;

    saving = true;
    conflictBanner.hide();
    hideUploadError();
    hideSaveError();
    toggleSaveSpinner(true);

    try {
      // 1) Collision check — re-fetch and compare updatedAt.
      if (!bypassConflictCheck && openedSnapshotTs) {
        try {
          const latest = await getDoc("appSettings/singleton");
          if (hasConflict(latest, openedSnapshotTs)) {
            toggleSaveSpinner(false);
            saving = false;
            conflictBanner.show({
              onReload: () => {
                conflictBanner.hide();
                restartSubscription();
              },
              onOverwrite: () => {
                conflictBanner.hide();
                save({ bypassConflictCheck: true });
              },
            });
            return;
          }
        } catch (err) {
          // Non-fatal; proceed to save. The write will surface its own
          // error on failure.
          console.warn("[admin-map] collision pre-check failed:", err);
        }
      }

      // 2) Upload the pending file, if any. On upload failure the current
      // image stays visible (we don't clobber the preview with a broken
      // reference) and the pending file reference survives for retry.
      let urlToWrite =
        typeof cachedSettings?.venueMapUrl === "string" && cachedSettings.venueMapUrl.trim()
          ? cachedSettings.venueMapUrl.trim()
          : null;

      if (pendingFile) {
        showUploadProgress(true);
        try {
          const form = new FormData();
          form.append("file", pendingFile);
          form.append("kind", "venue-map");
          const uploaded = await adminFetch("/api/upload", {
            method: "POST",
            body: form,
          });
          if (!uploaded?.url || typeof uploaded.url !== "string") {
            throw new Error("Upload response missing url");
          }
          urlToWrite = uploaded.url;
        } catch (err) {
          console.warn("[admin-map] upload failed:", err);
          if (err?.code === "session-expired") return;
          toggleSaveSpinner(false);
          saving = false;
          showUploadProgress(false);
          showUploadError();
          return;
        }
        showUploadProgress(false);
      }

      // 3) Firestore write — op:"update" so other appSettings fields
      // (eventTitle, venueName, venueAddress, ...) are preserved.
      const captionToWrite = currentCaption.trim();
      try {
        await adminFetch("/api/firestore-write", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            collection: "appSettings",
            docId: "singleton",
            op: "update",
            data: {
              venueMapUrl: urlToWrite,
              venueMapCaption: captionToWrite,
            },
          }),
        });
      } catch (err) {
        console.warn("[admin-map] firestore write failed:", err);
        if (err?.code === "session-expired") return;
        toggleSaveSpinner(false);
        saving = false;
        showSaveError();
        return;
      }

      ui.toast("success", "Venue map updated.");
      // Clear pending state and let the next poll pick up the new values.
      // Reset the editor-init flag + snapshot so the server's new
      // updatedAt becomes our new baseline on the fresh poll.
      setPendingFile(null, null);
      editorInitialized = false;
      openedSnapshotTs = null;
      serverCaption = captionToWrite;
      currentCaption = captionToWrite;
      toggleSaveSpinner(false);
      saving = false;
      nudgeRefresh();
    } catch (err) {
      console.warn("[admin-map] save failed:", err);
      if (err?.code === "session-expired") return;
      toggleSaveSpinner(false);
      saving = false;
      showSaveError();
    }
  }

  function toggleSaveSpinner(loading) {
    const btn = body.querySelector("[data-save-btn]");
    if (!btn) return;
    const label = btn.querySelector(".admin-map-save-btn__label");
    if (loading) {
      btn.disabled = true;
      btn.classList.add("admin-map-save-btn--loading");
      if (label) label.textContent = "Saving\u2026";
    } else {
      btn.classList.remove("admin-map-save-btn--loading");
      if (label) label.textContent = "Save";
      // Dirty-aware re-enable; the handler on update-save keeps this in sync.
      updateSaveEnabled();
    }
  }

  function showUploadProgress(visible) {
    const el = body.querySelector("[data-upload-progress]");
    if (!el) return;
    el.hidden = !visible;
  }

  function showUploadError() {
    const el = body.querySelector("[data-upload-error]");
    if (!el) return;
    el.hidden = false;
  }
  function hideUploadError() {
    const el = body.querySelector("[data-upload-error]");
    if (!el) return;
    el.hidden = true;
  }

  function showSaveError() {
    const el = body.querySelector("[data-save-error]");
    if (!el) return;
    el.hidden = false;
  }
  function hideSaveError() {
    const el = body.querySelector("[data-save-error]");
    if (!el) return;
    el.hidden = true;
  }

  /* ---------------- Connectivity ---------------- */

  const onOnline = () => { online = true; rerender(); };
  const onOffline = () => { online = false; rerender(); };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  const onVisibility = () => {
    if (document.visibilityState !== "visible") return;
    rerender();
  };
  document.addEventListener("visibilitychange", onVisibility);

  registerAdminViewCleanup(() => {
    if (unsub) { unsub(); unsub = null; }
    if (pendingPreviewUrl) {
      try { URL.revokeObjectURL(pendingPreviewUrl); } catch (_err) { /* no-op */ }
      pendingPreviewUrl = null;
    }
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onVisibility);
  });

  document.title = "Admin \u2014 Venue Map \u2014 Vendor Day 2027";
}

/* =================================================================
 * Sticky secondary header
 * ================================================================= */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "admin-map-header";
  el.innerHTML = `
    <div class="admin-map-header__row">
      <h2 class="admin-map-header__title">Admin \u2014 Venue Map</h2>
      <p class="admin-map-header__meta" aria-live="polite">never edited</p>
    </div>
  `;

  const metaEl = el.querySelector(".admin-map-header__meta");

  function setLastEdited(doc) {
    metaEl.textContent = formatLastEditedPhrase(doc);
  }

  // The header owns no interactive controls today — kept for parity
  // with the other editors so the view can broadcast online state in
  // one call.
  function setOnline(_online) { /* no-op */ }

  return { el, setLastEdited, setOnline };
}

/* =================================================================
 * Conflict banner (reuses .admin-conflict-banner from Task 18)
 * ================================================================= */

function buildConflictBanner() {
  const el = document.createElement("div");
  el.className = "admin-conflict-banner admin-map-conflict-banner";
  el.setAttribute("role", "status");
  el.hidden = true;

  function show({ onReload, onOverwrite }) {
    el.innerHTML = `
      <p>The venue map was edited by someone else since you opened it. Reload to see their changes, or Overwrite to save yours anyway.</p>
      <div class="admin-map-conflict-banner__actions">
        <button type="button" class="btn-secondary" data-reload>Reload</button>
        <button type="button" class="btn-primary" data-overwrite>Overwrite</button>
      </div>
    `;
    el.hidden = false;
    el.querySelector("[data-reload]").addEventListener("click", () => {
      if (typeof onReload === "function") onReload();
    });
    el.querySelector("[data-overwrite]").addEventListener("click", () => {
      if (typeof onOverwrite === "function") onOverwrite();
    });
  }

  function hide() {
    el.hidden = true;
    el.innerHTML = "";
  }

  return { el, show, hide };
}

/* =================================================================
 * Offline banner (scoped to the view)
 * ================================================================= */

function buildOfflineBanner() {
  const el = document.createElement("div");
  el.className = "admin-view-offline-banner";
  el.setAttribute("role", "status");
  el.textContent = "You're offline \u2014 admin changes require connectivity.";
  el.hidden = true;
  function setVisible(visible) {
    el.hidden = !visible;
  }
  return { el, setVisible };
}

/* =================================================================
 * Rendering states
 * ================================================================= */

function renderSkeleton(host) {
  host.innerHTML = `
    <div class="skeleton-card admin-map-preview-skeleton" aria-hidden="true"></div>
    <div class="skeleton-row admin-map-caption-skeleton" aria-hidden="true"></div>
    <div class="skeleton-row admin-map-caption-skeleton admin-map-caption-skeleton--short" aria-hidden="true"></div>
  `;
}

function renderErrorNoCache(host, onRetry) {
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't load the venue map.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

function renderEditor(host, settings, {
  hasError, online, currentCaption, pendingFile, pendingPreviewUrl, isDirty,
  onRetry, onPickFile, onCancelPending, onCaptionInput, onSave,
}) {
  host.innerHTML = "";

  if (hasError) {
    const strip = document.createElement("div");
    strip.className = "status-error admin-map-error-strip";
    strip.setAttribute("role", "status");
    strip.innerHTML = `
      <span>Couldn't refresh. Showing last-saved map.</span>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    `;
    strip.querySelector("[data-retry]").addEventListener("click", onRetry);
    host.appendChild(strip);
  }

  const uploadedUrl =
    typeof settings.venueMapUrl === "string" && settings.venueMapUrl.trim()
      ? settings.venueMapUrl.trim()
      : "";
  const isPlaceholder = !uploadedUrl;

  // When a file is pending, show its preview over the saved image; the
  // saved image stays as a fallback (previous image remains visible on
  // upload failure).
  const displayedSrc = pendingFile && pendingPreviewUrl
    ? pendingPreviewUrl
    : (uploadedUrl || PLACEHOLDER_IMG);

  // Preview frame
  const preview = document.createElement("div");
  preview.className = "admin-map-preview";
  if (isPlaceholder && !pendingFile) preview.classList.add("admin-map-preview--placeholder");

  const img = document.createElement("img");
  img.className = "admin-map-preview-img";
  img.src = displayedSrc;
  // SR-visible alt for the uploaded map; empty alt for the placeholder so
  // SRs rely on the visible "No map uploaded yet" badge below.
  img.alt = pendingFile
    ? "Pending venue map upload"
    : isPlaceholder
    ? ""
    : "Current venue map";
  img.draggable = false;
  preview.appendChild(img);

  if (pendingFile) {
    const pending = document.createElement("div");
    pending.className = "admin-map-pending-badge";
    pending.textContent = "Pending upload \u2014 click Save to publish";
    preview.appendChild(pending);
  } else if (isPlaceholder) {
    const empty = document.createElement("div");
    empty.className = "admin-map-empty-badge";
    empty.textContent = "No map uploaded yet";
    preview.appendChild(empty);
  }

  // Indeterminate shimmer bar. XMLHttpRequest.upload.onprogress could
  // provide determinate progress, but fetch + FormData doesn't surface
  // progress events — indeterminate is the honest UI here.
  const progress = document.createElement("div");
  progress.className = "admin-map-upload-progress";
  progress.setAttribute("data-upload-progress", "");
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "Uploading image");
  progress.hidden = true;
  preview.appendChild(progress);

  host.appendChild(preview);

  // Replace row (button + file input + Cancel pending link)
  const replaceRow = document.createElement("div");
  replaceRow.className = "admin-map-replace-row";

  const replaceBtn = document.createElement("button");
  replaceBtn.type = "button";
  replaceBtn.className = "btn-secondary admin-map-replace-btn";
  replaceBtn.textContent = pendingFile ? "Choose a different image" : "Replace image";
  if (!online) {
    replaceBtn.disabled = true;
    replaceBtn.setAttribute("title", OFFLINE_TOOLTIP);
    replaceBtn.setAttribute("aria-disabled", "true");
  }

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg,image/webp";
  fileInput.className = "admin-map-file-input";

  const fileError = document.createElement("p");
  fileError.className = "admin-inline-error admin-map-file-error";
  fileError.hidden = true;

  const cancelPending = document.createElement("button");
  cancelPending.type = "button";
  cancelPending.className = "btn-link admin-map-cancel-pending";
  cancelPending.textContent = "Cancel pending";
  cancelPending.hidden = !pendingFile;

  replaceBtn.addEventListener("click", () => {
    if (!online) return;
    fileError.hidden = true;
    fileError.textContent = "";
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const err = validateFile(file);
    if (err) {
      fileError.textContent = err;
      fileError.hidden = false;
      fileInput.value = "";
      return;
    }
    let previewUrl = null;
    try {
      previewUrl = URL.createObjectURL(file);
    } catch (_err) { /* preview is best-effort */ }
    fileError.hidden = true;
    fileError.textContent = "";
    onPickFile(file, previewUrl);
  });
  cancelPending.addEventListener("click", () => {
    fileInput.value = "";
    fileError.hidden = true;
    fileError.textContent = "";
    onCancelPending();
  });

  replaceRow.append(replaceBtn, cancelPending, fileInput, fileError);
  host.appendChild(replaceRow);

  // Inline error banners (upload + save). Hidden by default; the save
  // flow flips them on by [data-upload-error] / [data-save-error].
  const uploadError = document.createElement("div");
  uploadError.className = "status-error admin-map-upload-error";
  uploadError.setAttribute("data-upload-error", "");
  uploadError.setAttribute("role", "alert");
  uploadError.textContent = "Upload failed \u2014 try again.";
  uploadError.hidden = true;
  host.appendChild(uploadError);

  const saveError = document.createElement("div");
  saveError.className = "status-error admin-map-save-error";
  saveError.setAttribute("data-save-error", "");
  saveError.setAttribute("role", "alert");
  saveError.textContent = "Could not save \u2014 try again.";
  saveError.hidden = true;
  host.appendChild(saveError);

  // Caption textarea
  const captionGroup = document.createElement("div");
  captionGroup.className = "admin-form-group admin-map-caption-group";
  const captionId = "admin-map-caption";
  captionGroup.innerHTML = `
    <label for="${captionId}">Caption / legend text</label>
    <textarea
      id="${captionId}"
      class="admin-textarea admin-map-caption-field"
      maxlength="${CAPTION_MAX}"
      rows="3"
    ></textarea>
  `;
  const captionEl = captionGroup.querySelector(`#${captionId}`);
  captionEl.value = currentCaption;
  captionEl.addEventListener("input", () => onCaptionInput(captionEl.value));
  host.appendChild(captionGroup);

  // Save row
  const saveRow = document.createElement("div");
  saveRow.className = "admin-map-save-row";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn-primary admin-map-save-btn";
  saveBtn.setAttribute("data-save-btn", "");
  const saveDisabled = !isDirty || !online;
  saveBtn.disabled = saveDisabled;
  if (!online) {
    saveBtn.setAttribute("title", OFFLINE_TOOLTIP);
    saveBtn.setAttribute("aria-disabled", "true");
  }
  saveBtn.innerHTML = `<span class="admin-map-save-btn__label">Save</span>`;
  saveBtn.addEventListener("click", () => onSave());
  saveRow.appendChild(saveBtn);
  host.appendChild(saveRow);
}

/* =================================================================
 * Validation
 * ================================================================= */

/**
 * Reject the file if it exceeds 5 MB or carries a MIME type outside the
 * allow-list. Returns null when valid or an error message when not.
 * @param {File} file
 * @returns {string | null}
 */
function validateFile(file) {
  if (file.size > MAX_BYTES) {
    return "File too large (max 5 MB).";
  }
  const type = (file.type || "").toLowerCase();
  if (!ALLOWED_TYPES.has(type)) {
    return "Only PNG, JPEG, or WebP accepted.";
  }
  return null;
}
