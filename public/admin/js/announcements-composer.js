// announcements-composer.js — admin Announcement composer + push toggle (Task 21).
//
// Mounts into #admin-view-root. Unlike the Agenda / Sponsors editors
// which open a modal to compose, announcements compose inline in a
// card at the top of the view and the past-announcements list sits
// below. There is no grouping to compete with (announcements are a
// flat chronological feed) so an inline composer is simpler than a
// modal and keeps the live markdown preview visible alongside the
// list for context.
//
// This view also owns the Task 21 push flow: on Publish the view
// writes the announcement to Firestore via /api/firestore-write, then
// (if the Send-push checkbox is on) POSTs to /api/send-push. The three
// failure modes from design section 7 are mapped to concrete UI:
//
//   1. Firestore write fails
//      -> inline error banner at the top of the composer, content kept.
//        No push attempt. Admin re-taps Publish to retry.
//
//   2. Firestore write succeeds, push send fails
//      -> the "Published but push did not send" banner at the very top
//        of the view with Retry push + Dismiss. The announcement is
//        already visible in the list below with pushSent: false.
//
//   3. OneSignal returns a specific error (401 auth, quota, etc.)
//      -> the same banner, with the server-forwarded error message
//        surfaced verbatim so the admin can tell OneSignal from a
//        generic network failure.
//
// Edit flow: clicking Edit on a card replaces the composer with an
// inline edit panel pre-filled with the announcement's title and body.
// The Send-push checkbox is hidden on edit — edits never fire a new
// push (design section 7 is explicit about this). Edit writes use
// op:"update" touching only title and body so publishedAt, pushSent,
// and pushSentAt stay as they were when the announcement was first
// published.
//
// Delete flow: click Delete -> confirm dialog with a note that any
// push already sent cannot be recalled -> firestore-write delete.
//
// Rendering split: the composer card is deliberately NOT rebuilt from
// the main `rerender()` so a 15-second list poll never steals focus
// from an admin who's mid-sentence in the body textarea. The composer
// is remounted only on mode transitions (open edit, cancel edit,
// clear, after a successful publish/save). The list, headers, and
// banners re-render on each poll via `rerender()`; online-state flips
// use scoped DOM updates on the composer's buttons rather than a
// remount.
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

const POLL_INTERVAL_MS = 15_000;
const OFFLINE_TOOLTIP = "You're offline \u2014 admin changes require connectivity.";
const TITLE_MAX = 120;
const BODY_MAX = 2000;
const PUSH_TITLE_PREVIEW_MAX = 50;
const PUSH_BODY_PREVIEW_MAX = 120;
const PREVIEW_DEBOUNCE_MS = 100;

/**
 * Render the admin Announcements composer into `host`.
 * @param {HTMLElement} host  typically `#admin-view-root`.
 * @returns {Promise<void>}
 */
export default async function renderAnnouncementsComposer(host) {
  host.innerHTML = "";

  const container = document.createElement("section");
  container.className = "admin-announcements-view";
  container.setAttribute("aria-label", "Admin Announcements composer");
  host.appendChild(container);

  const header = buildStickyHeader();
  const partialBanner = buildPartialPushBanner();
  const offlineBanner = buildOfflineBanner();
  const composerHost = document.createElement("div");
  composerHost.className = "admin-announcement-composer-host";
  const listSection = document.createElement("div");
  listSection.className = "admin-announcement-list";
  listSection.setAttribute("aria-live", "polite");
  listSection.setAttribute("aria-label", "Past announcements");

  container.append(
    header.el,
    partialBanner.el,
    offlineBanner.el,
    composerHost,
    listSection,
  );

  // Prime /api/config; cached inside firebase.js after the first call.
  const configReady = initFirestore().catch((err) => {
    console.warn("[admin-announcements] /api/config load failed:", err);
    return null;
  });

  /** @type {object[] | null} */
  let cachedAnnouncements = null;
  /** @type {Error | null} */
  let lastErr = null;
  let sawFirstResult = false;
  let errorToasted = false;
  let online = typeof navigator === "undefined" || navigator.onLine !== false;

  // Composer state. `editing` is null in New mode; set to the pre-fill
  // announcement when the admin tapped Edit on a card. draft* seeds a
  // fresh mount of the composer DOM; while the composer is mounted the
  // live input values are the source of truth and are read via
  // readComposerDraft() at submit time.
  /** @type {object | null} */
  let editing = null;
  /** @type {string | null} */
  let editingSnapshotTs = null;
  let draftTitle = "";
  let draftBody = "";
  let draftSendPush = false;

  // Delete confirm modal handle, if any.
  /** @type {{ close: () => void } | null} */
  let openDeleteModal = null;

  // The "Published but push did not send" banner payload. Null when
  // the banner is dismissed or when the last publish ran cleanly.
  /** @type {{ announcementId: string, title: string, bodyPreview: string, error: string } | null} */
  let partialPushState = null;

  // Composer DOM handles populated by mountComposer(). Scoped updates
  // (push preview, submit spinner, conflict banner, error banner) go
  // through these refs so a list poll never has to remount the whole
  // composer card.
  /** @type {{
   *   card: HTMLElement,
   *   titleInput: HTMLInputElement,
   *   bodyInput: HTMLTextAreaElement,
   *   sendPushCheckbox: HTMLInputElement | null,
   *   pushPreviewEl: HTMLElement | null,
   *   submitBtn: HTMLButtonElement,
   *   clearBtn: HTMLButtonElement | null,
   *   errorEl: HTMLElement,
   *   conflictEl: HTMLElement,
   *   isEdit: boolean,
   * } | null} */
  let composerRefs = null;

  // Debounce handle for the live markdown preview update.
  let previewTimer = null;

  function rerender() {
    offlineBanner.setVisible(!online);
    header.setOnline(online);
    syncComposerOnline();

    if (partialPushState) {
      partialBanner.show(partialPushState, {
        online,
        onRetry: () => retryPush(),
        onDismiss: () => {
          partialPushState = null;
          partialBanner.hide();
        },
      });
    } else {
      partialBanner.hide();
    }

    if (lastErr && !cachedAnnouncements) {
      renderListErrorNoCache(listSection, () => restartSubscription());
      return;
    }
    if (!sawFirstResult) {
      renderListSkeleton(listSection);
      return;
    }
    const sorted = (cachedAnnouncements || []).slice().sort(sortByPublishedDesc);
    header.setLastEdited(mostRecentlyEdited(sorted));
    renderList(listSection, sorted, {
      hasError: Boolean(lastErr),
      online,
      onRetry: () => restartSubscription(),
      onEdit: (announcement) => openEdit(announcement),
      onDelete: (announcement) => openDeleteDialog(announcement),
    });
  }

  /* ---------------- Composer mounting + scoped updates ---------------- */

  /**
   * (Re)build the composer card. Called on initial render and on mode
   * transitions ONLY — never from the list poll — so the admin's
   * caret and selection aren't disturbed while they're typing.
   */
  function mountComposer() {
    composerRefs = renderComposer(composerHost, {
      isEdit: Boolean(editing),
      initialTitle: draftTitle,
      initialBody: draftBody,
      initialSendPush: draftSendPush,
      online,
      onLivePreviewUpdate: schedulePreviewUpdate,
      onPushPreviewUpdate: updatePushPreviewFromDom,
      onSendPushChange: () => {
        if (composerRefs?.pushPreviewEl && composerRefs.sendPushCheckbox) {
          composerRefs.pushPreviewEl.hidden = !composerRefs.sendPushCheckbox.checked;
          updatePushPreviewFromDom();
        }
      },
      onPublish: () => publishNew(),
      onSaveEdit: () => saveEdit(),
      onClear: () => clearComposer(),
      onCancelEdit: () => cancelEdit(),
    });
    schedulePreviewUpdate();
    updatePushPreviewFromDom();
  }

  function syncComposerOnline() {
    if (!composerRefs) return;
    const { submitBtn, clearBtn } = composerRefs;
    if (online) {
      submitBtn.disabled = false;
      submitBtn.removeAttribute("title");
      submitBtn.removeAttribute("aria-disabled");
      if (clearBtn) {
        clearBtn.disabled = false;
        clearBtn.removeAttribute("title");
        clearBtn.removeAttribute("aria-disabled");
      }
    } else {
      submitBtn.disabled = true;
      submitBtn.setAttribute("title", OFFLINE_TOOLTIP);
      submitBtn.setAttribute("aria-disabled", "true");
      if (clearBtn) {
        clearBtn.disabled = true;
        clearBtn.setAttribute("title", OFFLINE_TOOLTIP);
        clearBtn.setAttribute("aria-disabled", "true");
      }
    }
  }

  function showComposerError(message) {
    if (!composerRefs) return;
    composerRefs.errorEl.textContent = message;
    composerRefs.errorEl.hidden = false;
  }
  function hideComposerError() {
    if (!composerRefs) return;
    composerRefs.errorEl.textContent = "";
    composerRefs.errorEl.hidden = true;
  }

  function readComposerDraft() {
    if (!composerRefs) {
      return { title: draftTitle, body: draftBody, sendPush: draftSendPush };
    }
    return {
      title: composerRefs.titleInput.value,
      body: composerRefs.bodyInput.value,
      sendPush: composerRefs.sendPushCheckbox
        ? composerRefs.sendPushCheckbox.checked
        : false,
    };
  }

  function schedulePreviewUpdate() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      if (!composerRefs) return;
      updateLivePreview(composerRefs.card, composerRefs.bodyInput.value);
    }, PREVIEW_DEBOUNCE_MS);
  }

  function updatePushPreviewFromDom() {
    if (!composerRefs) return;
    const titleEl = composerRefs.card.querySelector("[data-push-preview-title]");
    const bodyEl = composerRefs.card.querySelector("[data-push-preview-body]");
    if (!titleEl || !bodyEl) return;
    const t = composerRefs.titleInput.value.trim();
    const b = composerRefs.bodyInput.value.trim();
    const plainBody = plainTextFromMarkdown(b);
    titleEl.textContent = t
      ? truncate(t, PUSH_TITLE_PREVIEW_MAX)
      : "(title appears here)";
    bodyEl.textContent = plainBody
      ? truncate(plainBody, PUSH_BODY_PREVIEW_MAX)
      : "(body appears here)";
  }

  /* ---------------- Composer state transitions ---------------- */

  function openEdit(announcement) {
    editing = announcement;
    editingSnapshotTs = snapshotEditingTimestamp(announcement);
    draftTitle = typeof announcement?.title === "string" ? announcement.title : "";
    draftBody = typeof announcement?.body === "string" ? announcement.body : "";
    draftSendPush = false;
    mountComposer();
    syncComposerOnline();
    try {
      composerHost.scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (_err) { /* no-op */ }
  }

  function cancelEdit() {
    editing = null;
    editingSnapshotTs = null;
    draftTitle = "";
    draftBody = "";
    draftSendPush = false;
    mountComposer();
    syncComposerOnline();
  }

  function clearComposer() {
    const { title, body } = readComposerDraft();
    if (title.trim() || body.trim()) {
      const confirmed = window.confirm(
        "Clear the title and body you've typed? This can't be undone.",
      );
      if (!confirmed) return;
    }
    draftTitle = "";
    draftBody = "";
    draftSendPush = false;
    mountComposer();
    syncComposerOnline();
  }

  /* ---------------- Publish (new) ---------------- */

  let publishing = false;
  async function publishNew() {
    if (publishing) return;
    if (!online) return;
    const { title: rawTitle, body: rawBody, sendPush } = readComposerDraft();
    const title = rawTitle.trim();
    const body = rawBody.trim();
    const validationErr = validateComposer(title, body);
    if (validationErr) {
      showComposerError(validationErr);
      return;
    }
    hideComposerError();

    publishing = true;
    const announcementId = newDocId();
    const nowIso = new Date().toISOString();

    toggleSubmitSaving(true);

    // 1) Firestore write (set) — includes publishedAt, pushSent:false,
    //    pushSentAt:null.
    try {
      await adminFetch("/api/firestore-write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection: "announcements",
          docId: announcementId,
          op: "set",
          data: {
            title,
            body,
            publishedAt: nowIso,
            pushSent: false,
            pushSentAt: null,
          },
        }),
      });
    } catch (err) {
      console.warn("[admin-announcements] firestore write failed:", err);
      if (err?.code === "session-expired") {
        publishing = false;
        return;
      }
      publishing = false;
      toggleSubmitSaving(false);
      showComposerError(
        "Could not publish \u2014 the announcement was not saved. Try again.",
      );
      return;
    }

    // 2) If the push toggle is off, we're done.
    if (!sendPush) {
      publishing = false;
      toggleSubmitSaving(false);
      ui.toast("success", "Announcement published.");
      resetComposerAfterPublish();
      nudgeRefresh();
      return;
    }

    // 3) Push toggle is on — send to OneSignal. On failure, the
    //    announcement is already in Firestore so we surface the
    //    partial banner instead of unwinding.
    const bodyPreview = truncate(plainTextFromMarkdown(body), PUSH_BODY_PREVIEW_MAX);
    try {
      await adminFetch("/api/send-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          announcementId,
          title,
          // bodyPreview must be 1-120 chars server-side; fall back to
          // the title when the body plain-text ends up empty (body
          // made entirely of link syntax or similar).
          bodyPreview: bodyPreview || title,
        }),
      });
      ui.toast("success", "Announcement published and push sent.");
      partialPushState = null;
      partialBanner.hide();
    } catch (err) {
      console.warn("[admin-announcements] send-push failed:", err);
      if (err?.code === "session-expired") {
        publishing = false;
        return;
      }
      partialPushState = {
        announcementId,
        title,
        bodyPreview: bodyPreview || title,
        error: formatPushError(err),
      };
      ui.toast("success", "Announcement published.");
      partialBanner.show(partialPushState, {
        online,
        onRetry: () => retryPush(),
        onDismiss: () => {
          partialPushState = null;
          partialBanner.hide();
        },
      });
    }

    publishing = false;
    toggleSubmitSaving(false);
    resetComposerAfterPublish();
    nudgeRefresh();
  }

  function resetComposerAfterPublish() {
    draftTitle = "";
    draftBody = "";
    draftSendPush = false;
    mountComposer();
    syncComposerOnline();
  }

  /* ---------------- Retry push (banner button) ---------------- */

  let retrying = false;
  async function retryPush() {
    if (retrying || !partialPushState || !online) return;
    retrying = true;
    partialBanner.setRetryBusy(true);
    try {
      await adminFetch("/api/send-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          announcementId: partialPushState.announcementId,
          title: partialPushState.title,
          bodyPreview: partialPushState.bodyPreview,
        }),
      });
      ui.toast("success", "Push sent.");
      partialPushState = null;
      partialBanner.hide();
      nudgeRefresh();
    } catch (err) {
      console.warn("[admin-announcements] retry push failed:", err);
      if (err?.code === "session-expired") {
        retrying = false;
        partialBanner.setRetryBusy(false);
        return;
      }
      partialPushState = {
        ...partialPushState,
        error: formatPushError(err),
      };
      partialBanner.show(partialPushState, {
        online,
        onRetry: () => retryPush(),
        onDismiss: () => {
          partialPushState = null;
          partialBanner.hide();
        },
      });
    } finally {
      retrying = false;
      partialBanner.setRetryBusy(false);
    }
  }

  /* ---------------- Save edit (existing announcement) ---------------- */

  let saving = false;
  async function saveEdit({ bypassConflictCheck = false } = {}) {
    if (saving) return;
    if (!editing || !editing.id) return;
    if (!online) return;

    const { title: rawTitle, body: rawBody } = readComposerDraft();
    const title = rawTitle.trim();
    const body = rawBody.trim();
    const validationErr = validateComposer(title, body);
    if (validationErr) {
      showComposerError(validationErr);
      return;
    }
    hideComposerError();

    saving = true;
    toggleSubmitSaving(true);

    // Collision check — re-read the latest server copy before writing.
    if (!bypassConflictCheck && editingSnapshotTs) {
      try {
        const latest = await getDoc(`announcements/${editing.id}`);
        if (hasConflict(latest, editingSnapshotTs)) {
          saving = false;
          toggleSubmitSaving(false);
          renderConflictInComposer(composerRefs?.conflictEl, {
            onReload: async () => {
              try {
                const fresh = await getDoc(`announcements/${editing.id}`);
                if (!fresh) {
                  ui.toast("info", "That announcement was deleted.");
                  cancelEdit();
                  return;
                }
                editing = fresh;
                editingSnapshotTs = snapshotEditingTimestamp(fresh);
                draftTitle = typeof fresh.title === "string" ? fresh.title : "";
                draftBody = typeof fresh.body === "string" ? fresh.body : "";
                mountComposer();
                syncComposerOnline();
              } catch (err) {
                console.warn("[admin-announcements] conflict reload failed:", err);
                showComposerError("Could not reload \u2014 try again.");
              }
            },
            onOverwrite: () => saveEdit({ bypassConflictCheck: true }),
          });
          return;
        }
      } catch (err) {
        // Non-fatal; proceed to save. The write will surface its own
        // error on failure.
        console.warn("[admin-announcements] collision pre-check failed:", err);
      }
    }

    try {
      await adminFetch("/api/firestore-write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection: "announcements",
          docId: editing.id,
          op: "update",
          data: { title, body },
        }),
      });
      saving = false;
      toggleSubmitSaving(false);
      ui.toast("success", "Announcement updated.");
      editing = null;
      editingSnapshotTs = null;
      draftTitle = "";
      draftBody = "";
      draftSendPush = false;
      mountComposer();
      syncComposerOnline();
      nudgeRefresh();
    } catch (err) {
      console.warn("[admin-announcements] edit save failed:", err);
      if (err?.code === "session-expired") {
        saving = false;
        return;
      }
      saving = false;
      toggleSubmitSaving(false);
      showComposerError("Could not save \u2014 try again.");
    }
  }

  function toggleSubmitSaving(busy) {
    if (!composerRefs) return;
    const { submitBtn, isEdit } = composerRefs;
    const label = submitBtn.querySelector(".admin-announcement-composer__submit-label");
    if (busy) {
      submitBtn.disabled = true;
      submitBtn.classList.add("admin-announcement-composer__submit--loading");
      if (label) label.textContent = "Working\u2026";
    } else {
      submitBtn.classList.remove("admin-announcement-composer__submit--loading");
      if (label) label.textContent = isEdit ? "Save changes" : "Publish";
      // Only re-enable if still online; otherwise syncComposerOnline()
      // owns the disabled state.
      if (online) submitBtn.disabled = false;
    }
  }

  /* ---------------- Delete ---------------- */

  function openDeleteDialog(announcement) {
    if (openDeleteModal) openDeleteModal.close();
    openDeleteModal = createDeleteDialog({
      announcement,
      online,
      onClose: () => { openDeleteModal = null; },
      onDeleted: () => {
        openDeleteModal = null;
        if (editing && editing.id === announcement.id) {
          cancelEdit();
        }
        nudgeRefresh();
      },
    });
  }

  /* ---------------- Subscription plumbing ---------------- */

  /** @type {(() => void) | null} */
  let unsub = null;
  async function startSubscription() {
    try { await configReady; } catch (_err) { /* non-fatal */ }
    unsub = onSnapshot(
      "announcements",
      (data, err) => {
        if (err) {
          console.warn("[admin-announcements] poll failed:", err);
          lastErr = err;
          if (!cachedAnnouncements && !errorToasted) {
            ui.toast(
              "error",
              "Couldn't load announcements. Tap Retry to try again.",
            );
            errorToasted = true;
          }
        } else {
          lastErr = null;
          errorToasted = false;
          cachedAnnouncements = Array.isArray(data) ? data : [];
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
    cachedAnnouncements = null;
    sawFirstResult = false;
    errorToasted = false;
    renderListSkeleton(listSection);
    startSubscription();
  }

  function nudgeRefresh() {
    if (unsub) { unsub(); unsub = null; }
    lastErr = null;
    errorToasted = false;
    startSubscription();
  }

  // Initial composer mount, then start the list poll. Order matters so
  // the admin can start typing before any Firestore response lands.
  mountComposer();
  syncComposerOnline();
  startSubscription();

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
    if (openDeleteModal) {
      try { openDeleteModal.close(); } catch (_err) { /* no-op */ }
      openDeleteModal = null;
    }
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onVisibility);
  });

  document.title = "Admin \u2014 Announcements \u2014 Vendor Day 2027";
}

/* =================================================================
 * Sticky secondary header
 * ================================================================= */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "admin-announcements-header";
  el.innerHTML = `
    <div class="admin-announcements-header__row">
      <h2 class="admin-announcements-header__title">Admin \u2014 Announcements</h2>
      <p class="admin-announcements-header__meta" aria-live="polite">never edited</p>
    </div>
  `;
  const metaEl = el.querySelector(".admin-announcements-header__meta");

  function setLastEdited(doc) {
    metaEl.textContent = formatLastEditedPhrase(doc);
  }
  // Reserved for parity with other admin editor headers.
  function setOnline(_online) { /* no-op */ }

  return { el, setLastEdited, setOnline };
}

/* =================================================================
 * "Published but push did not send" banner
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
          The announcement is live in the attendee feed, but the OneSignal push did not go out.
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
 * Composer card
 * ================================================================= */

/**
 * Build the composer card inside `host`, replacing any prior content.
 * Returns handles the caller uses for scoped DOM updates (push
 * preview refresh, submit button spinner, conflict banner) so a
 * subsequent list poll never has to remount the whole composer.
 */
function renderComposer(host, {
  isEdit,
  initialTitle,
  initialBody,
  initialSendPush,
  online,
  onLivePreviewUpdate,
  onPushPreviewUpdate,
  onSendPushChange,
  onPublish,
  onSaveEdit,
  onClear,
  onCancelEdit,
}) {
  host.innerHTML = "";

  const card = document.createElement("section");
  card.className = `admin-announcement-composer${isEdit ? " admin-announcement-composer--edit" : ""}`;
  card.setAttribute("aria-label", isEdit ? "Edit announcement" : "New announcement");

  const headerLabel = isEdit ? "Edit announcement" : "New announcement";
  const submitLabel = isEdit ? "Save changes" : "Publish";
  const submitAttr = isEdit ? "data-save-edit" : "data-publish";
  const offlineBtnAttrs = online
    ? ""
    : ` disabled aria-disabled="true" title="${escapeAttr(OFFLINE_TOOLTIP)}"`;

  card.innerHTML = `
    <header class="admin-announcement-composer__header">
      <h3 class="admin-announcement-composer__title">${escapeHtml(headerLabel)}</h3>
      ${isEdit
        ? `<button type="button" class="btn-link admin-announcement-composer__cancel-edit" data-cancel-edit>Cancel edit</button>`
        : ""}
    </header>
    <div class="admin-announcement-composer__error" data-composer-error hidden role="alert"></div>
    <div class="admin-announcement-composer__conflict" data-composer-conflict hidden></div>
    <div class="admin-announcement-composer-grid">
      <div class="admin-announcement-composer__fields">
        <div class="admin-form-group">
          <label for="admin-ann-title">
            Title
            <span class="admin-required-marker" aria-hidden="true">*</span>
            <span class="sr-only">required</span>
          </label>
          <input
            id="admin-ann-title"
            class="admin-input"
            type="text"
            maxlength="${TITLE_MAX}"
            required
            autocomplete="off"
          />
        </div>
        <div class="admin-form-group">
          <label for="admin-ann-body">
            Body (markdown supported)
            <span class="admin-required-marker" aria-hidden="true">*</span>
            <span class="sr-only">required</span>
          </label>
          <textarea
            id="admin-ann-body"
            class="admin-textarea admin-announcement-composer__body-field"
            maxlength="${BODY_MAX}"
            rows="8"
            required
          ></textarea>
          <div class="admin-announcement-composer__md-help">
            <button
              type="button"
              class="btn-link admin-announcement-composer__md-ref-btn"
              aria-expanded="false"
              aria-controls="admin-ann-md-ref"
              data-md-ref-toggle
            >Markdown reference</button>
            <div
              id="admin-ann-md-ref"
              class="admin-announcement-composer__md-ref-popover"
              hidden
              role="region"
              aria-label="Supported markdown syntax"
            >
              <ul>
                <li><code>**bold**</code> \u2192 <strong>bold</strong></li>
                <li><code>*italic*</code> \u2192 <em>italic</em></li>
                <li><code>\`code\`</code> \u2192 <code>code</code></li>
                <li><code>[label](https://example.com)</code> \u2192 link</li>
                <li><code>- item</code> or <code>* item</code> \u2192 bullet list</li>
                <li><code>1. item</code> \u2192 numbered list</li>
                <li>Blank line separates paragraphs; single newline becomes a line break.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
      <div class="admin-announcement-composer__preview-column">
        <p class="admin-announcement-composer__preview-label">Live preview</p>
        <article class="announcement-card admin-announcement-composer__preview-card">
          <section class="announcement-card__body" data-live-preview></section>
        </article>
      </div>
    </div>
    ${isEdit
      ? ""
      : `
      <div class="admin-announcement-composer__push-row">
        <label class="admin-announcement-composer__push-toggle-label">
          <input
            type="checkbox"
            data-send-push
            class="admin-announcement-composer__push-toggle"
          />
          <span>Send a push to subscribers when I publish.</span>
        </label>
        <div class="admin-push-preview" data-push-preview hidden>
          <p class="admin-push-preview__header">Push preview</p>
          <p class="admin-push-preview__title" data-push-preview-title>(title appears here)</p>
          <p class="admin-push-preview__body" data-push-preview-body>(body appears here)</p>
          <p class="admin-push-preview__note">This is roughly what subscribers' devices will show.</p>
        </div>
      </div>
    `}
    <footer class="admin-announcement-composer__footer">
      ${isEdit
        ? ""
        : `<button type="button" class="btn-secondary" data-clear${offlineBtnAttrs}>Clear</button>`}
      <button
        type="button"
        class="btn-primary admin-announcement-composer__submit"
        ${submitAttr}
        ${offlineBtnAttrs}
      >
        <span class="admin-announcement-composer__submit-label">${escapeHtml(submitLabel)}</span>
      </button>
    </footer>
  `;

  host.appendChild(card);

  const titleInput = card.querySelector("#admin-ann-title");
  const bodyInput = card.querySelector("#admin-ann-body");
  const errorEl = card.querySelector("[data-composer-error]");
  const conflictEl = card.querySelector("[data-composer-conflict]");
  const sendPushCheckbox = card.querySelector("[data-send-push]");
  const pushPreviewEl = card.querySelector("[data-push-preview]");
  const mdRefBtn = card.querySelector("[data-md-ref-toggle]");
  const mdRefPopover = card.querySelector("#admin-ann-md-ref");
  const submitBtn = card.querySelector(`[${submitAttr}]`);
  const clearBtn = card.querySelector("[data-clear]");

  titleInput.value = initialTitle;
  bodyInput.value = initialBody;
  if (sendPushCheckbox) {
    sendPushCheckbox.checked = Boolean(initialSendPush);
    if (pushPreviewEl) pushPreviewEl.hidden = !sendPushCheckbox.checked;
  }

  // Wire inputs. Title and body don't trigger a composer re-render;
  // the live preview + push preview update in place.
  titleInput.addEventListener("input", () => {
    if (typeof onPushPreviewUpdate === "function") onPushPreviewUpdate();
  });
  bodyInput.addEventListener("input", () => {
    if (typeof onLivePreviewUpdate === "function") onLivePreviewUpdate();
    if (typeof onPushPreviewUpdate === "function") onPushPreviewUpdate();
  });

  if (sendPushCheckbox) {
    sendPushCheckbox.addEventListener("change", () => {
      if (typeof onSendPushChange === "function") onSendPushChange();
    });
  }

  // Markdown reference popover: tap to toggle. The outside-click
  // handler is attached only while the popover is open and detaches
  // on close, so a never-opened popover carries no document listener.
  function onOutsideClick(ev) {
    if (!card.isConnected) {
      document.removeEventListener("click", onOutsideClick);
      return;
    }
    if (mdRefPopover.hidden) return;
    if (!mdRefPopover.contains(ev.target) && ev.target !== mdRefBtn) {
      mdRefPopover.hidden = true;
      mdRefBtn.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onOutsideClick);
    }
  }
  mdRefBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const willOpen = mdRefPopover.hidden;
    mdRefPopover.hidden = !willOpen;
    mdRefBtn.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) {
      document.addEventListener("click", onOutsideClick);
    } else {
      document.removeEventListener("click", onOutsideClick);
    }
  });

  submitBtn.addEventListener("click", () => {
    if (isEdit) onSaveEdit();
    else onPublish();
  });
  if (clearBtn) {
    clearBtn.addEventListener("click", () => onClear());
  }
  if (isEdit) {
    const cancelEditBtn = card.querySelector("[data-cancel-edit]");
    if (cancelEditBtn) {
      cancelEditBtn.addEventListener("click", () => onCancelEdit());
    }
  }

  return {
    card,
    titleInput,
    bodyInput,
    sendPushCheckbox,
    pushPreviewEl,
    submitBtn,
    clearBtn,
    errorEl,
    conflictEl,
    isEdit,
  };
}

/**
 * Refresh the live markdown preview without re-rendering the composer.
 */
function updateLivePreview(card, body) {
  const target = card.querySelector("[data-live-preview]");
  if (!target) return;
  const html = renderMarkdown(body || "");
  if (!html) {
    target.innerHTML = `<p class="admin-announcement-composer__preview-empty">Preview appears here.</p>`;
    return;
  }
  // markdown-mini escapes HTML inside its parser so this innerHTML
  // assignment is safe.
  target.innerHTML = html;
}

/**
 * Render the conflict banner inline inside the composer card. Shown
 * when a saveEdit() call detected that someone else updated the
 * announcement in Firestore since this editor opened it.
 */
function renderConflictInComposer(target, { onReload, onOverwrite }) {
  if (!target) return;
  target.hidden = false;
  target.innerHTML = `
    <p>This announcement was edited by someone else since you opened it. Reload to see their changes, or Overwrite to save yours anyway.</p>
    <div class="admin-announcement-composer__conflict-actions">
      <button type="button" class="btn-secondary" data-conflict-reload>Reload</button>
      <button type="button" class="btn-primary" data-conflict-overwrite>Overwrite</button>
    </div>
  `;
  target.querySelector("[data-conflict-reload]").addEventListener("click", () => {
    target.hidden = true;
    target.innerHTML = "";
    onReload();
  });
  target.querySelector("[data-conflict-overwrite]").addEventListener("click", () => {
    target.hidden = true;
    target.innerHTML = "";
    onOverwrite();
  });
}

/* =================================================================
 * Past-announcements list
 * ================================================================= */

function renderListSkeleton(host) {
  host.innerHTML = `
    <h3 class="admin-announcement-list__heading">Past announcements</h3>
    <div class="admin-announcement-card skeleton-card" aria-hidden="true"></div>
    <div class="admin-announcement-card skeleton-card" aria-hidden="true"></div>
    <div class="admin-announcement-card skeleton-card" aria-hidden="true"></div>
  `;
}

function renderListErrorNoCache(host, onRetry) {
  host.innerHTML = `
    <h3 class="admin-announcement-list__heading">Past announcements</h3>
    <div class="status-error" role="alert">
      <p>Couldn't load announcements.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

function renderList(host, items, { hasError, online, onRetry, onEdit, onDelete }) {
  host.innerHTML = "";

  const heading = document.createElement("h3");
  heading.className = "admin-announcement-list__heading";
  heading.textContent = "Past announcements";
  host.appendChild(heading);

  if (hasError) {
    const strip = document.createElement("div");
    strip.className = "status-error admin-announcement-list__error-strip";
    strip.setAttribute("role", "status");
    strip.innerHTML = `
      <span>Couldn't refresh. Showing last-saved announcements.</span>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    `;
    strip.querySelector("[data-retry]").addEventListener("click", onRetry);
    host.appendChild(strip);
  }

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "placeholder-card admin-announcement-list__empty";
    empty.innerHTML = `
      <h2>No announcements yet</h2>
      <p>Compose one above.</p>
    `;
    host.appendChild(empty);
    return;
  }

  for (const announcement of items) {
    host.appendChild(renderCard(announcement, { online, onEdit, onDelete }));
  }
}

function renderCard(announcement, { online, onEdit, onDelete }) {
  const el = document.createElement("article");
  el.className = "admin-announcement-card";

  const title = typeof announcement.title === "string" && announcement.title.trim()
    ? announcement.title.trim()
    : "Untitled announcement";
  const bodyPlain = plainTextFromMarkdown(
    typeof announcement.body === "string" ? announcement.body : "",
  );
  const publishedIso = typeof announcement.publishedAt === "string" ? announcement.publishedAt : "";
  const publishedRel = relativeTime(publishedIso);
  const pushSent = announcement.pushSent === true;
  const pushRel = pushSent && typeof announcement.pushSentAt === "string"
    ? relativeTime(announcement.pushSentAt)
    : "";

  const disabledAttrs = online
    ? ""
    : ` disabled aria-disabled="true" title="${escapeAttr(OFFLINE_TOOLTIP)}"`;

  el.innerHTML = `
    <div class="admin-announcement-card__body-wrap">
      <header class="admin-announcement-card__header">
        <h4 class="admin-announcement-card__title">${escapeHtml(title)}</h4>
      </header>
      <p class="admin-announcement-card__body">${escapeHtml(bodyPlain || "")}</p>
      <p class="admin-announcement-card__meta">
        ${publishedIso
          ? `<time datetime="${escapeAttr(publishedIso)}">${escapeHtml(publishedRel || publishedIso)}</time>`
          : ""}
        ${pushSent
          ? `<span class="admin-announcement-card__push-chip" aria-label="Push notification sent">
               Push sent${pushRel ? ` \u00B7 ${escapeHtml(pushRel)}` : ""}
             </span>`
          : ""}
      </p>
    </div>
    <div class="admin-announcement-card__actions">
      <button
        type="button"
        class="admin-announcement-action-btn admin-announcement-action-btn--edit"
        aria-label="Edit ${escapeAttr(title)}"
        data-edit
        ${disabledAttrs}
      >Edit</button>
      <button
        type="button"
        class="admin-announcement-action-btn admin-announcement-action-btn--delete"
        aria-label="Delete ${escapeAttr(title)}"
        data-delete
        ${disabledAttrs}
      >Delete</button>
    </div>
  `;

  el.querySelector("[data-edit]").addEventListener("click", () => {
    if (!online) return;
    onEdit(announcement);
  });
  el.querySelector("[data-delete]").addEventListener("click", () => {
    if (!online) return;
    onDelete(announcement);
  });

  return el;
}

/* =================================================================
 * Delete confirm dialog
 * ================================================================= */

function createDeleteDialog({ announcement, online, onClose, onDeleted }) {
  const docId = typeof announcement.id === "string" ? announcement.id : "";
  const title = typeof announcement.title === "string" && announcement.title.trim()
    ? announcement.title.trim()
    : "Untitled announcement";

  const overlay = document.createElement("div");
  overlay.className = "admin-modal-overlay admin-modal-overlay--confirm";

  const modal = document.createElement("div");
  modal.className = "admin-modal admin-modal--confirm";
  modal.setAttribute("role", "alertdialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "admin-announcement-delete-title");
  modal.setAttribute("aria-describedby", "admin-announcement-delete-body");
  modal.setAttribute("tabindex", "-1");

  modal.innerHTML = `
    <header class="admin-modal__header">
      <h2 class="admin-modal__title" id="admin-announcement-delete-title">Delete announcement?</h2>
    </header>
    <div class="admin-modal__body" id="admin-announcement-delete-body">
      <p>Delete \u201C${escapeHtml(title)}\u201D? This cannot be undone.</p>
      <p class="admin-announcement-delete-note">
        This removes the announcement from the in-app feed. Any push notification that was already sent cannot be recalled.
      </p>
      <div class="admin-modal__banner" data-banner hidden></div>
    </div>
    <footer class="admin-modal__footer">
      <button type="button" class="btn-secondary" data-cancel>Cancel</button>
      <button type="button" class="btn-destructive" data-confirm>Delete</button>
    </footer>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  document.body.classList.add("admin-modal-open");

  const cancelBtn = modal.querySelector("[data-cancel]");
  const confirmBtn = modal.querySelector("[data-confirm]");
  const banner = modal.querySelector("[data-banner]");

  let deleting = false;

  function closeNow() {
    try { uninstall(); } catch (_err) { /* no-op */ }
    overlay.remove();
    document.body.classList.remove("admin-modal-open");
    onClose();
  }

  async function confirm() {
    if (deleting) return;
    const onlineNow = typeof navigator === "undefined" || navigator.onLine !== false;
    if (!onlineNow) {
      banner.hidden = false;
      banner.className = "admin-modal__banner admin-modal__banner--error";
      banner.innerHTML = `<p>You're offline. Reconnect and try again.</p>`;
      return;
    }
    deleting = true;
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Deleting\u2026";
    try {
      await adminFetch("/api/firestore-write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection: "announcements",
          docId,
          op: "delete",
        }),
      });
      ui.toast("success", "Announcement deleted.");
      closeNow();
      onDeleted();
    } catch (err) {
      console.warn("[admin-announcements] delete failed:", err);
      if (err?.code === "session-expired") return;
      deleting = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Delete";
      ui.toast("error", "Could not delete \u2014 try again.");
    }
  }

  cancelBtn.addEventListener("click", () => closeNow());
  confirmBtn.addEventListener("click", () => confirm());
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) closeNow();
  });

  const uninstall = installFocusTrap(modal, {
    onEscape: () => closeNow(),
    initialFocus: () => cancelBtn, // destructive confirms start on Cancel
  });

  return { close: closeNow };
}

/* =================================================================
 * Validation
 * ================================================================= */

/**
 * Enforce the design-section-14 bounds. Returns null when valid or an
 * error message string when not.
 */
function validateComposer(title, body) {
  if (!title) return "Title is required.";
  if (title.length > TITLE_MAX) return `Title must be ${TITLE_MAX} characters or fewer.`;
  if (!body) return "Body is required.";
  if (body.length > BODY_MAX) return `Body must be ${BODY_MAX} characters or fewer.`;
  return null;
}

/* =================================================================
 * Markdown -> plain text
 * ================================================================= */

/**
 * Strip the markdown subset `markdown-mini.js` renders to plain text.
 * Used by the push preview + the list card body preview so neither
 * surface renders asterisks or bracketed link syntax verbatim.
 *
 * Rules:
 *   - **bold** / __bold__ markers removed
 *   - *italic* / _italic_ markers removed
 *   - `inline code` backticks removed
 *   - [label](url) -> label
 *   - leading `-`, `*`, `1.` list markers removed per line
 *   - CRLF normalized to LF
 *   - any run of whitespace (including newlines) collapsed to a
 *     single space so the final value fits in a single-line preview
 */
function plainTextFromMarkdown(src) {
  if (typeof src !== "string" || !src) return "";
  let s = src.replace(/\r\n?/g, "\n");
  // Links before emphasis so `[` `]` don't trip the italic matcher.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1");
  // Code spans — drop the backticks, keep the contents.
  s = s.replace(/`([^`\n]+)`/g, "$1");
  // Bold before italic (same ordering as markdown-mini).
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "$1");
  s = s.replace(/__([^_\n]+?)__/g, "$1");
  s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2");
  s = s.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1$2");
  // Strip leading list markers per line.
  s = s.replace(/^\s*(?:[-*]|\d+\.)\s+/gm, "");
  // Collapse all whitespace runs to a single space.
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Truncate `s` to at most `max` characters, appending a single-char
 * ellipsis when truncation happens. The ellipsis counts toward `max`
 * so the result is always <= max characters.
 */
function truncate(s, max) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}\u2026`;
}

/* =================================================================
 * Error formatting
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
 * Helpers
 * ================================================================= */

function sortByPublishedDesc(a, b) {
  const ma = Date.parse(a?.publishedAt);
  const mb = Date.parse(b?.publishedAt);
  const na = Number.isNaN(ma) ? 0 : ma;
  const nb = Number.isNaN(mb) ? 0 : mb;
  return nb - na;
}

function mostRecentlyEdited(docs) {
  let best = null;
  let bestMs = -Infinity;
  for (const d of docs || []) {
    const t = Date.parse(d?.updatedAt);
    if (!Number.isNaN(t) && t > bestMs) {
      best = d;
      bestMs = t;
    }
  }
  return best;
}

function newDocId() {
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
