// recap-editor.js — admin Recap editor (Task 24).
//
// Mounts into #admin-view-root. The view owns the singleton
// `recap/singleton` document and renders:
//
//   - a sticky secondary header ("Admin — Recap" + the doc-level
//     "updated X ago by Y" meta line),
//   - a Publication state card: green/muted pill reflecting
//     `published`, destructive "Unpublish recap" button when published.
//     Publication is intentionally not a toggle — the admin opts in
//     explicitly via the Publish button at the bottom of the view
//     (the publish push flow depends on an explicit button tap, not
//     a stray toggle).
//   - a thank-you textarea (plain text, line breaks preserved by the
//     attendee view),
//   - an acknowledgments textarea (markdown-mini subset) with a live
//     markdown preview panel + a markdown-reference popover (same
//     pattern as the Announcements composer),
//   - a photo gallery editor: existing photos shown in a CSS grid as
//     tiles with thumbnail, caption input, up/down reorder arrows,
//     and a destructive Delete button. New photos are uploaded eagerly
//     on file-select to R2 via /api/upload (FormData with
//     `kind="recap"` and a client-generated `id=<photo-uuid>`).
//     Upload failures stay visible as per-tile error rows with Retry
//     until the admin either succeeds or removes the row,
//   - a Send-push checkbox + preview card (only enabled when the
//     recap is currently unpublished — publishing is the push trigger),
//   - Save-draft (writes thanks/acks/photos only) and Publish (writes
//     those three plus published:true + publishedAt; chains /api/send-push
//     when the checkbox is on) buttons.
//
// Three failure-mode banners from design section 7 are mapped verbatim
// from the Announcements composer:
//   1. Firestore write fails -> inline red error banner, draft kept.
//   2. Firestore write succeeds, OneSignal fails -> "Published, but
//      push did not send" banner with Retry push + Dismiss.
//   3. OneSignal returns a specific error -> the same banner surfaces
//      the message verbatim.
//
// Dirty tracking follows the Feedback editor's post-Task-23 pattern:
// a dedicated `hasInitiallySynced` flag replaces the "serverState ===
// null" sentinel because recap/singleton may legitimately not exist
// yet. When the draft is clean, each poll syncs the fresh server copy
// forward (so a colleague's edits land in the editor). When the draft
// is dirty, the server copy only updates meta display; the admin's
// in-progress edits survive polls.
//
// Collision soft-safeguard (design section 6): before each write we
// re-read the recap doc and call hasConflict() against the snapshot
// taken at the last clean sync. On conflict we surface the standard
// Reload / Overwrite banner.
"use strict";

import { initFirestore, getDoc, onSnapshot } from "/js/firebase.js";
import * as ui from "/js/ui.js";
import { renderMarkdown } from "/js/markdown-mini.js";
import { relativeTime } from "/js/utils/time.js";
import { installFocusTrap } from "/js/utils/focus-trap.js";
import { adminFetch } from "./admin-fetch.js";
import { registerAdminViewCleanup } from "./admin.js";
import {
  snapshotEditingTimestamp,
  hasConflict,
  formatLastEditedPhrase,
} from "./collision-check.js";

const POLL_INTERVAL_MS = 30_000;
const OFFLINE_TOOLTIP = "You're offline \u2014 admin changes require connectivity.";
const THANKS_MAX = 2000;
const ACKS_MAX = 2000;
const CAPTION_MAX = 240;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_PHOTO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PREVIEW_DEBOUNCE_MS = 100;

// Push copy is hard-coded per the design: a short, generic alert that
// just announces the recap is up. The deep-link URL opens the attendee
// Recap view, so attendees land on the thanks + photos directly.
const PUSH_TITLE = "Vendor Day 2027 recap";
const PUSH_BODY = "The recap is up with photos and thank-yous.";
const PUSH_URL = "https://2027vendorday.gatewayscte.org/#/recap";

/**
 * Render the admin Recap editor into `host`.
 * @param {HTMLElement} host  typically `#admin-view-root`.
 * @returns {Promise<void>}
 */
export default async function renderRecapEditor(host) {
  host.innerHTML = "";

  const container = document.createElement("section");
  container.className = "admin-recap-editor";
  container.setAttribute("aria-label", "Admin Recap editor");
  host.appendChild(container);

  const header = buildStickyHeader();
  const partialBanner = buildPartialPushBanner();
  const offlineBanner = buildOfflineBanner();
  const panel = document.createElement("div");
  panel.className = "admin-recap-editor__panel";

  container.append(header.el, partialBanner.el, offlineBanner.el, panel);

  // Prime /api/config; cached inside firebase.js after the first call.
  const configReady = initFirestore().catch((err) => {
    console.warn("[admin-recap] /api/config load failed:", err);
    return null;
  });

  /* -------------------- State -------------------- */

  /** @type {object | null} Server copy of recap/singleton (may be null if doc missing). */
  let serverState = null;
  /** Collision snapshot taken when the editor last synced from the server. */
  let snapshotTs = null;
  /**
   * Whether we have ever synced the draft from a server read. Distinct from
   * `serverState === null` because the recap doc may legitimately not exist
   * yet; every pre-first-publish poll returns null and we must only sync
   * into the draft once (not on every subsequent poll).
   */
  let hasInitiallySynced = false;
  /** @type {Error | null} */
  let serverErr = null;
  let sawFirstResult = false;
  let serverErrorToasted = false;

  // Draft fields. Live edits are in the DOM; these mirror what the DOM
  // reads at any moment and are the source of truth for dirty checks.
  let draftThanks = "";
  let draftAcks = "";
  /** @type {Array<{ id: string, url: string, caption: string, order: number }>} */
  let draftPhotos = [];

  // In-flight / errored uploads. Rendered as tiles alongside draftPhotos
  // but NOT counted in dirty checks or writes — a pending upload is not
  // part of the saveable state until it succeeds and migrates into
  // draftPhotos.
  /** @type {Map<string, { file: File | null, status: "uploading" | "error", error?: string }>} */
  const pendingUploads = new Map();

  let draftSendPush = false;
  let online = typeof navigator === "undefined" || navigator.onLine !== false;

  // Flags protecting against double-submits.
  let savingDraft = false;
  let publishing = false;
  let unpublishing = false;

  /**
   * The "Published, but push did not send" banner payload. Null when the
   * banner is dismissed or when the last publish ran cleanly.
   * @type {{ error: string } | null}
   */
  let partialPushState = null;
  let retryingPush = false;

  // Debounce handle for the live markdown preview.
  let previewTimer = null;

  // Mounted editor DOM refs — populated by mountEditor() and consumed by
  // every scoped update that doesn't rebuild the whole editor.
  /** @type {{
   *   publicationCard: HTMLElement,
   *   thanksInput: HTMLTextAreaElement,
   *   acksInput: HTMLTextAreaElement,
   *   acksPreview: HTMLElement,
   *   photosGrid: HTMLElement,
   *   pushToggleWrap: HTMLElement,
   *   pushToggleInput: HTMLInputElement,
   *   pushPreviewEl: HTMLElement,
   *   saveBtn: HTMLButtonElement,
   *   saveLabel: HTMLElement,
   *   publishBtn: HTMLButtonElement,
   *   publishLabel: HTMLElement,
   *   errorBanner: HTMLElement,
   *   conflictBanner: HTMLElement,
   * } | null} */
  let editorRefs = null;

  /* -------------------- Subscription -------------------- */

  /** @type {(() => void) | null} */
  let unsub = null;

  async function startSubscription() {
    try { await configReady; } catch (_err) { /* non-fatal */ }
    unsub = onSnapshot(
      "recap/singleton",
      (data, err) => {
        if (err) {
          console.warn("[admin-recap] poll failed:", err);
          serverErr = err;
          if (!hasInitiallySynced && !serverErrorToasted) {
            ui.toast(
              "error",
              "Couldn't load the recap. Tap Retry to try again.",
            );
            serverErrorToasted = true;
          }
        } else {
          serverErr = null;
          serverErrorToasted = false;
          applyServerState(data);
        }
        sawFirstResult = true;
        afterServerRead();
      },
      { intervalMs: POLL_INTERVAL_MS },
    );
  }

  function restartSubscription() {
    if (unsub) { unsub(); unsub = null; }
    serverErr = null;
    serverState = null;
    hasInitiallySynced = false;
    sawFirstResult = false;
    serverErrorToasted = false;
    renderSkeleton(panel);
    editorRefs = null;
    startSubscription();
  }

  /**
   * Nudge an off-cycle poll right now so the view reflects a just-saved
   * write without waiting out the 30s interval. Keeps the current DOM
   * mounted so the admin's cursor isn't disturbed.
   */
  function nudgeRefresh() {
    if (unsub) { unsub(); unsub = null; }
    serverErr = null;
    serverErrorToasted = false;
    startSubscription();
  }

  /**
   * Reconcile incoming server state with the local draft. On first sync
   * we always adopt. On later syncs we adopt only when the draft is
   * byte-identical to what we last synced (so the admin's uncommitted
   * edits survive polls). The Save flow surfaces a conflict banner when
   * a dirty draft collides with a newer server copy.
   */
  function applyServerState(data) {
    const next = data && typeof data === "object" ? data : null;
    const nextSnapshotTs = snapshotEditingTimestamp(next);

    const draftWasClean =
      !hasInitiallySynced ||
      serializeDraft() === serializeServer(serverState);

    serverState = next;
    if (draftWasClean) {
      draftThanks = typeof next?.thanksMessage === "string" ? next.thanksMessage : "";
      draftAcks = typeof next?.acknowledgments === "string" ? next.acknowledgments : "";
      draftPhotos = normalizePhotos(next?.photos);
      snapshotTs = nextSnapshotTs;
      syncDomFromDraft();
    }
    hasInitiallySynced = true;
  }

  /**
   * After every server-read tick: either show the error-no-cache panel,
   * mount the editor (first sync), or scope-update the editor's
   * publication card / button states / meta line.
   */
  function afterServerRead() {
    offlineBanner.setVisible(!online);
    header.setLastEdited(serverState);
    syncPartialPushBanner();

    if (serverErr && !hasInitiallySynced) {
      renderErrorNoCache(panel, () => restartSubscription());
      editorRefs = null;
      return;
    }
    if (!sawFirstResult) {
      renderSkeleton(panel);
      return;
    }

    if (!editorRefs) {
      mountEditor();
    }
    refreshPublicationCard();
    refreshErrorStrip();
    refreshButtonStates();
    refreshPushToggle();
  }

  /* -------------------- Editor mounting -------------------- */

  function mountEditor() {
    panel.innerHTML = "";

    const publicationCard = buildPublicationCard();
    const errorBanner = document.createElement("div");
    errorBanner.className = "admin-modal__banner admin-recap-save-banner";
    errorBanner.hidden = true;
    errorBanner.setAttribute("role", "alert");

    const conflictBanner = document.createElement("div");
    conflictBanner.className =
      "admin-modal__banner admin-recap-save-banner admin-recap-save-banner--conflict";
    conflictBanner.hidden = true;

    const thanksSection = buildThanksSection();
    const acksSection = buildAcksSection();
    const photosSection = buildPhotosSection();
    const pushSection = buildPushSection();
    const buttonsRow = buildSavePublishButtons();

    panel.append(
      publicationCard.el,
      errorBanner,
      conflictBanner,
      thanksSection.el,
      acksSection.el,
      photosSection.el,
      pushSection.el,
      buttonsRow.el,
    );

    editorRefs = {
      publicationCard: publicationCard.el,
      thanksInput: thanksSection.input,
      acksInput: acksSection.input,
      acksPreview: acksSection.preview,
      photosGrid: photosSection.grid,
      pushToggleWrap: pushSection.el,
      pushToggleInput: pushSection.input,
      pushPreviewEl: pushSection.preview,
      saveBtn: buttonsRow.saveBtn,
      saveLabel: buttonsRow.saveLabel,
      publishBtn: buttonsRow.publishBtn,
      publishLabel: buttonsRow.publishLabel,
      errorBanner,
      conflictBanner,
    };

    syncDomFromDraft();
    renderPhotosGrid();
    updateAcksPreview();
  }

  function syncDomFromDraft() {
    if (!editorRefs) return;
    if (editorRefs.thanksInput.value !== draftThanks) {
      editorRefs.thanksInput.value = draftThanks;
    }
    if (editorRefs.acksInput.value !== draftAcks) {
      editorRefs.acksInput.value = draftAcks;
    }
    updateAcksPreview();
    renderPhotosGrid();
  }

  /* -------------------- Section builders -------------------- */

  function buildPublicationCard() {
    const el = document.createElement("section");
    el.className = "admin-recap-publication-card";
    el.setAttribute("aria-label", "Recap publication status");
    el.innerHTML = `
      <div class="admin-recap-publication-card__header">
        <span class="admin-recap-publication-card__pill" data-pub-pill>OFF</span>
        <p class="admin-recap-publication-card__text" data-pub-text>Loading\u2026</p>
      </div>
      <p class="admin-recap-publication-card__timestamp" data-pub-timestamp hidden></p>
      <div class="admin-recap-publication-card__actions" data-pub-actions hidden>
        <button type="button" class="btn-destructive admin-recap-unpublish-btn" data-unpublish>Unpublish recap</button>
      </div>
    `;
    const unpublishBtn = el.querySelector("[data-unpublish]");
    unpublishBtn.addEventListener("click", () => confirmUnpublish());
    return { el };
  }

  function refreshPublicationCard() {
    if (!editorRefs) return;
    const card = editorRefs.publicationCard;
    const pill = card.querySelector("[data-pub-pill]");
    const text = card.querySelector("[data-pub-text]");
    const stamp = card.querySelector("[data-pub-timestamp]");
    const actions = card.querySelector("[data-pub-actions]");
    const unpublishBtn = card.querySelector("[data-unpublish]");

    const isPublished = serverState?.published === true;

    card.classList.toggle("admin-recap-publication-card--on", isPublished);
    card.classList.toggle("admin-recap-publication-card--off", !isPublished);
    pill.classList.toggle("admin-recap-publication-card__pill--on", isPublished);
    pill.classList.toggle("admin-recap-publication-card__pill--off", !isPublished);
    pill.textContent = isPublished ? "LIVE" : "OFF";

    if (isPublished) {
      text.textContent =
        "Recap published \u00B7 Attendees can view it from the More menu.";
      const publishedIso = typeof serverState.publishedAt === "string"
        ? serverState.publishedAt
        : "";
      const rel = publishedIso ? relativeTime(publishedIso) : "";
      if (rel) {
        stamp.hidden = false;
        stamp.innerHTML =
          `Published <time datetime="${escapeAttr(publishedIso)}">${escapeHtml(rel)}</time>.`;
      } else {
        stamp.hidden = true;
      }
      actions.hidden = false;
      const disable = !online || unpublishing;
      unpublishBtn.disabled = disable;
      if (!online) unpublishBtn.setAttribute("title", OFFLINE_TOOLTIP);
      else unpublishBtn.removeAttribute("title");
      if (disable) unpublishBtn.setAttribute("aria-disabled", "true");
      else unpublishBtn.removeAttribute("aria-disabled");
      unpublishBtn.textContent = unpublishing ? "Unpublishing\u2026" : "Unpublish recap";
    } else {
      text.textContent =
        "Recap not published. Attendees do NOT see the Recap entry in the More menu.";
      stamp.hidden = true;
      actions.hidden = true;
    }
  }

  function buildThanksSection() {
    const el = document.createElement("section");
    el.className = "admin-recap-section admin-recap-thanks-section";
    el.innerHTML = `
      <label class="admin-recap-field-label" for="admin-recap-thanks">
        Thank-you message
      </label>
      <textarea
        id="admin-recap-thanks"
        class="admin-textarea admin-recap-thanks-field"
        maxlength="${THANKS_MAX}"
        rows="3"
        autocomplete="off"
        placeholder="A short message from the Gateway Chapter board."
      ></textarea>
      <p class="admin-recap-field-help">
        Plain text. Line breaks are preserved on the attendee Recap view.
      </p>
    `;
    const input = el.querySelector("textarea");
    input.addEventListener("input", () => {
      draftThanks = input.value;
      refreshButtonStates();
    });
    return { el, input };
  }

  function buildAcksSection() {
    const el = document.createElement("section");
    el.className = "admin-recap-section admin-recap-acknowledgments-section";
    el.innerHTML = `
      <label class="admin-recap-field-label" for="admin-recap-acks">
        Acknowledgments (markdown supported)
      </label>
      <div class="admin-recap-acknowledgments-grid">
        <div class="admin-recap-acknowledgments-field-column">
          <textarea
            id="admin-recap-acks"
            class="admin-textarea admin-recap-acknowledgments-field"
            maxlength="${ACKS_MAX}"
            rows="6"
            autocomplete="off"
            placeholder="Thank the sponsors, volunteers, speakers, and venue."
          ></textarea>
          <div class="admin-recap-md-help">
            <button
              type="button"
              class="btn-link admin-recap-md-ref-btn"
              aria-expanded="false"
              aria-controls="admin-recap-md-ref"
              data-md-ref-toggle
            >Markdown reference</button>
            <div
              id="admin-recap-md-ref"
              class="admin-recap-md-ref-popover"
              hidden
              role="region"
              aria-label="Supported markdown syntax"
            >
              <ul>
                <li><code>**bold**</code> &rarr; <strong>bold</strong></li>
                <li><code>*italic*</code> &rarr; <em>italic</em></li>
                <li><code>\`code\`</code> &rarr; <code>code</code></li>
                <li><code>[label](https://example.com)</code> &rarr; link</li>
                <li><code>- item</code> or <code>* item</code> &rarr; bullet list</li>
                <li><code>1. item</code> &rarr; numbered list</li>
                <li>Blank line separates paragraphs; single newline becomes a line break.</li>
              </ul>
            </div>
          </div>
        </div>
        <div class="admin-recap-acknowledgments-preview-column">
          <p class="admin-recap-acknowledgments-preview-label">Live preview</p>
          <article class="admin-recap-acknowledgments-preview" data-acks-preview>
            <p class="admin-recap-acknowledgments-preview-empty">Preview appears here.</p>
          </article>
        </div>
      </div>
    `;
    const input = el.querySelector("textarea");
    const preview = el.querySelector("[data-acks-preview]");

    input.addEventListener("input", () => {
      draftAcks = input.value;
      refreshButtonStates();
      schedulePreviewUpdate();
    });

    // Markdown reference popover: tap to toggle; outside-click closes it.
    const refBtn = el.querySelector("[data-md-ref-toggle]");
    const refPopover = el.querySelector("#admin-recap-md-ref");
    function onOutsideClick(ev) {
      if (!el.isConnected) {
        document.removeEventListener("click", onOutsideClick);
        return;
      }
      if (refPopover.hidden) return;
      if (!refPopover.contains(ev.target) && ev.target !== refBtn) {
        refPopover.hidden = true;
        refBtn.setAttribute("aria-expanded", "false");
        document.removeEventListener("click", onOutsideClick);
      }
    }
    refBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const willOpen = refPopover.hidden;
      refPopover.hidden = !willOpen;
      refBtn.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) document.addEventListener("click", onOutsideClick);
      else document.removeEventListener("click", onOutsideClick);
    });

    return { el, input, preview };
  }

  function schedulePreviewUpdate() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      updateAcksPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  function updateAcksPreview() {
    if (!editorRefs) return;
    const html = renderMarkdown(draftAcks || "");
    if (!html) {
      editorRefs.acksPreview.innerHTML =
        `<p class="admin-recap-acknowledgments-preview-empty">Preview appears here.</p>`;
    } else {
      editorRefs.acksPreview.innerHTML = html;
    }
  }

  function buildPhotosSection() {
    const el = document.createElement("section");
    el.className = "admin-recap-section admin-recap-photos-section";
    el.innerHTML = `
      <div class="admin-recap-field-label">Photo gallery</div>
      <p class="admin-recap-field-help">
        PNG, JPEG, or WebP. Max 5 MB per photo. Thumbnails and captions
        show in the attendee Recap view sorted by the order below.
      </p>
      <div
        class="admin-recap-photos-grid"
        data-photos-grid
        aria-label="Recap photos"
      ></div>
      <input
        type="file"
        class="admin-recap-photos-input"
        data-photos-input
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
      />
    `;
    const grid = el.querySelector("[data-photos-grid]");
    const fileInput = el.querySelector("[data-photos-input]");
    fileInput.addEventListener("change", () => {
      const files = Array.from(fileInput.files || []);
      // Clear so re-picking the same file re-triggers the change event.
      fileInput.value = "";
      for (const file of files) addPhotoFile(file);
    });
    return { el, grid };
  }

  function buildPushSection() {
    const el = document.createElement("div");
    el.className = "admin-recap-push-toggle";
    el.innerHTML = `
      <label class="admin-recap-push-toggle__label">
        <input
          type="checkbox"
          class="admin-recap-push-toggle__input"
          data-push-input
        />
        <span>Send a push notification when I publish.</span>
      </label>
      <div class="admin-push-preview admin-recap-push-preview" data-push-preview hidden>
        <p class="admin-push-preview__header">Push preview</p>
        <p class="admin-push-preview__title">${escapeHtml(PUSH_TITLE)}</p>
        <p class="admin-push-preview__body">${escapeHtml(PUSH_BODY)}</p>
        <p class="admin-push-preview__note">
          This is roughly what subscribers' devices will show. Tapping
          the notification opens the Recap view.
        </p>
      </div>
    `;
    const input = el.querySelector("[data-push-input]");
    const preview = el.querySelector("[data-push-preview]");
    input.addEventListener("change", () => {
      draftSendPush = input.checked;
      preview.hidden = !input.checked;
    });
    return { el, input, preview };
  }

  function buildSavePublishButtons() {
    const el = document.createElement("div");
    el.className = "admin-recap-save-buttons";
    el.innerHTML = `
      <button type="button" class="btn-secondary admin-recap-save-btn" data-save>
        <span class="admin-recap-save-btn__label">Save draft</span>
      </button>
      <button type="button" class="btn-primary admin-recap-publish-btn" data-publish>
        <span class="admin-recap-publish-btn__label">Publish</span>
      </button>
    `;
    const saveBtn = el.querySelector("[data-save]");
    const saveLabel = el.querySelector(".admin-recap-save-btn__label");
    const publishBtn = el.querySelector("[data-publish]");
    const publishLabel = el.querySelector(".admin-recap-publish-btn__label");

    saveBtn.addEventListener("click", () => saveDraft());
    publishBtn.addEventListener("click", () => publishRecap());

    return { el, saveBtn, saveLabel, publishBtn, publishLabel };
  }

  /* -------------------- Scoped refreshers -------------------- */

  function refreshErrorStrip() {
    if (!editorRefs) return;
    let strip = panel.querySelector(".admin-recap-stale-strip");
    const show = Boolean(serverErr) && hasInitiallySynced;
    if (!show) {
      if (strip) strip.remove();
      return;
    }
    if (!strip) {
      strip = document.createElement("div");
      strip.className = "status-error admin-recap-stale-strip";
      strip.setAttribute("role", "status");
      strip.innerHTML = `
        <span>Couldn't refresh. Showing last-saved recap.</span>
        <button type="button" class="btn-secondary" data-retry>Retry</button>
      `;
      strip.querySelector("[data-retry]").addEventListener("click", () =>
        restartSubscription(),
      );
      panel.insertBefore(strip, editorRefs.publicationCard);
    }
  }

  function refreshButtonStates() {
    if (!editorRefs) return;
    const dirty = isDirty();
    const isPublished = serverState?.published === true;
    const saveEnabled =
      online && !savingDraft && !publishing && dirty && !hasUploadInFlight();
    const publishEnabled =
      online &&
      !publishing &&
      !savingDraft &&
      !hasUploadInFlight() &&
      (dirty || !isPublished);

    setBtnEnabled(editorRefs.saveBtn, saveEnabled, OFFLINE_TOOLTIP);
    setBtnEnabled(editorRefs.publishBtn, publishEnabled, OFFLINE_TOOLTIP);

    if (!savingDraft) editorRefs.saveLabel.textContent = "Save draft";
    if (!publishing) editorRefs.publishLabel.textContent = "Publish";
  }

  function refreshPushToggle() {
    if (!editorRefs) return;
    const isPublished = serverState?.published === true;
    // Only enabled when the recap is NOT already published — publishing
    // is the trigger. On republish-after-unpublish we reset to unchecked.
    const canEnable = online && !isPublished;
    editorRefs.pushToggleInput.disabled = !canEnable;
    if (!canEnable) {
      editorRefs.pushToggleInput.checked = false;
      draftSendPush = false;
      editorRefs.pushPreviewEl.hidden = true;
    } else {
      editorRefs.pushToggleInput.checked = draftSendPush;
      editorRefs.pushPreviewEl.hidden = !draftSendPush;
    }
    editorRefs.pushToggleWrap.classList.toggle(
      "admin-recap-push-toggle--disabled",
      !canEnable,
    );
    if (!online) {
      editorRefs.pushToggleInput.setAttribute("title", OFFLINE_TOOLTIP);
    } else {
      editorRefs.pushToggleInput.removeAttribute("title");
    }
  }

  function setBtnEnabled(btn, enabled, offlineTip) {
    if (enabled) {
      btn.disabled = false;
      btn.removeAttribute("aria-disabled");
      btn.removeAttribute("title");
    } else {
      btn.disabled = true;
      btn.setAttribute("aria-disabled", "true");
      if (!online && offlineTip) btn.setAttribute("title", offlineTip);
      else btn.removeAttribute("title");
    }
  }

  /* -------------------- Dirty tracking -------------------- */

  function serializeDraft() {
    return JSON.stringify({
      thanks: (draftThanks || "").trim(),
      acks: (draftAcks || "").trim(),
      photos: photosForWrite(),
    });
  }

  function serializeServer(state) {
    return JSON.stringify({
      thanks: typeof state?.thanksMessage === "string" ? state.thanksMessage.trim() : "",
      acks: typeof state?.acknowledgments === "string" ? state.acknowledgments.trim() : "",
      photos: normalizePhotos(state?.photos).map((p, idx) => ({
        id: p.id,
        url: p.url,
        caption: (p.caption || "").trim(),
        order: idx + 1,
      })),
    });
  }

  function isDirty() {
    return serializeDraft() !== serializeServer(serverState);
  }

  function hasUploadInFlight() {
    for (const [, entry] of pendingUploads) {
      if (entry.status === "uploading") return true;
    }
    return false;
  }

  function photosForWrite() {
    // Normalize the order to a dense 1..N and strip local-only fields.
    const sorted = draftPhotos.slice().sort((a, b) =>
      (Number(a.order) || 0) - (Number(b.order) || 0),
    );
    return sorted.map((p, idx) => ({
      id: p.id,
      url: p.url,
      caption: (p.caption || "").trim(),
      order: idx + 1,
    }));
  }

  /* -------------------- Photo gallery -------------------- */

  function renderPhotosGrid() {
    if (!editorRefs) return;
    const grid = editorRefs.photosGrid;
    grid.innerHTML = "";

    const sortedPhotos = draftPhotos.slice().sort((a, b) =>
      (Number(a.order) || 0) - (Number(b.order) || 0),
    );

    sortedPhotos.forEach((photo, idx) => {
      grid.appendChild(buildPhotoTile(photo, {
        isFirst: idx === 0,
        isLast: idx === sortedPhotos.length - 1,
      }));
    });

    // Pending (uploading or errored) uploads render after ready photos
    // so their position matches admin expectation.
    for (const [tempId, entry] of pendingUploads) {
      grid.appendChild(buildPendingTile(tempId, entry));
    }

    grid.appendChild(buildAddPhotoTile());
  }

  function buildPhotoTile(photo, { isFirst, isLast }) {
    const el = document.createElement("div");
    el.className = "admin-recap-photo-tile";
    el.dataset.photoId = photo.id;

    const upDisabled = isFirst || !online;
    const downDisabled = isLast || !online;
    const captionDisabled = !online;

    el.innerHTML = `
      <div class="admin-recap-photo-tile__thumb-wrap">
        <img
          class="admin-recap-photo-tile__img"
          src="${escapeAttr(photo.url)}"
          alt="${escapeAttr(photo.caption || "")}"
          loading="lazy"
        />
      </div>
      <div class="admin-recap-photo-tile__reorder" role="group" aria-label="Reorder photo">
        <button
          type="button"
          class="admin-recap-photo-tile__reorder-btn"
          aria-label="Move photo up"
          data-up
          ${upDisabled ? "disabled aria-disabled=\"true\"" : ""}
          ${!online ? `title="${escapeAttr(OFFLINE_TOOLTIP)}"` : ""}
        >\u2191</button>
        <button
          type="button"
          class="admin-recap-photo-tile__reorder-btn"
          aria-label="Move photo down"
          data-down
          ${downDisabled ? "disabled aria-disabled=\"true\"" : ""}
          ${!online ? `title="${escapeAttr(OFFLINE_TOOLTIP)}"` : ""}
        >\u2193</button>
      </div>
      <label class="admin-recap-photo-tile__caption-label">
        <span class="sr-only">Caption</span>
        <input
          type="text"
          class="admin-input admin-recap-photo-tile__caption"
          maxlength="${CAPTION_MAX}"
          placeholder="Caption (optional)"
          ${captionDisabled ? "disabled" : ""}
        />
      </label>
      <button
        type="button"
        class="btn-destructive admin-recap-photo-tile__delete"
        aria-label="Delete photo"
        data-delete
        ${!online ? `disabled aria-disabled="true" title="${escapeAttr(OFFLINE_TOOLTIP)}"` : ""}
      >Delete</button>
    `;

    const captionInput = el.querySelector(".admin-recap-photo-tile__caption");
    captionInput.value = photo.caption || "";
    captionInput.addEventListener("input", () => {
      photo.caption = captionInput.value;
      refreshButtonStates();
    });

    el.querySelector("[data-up]").addEventListener("click", () => {
      if (isFirst || !online) return;
      swapPhotoOrder(photo.id, -1);
    });
    el.querySelector("[data-down]").addEventListener("click", () => {
      if (isLast || !online) return;
      swapPhotoOrder(photo.id, +1);
    });
    el.querySelector("[data-delete]").addEventListener("click", () => {
      if (!online) return;
      confirmDeletePhoto(photo);
    });

    return el;
  }

  function buildPendingTile(tempId, entry) {
    const el = document.createElement("div");
    el.className = "admin-recap-photo-tile";
    el.dataset.pendingId = tempId;
    if (entry.status === "uploading") {
      el.classList.add("admin-recap-photo-tile--uploading");
      el.innerHTML = `
        <div class="admin-recap-photo-tile__thumb-wrap admin-recap-photo-tile__thumb-wrap--placeholder">
          <div class="admin-recap-photo-tile__shimmer" aria-hidden="true"></div>
        </div>
        <p class="admin-recap-photo-tile__status" role="status">Uploading\u2026</p>
      `;
    } else {
      el.classList.add("admin-recap-photo-tile--error");
      const errText = entry.error || "Could not upload \u2014 Retry.";
      el.innerHTML = `
        <div class="admin-recap-photo-tile__thumb-wrap admin-recap-photo-tile__thumb-wrap--placeholder">
          <p class="admin-recap-photo-tile__error-icon" aria-hidden="true">!</p>
        </div>
        <p class="admin-recap-photo-tile__status admin-recap-photo-tile__status--error" role="alert">
          ${escapeHtml(errText)}
        </p>
        <div class="admin-recap-photo-tile__error-actions">
          <button
            type="button"
            class="btn-primary admin-recap-photo-tile__retry"
            data-retry
            ${!online ? `disabled aria-disabled="true" title="${escapeAttr(OFFLINE_TOOLTIP)}"` : ""}
          >Retry</button>
          <button
            type="button"
            class="btn-secondary admin-recap-photo-tile__remove"
            data-remove
          >Remove</button>
        </div>
      `;
      el.querySelector("[data-retry]").addEventListener("click", () => {
        if (!online) return;
        retryPendingUpload(tempId);
      });
      el.querySelector("[data-remove]").addEventListener("click", () => {
        pendingUploads.delete(tempId);
        renderPhotosGrid();
        refreshButtonStates();
      });
    }
    return el;
  }

  function buildAddPhotoTile() {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "admin-recap-add-photo-tile";
    el.setAttribute("aria-label", "Add photo");
    el.innerHTML = `
      <span class="admin-recap-add-photo-tile__plus" aria-hidden="true">+</span>
      <span class="admin-recap-add-photo-tile__label">Add photo</span>
    `;
    if (!online) {
      el.disabled = true;
      el.setAttribute("aria-disabled", "true");
      el.setAttribute("title", OFFLINE_TOOLTIP);
    }
    el.addEventListener("click", () => {
      if (!online) return;
      const input = panel.querySelector("[data-photos-input]");
      if (input) input.click();
    });
    return el;
  }

  function nextOrderValue() {
    let max = 0;
    for (const p of draftPhotos) {
      const n = Number(p.order);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
  }

  function swapPhotoOrder(photoId, delta) {
    const sorted = draftPhotos.slice().sort((a, b) =>
      (Number(a.order) || 0) - (Number(b.order) || 0),
    );
    const idx = sorted.findIndex((p) => p.id === photoId);
    if (idx < 0) return;
    const neighborIdx = idx + delta;
    if (neighborIdx < 0 || neighborIdx >= sorted.length) return;
    // Normalize to dense 1..N so a photos array that only had server-side
    // orders still gets stable integer values after the first swap.
    sorted.forEach((p, i) => {
      p.order = i + 1;
    });
    const a = sorted[idx];
    const b = sorted[neighborIdx];
    const tmp = a.order;
    a.order = b.order;
    b.order = tmp;
    renderPhotosGrid();
    refreshButtonStates();
  }

  async function addPhotoFile(file) {
    const validationErr = validatePhotoFile(file);
    if (validationErr) {
      ui.toast("error", validationErr);
      return;
    }
    const tempId = newUuid();
    pendingUploads.set(tempId, { file, status: "uploading" });
    renderPhotosGrid();
    refreshButtonStates();

    try {
      const result = await uploadRecapPhoto(file, tempId);
      if (!result?.url || typeof result.url !== "string") {
        throw new Error("Upload response missing url");
      }
      pendingUploads.delete(tempId);
      draftPhotos.push({
        id: tempId,
        url: result.url,
        caption: "",
        order: nextOrderValue(),
      });
      renderPhotosGrid();
      refreshButtonStates();
    } catch (err) {
      console.warn("[admin-recap] photo upload failed:", err);
      if (err?.code === "session-expired") return;
      pendingUploads.set(tempId, {
        file,
        status: "error",
        error: formatUploadError(err),
      });
      renderPhotosGrid();
      refreshButtonStates();
    }
  }

  async function retryPendingUpload(tempId) {
    const entry = pendingUploads.get(tempId);
    if (!entry || !entry.file) return;
    pendingUploads.set(tempId, { file: entry.file, status: "uploading" });
    renderPhotosGrid();
    refreshButtonStates();

    try {
      const result = await uploadRecapPhoto(entry.file, tempId);
      if (!result?.url || typeof result.url !== "string") {
        throw new Error("Upload response missing url");
      }
      pendingUploads.delete(tempId);
      draftPhotos.push({
        id: tempId,
        url: result.url,
        caption: "",
        order: nextOrderValue(),
      });
      renderPhotosGrid();
      refreshButtonStates();
    } catch (err) {
      console.warn("[admin-recap] photo retry failed:", err);
      if (err?.code === "session-expired") return;
      pendingUploads.set(tempId, {
        file: entry.file,
        status: "error",
        error: formatUploadError(err),
      });
      renderPhotosGrid();
      refreshButtonStates();
    }
  }

  async function confirmDeletePhoto(photo) {
    const confirmed = await confirmDialog({
      title: "Delete photo?",
      body:
        "Remove this photo from the recap? The next save removes it " +
        "from Firestore. The uploaded file stays in storage and could " +
        "be reused by re-uploading later.",
      confirmLabel: "Delete photo",
      destructive: true,
    });
    if (!confirmed) return;
    draftPhotos = draftPhotos.filter((p) => p.id !== photo.id);
    renderPhotosGrid();
    refreshButtonStates();
  }

  /* -------------------- Save draft / Publish / Unpublish -------------------- */

  function showErrorBanner(message) {
    if (!editorRefs) return;
    const banner = editorRefs.errorBanner;
    banner.className =
      "admin-modal__banner admin-modal__banner--error admin-recap-save-banner";
    banner.innerHTML = `<p>${escapeHtml(message)}</p>`;
    banner.hidden = false;
    try { banner.scrollIntoView({ block: "center", behavior: "smooth" }); }
    catch (_err) { /* no-op */ }
  }
  function hideErrorBanner() {
    if (!editorRefs) return;
    editorRefs.errorBanner.hidden = true;
    editorRefs.errorBanner.innerHTML = "";
    editorRefs.errorBanner.className =
      "admin-modal__banner admin-recap-save-banner";
  }

  function showConflictBanner({ onReload, onOverwrite }) {
    if (!editorRefs) return;
    const banner = editorRefs.conflictBanner;
    banner.className =
      "admin-modal__banner admin-modal__banner--warning admin-conflict-banner admin-recap-save-banner admin-recap-save-banner--conflict";
    banner.innerHTML = `
      <p>The recap was edited by someone else since you opened the editor. Reload to see their changes, or Overwrite to save yours anyway.</p>
      <div class="admin-modal__banner-actions">
        <button type="button" class="btn-secondary" data-conflict-reload>Reload</button>
        <button type="button" class="btn-primary" data-conflict-overwrite>Overwrite</button>
      </div>
    `;
    banner.hidden = false;
    try { banner.scrollIntoView({ block: "center", behavior: "smooth" }); }
    catch (_err) { /* no-op */ }
    banner.querySelector("[data-conflict-reload]").addEventListener("click", () => {
      hideConflictBanner();
      onReload();
    });
    banner.querySelector("[data-conflict-overwrite]").addEventListener("click", () => {
      hideConflictBanner();
      onOverwrite();
    });
  }
  function hideConflictBanner() {
    if (!editorRefs) return;
    editorRefs.conflictBanner.hidden = true;
    editorRefs.conflictBanner.innerHTML = "";
    editorRefs.conflictBanner.className =
      "admin-modal__banner admin-recap-save-banner admin-recap-save-banner--conflict";
  }

  async function saveDraft({ bypassConflictCheck = false } = {}) {
    if (savingDraft || publishing || !editorRefs) return;
    if (!online) {
      showErrorBanner("You're offline. Reconnect and try again.");
      return;
    }
    if (hasUploadInFlight()) {
      showErrorBanner("Wait for photo uploads to finish before saving.");
      return;
    }
    hideErrorBanner();
    hideConflictBanner();

    savingDraft = true;
    refreshButtonStates();
    editorRefs.saveLabel.textContent = "Saving\u2026";

    try {
      if (!bypassConflictCheck && snapshotTs) {
        try {
          const latest = await getDoc("recap/singleton");
          if (hasConflict(latest, snapshotTs)) {
            savingDraft = false;
            refreshButtonStates();
            showConflictBanner({
              onReload: () => reloadFromLatest(),
              onOverwrite: () => saveDraft({ bypassConflictCheck: true }),
            });
            return;
          }
        } catch (err) {
          console.warn("[admin-recap] save conflict pre-check failed:", err);
        }
      }

      const payload = {
        thanksMessage: (draftThanks || "").trim(),
        acknowledgments: (draftAcks || "").trim(),
        photos: photosForWrite(),
      };

      await adminFetch("/api/firestore-write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection: "recap",
          docId: "singleton",
          op: "update",
          data: payload,
        }),
      });

      // Reflect the write locally so Save goes idle until a new edit.
      serverState = {
        ...(serverState || { published: false, publishedAt: null }),
        thanksMessage: payload.thanksMessage,
        acknowledgments: payload.acknowledgments,
        photos: clonePhotos(payload.photos),
      };
      snapshotTs = snapshotEditingTimestamp({
        ...serverState,
        updatedAt: new Date().toISOString(),
      });
      ui.toast("success", "Recap draft saved.");
      nudgeRefresh();
    } catch (err) {
      console.warn("[admin-recap] save draft failed:", err);
      if (err?.code === "session-expired") return;
      showErrorBanner("Could not save \u2014 try again.");
    } finally {
      savingDraft = false;
      editorRefs.saveLabel.textContent = "Save draft";
      refreshButtonStates();
    }
  }

  async function reloadFromLatest() {
    try {
      const latest = await getDoc("recap/singleton");
      serverState = latest && typeof latest === "object" ? latest : null;
      draftThanks = typeof serverState?.thanksMessage === "string"
        ? serverState.thanksMessage : "";
      draftAcks = typeof serverState?.acknowledgments === "string"
        ? serverState.acknowledgments : "";
      draftPhotos = normalizePhotos(serverState?.photos);
      snapshotTs = snapshotEditingTimestamp(serverState);
      syncDomFromDraft();
      refreshPublicationCard();
      refreshButtonStates();
      refreshPushToggle();
    } catch (err) {
      console.warn("[admin-recap] reload-latest failed:", err);
      showErrorBanner("Couldn't reload the latest copy. Try again.");
    }
  }

  async function publishRecap({ bypassConflictCheck = false } = {}) {
    if (publishing || savingDraft || !editorRefs) return;
    if (!online) {
      showErrorBanner("You're offline. Reconnect and try again.");
      return;
    }
    if (hasUploadInFlight()) {
      showErrorBanner("Wait for photo uploads to finish before publishing.");
      return;
    }
    hideErrorBanner();
    hideConflictBanner();

    publishing = true;
    refreshButtonStates();
    editorRefs.publishLabel.textContent = "Publishing\u2026";

    // 1) Collision pre-check.
    if (!bypassConflictCheck && snapshotTs) {
      try {
        const latest = await getDoc("recap/singleton");
        if (hasConflict(latest, snapshotTs)) {
          publishing = false;
          editorRefs.publishLabel.textContent = "Publish";
          refreshButtonStates();
          showConflictBanner({
            onReload: () => reloadFromLatest(),
            onOverwrite: () => publishRecap({ bypassConflictCheck: true }),
          });
          return;
        }
      } catch (err) {
        console.warn("[admin-recap] publish conflict pre-check failed:", err);
      }
    }

    const nowIso = new Date().toISOString();
    const payload = {
      thanksMessage: (draftThanks || "").trim(),
      acknowledgments: (draftAcks || "").trim(),
      photos: photosForWrite(),
      published: true,
      publishedAt: nowIso,
    };

    // 2) Firestore write.
    try {
      await adminFetch("/api/firestore-write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection: "recap",
          docId: "singleton",
          op: "update",
          data: payload,
        }),
      });
    } catch (err) {
      console.warn("[admin-recap] publish firestore write failed:", err);
      if (err?.code === "session-expired") {
        publishing = false;
        return;
      }
      publishing = false;
      editorRefs.publishLabel.textContent = "Publish";
      refreshButtonStates();
      showErrorBanner(
        "Could not publish \u2014 the recap was not saved. Try again.",
      );
      return;
    }

    // Reflect the write locally.
    serverState = {
      ...(serverState || {}),
      thanksMessage: payload.thanksMessage,
      acknowledgments: payload.acknowledgments,
      photos: clonePhotos(payload.photos),
      published: true,
      publishedAt: nowIso,
    };
    snapshotTs = snapshotEditingTimestamp({
      ...serverState,
      updatedAt: new Date().toISOString(),
    });

    // 3) Optional push.
    const shouldPush = draftSendPush === true;
    if (!shouldPush) {
      ui.toast("success", "Recap published.");
      finalizePublishSuccess();
      return;
    }

    try {
      await adminFetch("/api/send-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: PUSH_TITLE,
          bodyPreview: PUSH_BODY,
          url: PUSH_URL,
        }),
      });
      ui.toast("success", "Recap published and push sent.");
      partialPushState = null;
      syncPartialPushBanner();
    } catch (err) {
      console.warn("[admin-recap] send-push failed:", err);
      if (err?.code === "session-expired") {
        publishing = false;
        return;
      }
      // Firestore write already succeeded; surface the partial banner.
      partialPushState = { error: formatPushError(err) };
      ui.toast("success", "Recap published.");
      syncPartialPushBanner();
    }

    finalizePublishSuccess();
  }

  function finalizePublishSuccess() {
    publishing = false;
    draftSendPush = false;
    if (editorRefs) {
      editorRefs.publishLabel.textContent = "Publish";
      editorRefs.pushToggleInput.checked = false;
      editorRefs.pushPreviewEl.hidden = true;
    }
    refreshPublicationCard();
    refreshPushToggle();
    refreshButtonStates();
    nudgeRefresh();
  }

  async function confirmUnpublish() {
    if (unpublishing || !online) return;
    const confirmed = await confirmDialog({
      title: "Unpublish recap?",
      body:
        "Unpublish the recap? The Recap entry will disappear from the " +
        "attendee More menu. The content stays in Firestore and can be " +
        "republished later.",
      confirmLabel: "Unpublish",
      destructive: true,
    });
    if (!confirmed) return;

    unpublishing = true;
    refreshPublicationCard();

    try {
      await adminFetch("/api/firestore-write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection: "recap",
          docId: "singleton",
          op: "update",
          data: { published: false },
        }),
      });
      serverState = { ...(serverState || {}), published: false };
      snapshotTs = snapshotEditingTimestamp({
        ...serverState,
        updatedAt: new Date().toISOString(),
      });
      ui.toast("success", "Recap unpublished.");
      nudgeRefresh();
    } catch (err) {
      console.warn("[admin-recap] unpublish failed:", err);
      if (err?.code === "session-expired") return;
      ui.toast("error", "Could not unpublish \u2014 try again.");
    } finally {
      unpublishing = false;
      refreshPublicationCard();
      refreshPushToggle();
      refreshButtonStates();
    }
  }

  /* -------------------- Partial push banner -------------------- */

  function syncPartialPushBanner() {
    if (!partialPushState) {
      partialBanner.hide();
      return;
    }
    partialBanner.show(partialPushState, {
      online,
      onRetry: () => retryPush(),
      onDismiss: () => {
        partialPushState = null;
        partialBanner.hide();
      },
    });
  }

  async function retryPush() {
    if (retryingPush || !partialPushState || !online) return;
    retryingPush = true;
    partialBanner.setRetryBusy(true);
    try {
      await adminFetch("/api/send-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: PUSH_TITLE,
          bodyPreview: PUSH_BODY,
          url: PUSH_URL,
        }),
      });
      ui.toast("success", "Push sent.");
      partialPushState = null;
      partialBanner.hide();
    } catch (err) {
      console.warn("[admin-recap] retry push failed:", err);
      if (err?.code === "session-expired") {
        retryingPush = false;
        partialBanner.setRetryBusy(false);
        return;
      }
      partialPushState = { error: formatPushError(err) };
      partialBanner.show(partialPushState, {
        online,
        onRetry: () => retryPush(),
        onDismiss: () => {
          partialPushState = null;
          partialBanner.hide();
        },
      });
    } finally {
      retryingPush = false;
      partialBanner.setRetryBusy(false);
    }
  }

  /* -------------------- Connectivity -------------------- */

  const onOnline = () => {
    online = true;
    afterServerRead();
    renderPhotosGrid();
  };
  const onOffline = () => {
    online = false;
    afterServerRead();
    renderPhotosGrid();
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  const onVisibility = () => {
    if (document.visibilityState !== "visible") return;
    afterServerRead();
  };
  document.addEventListener("visibilitychange", onVisibility);

  registerAdminViewCleanup(() => {
    if (unsub) { unsub(); unsub = null; }
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onVisibility);
  });

  // Initial paint + start poll.
  renderSkeleton(panel);
  startSubscription();

  document.title = "Admin \u2014 Recap \u2014 Vendor Day 2027";
}

/* =================================================================
 * Sticky secondary header
 * ================================================================= */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "admin-recap-header";
  el.innerHTML = `
    <div class="admin-recap-header__row">
      <h2 class="admin-recap-header__title">Admin \u2014 Recap</h2>
      <p class="admin-recap-header__meta" aria-live="polite">never edited</p>
    </div>
  `;
  const metaEl = el.querySelector(".admin-recap-header__meta");
  function setLastEdited(doc) {
    metaEl.textContent = formatLastEditedPhrase(doc);
  }
  return { el, setLastEdited };
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
 * "Published, but push did not send" banner
 * ================================================================= */

function buildPartialPushBanner() {
  const el = document.createElement("div");
  el.className = "admin-push-banner-sent-partial";
  el.setAttribute("role", "status");
  el.hidden = true;

  /** @type {HTMLButtonElement | null} */
  let retryBtn = null;

  function show(state, { online, onRetry, onDismiss }) {
    el.innerHTML = `
      <div class="admin-push-banner-sent-partial__body">
        <p class="admin-push-banner-sent-partial__title">Published, but push did not send.</p>
        <p class="admin-push-banner-sent-partial__detail">
          The recap is live, but the OneSignal push did not go out.
        </p>
        <p class="admin-push-banner-sent-partial__error">${escapeHtml(state.error || "")}</p>
      </div>
      <div class="admin-push-banner-sent-partial__actions">
        <button type="button" class="btn-secondary" data-dismiss>Dismiss</button>
        <button
          type="button"
          class="btn-primary admin-push-banner-sent-partial__retry"
          data-retry
          ${online ? "" : `disabled aria-disabled="true" title="${escapeAttr(OFFLINE_TOOLTIP)}"`}
        >
          <span class="admin-push-banner-sent-partial__retry-label">Retry push</span>
        </button>
      </div>
    `;
    el.hidden = false;
    retryBtn = el.querySelector("[data-retry]");
    el.querySelector("[data-dismiss]").addEventListener("click", () => {
      if (typeof onDismiss === "function") onDismiss();
    });
    retryBtn.addEventListener("click", () => {
      if (!online) return;
      if (typeof onRetry === "function") onRetry();
    });
  }

  function hide() {
    el.hidden = true;
    el.innerHTML = "";
    retryBtn = null;
  }

  function setRetryBusy(busy) {
    if (!retryBtn) return;
    const label = retryBtn.querySelector(".admin-push-banner-sent-partial__retry-label");
    if (busy) {
      retryBtn.disabled = true;
      retryBtn.classList.add("admin-push-banner-sent-partial__retry--loading");
      if (label) label.textContent = "Retrying\u2026";
    } else {
      retryBtn.disabled = false;
      retryBtn.classList.remove("admin-push-banner-sent-partial__retry--loading");
      if (label) label.textContent = "Retry push";
    }
  }

  return { el, show, hide, setRetryBusy };
}

/* =================================================================
 * Loading / error states
 * ================================================================= */

function renderSkeleton(host) {
  host.innerHTML = `
    <div class="admin-recap-publication-card skeleton-card" aria-hidden="true"></div>
    <div class="admin-recap-section skeleton-card" aria-hidden="true" style="height: 7rem;"></div>
    <div class="admin-recap-section skeleton-card" aria-hidden="true" style="height: 10rem;"></div>
    <div class="admin-recap-photos-grid" aria-hidden="true">
      <div class="admin-recap-photo-tile skeleton-card"></div>
      <div class="admin-recap-photo-tile skeleton-card"></div>
      <div class="admin-recap-photo-tile skeleton-card"></div>
    </div>
  `;
}

function renderErrorNoCache(host, onRetry) {
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't load the recap.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

/* =================================================================
 * Photo upload (POST /api/upload)
 * ================================================================= */

/**
 * POST the picked file to `/api/upload` as multipart/form-data with the
 * fields the Function expects (`file`, `kind=recap`, `id=<photoId>`).
 * The browser sets the multipart Content-Type with its boundary; we
 * must NOT set it manually. The admin JWT comes from adminFetch, which
 * forwards 401 to the session-expired redirect.
 *
 * @param {File} file
 * @param {string} photoId  the photo's UUID (becomes the R2 object key)
 * @returns {Promise<{ url: string, key: string, size: number, contentType: string }>}
 */
async function uploadRecapPhoto(file, photoId) {
  const form = new FormData();
  form.append("file", file);
  form.append("kind", "recap");
  form.append("id", photoId);
  return adminFetch("/api/upload", {
    method: "POST",
    body: form,
  });
}

function validatePhotoFile(file) {
  if (!file || typeof file.size !== "number") return "That file isn't recognized as an image.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_PHOTO_BYTES) return "File too large. Max 5 MB.";
  const type = (file.type || "").toLowerCase();
  if (!ALLOWED_PHOTO_TYPES.has(type)) {
    return "Unsupported file type. Choose a PNG, JPEG, or WebP.";
  }
  return null;
}

function formatUploadError(err) {
  if (!err) return "Could not upload \u2014 Retry.";
  if (err.code === "network-error") {
    return "Network error \u2014 Retry.";
  }
  if (err.code === "rate-limited") {
    return "Too many uploads \u2014 wait a moment, then Retry.";
  }
  if (typeof err.status === "number") {
    if (err.status === 413) return "File too large. Max 5 MB.";
    if (err.status === 415) return "Unsupported file type.";
    return `Upload failed (${err.status}). Retry.`;
  }
  return "Could not upload \u2014 Retry.";
}

/* =================================================================
 * Push error formatting (shared pattern with Announcements composer)
 * ================================================================= */

function formatPushError(err) {
  if (!err) return "Unknown error.";
  const code = err.code;
  const base = err.message || "Push send failed.";
  if (code === "network-error") {
    return "Network error reaching OneSignal \u2014 check your connection and try again.";
  }
  if (code === "rate-limited") {
    const sec = Number(err.retryAfterSec);
    const wait = Number.isFinite(sec) && sec > 0 ? ` Try again in ${sec}s.` : "";
    return `Rate limited.${wait}`;
  }
  if (typeof err.status === "number") {
    return `OneSignal returned ${err.status}: ${base}`;
  }
  return base;
}

/* =================================================================
 * Generic confirm dialog (reused for Unpublish + Delete photo)
 * ================================================================= */

function confirmDialog({ title, body, confirmLabel, destructive }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className =
      "admin-modal-overlay admin-modal-overlay--confirm admin-modal-overlay--nested";

    const modal = document.createElement("div");
    modal.className = "admin-modal admin-modal--confirm";
    modal.setAttribute("role", "alertdialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "admin-recap-confirm-title");
    modal.setAttribute("aria-describedby", "admin-recap-confirm-body");
    modal.setAttribute("tabindex", "-1");

    const confirmClass = destructive ? "btn-destructive" : "btn-primary";
    modal.innerHTML = `
      <header class="admin-modal__header">
        <h2 class="admin-modal__title" id="admin-recap-confirm-title">${escapeHtml(title)}</h2>
      </header>
      <div class="admin-modal__body" id="admin-recap-confirm-body">
        <p>${escapeHtml(body)}</p>
      </div>
      <footer class="admin-modal__footer">
        <button type="button" class="btn-secondary" data-cancel>Cancel</button>
        <button type="button" class="${confirmClass}" data-confirm>${escapeHtml(confirmLabel)}</button>
      </footer>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const cancelBtn = modal.querySelector("[data-cancel]");
    const confirmBtn = modal.querySelector("[data-confirm]");

    function close(result) {
      try { uninstall(); } catch (_err) { /* no-op */ }
      overlay.remove();
      resolve(result);
    }

    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close(false);
    });

    const uninstall = installFocusTrap(modal, {
      onEscape: () => close(false),
      // Destructive confirms start on Cancel so the admin can't blow
      // past the dialog with Enter.
      initialFocus: () => (destructive ? cancelBtn : confirmBtn),
    });
  });
}

/* =================================================================
 * Helpers
 * ================================================================= */

function normalizePhotos(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const normalized = [];
  for (const p of arr) {
    if (!p || typeof p !== "object") continue;
    const id = typeof p.id === "string" && p.id.trim() ? p.id.trim() : null;
    const url = typeof p.url === "string" && p.url.trim() ? p.url.trim() : null;
    if (!id || !url) continue;
    const caption = typeof p.caption === "string" ? p.caption : "";
    const order = Number.isFinite(Number(p.order)) ? Number(p.order) : 0;
    normalized.push({ id, url, caption, order });
  }
  normalized.sort((a, b) => a.order - b.order);
  // Rewrite order densely so a legacy doc with sparse orders becomes
  // predictable for later reorder swaps.
  for (let i = 0; i < normalized.length; i++) {
    normalized[i].order = i + 1;
  }
  return normalized;
}

function clonePhotos(photos) {
  return (photos || []).map((p) => ({
    id: p.id,
    url: p.url,
    caption: p.caption || "",
    order: Number(p.order) || 0,
  }));
}

function newUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
function escapeAttr(s) {
  return escapeHtml(s);
}
