// agenda-editor.js — admin Agenda editor view (Task 18).
//
// Mounts into #admin-view-root. The view owns:
//   - a sticky secondary header ("Admin — Agenda" + Add session button +
//     the collection-wide "updated X ago by Y" meta line),
//   - a session list driven by a 15-second poll of the public `agenda`
//     collection via /js/firebase.js onSnapshot (admin reads bypass the
//     broker — firestore.rules grant public read),
//   - a shared Add/Edit modal with client-side validation, the design
//     section 6 collision soft-safeguard (Overwrite / Reload banner),
//     and a focus trap from /js/utils/focus-trap.js,
//   - a Delete confirm dialog reusing the same modal shell.
//
// All writes go through /api/firestore-write via adminFetch (JWT required).
// The Function server-stamps `updatedAt` + `updatedBy`, so the write
// payload omits those fields. For a `set` write to a known docId the
// Function PATCHes without an updateMask, which overwrites the doc in
// place (what we want for Agenda sessions). Deletes use op:"delete".
"use strict";

import { initFirestore, getDoc, onSnapshot } from "/js/firebase.js";
import * as ui from "/js/ui.js";
import { installFocusTrap } from "/js/utils/focus-trap.js";
import { adminFetch } from "./admin-fetch.js";
import { registerAdminViewCleanup } from "./admin.js";
import {
  snapshotEditingTimestamp,
  hasConflict,
  formatLastEditedPhrase,
} from "./collision-check.js";

const POLL_INTERVAL_MS = 15_000;
const OFFLINE_TOOLTIP = "You're offline — admin changes require connectivity.";

/**
 * Render the admin Agenda editor into `host`.
 * @param {HTMLElement} host  typically `#admin-view-root`.
 * @returns {Promise<void>}
 */
export default async function renderAgendaEditor(host) {
  host.innerHTML = "";

  const container = document.createElement("section");
  container.className = "admin-agenda-view";
  container.setAttribute("aria-label", "Admin Agenda editor");
  host.appendChild(container);

  const header = buildStickyHeader();
  const offlineBanner = buildOfflineBanner();
  const listSection = document.createElement("div");
  listSection.className = "admin-agenda-list";
  listSection.setAttribute("aria-live", "polite");
  listSection.setAttribute("aria-label", "Agenda sessions");

  container.append(header.el, offlineBanner.el, listSection);

  // Prime /api/config; cached inside firebase.js after the first call.
  const configReady = initFirestore().catch((err) => {
    console.warn("[admin-agenda] /api/config load failed:", err);
    return null;
  });

  /** @type {object[] | null} */
  let cachedSessions = null;
  /** @type {Error | null} */
  let lastErr = null;
  let sawFirstResult = false;
  let errorToasted = false;
  let online = typeof navigator === "undefined" || navigator.onLine !== false;

  // Keep a handle to the open modal (if any) so network events can
  // refresh its disabled state when connectivity flips.
  /** @type {{ setOnline: (online: boolean) => void, close: () => void } | null} */
  let openModal = null;

  function rerender() {
    offlineBanner.setVisible(!online);
    header.setOnline(online);
    if (openModal) openModal.setOnline(online);

    if (lastErr && !cachedSessions) {
      renderErrorNoCache(listSection, () => restartSubscription());
      return;
    }
    if (!sawFirstResult) {
      renderSkeleton(listSection);
      return;
    }
    const sorted = (cachedSessions || []).slice().sort(sortSessions);
    header.setLastEdited(mostRecentlyEdited(sorted));
    renderSessionList(listSection, sorted, {
      hasError: Boolean(lastErr),
      online,
      onRetry: () => restartSubscription(),
      onEdit: (session) => openAgendaModal({ mode: "edit", session }),
      onDelete: (session) => openDeleteDialog(session),
      onAdd: () => openAgendaModal({ mode: "add" }),
    });
  }

  /** @type {(() => void) | null} */
  let unsub = null;
  async function startSubscription() {
    try { await configReady; } catch (_err) { /* non-fatal */ }
    unsub = onSnapshot(
      "agenda",
      (data, err) => {
        if (err) {
          console.warn("[admin-agenda] poll failed:", err);
          lastErr = err;
          if (!cachedSessions && !errorToasted) {
            ui.toast("error", "Couldn't load the agenda. Tap Retry to try again.");
            errorToasted = true;
          }
        } else {
          lastErr = null;
          errorToasted = false;
          cachedSessions = Array.isArray(data) ? data : [];
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
    cachedSessions = null;
    sawFirstResult = false;
    errorToasted = false;
    renderSkeleton(listSection);
    startSubscription();
  }

  /**
   * Trigger an off-cycle poll right now so the list reflects a just-saved
   * write without waiting out the 15s interval. Unlike `restartSubscription`
   * this keeps the cached list visible until the fresh poll resolves so
   * the UI doesn't flash a skeleton over the admin's own write.
   */
  function nudgeRefresh() {
    if (unsub) { unsub(); unsub = null; }
    lastErr = null;
    errorToasted = false;
    startSubscription();
  }

  startSubscription();

  // Wire the header's Add button once; it stays mounted across all list
  // re-renders. The empty-state card has its own Add button that calls
  // the same handler.
  header.setOnAdd(() => openAgendaModal({ mode: "add" }));

  /* ---------------- Modal plumbing ---------------- */

  function openAgendaModal({ mode, session }) {
    if (openModal) openModal.close();
    openModal = createAgendaModal({
      mode,
      session,
      online,
      onClose: () => { openModal = null; },
      onSaved: () => { openModal = null; nudgeRefresh(); },
      // Reload-latest routes back through the view so the view's
      // `openModal` reference tracks the newly-opened modal.
      onRequestReopenEdit: (latest) => openAgendaModal({ mode: "edit", session: latest }),
    });
  }

  function openDeleteDialog(session) {
    if (openModal) openModal.close();
    openModal = createDeleteDialog({
      session,
      online,
      onClose: () => { openModal = null; },
      onDeleted: () => { openModal = null; nudgeRefresh(); },
    });
  }

  /* ---------------- Connectivity ---------------- */

  const onOnline = () => { online = true; rerender(); };
  const onOffline = () => { online = false; rerender(); };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  // Re-render on tab regain so a stale list refreshes immediately after
  // the admin returns from another tab. The next poll (<=15s) handles
  // actual data refresh.
  const onVisibility = () => {
    if (document.visibilityState !== "visible") return;
    rerender();
  };
  document.addEventListener("visibilitychange", onVisibility);

  registerAdminViewCleanup(() => {
    if (unsub) { unsub(); unsub = null; }
    if (openModal) {
      try { openModal.close(); } catch (_err) { /* no-op */ }
      openModal = null;
    }
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onVisibility);
  });

  document.title = "Admin \u2014 Agenda \u2014 Vendor Day 2027";
}

/* =================================================================
 * Sticky secondary header
 * ================================================================= */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "admin-agenda-header";
  el.innerHTML = `
    <div class="admin-agenda-header__row">
      <h2 class="admin-agenda-header__title">Admin \u2014 Agenda</h2>
      <button
        type="button"
        class="btn-primary admin-agenda-header__add"
        data-add-session
      >Add session</button>
    </div>
    <p class="admin-agenda-header__meta" aria-live="polite">never edited</p>
  `;

  const addBtn = el.querySelector("[data-add-session]");
  const metaEl = el.querySelector(".admin-agenda-header__meta");

  function setLastEdited(doc) {
    metaEl.textContent = formatLastEditedPhrase(doc);
  }

  function setOnline(online) {
    if (online) {
      addBtn.disabled = false;
      addBtn.removeAttribute("title");
      addBtn.removeAttribute("aria-disabled");
    } else {
      addBtn.disabled = true;
      addBtn.setAttribute("title", OFFLINE_TOOLTIP);
      addBtn.setAttribute("aria-disabled", "true");
    }
  }

  // Wire the Add button to the owner view via a custom event. The owner
  // sets its handler by replacing addBtn.onclick after mounting (see
  // renderSessionList), so we expose a plain `onAdd` hook via DOM here.
  addBtn.addEventListener("click", () => {
    // The owner view installs an actual handler on this attribute after
    // mounting; the default is a no-op guard so an early click before
    // the list first paints does nothing dangerous.
    const handler = el.__onAdd;
    if (typeof handler === "function") handler();
  });

  function setOnAdd(fn) {
    el.__onAdd = typeof fn === "function" ? fn : null;
  }

  return { el, setLastEdited, setOnline, setOnAdd };
}

/* =================================================================
 * Offline banner (scoped to the view)
 * ================================================================= */

function buildOfflineBanner() {
  const el = document.createElement("div");
  el.className = "admin-view-offline-banner";
  el.setAttribute("role", "status");
  el.textContent = "You're offline \u2014 showing last-saved sessions.";
  el.hidden = true;
  function setVisible(visible) {
    el.hidden = !visible;
  }
  return { el, setVisible };
}

/* =================================================================
 * List rendering
 * ================================================================= */

function renderSkeleton(host) {
  host.innerHTML = `
    <div class="admin-session-card skeleton-card" aria-hidden="true"></div>
    <div class="admin-session-card skeleton-card" aria-hidden="true"></div>
    <div class="admin-session-card skeleton-card" aria-hidden="true"></div>
    <div class="admin-session-card skeleton-card" aria-hidden="true"></div>
  `;
}

function renderErrorNoCache(host, onRetry) {
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't load the agenda.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

function renderEmptyState(host, { online, onAdd }) {
  const el = document.createElement("div");
  el.className = "placeholder-card admin-agenda-empty";
  const btnTitle = online ? "" : ` title="${escapeAttr(OFFLINE_TOOLTIP)}"`;
  const btnDisabled = online ? "" : " disabled aria-disabled=\"true\"";
  el.innerHTML = `
    <h2>No sessions yet</h2>
    <p>Tap Add session to create the first one.</p>
    <button type="button" class="btn-primary" data-add${btnDisabled}${btnTitle}>Add session</button>
  `;
  el.querySelector("[data-add]").addEventListener("click", () => {
    if (!online) return;
    onAdd();
  });
  host.appendChild(el);
}

function renderSessionList(host, sessions, {
  hasError, online, onRetry, onEdit, onDelete, onAdd,
}) {
  host.innerHTML = "";

  if (hasError) {
    const strip = document.createElement("div");
    strip.className = "status-error admin-agenda-error-strip";
    strip.setAttribute("role", "status");
    strip.innerHTML = `
      <span>Couldn't refresh. Showing last-saved agenda.</span>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    `;
    strip.querySelector("[data-retry]").addEventListener("click", onRetry);
    host.appendChild(strip);
  }

  if (!sessions.length) {
    renderEmptyState(host, { online, onAdd });
    return;
  }

  for (const session of sessions) {
    host.appendChild(renderSessionCard(session, { online, onEdit, onDelete }));
  }
}

function renderSessionCard(session, { online, onEdit, onDelete }) {
  const el = document.createElement("article");
  el.className = "admin-session-card";

  const title = typeof session.title === "string" && session.title.trim()
    ? session.title.trim()
    : "Untitled session";
  const timeRange = formatTimeRange(session.startAt, session.endAt);
  const room = typeof session.room === "string" ? session.room.trim() : "";
  const speakerName =
    session.speaker && typeof session.speaker === "object" && typeof session.speaker.name === "string"
      ? session.speaker.name.trim()
      : "";

  const disabledAttrs = online ? "" : ` disabled aria-disabled="true" title="${escapeAttr(OFFLINE_TOOLTIP)}"`;

  el.innerHTML = `
    <div class="admin-session-card__header">
      <h3 class="admin-session-card__title">${escapeHtml(title)}</h3>
    </div>
    <div class="admin-session-card__meta">
      ${timeRange ? `<p class="admin-session-card__time">${escapeHtml(timeRange)}</p>` : ""}
      ${room ? `<p class="admin-session-card__room">${escapeHtml(room)}</p>` : ""}
      ${speakerName ? `<p class="admin-session-card__speaker">${escapeHtml(speakerName)}</p>` : ""}
    </div>
    <div class="admin-session-card__actions">
      <button
        type="button"
        class="admin-session-action-btn admin-session-action-btn--edit"
        aria-label="Edit ${escapeAttr(title)}"
        data-edit
        ${disabledAttrs}
      >Edit</button>
      <button
        type="button"
        class="admin-session-action-btn admin-session-action-btn--delete"
        aria-label="Delete ${escapeAttr(title)}"
        data-delete
        ${disabledAttrs}
      >Delete</button>
    </div>
  `;

  el.querySelector("[data-edit]").addEventListener("click", () => {
    if (!online) return;
    onEdit(session);
  });
  el.querySelector("[data-delete]").addEventListener("click", () => {
    if (!online) return;
    onDelete(session);
  });

  return el;
}

/* =================================================================
 * Add/Edit modal
 * ================================================================= */

function createAgendaModal({
  mode,
  session,
  online,
  onClose,
  onSaved,
  onRequestReopenEdit,
}) {
  const isEdit = mode === "edit";
  const existing = isEdit && session && typeof session === "object" ? session : null;
  const snapshotTs = snapshotEditingTimestamp(existing);
  const docId = existing && typeof existing.id === "string" ? existing.id : newDocId();

  const overlay = document.createElement("div");
  overlay.className = "admin-modal-overlay";

  const modal = document.createElement("div");
  modal.className = "admin-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "admin-agenda-modal-title");
  modal.setAttribute("tabindex", "-1");

  modal.innerHTML = `
    <header class="admin-modal__header">
      <h2 class="admin-modal__title" id="admin-agenda-modal-title">${isEdit ? "Edit session" : "Add session"}</h2>
      <button type="button" class="admin-modal__close" aria-label="Close" data-close>&times;</button>
    </header>
    <div class="admin-modal__banner" data-banner hidden></div>
    <form class="admin-modal__body" novalidate data-form>
      <div class="admin-form-group">
        <label for="admin-agenda-title">
          Title
          <span class="admin-required-marker" aria-hidden="true">*</span>
          <span class="sr-only">required</span>
        </label>
        <input
          id="admin-agenda-title"
          name="title"
          class="admin-input"
          type="text"
          maxlength="120"
          required
          autocomplete="off"
          aria-describedby="admin-agenda-title-error"
        />
        <p class="admin-inline-error" id="admin-agenda-title-error" hidden></p>
      </div>
      <div class="admin-form-group">
        <label for="admin-agenda-start">
          Start
          <span class="admin-required-marker" aria-hidden="true">*</span>
          <span class="sr-only">required</span>
        </label>
        <input
          id="admin-agenda-start"
          name="startAt"
          class="admin-input"
          type="datetime-local"
          required
          aria-describedby="admin-agenda-start-error"
        />
        <p class="admin-inline-error" id="admin-agenda-start-error" hidden></p>
      </div>
      <div class="admin-form-group">
        <label for="admin-agenda-end">
          End
          <span class="admin-required-marker" aria-hidden="true">*</span>
          <span class="sr-only">required</span>
        </label>
        <input
          id="admin-agenda-end"
          name="endAt"
          class="admin-input"
          type="datetime-local"
          required
          aria-describedby="admin-agenda-end-error"
        />
        <p class="admin-inline-error" id="admin-agenda-end-error" hidden></p>
      </div>
      <div class="admin-form-group">
        <label for="admin-agenda-room">Room</label>
        <input
          id="admin-agenda-room"
          name="room"
          class="admin-input"
          type="text"
          maxlength="60"
          autocomplete="off"
        />
      </div>
      <div class="admin-form-group">
        <label for="admin-agenda-speaker-name">Speaker name</label>
        <input
          id="admin-agenda-speaker-name"
          name="speakerName"
          class="admin-input"
          type="text"
          maxlength="120"
          autocomplete="off"
          aria-describedby="admin-agenda-speaker-name-error"
        />
        <p class="admin-inline-error" id="admin-agenda-speaker-name-error" hidden></p>
      </div>
      <div class="admin-form-group">
        <label for="admin-agenda-speaker-bio">Speaker bio</label>
        <textarea
          id="admin-agenda-speaker-bio"
          name="speakerBio"
          class="admin-textarea"
          rows="3"
          maxlength="2000"
        ></textarea>
      </div>
      <div class="admin-form-group">
        <label for="admin-agenda-description">Description</label>
        <textarea
          id="admin-agenda-description"
          name="description"
          class="admin-textarea"
          rows="4"
          maxlength="2000"
        ></textarea>
      </div>
    </form>
    <footer class="admin-modal__footer">
      <button type="button" class="btn-secondary" data-cancel>Cancel</button>
      <button type="button" class="btn-primary admin-modal__save" data-save>
        <span class="admin-modal__save-label">Save</span>
      </button>
    </footer>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  document.body.classList.add("admin-modal-open");

  const form = modal.querySelector("[data-form]");
  const banner = modal.querySelector("[data-banner]");
  const titleInput = modal.querySelector("#admin-agenda-title");
  const startInput = modal.querySelector("#admin-agenda-start");
  const endInput = modal.querySelector("#admin-agenda-end");
  const roomInput = modal.querySelector("#admin-agenda-room");
  const speakerNameInput = modal.querySelector("#admin-agenda-speaker-name");
  const speakerBioInput = modal.querySelector("#admin-agenda-speaker-bio");
  const descriptionInput = modal.querySelector("#admin-agenda-description");
  const closeBtn = modal.querySelector("[data-close]");
  const cancelBtn = modal.querySelector("[data-cancel]");
  const saveBtn = modal.querySelector("[data-save]");
  const saveLabel = modal.querySelector(".admin-modal__save-label");

  // Prefill for edit; sensible defaults for add.
  if (existing) {
    titleInput.value = existing.title || "";
    startInput.value = isoToLocalInput(existing.startAt);
    endInput.value = isoToLocalInput(existing.endAt);
    roomInput.value = typeof existing.room === "string" ? existing.room : "";
    if (existing.speaker && typeof existing.speaker === "object") {
      speakerNameInput.value = typeof existing.speaker.name === "string" ? existing.speaker.name : "";
      speakerBioInput.value = typeof existing.speaker.bio === "string" ? existing.speaker.bio : "";
    }
    descriptionInput.value = typeof existing.description === "string" ? existing.description : "";
  }

  // Snapshot initial values so Escape can distinguish dirty vs. clean.
  const initialSnapshot = snapshotFormValues();

  function snapshotFormValues() {
    return JSON.stringify({
      title: titleInput.value,
      startAt: startInput.value,
      endAt: endInput.value,
      room: roomInput.value,
      speakerName: speakerNameInput.value,
      speakerBio: speakerBioInput.value,
      description: descriptionInput.value,
    });
  }

  function isDirty() {
    return snapshotFormValues() !== initialSnapshot;
  }

  /* ---- Banner helpers ---- */

  function showBanner(kind, html) {
    banner.className = `admin-modal__banner admin-modal__banner--${kind}`;
    banner.innerHTML = html;
    banner.hidden = false;
    // Wire any banner buttons the caller injected.
    const retryBtn = banner.querySelector("[data-banner-retry]");
    if (retryBtn) retryBtn.addEventListener("click", () => {
      hideBanner();
      submit();
    });
    const overwriteBtn = banner.querySelector("[data-banner-overwrite]");
    if (overwriteBtn) overwriteBtn.addEventListener("click", () => {
      hideBanner();
      submit({ bypassConflictCheck: true });
    });
    const reloadBtn = banner.querySelector("[data-banner-reload]");
    if (reloadBtn) reloadBtn.addEventListener("click", async () => {
      hideBanner();
      await reopenWithLatest();
    });
  }

  function hideBanner() {
    banner.hidden = true;
    banner.innerHTML = "";
    banner.className = "admin-modal__banner";
  }

  async function reopenWithLatest() {
    try {
      const latest = await getDoc(`agenda/${docId}`);
      // Tear down the current modal cleanly. closeNow() invokes onClose,
      // which clears the owner view's `openModal` reference. Then ask
      // the owner view to open a fresh edit modal so the new modal
      // enters that reference.
      closeNow();
      if (latest && typeof onRequestReopenEdit === "function") {
        onRequestReopenEdit(latest);
      }
    } catch (err) {
      console.warn("[admin-agenda] reload-latest failed:", err);
      showBanner(
        "error",
        `<p>Couldn't reload the latest copy. <button type="button" class="btn-link" data-banner-retry>Retry</button></p>`,
      );
    }
  }

  /* ---- Validation ---- */

  function clearInlineErrors() {
    for (const el of modal.querySelectorAll(".admin-inline-error")) {
      el.hidden = true;
      el.textContent = "";
    }
    for (const el of modal.querySelectorAll("[aria-invalid=\"true\"]")) {
      el.removeAttribute("aria-invalid");
    }
  }

  function setFieldError(input, message) {
    input.setAttribute("aria-invalid", "true");
    const describedby = input.getAttribute("aria-describedby");
    const errEl = describedby ? modal.querySelector(`#${CSS.escape(describedby)}`) : null;
    if (errEl) {
      errEl.textContent = message;
      errEl.hidden = false;
    }
  }

  function validate() {
    clearInlineErrors();
    let firstInvalid = null;

    const title = titleInput.value.trim();
    if (!title) {
      setFieldError(titleInput, "Title is required.");
      firstInvalid = firstInvalid || titleInput;
    } else if (title.length > 120) {
      setFieldError(titleInput, "Title must be 120 characters or fewer.");
      firstInvalid = firstInvalid || titleInput;
    }

    if (!startInput.value) {
      setFieldError(startInput, "Start time is required.");
      firstInvalid = firstInvalid || startInput;
    }
    if (!endInput.value) {
      setFieldError(endInput, "End time is required.");
      firstInvalid = firstInvalid || endInput;
    }
    if (startInput.value && endInput.value) {
      const startMs = new Date(startInput.value).getTime();
      const endMs = new Date(endInput.value).getTime();
      if (Number.isNaN(startMs)) {
        setFieldError(startInput, "Enter a valid start time.");
        firstInvalid = firstInvalid || startInput;
      }
      if (Number.isNaN(endMs)) {
        setFieldError(endInput, "Enter a valid end time.");
        firstInvalid = firstInvalid || endInput;
      }
      if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs <= startMs) {
        setFieldError(endInput, "End time must be after start time.");
        firstInvalid = firstInvalid || endInput;
      }
    }

    const speakerName = speakerNameInput.value.trim();
    const speakerBio = speakerBioInput.value.trim();
    if (speakerBio && !speakerName) {
      setFieldError(speakerNameInput, "Speaker name is required when a bio is provided.");
      firstInvalid = firstInvalid || speakerNameInput;
    }

    if (firstInvalid) {
      firstInvalid.focus();
      try { firstInvalid.scrollIntoView({ block: "center", behavior: "smooth" }); }
      catch (_err) { /* no-op */ }
      return null;
    }

    return {
      title,
      startAt: new Date(startInput.value).toISOString(),
      endAt: new Date(endInput.value).toISOString(),
      room: roomInput.value.trim(),
      speakerName,
      speakerBio,
      description: descriptionInput.value.trim(),
    };
  }

  /* ---- Submit ---- */

  let saving = false;
  async function submit({ bypassConflictCheck } = {}) {
    if (saving) return;
    const online = typeof navigator === "undefined" || navigator.onLine !== false;
    if (!online) {
      showBanner(
        "error",
        `<p>You're offline. Reconnect and try again.</p>`,
      );
      return;
    }
    const values = validate();
    if (!values) return;

    saving = true;
    saveBtn.disabled = true;
    saveBtn.classList.add("admin-modal__save--loading");
    saveLabel.textContent = "Saving\u2026";

    try {
      // Collision soft-safeguard (edit only): re-read before writing.
      if (isEdit && !bypassConflictCheck) {
        try {
          const latest = await getDoc(`agenda/${docId}`);
          if (hasConflict(latest, snapshotTs)) {
            resetSaveButton();
            showBanner(
              "warning",
              `<p>This session was edited by someone else since you opened it. Reload to see their changes, or Overwrite to save yours anyway.</p>
               <div class="admin-modal__banner-actions">
                 <button type="button" class="btn-secondary" data-banner-reload>Reload</button>
                 <button type="button" class="btn-primary" data-banner-overwrite>Overwrite</button>
               </div>`,
            );
            return;
          }
        } catch (err) {
          // Non-fatal; proceed to save. The write will surface its own
          // error on failure.
          console.warn("[admin-agenda] collision pre-check failed:", err);
        }
      }

      const payload = {
        title: values.title,
        description: values.description,
        startAt: values.startAt,
        endAt: values.endAt,
        room: values.room,
        speaker: values.speakerName
          ? { name: values.speakerName, bio: values.speakerBio }
          : null,
        order: deriveOrder(existing, values.startAt),
      };

      await adminFetch("/api/firestore-write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection: "agenda",
          docId,
          op: "set",
          data: payload,
        }),
      });

      ui.toast("success", "Session saved.");
      closeNow();
      onSaved();
    } catch (err) {
      console.warn("[admin-agenda] save failed:", err);
      if (err?.code === "session-expired") {
        // adminFetch already triggered the redirect; just stop.
        return;
      }
      resetSaveButton();
      showBanner(
        "error",
        `<p>Could not save \u2014 try again. <button type="button" class="btn-link" data-banner-retry>Retry</button></p>`,
      );
    }
  }

  function resetSaveButton() {
    saving = false;
    saveBtn.disabled = false;
    saveBtn.classList.remove("admin-modal__save--loading");
    saveLabel.textContent = "Save";
  }

  /* ---- Close plumbing ---- */

  function closeNow() {
    try { uninstall(); } catch (_err) { /* no-op */ }
    overlay.remove();
    document.body.classList.remove("admin-modal-open");
    onClose();
  }

  async function requestClose() {
    if (isDirty()) {
      const confirmed = await confirmDialog({
        title: "Discard changes?",
        body: "You have unsaved changes. Discard them?",
        confirmLabel: "Discard",
        destructive: true,
      });
      if (!confirmed) return;
    }
    closeNow();
  }

  closeBtn.addEventListener("click", () => { requestClose(); });
  cancelBtn.addEventListener("click", () => { requestClose(); });
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) requestClose();
  });
  saveBtn.addEventListener("click", () => { submit(); });
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    submit();
  });

  const uninstall = installFocusTrap(modal, {
    onEscape: () => { requestClose(); },
    initialFocus: () => titleInput,
  });

  function setOnline(online) {
    // The modal doesn't disable Save on offline — the submit path shows
    // the explicit banner. Here we keep the hook so the view's rerender
    // can broadcast state cleanly.
    modal.dataset.online = online ? "true" : "false";
  }
  setOnline(online);

  return { setOnline, close: closeNow };
}

/* =================================================================
 * Delete confirm dialog
 * ================================================================= */

function createDeleteDialog({ session, online, onClose, onDeleted }) {
  const docId = typeof session.id === "string" ? session.id : "";
  const title = typeof session.title === "string" && session.title.trim()
    ? session.title.trim()
    : "Untitled session";

  const overlay = document.createElement("div");
  overlay.className = "admin-modal-overlay admin-modal-overlay--confirm";

  const modal = document.createElement("div");
  modal.className = "admin-modal admin-modal--confirm";
  modal.setAttribute("role", "alertdialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "admin-agenda-delete-title");
  modal.setAttribute("aria-describedby", "admin-agenda-delete-body");
  modal.setAttribute("tabindex", "-1");

  modal.innerHTML = `
    <header class="admin-modal__header">
      <h2 class="admin-modal__title" id="admin-agenda-delete-title">Delete session?</h2>
    </header>
    <div class="admin-modal__body" id="admin-agenda-delete-body">
      <p>Delete \u201C${escapeHtml(title)}\u201D? This cannot be undone.</p>
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
    const online = typeof navigator === "undefined" || navigator.onLine !== false;
    if (!online) {
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
          collection: "agenda",
          docId,
          op: "delete",
        }),
      });
      ui.toast("success", "Session deleted.");
      closeNow();
      onDeleted();
    } catch (err) {
      console.warn("[admin-agenda] delete failed:", err);
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

  function setOnline(nowOnline) {
    modal.dataset.online = nowOnline ? "true" : "false";
  }
  setOnline(online);

  return { setOnline, close: closeNow };
}

/* =================================================================
 * Generic confirm dialog (used by Escape-with-unsaved-changes)
 * ================================================================= */

function confirmDialog({ title, body, confirmLabel, destructive }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "admin-modal-overlay admin-modal-overlay--confirm admin-modal-overlay--nested";

    const modal = document.createElement("div");
    modal.className = "admin-modal admin-modal--confirm";
    modal.setAttribute("role", "alertdialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "admin-confirm-title");
    modal.setAttribute("aria-describedby", "admin-confirm-body");
    modal.setAttribute("tabindex", "-1");

    const confirmClass = destructive ? "btn-destructive" : "btn-primary";
    modal.innerHTML = `
      <header class="admin-modal__header">
        <h2 class="admin-modal__title" id="admin-confirm-title">${escapeHtml(title)}</h2>
      </header>
      <div class="admin-modal__body" id="admin-confirm-body">
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
      initialFocus: () => cancelBtn,
    });
  });
}

/* =================================================================
 * Helpers
 * ================================================================= */

/**
 * Convert an ISO 8601 timestamp to the `YYYY-MM-DDTHH:mm` string the
 * `<input type="datetime-local">` consumes. The input is in the user's
 * local time, so we project the ISO value to local via Date and format
 * the parts manually (toISOString() would re-serialize as UTC).
 */
function isoToLocalInput(iso) {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Derive the `order` field. Preserve the existing numeric order on edit;
 * fall back to the startAt epoch milliseconds for a new session (and for
 * an edit when the stored order is missing/invalid) so sessions sort
 * naturally by start time without the admin having to touch `order`.
 */
function deriveOrder(existing, startAtIso) {
  if (existing && Number.isFinite(Number(existing.order))) {
    return Number(existing.order);
  }
  const t = Date.parse(startAtIso);
  return Number.isFinite(t) ? t : 0;
}

/** Return the doc with the greatest parseable `updatedAt`, or null. */
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

function sortSessions(a, b) {
  const sa = Date.parse(a?.startAt);
  const sb = Date.parse(b?.startAt);
  const saN = Number.isNaN(sa) ? Infinity : sa;
  const sbN = Number.isNaN(sb) ? Infinity : sb;
  if (saN !== sbN) return saN - sbN;
  const oa = Number(a?.order);
  const ob = Number(b?.order);
  const oaN = Number.isFinite(oa) ? oa : Infinity;
  const obN = Number.isFinite(ob) ? ob : Infinity;
  return oaN - obN;
}

function formatTimeRange(startIso, endIso) {
  const s = formatTime(startIso);
  const e = formatTime(endIso);
  if (!s || !e) return "";
  return `${s} \u2013 ${e}`;
}

function formatTime(iso) {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function newDocId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback — same shape as firebase.js's helper.
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
