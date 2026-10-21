// sponsors-editor.js — admin Sponsor editor view (Task 19).
//
// Mounts into #admin-view-root. The view owns:
//   - a sticky secondary header ("Admin — Sponsors" + Add sponsor button
//     + the collection-wide "updated X ago by Y" meta line),
//   - a tier-grouped sponsor list driven by a 15-second poll of the
//     public `sponsors` collection via /js/firebase.js onSnapshot (admin
//     reads bypass the broker — firestore.rules grant public read),
//   - a within-tier reorder control (up/down arrows) that swaps `order`
//     with the neighbor via two /api/firestore-write updates. If a swap
//     partially fails the user sees a reconcile toast and the next
//     poll corrects the client view,
//   - a shared Add/Edit modal with client-side validation, logo upload
//     to Cloudflare R2 via /api/upload (FormData), the design section 6
//     collision soft-safeguard (Overwrite / Reload banner), and a focus
//     trap from /js/utils/focus-trap.js,
//   - a Delete confirm dialog reusing the same modal shell. Deleting the
//     Firestore doc does NOT delete the R2 object (orphan images are
//     harmless on the free tier; a future cleanup task can prune them).
//
// All Firestore writes go through /api/firestore-write via adminFetch
// (JWT required). The Function server-stamps `updatedAt` + `updatedBy`.
// Logo bytes go through /api/upload with multipart/form-data: fields
//   file (Blob), kind ("sponsor"), id (<sponsor-uuid>)
// — the browser sets the multipart boundary; we must NOT set a manual
// Content-Type header on the request.
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
const LOGO_PLACEHOLDER = "/assets/placeholders/logo-placeholder.svg";
const MAX_LOGO_BYTES = 5 * 1024 * 1024; // mirrors /api/upload's cap
const ALLOWED_LOGO_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
]);
// Loose but useful: single @ with non-space on each side and at least
// one dot in the host. Not RFC 5321 — matches the design doc's "looks
// like local@domain" bar.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Tiers in display order. Keeps the admin view in lockstep with the
// attendee list so the admin's mental model matches what attendees see.
const TIER_ORDER = ["platinum", "gold", "silver", "supporter"];
const TIER_LABELS = {
  platinum: "Platinum",
  gold: "Gold",
  silver: "Silver",
  supporter: "Supporter",
};

/**
 * Render the admin Sponsor editor into `host`.
 * @param {HTMLElement} host  typically `#admin-view-root`.
 * @returns {Promise<void>}
 */
export default async function renderSponsorsEditor(host) {
  host.innerHTML = "";

  const container = document.createElement("section");
  container.className = "admin-sponsors-view";
  container.setAttribute("aria-label", "Admin Sponsors editor");
  host.appendChild(container);

  const header = buildStickyHeader();
  const offlineBanner = buildOfflineBanner();
  const listSection = document.createElement("div");
  listSection.className = "admin-sponsors-list";
  listSection.setAttribute("aria-live", "polite");
  listSection.setAttribute("aria-label", "Sponsors");

  container.append(header.el, offlineBanner.el, listSection);

  // Prime /api/config; cached inside firebase.js after the first call.
  const configReady = initFirestore().catch((err) => {
    console.warn("[admin-sponsors] /api/config load failed:", err);
    return null;
  });

  /** @type {object[] | null} */
  let cachedSponsors = null;
  /** @type {Error | null} */
  let lastErr = null;
  let sawFirstResult = false;
  let errorToasted = false;
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  // Flag set when a reorder write partial-fails. Suppresses the "Showing
  // last-saved sponsors" strip on the very next poll so the UI doesn't
  // stack an error strip on top of the reconcile toast.
  let suppressStaleStripOnce = false;

  /** @type {{ setOnline: (online: boolean) => void, close: () => void } | null} */
  let openModal = null;

  function rerender() {
    offlineBanner.setVisible(!online);
    header.setOnline(online);
    if (openModal) openModal.setOnline(online);

    if (lastErr && !cachedSponsors) {
      renderErrorNoCache(listSection, () => restartSubscription());
      return;
    }
    if (!sawFirstResult) {
      renderSkeleton(listSection);
      return;
    }
    const sorted = (cachedSponsors || []).slice();
    header.setLastEdited(mostRecentlyEdited(sorted));
    renderSponsorList(listSection, sorted, {
      hasError: Boolean(lastErr) && !suppressStaleStripOnce,
      online,
      onRetry: () => restartSubscription(),
      onEdit: (sponsor) => openSponsorModal({ mode: "edit", sponsor }),
      onDelete: (sponsor) => openDeleteDialog(sponsor),
      onAdd: () => openSponsorModal({ mode: "add" }),
      onReorder: (sponsor, direction) => reorderWithinTier(sponsor, direction),
    });
  }

  /** @type {(() => void) | null} */
  let unsub = null;
  async function startSubscription() {
    try { await configReady; } catch (_err) { /* non-fatal */ }
    unsub = onSnapshot(
      "sponsors",
      (data, err) => {
        if (err) {
          console.warn("[admin-sponsors] poll failed:", err);
          lastErr = err;
          if (!cachedSponsors && !errorToasted) {
            ui.toast(
              "error",
              "Couldn't load sponsors. Tap Retry to try again.",
            );
            errorToasted = true;
          }
        } else {
          lastErr = null;
          errorToasted = false;
          if (suppressStaleStripOnce) suppressStaleStripOnce = false;
          cachedSponsors = Array.isArray(data) ? data : [];
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
    cachedSponsors = null;
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
  header.setOnAdd(() => openSponsorModal({ mode: "add" }));

  /* ---------------- Modal plumbing ---------------- */

  function openSponsorModal({ mode, sponsor }) {
    if (openModal) openModal.close();
    openModal = createSponsorModal({
      mode,
      sponsor,
      online,
      onClose: () => { openModal = null; },
      onSaved: () => { openModal = null; nudgeRefresh(); },
      onRequestReopenEdit: (latest) =>
        openSponsorModal({ mode: "edit", sponsor: latest }),
    });
  }

  function openDeleteDialog(sponsor) {
    if (openModal) openModal.close();
    openModal = createDeleteDialog({
      sponsor,
      online,
      onClose: () => { openModal = null; },
      onDeleted: () => { openModal = null; nudgeRefresh(); },
    });
  }

  /* ---------------- Reorder (within-tier swap) ---------------- */

  async function reorderWithinTier(sponsor, direction) {
    if (!online) return; // the UI disables the handles, this is belt+suspenders

    const list = (cachedSponsors || []).slice();
    const grouped = groupByTier(list);
    const bucket = grouped.find((g) => g.tier === tierKey(sponsor));
    if (!bucket) return;

    const idx = bucket.sponsors.findIndex((s) => s.id === sponsor.id);
    if (idx < 0) return;
    const neighborIdx = direction === "up" ? idx - 1 : idx + 1;
    if (neighborIdx < 0 || neighborIdx >= bucket.sponsors.length) return;

    const a = bucket.sponsors[idx];
    const b = bucket.sponsors[neighborIdx];

    // Compute concrete numeric orders. If a tier was previously ordered
    // only by name (no `order` fields), the first swap writes real
    // integers that subsequent swaps can sort against.
    const effectiveA = effectiveOrder(a, bucket.sponsors);
    const effectiveB = effectiveOrder(b, bucket.sponsors);

    const payloadA = {
      collection: "sponsors",
      docId: a.id,
      op: "update",
      data: { order: effectiveB },
    };
    const payloadB = {
      collection: "sponsors",
      docId: b.id,
      op: "update",
      data: { order: effectiveA },
    };

    // Optimistically paint the swap so the admin's tap feels instant.
    // The next poll (<=15s) reconciles with the server. If a write fails
    // we revert via nudgeRefresh() so the attendee list stays truthful.
    const localCopyA = { ...a, order: effectiveB };
    const localCopyB = { ...b, order: effectiveA };
    cachedSponsors = list.map((s) => {
      if (s.id === a.id) return localCopyA;
      if (s.id === b.id) return localCopyB;
      return s;
    });
    rerender();

    try {
      await adminFetch("/api/firestore-write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadA),
      });
      await adminFetch("/api/firestore-write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadB),
      });
      // Both succeeded. Pull a fresh poll to pick up server-stamped
      // updatedAt / updatedBy so the "last edited" meta line stays truthful.
      suppressStaleStripOnce = false;
      nudgeRefresh();
    } catch (err) {
      console.warn("[admin-sponsors] reorder failed:", err);
      if (err?.code === "session-expired") return; // redirect in flight
      ui.toast(
        "error",
        "Could not reorder \u2014 please refresh and try again.",
      );
      // Suppress the "Couldn't refresh" strip on the reconcile poll so the
      // toast reads clean. The poll itself still fires and overwrites the
      // optimistic swap (good: server is the source of truth).
      suppressStaleStripOnce = true;
      nudgeRefresh();
    }
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
    if (openModal) {
      try { openModal.close(); } catch (_err) { /* no-op */ }
      openModal = null;
    }
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onVisibility);
  });

  document.title = "Admin \u2014 Sponsors \u2014 Vendor Day 2027";
}

/* =================================================================
 * Sticky secondary header
 * ================================================================= */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "admin-sponsors-header";
  el.innerHTML = `
    <div class="admin-sponsors-header__row">
      <h2 class="admin-sponsors-header__title">Admin \u2014 Sponsors</h2>
      <button
        type="button"
        class="btn-primary admin-sponsors-header__add"
        data-add-sponsor
      >Add sponsor</button>
    </div>
    <p class="admin-sponsors-header__meta" aria-live="polite">never edited</p>
  `;

  const addBtn = el.querySelector("[data-add-sponsor]");
  const metaEl = el.querySelector(".admin-sponsors-header__meta");

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

  addBtn.addEventListener("click", () => {
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
  el.textContent = "You're offline \u2014 showing last-saved sponsors.";
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
    <div class="admin-sponsor-tier-group" aria-hidden="true">
      <div class="skeleton-row admin-sponsor-tier-label-skel" style="height: 20px; width: 30%;"></div>
      <div class="admin-sponsor-card skeleton-card"></div>
      <div class="admin-sponsor-card skeleton-card"></div>
    </div>
    <div class="admin-sponsor-tier-group" aria-hidden="true">
      <div class="skeleton-row admin-sponsor-tier-label-skel" style="height: 20px; width: 30%;"></div>
      <div class="admin-sponsor-card skeleton-card"></div>
    </div>
  `;
}

function renderErrorNoCache(host, onRetry) {
  host.innerHTML = `
    <div class="status-error" role="alert">
      <p>Couldn't load sponsors.</p>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    </div>
  `;
  host.querySelector("[data-retry]").addEventListener("click", onRetry);
}

function renderEmptyState(host, { online, onAdd }) {
  const el = document.createElement("div");
  el.className = "placeholder-card admin-sponsors-empty";
  const btnTitle = online ? "" : ` title="${escapeAttr(OFFLINE_TOOLTIP)}"`;
  const btnDisabled = online ? "" : " disabled aria-disabled=\"true\"";
  el.innerHTML = `
    <h2>No sponsors yet</h2>
    <p>Tap Add sponsor to create the first one.</p>
    <button type="button" class="btn-primary" data-add${btnDisabled}${btnTitle}>Add sponsor</button>
  `;
  el.querySelector("[data-add]").addEventListener("click", () => {
    if (!online) return;
    onAdd();
  });
  host.appendChild(el);
}

function renderSponsorList(host, sponsors, {
  hasError, online, onRetry, onEdit, onDelete, onAdd, onReorder,
}) {
  host.innerHTML = "";

  if (hasError) {
    const strip = document.createElement("div");
    strip.className = "status-error admin-sponsors-error-strip";
    strip.setAttribute("role", "status");
    strip.innerHTML = `
      <span>Couldn't refresh. Showing last-saved sponsors.</span>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    `;
    strip.querySelector("[data-retry]").addEventListener("click", onRetry);
    host.appendChild(strip);
  }

  if (!sponsors.length) {
    renderEmptyState(host, { online, onAdd });
    return;
  }

  const groups = groupByTier(sponsors);
  for (const group of groups) {
    host.appendChild(renderTierGroup(group, { online, onEdit, onDelete, onReorder }));
  }
}

function renderTierGroup(group, handlers) {
  const section = document.createElement("section");
  section.className = `admin-sponsor-tier-group admin-sponsor-tier-group--${group.tier}`;

  const h3 = document.createElement("h3");
  h3.className = "admin-sponsor-tier-label";
  h3.textContent = TIER_LABELS[group.tier] || "Other";
  section.appendChild(h3);

  group.sponsors.forEach((sponsor, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === group.sponsors.length - 1;
    section.appendChild(
      renderSponsorCard(sponsor, { ...handlers, isFirst, isLast }),
    );
  });
  return section;
}

function renderSponsorCard(sponsor, {
  online, onEdit, onDelete, onReorder, isFirst, isLast,
}) {
  const el = document.createElement("article");
  el.className = "admin-sponsor-card";

  const name = typeof sponsor.name === "string" && sponsor.name.trim()
    ? sponsor.name.trim()
    : "Untitled sponsor";
  const booth = typeof sponsor.boothNumber === "string"
    ? sponsor.boothNumber.trim()
    : "";
  const logoUrl = typeof sponsor.logoUrl === "string" && sponsor.logoUrl.trim()
    ? sponsor.logoUrl.trim()
    : LOGO_PLACEHOLDER;
  const tLabel = TIER_LABELS[tierKey(sponsor)] || "Other";

  const disabledAttrs = online
    ? ""
    : ` disabled aria-disabled="true" title="${escapeAttr(OFFLINE_TOOLTIP)}"`;
  const upDisabled = isFirst || !online
    ? ` disabled aria-disabled="true"${!online ? ` title="${escapeAttr(OFFLINE_TOOLTIP)}"` : ""}`
    : "";
  const downDisabled = isLast || !online
    ? ` disabled aria-disabled="true"${!online ? ` title="${escapeAttr(OFFLINE_TOOLTIP)}"` : ""}`
    : "";

  el.innerHTML = `
    <img
      class="admin-sponsor-card__logo"
      src="${escapeAttr(logoUrl)}"
      alt=""
      width="48"
      height="48"
      loading="lazy"
    />
    <div class="admin-sponsor-card__body">
      <p class="admin-sponsor-card__name">${escapeHtml(name)}</p>
      <p class="admin-sponsor-card__meta">
        <span class="admin-sponsor-card__tier-chip">${escapeHtml(tLabel)}</span>
        ${booth ? `<span class="admin-sponsor-card__booth">Booth ${escapeHtml(booth)}</span>` : ""}
      </p>
    </div>
    <div class="admin-sponsor-card__actions">
      <div class="admin-sponsor-reorder-group" role="group" aria-label="Reorder ${escapeAttr(name)} within tier">
        <button
          type="button"
          class="admin-sponsor-reorder-btn"
          aria-label="Move ${escapeAttr(name)} up"
          data-up
          ${upDisabled}
        >\u2191</button>
        <button
          type="button"
          class="admin-sponsor-reorder-btn"
          aria-label="Move ${escapeAttr(name)} down"
          data-down
          ${downDisabled}
        >\u2193</button>
      </div>
      <button
        type="button"
        class="admin-sponsor-action-btn admin-sponsor-action-btn--edit"
        aria-label="Edit ${escapeAttr(name)}"
        data-edit
        ${disabledAttrs}
      >Edit</button>
      <button
        type="button"
        class="admin-sponsor-action-btn admin-sponsor-action-btn--delete"
        aria-label="Delete ${escapeAttr(name)}"
        data-delete
        ${disabledAttrs}
      >Delete</button>
    </div>
  `;

  el.querySelector("[data-up]").addEventListener("click", () => {
    if (isFirst || !online) return;
    onReorder(sponsor, "up");
  });
  el.querySelector("[data-down]").addEventListener("click", () => {
    if (isLast || !online) return;
    onReorder(sponsor, "down");
  });
  el.querySelector("[data-edit]").addEventListener("click", () => {
    if (!online) return;
    onEdit(sponsor);
  });
  el.querySelector("[data-delete]").addEventListener("click", () => {
    if (!online) return;
    onDelete(sponsor);
  });

  return el;
}

/* =================================================================
 * Add/Edit modal
 * ================================================================= */

function createSponsorModal({
  mode,
  sponsor,
  online,
  onClose,
  onSaved,
  onRequestReopenEdit,
}) {
  const isEdit = mode === "edit";
  const existing = isEdit && sponsor && typeof sponsor === "object" ? sponsor : null;
  const snapshotTs = snapshotEditingTimestamp(existing);
  const docId = existing && typeof existing.id === "string" ? existing.id : newDocId();

  const overlay = document.createElement("div");
  overlay.className = "admin-modal-overlay";

  const modal = document.createElement("div");
  modal.className = "admin-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "admin-sponsor-modal-title");
  modal.setAttribute("tabindex", "-1");

  modal.innerHTML = `
    <header class="admin-modal__header">
      <h2 class="admin-modal__title" id="admin-sponsor-modal-title">${isEdit ? "Edit sponsor" : "Add sponsor"}</h2>
      <button type="button" class="admin-modal__close" aria-label="Close" data-close>&times;</button>
    </header>
    <div class="admin-modal__banner" data-banner hidden></div>
    <form class="admin-modal__body" novalidate data-form>
      <div class="admin-form-group">
        <label for="admin-sponsor-name">
          Name
          <span class="admin-required-marker" aria-hidden="true">*</span>
          <span class="sr-only">required</span>
        </label>
        <input
          id="admin-sponsor-name"
          name="name"
          class="admin-input"
          type="text"
          maxlength="120"
          required
          autocomplete="off"
          aria-describedby="admin-sponsor-name-error"
        />
        <p class="admin-inline-error" id="admin-sponsor-name-error" hidden></p>
      </div>
      <div class="admin-form-group">
        <label for="admin-sponsor-tier">
          Tier
          <span class="admin-required-marker" aria-hidden="true">*</span>
          <span class="sr-only">required</span>
        </label>
        <select
          id="admin-sponsor-tier"
          name="tier"
          class="admin-input"
          required
          aria-describedby="admin-sponsor-tier-error"
        >
          <option value="">\u2014 Select tier \u2014</option>
          <option value="platinum">Platinum</option>
          <option value="gold">Gold</option>
          <option value="silver">Silver</option>
          <option value="supporter">Supporter</option>
        </select>
        <p class="admin-inline-error" id="admin-sponsor-tier-error" hidden></p>
      </div>
      <div class="admin-form-group">
        <label for="admin-sponsor-booth">Booth number</label>
        <input
          id="admin-sponsor-booth"
          name="boothNumber"
          class="admin-input"
          type="text"
          maxlength="20"
          autocomplete="off"
        />
      </div>
      <div class="admin-form-group">
        <label for="admin-sponsor-website">Website</label>
        <input
          id="admin-sponsor-website"
          name="website"
          class="admin-input"
          type="url"
          maxlength="500"
          autocomplete="off"
          inputmode="url"
          placeholder="https://example.com"
          aria-describedby="admin-sponsor-website-error"
        />
        <p class="admin-inline-error" id="admin-sponsor-website-error" hidden></p>
      </div>
      <div class="admin-form-group">
        <label for="admin-sponsor-email">Email</label>
        <input
          id="admin-sponsor-email"
          name="email"
          class="admin-input"
          type="email"
          maxlength="120"
          autocomplete="off"
          inputmode="email"
          aria-describedby="admin-sponsor-email-error"
        />
        <p class="admin-inline-error" id="admin-sponsor-email-error" hidden></p>
      </div>
      <div class="admin-form-group">
        <label for="admin-sponsor-description">Description</label>
        <textarea
          id="admin-sponsor-description"
          name="description"
          class="admin-textarea"
          rows="4"
          maxlength="2000"
        ></textarea>
      </div>
      <div class="admin-form-group">
        <span class="admin-form-group__label-text">Logo</span>
        <div class="admin-sponsor-logo-preview-wrap">
          <img
            class="admin-sponsor-logo-preview"
            data-logo-preview
            alt=""
            width="96"
            height="96"
          />
          <div class="admin-sponsor-logo-controls">
            <button
              type="button"
              class="btn-secondary admin-sponsor-logo-replace-btn"
              data-logo-pick
            >Choose file</button>
            <p class="admin-sponsor-logo-filename" data-logo-filename aria-live="polite"></p>
          </div>
        </div>
        <input
          id="admin-sponsor-logo"
          name="logo"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          class="admin-sponsor-logo-input"
          data-logo-input
          aria-describedby="admin-sponsor-logo-help admin-sponsor-logo-error"
        />
        <p class="admin-sponsor-logo-help" id="admin-sponsor-logo-help">
          PNG, JPEG, WebP, or SVG. Max 5 MB.
        </p>
        <p class="admin-inline-error" id="admin-sponsor-logo-error" hidden></p>
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
  const nameInput = modal.querySelector("#admin-sponsor-name");
  const tierSelect = modal.querySelector("#admin-sponsor-tier");
  const boothInput = modal.querySelector("#admin-sponsor-booth");
  const websiteInput = modal.querySelector("#admin-sponsor-website");
  const emailInput = modal.querySelector("#admin-sponsor-email");
  const descriptionInput = modal.querySelector("#admin-sponsor-description");
  const logoInput = modal.querySelector("[data-logo-input]");
  const logoPreview = modal.querySelector("[data-logo-preview]");
  const logoPickBtn = modal.querySelector("[data-logo-pick]");
  const logoFilename = modal.querySelector("[data-logo-filename]");
  const closeBtn = modal.querySelector("[data-close]");
  const cancelBtn = modal.querySelector("[data-cancel]");
  const saveBtn = modal.querySelector("[data-save]");
  const saveLabel = modal.querySelector(".admin-modal__save-label");

  // Prefill for edit; sensible defaults for add.
  if (existing) {
    nameInput.value = existing.name || "";
    const existingTier = typeof existing.tier === "string"
      ? existing.tier.toLowerCase()
      : "";
    tierSelect.value = TIER_ORDER.includes(existingTier) ? existingTier : "";
    boothInput.value = typeof existing.boothNumber === "string"
      ? existing.boothNumber : "";
    websiteInput.value = typeof existing.website === "string"
      ? existing.website : "";
    emailInput.value = typeof existing.email === "string"
      ? existing.email : "";
    descriptionInput.value = typeof existing.description === "string"
      ? existing.description : "";
  }

  // Logo preview source. On add, show the placeholder. On edit, show the
  // sponsor's current logoUrl (or placeholder if blank).
  const existingLogoUrl = existing && typeof existing.logoUrl === "string" && existing.logoUrl.trim()
    ? existing.logoUrl.trim()
    : "";
  logoPreview.src = existingLogoUrl || LOGO_PLACEHOLDER;
  if (existingLogoUrl) {
    logoPickBtn.textContent = "Replace";
  }

  /** @type {File | null} */
  let pendingLogoFile = null;
  // Snapshot initial values so Escape can distinguish dirty vs. clean.
  const initialSnapshot = snapshotFormValues();

  function snapshotFormValues() {
    return JSON.stringify({
      name: nameInput.value,
      tier: tierSelect.value,
      boothNumber: boothInput.value,
      website: websiteInput.value,
      email: emailInput.value,
      description: descriptionInput.value,
      hasPendingLogo: Boolean(pendingLogoFile),
    });
  }

  function isDirty() {
    return snapshotFormValues() !== initialSnapshot;
  }

  /* ---- Logo picker wiring ---- */

  logoPickBtn.addEventListener("click", () => logoInput.click());
  logoInput.addEventListener("change", () => {
    clearFieldError(logoInput);
    const file = logoInput.files && logoInput.files[0];
    if (!file) {
      pendingLogoFile = null;
      logoFilename.textContent = "";
      logoPreview.src = existingLogoUrl || LOGO_PLACEHOLDER;
      return;
    }
    const typeErr = validateLogoFile(file);
    if (typeErr) {
      setFieldError(logoInput, typeErr);
      pendingLogoFile = null;
      logoInput.value = "";
      logoFilename.textContent = "";
      logoPreview.src = existingLogoUrl || LOGO_PLACEHOLDER;
      return;
    }
    pendingLogoFile = file;
    logoFilename.textContent = file.name;
    try {
      // Revoke any prior preview blob first so we don't leak memory on
      // repeated picks within the same modal lifetime.
      if (logoPreview.__objectUrl) {
        try { URL.revokeObjectURL(logoPreview.__objectUrl); } catch (_err) { /* no-op */ }
      }
      const url = URL.createObjectURL(file);
      logoPreview.src = url;
      logoPreview.__objectUrl = url;
    } catch (_err) { /* preview is best-effort */ }
  });

  /* ---- Banner helpers ---- */

  function showBanner(kind, html) {
    banner.className = `admin-modal__banner admin-modal__banner--${kind}`;
    banner.innerHTML = html;
    banner.hidden = false;
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
      const latest = await getDoc(`sponsors/${docId}`);
      closeNow();
      if (latest && typeof onRequestReopenEdit === "function") {
        onRequestReopenEdit(latest);
      }
    } catch (err) {
      console.warn("[admin-sponsors] reload-latest failed:", err);
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
    // aria-describedby may list multiple ids (help + error); pick the
    // one that ends in "-error". CSS.escape guards non-standard chars.
    const ids = (describedby || "").split(/\s+/).filter(Boolean);
    const errId = ids.find((id) => id.endsWith("-error"));
    const errEl = errId ? modal.querySelector(`#${CSS.escape(errId)}`) : null;
    if (errEl) {
      errEl.textContent = message;
      errEl.hidden = false;
    }
  }

  function clearFieldError(input) {
    input.removeAttribute("aria-invalid");
    const describedby = input.getAttribute("aria-describedby");
    const ids = (describedby || "").split(/\s+/).filter(Boolean);
    const errId = ids.find((id) => id.endsWith("-error"));
    const errEl = errId ? modal.querySelector(`#${CSS.escape(errId)}`) : null;
    if (errEl) {
      errEl.textContent = "";
      errEl.hidden = true;
    }
  }

  function validate() {
    clearInlineErrors();
    let firstInvalid = null;

    const name = nameInput.value.trim();
    if (!name) {
      setFieldError(nameInput, "Name is required.");
      firstInvalid = firstInvalid || nameInput;
    } else if (name.length > 120) {
      setFieldError(nameInput, "Name must be 120 characters or fewer.");
      firstInvalid = firstInvalid || nameInput;
    }

    const tier = tierSelect.value;
    if (!TIER_ORDER.includes(tier)) {
      setFieldError(tierSelect, "Tier is required.");
      firstInvalid = firstInvalid || tierSelect;
    }

    const website = websiteInput.value.trim();
    if (website) {
      const err = validateWebsite(website);
      if (err) {
        setFieldError(websiteInput, err);
        firstInvalid = firstInvalid || websiteInput;
      }
    }

    const email = emailInput.value.trim();
    if (email && !EMAIL_RE.test(email)) {
      setFieldError(emailInput, "Enter a valid email address.");
      firstInvalid = firstInvalid || emailInput;
    }

    // Re-validate the file in case it was staged earlier and the admin
    // tabbed straight to Save.
    if (pendingLogoFile) {
      const err = validateLogoFile(pendingLogoFile);
      if (err) {
        setFieldError(logoInput, err);
        firstInvalid = firstInvalid || logoInput;
      }
    }

    if (firstInvalid) {
      firstInvalid.focus();
      try { firstInvalid.scrollIntoView({ block: "center", behavior: "smooth" }); }
      catch (_err) { /* no-op */ }
      return null;
    }

    return {
      name,
      tier,
      boothNumber: boothInput.value.trim(),
      website,
      email,
      description: descriptionInput.value.trim(),
    };
  }

  /* ---- Submit ---- */

  let saving = false;
  async function submit({ bypassConflictCheck } = {}) {
    if (saving) return;
    const onlineNow = typeof navigator === "undefined" || navigator.onLine !== false;
    if (!onlineNow) {
      showBanner("error", `<p>You're offline. Reconnect and try again.</p>`);
      return;
    }
    const values = validate();
    if (!values) return;

    saving = true;
    saveBtn.disabled = true;
    saveBtn.classList.add("admin-modal__save--loading");
    saveLabel.textContent = "Saving\u2026";

    // 1) Upload the logo first (if a new file was picked). On any upload
    // error we abort BEFORE the Firestore write so the sponsor doc never
    // ends up pointing at a half-written object.
    let logoUrlToWrite = existingLogoUrl || "";
    if (pendingLogoFile) {
      try {
        const uploaded = await uploadLogo(pendingLogoFile, docId);
        if (!uploaded?.url || typeof uploaded.url !== "string") {
          throw new Error("Upload response missing url");
        }
        logoUrlToWrite = uploaded.url;
      } catch (err) {
        console.warn("[admin-sponsors] logo upload failed:", err);
        if (err?.code === "session-expired") return;
        resetSaveButton();
        showBanner(
          "error",
          `<p>Could not upload the logo. The sponsor was not saved. <button type="button" class="btn-link" data-banner-retry>Try again</button></p>`,
        );
        return;
      }
    }

    try {
      // 2) Collision soft-safeguard (edit only): re-read before writing.
      if (isEdit && !bypassConflictCheck) {
        try {
          const latest = await getDoc(`sponsors/${docId}`);
          if (hasConflict(latest, snapshotTs)) {
            resetSaveButton();
            showBanner(
              "warning",
              `<p>This sponsor was edited by someone else since you opened it. Reload to see their changes, or Overwrite to save yours anyway.</p>
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
          console.warn("[admin-sponsors] collision pre-check failed:", err);
        }
      }

      // 3) Firestore write via /api/firestore-write. Omit optional fields
      // that are empty — the schema in design section 5 marks them
      // optional, and sending null preserves "unset" semantics without
      // writing an empty string the attendee view would have to filter.
      const payload = {
        name: values.name,
        tier: values.tier,
        description: values.description || null,
        website: values.website || null,
        email: values.email || null,
        boothNumber: values.boothNumber || null,
        logoUrl: logoUrlToWrite || null,
        order: deriveOrder(existing),
      };

      await adminFetch("/api/firestore-write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection: "sponsors",
          docId,
          op: "set",
          data: payload,
        }),
      });

      ui.toast("success", "Sponsor saved.");
      closeNow();
      onSaved();
    } catch (err) {
      console.warn("[admin-sponsors] save failed:", err);
      if (err?.code === "session-expired") return;
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
    if (logoPreview.__objectUrl) {
      try { URL.revokeObjectURL(logoPreview.__objectUrl); } catch (_err) { /* no-op */ }
      logoPreview.__objectUrl = null;
    }
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
    initialFocus: () => nameInput,
  });

  function setOnline(online) {
    modal.dataset.online = online ? "true" : "false";
  }
  setOnline(online);

  return { setOnline, close: closeNow };
}

/* =================================================================
 * Delete confirm dialog
 * ================================================================= */

function createDeleteDialog({ sponsor, online, onClose, onDeleted }) {
  const docId = typeof sponsor.id === "string" ? sponsor.id : "";
  const name = typeof sponsor.name === "string" && sponsor.name.trim()
    ? sponsor.name.trim()
    : "Untitled sponsor";

  const overlay = document.createElement("div");
  overlay.className = "admin-modal-overlay admin-modal-overlay--confirm";

  const modal = document.createElement("div");
  modal.className = "admin-modal admin-modal--confirm";
  modal.setAttribute("role", "alertdialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "admin-sponsor-delete-title");
  modal.setAttribute("aria-describedby", "admin-sponsor-delete-body");
  modal.setAttribute("tabindex", "-1");

  modal.innerHTML = `
    <header class="admin-modal__header">
      <h2 class="admin-modal__title" id="admin-sponsor-delete-title">Delete sponsor?</h2>
    </header>
    <div class="admin-modal__body" id="admin-sponsor-delete-body">
      <p>Delete \u201C${escapeHtml(name)}\u201D? This cannot be undone.</p>
      <p class="admin-sponsor-delete-note">The sponsor's uploaded logo stays in storage and can be reused if you re-add this sponsor later.</p>
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
          collection: "sponsors",
          docId,
          op: "delete",
        }),
      });
      ui.toast("success", "Sponsor deleted.");
      closeNow();
      onDeleted();
    } catch (err) {
      console.warn("[admin-sponsors] delete failed:", err);
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
 * Logo upload
 * ================================================================= */

/**
 * POST the picked file to `/api/upload` as multipart/form-data with the
 * fields the Function expects (`file`, `kind=sponsor`, `id=<docId>`). The
 * browser sets the multipart Content-Type with its boundary; we must NOT
 * set the header manually. The admin JWT comes from adminFetch, which
 * forwards 401 to the session-expired redirect.
 *
 * @param {File} file
 * @param {string} docId  the sponsor's UUID
 * @returns {Promise<{ url: string, key: string, size: number, contentType: string }>}
 */
async function uploadLogo(file, docId) {
  const form = new FormData();
  form.append("file", file);
  form.append("kind", "sponsor");
  form.append("id", docId);
  const result = await adminFetch("/api/upload", {
    method: "POST",
    body: form,
  });
  return result;
}

/**
 * Reject the file if it exceeds 5 MB or carries a MIME type outside the
 * allow-list. Returns null when valid or an error message when not.
 * @param {File} file
 * @returns {string | null}
 */
function validateLogoFile(file) {
  if (file.size > MAX_LOGO_BYTES) {
    return "File too large. Max 5 MB.";
  }
  const type = (file.type || "").toLowerCase();
  if (!ALLOWED_LOGO_TYPES.has(type)) {
    return "Unsupported file type. Choose a PNG, JPEG, WebP, or SVG.";
  }
  return null;
}

/**
 * Enforce the design-doc URL rule: parses as a URL AND uses http(s). The
 * attendee view opens website links with `target=_blank rel=noopener`
 * — we still reject non-http(s) here so an attendee tap can't ever leave
 * the browser to a `javascript:` or `data:` URL.
 * @param {string} website
 * @returns {string | null}
 */
function validateWebsite(website) {
  let parsed;
  try {
    parsed = new URL(website);
  } catch (_err) {
    return "Website must start with https:// or http://.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "Website must start with https:// or http://.";
  }
  return null;
}

/* =================================================================
 * Helpers
 * ================================================================= */

/**
 * Derive the `order` field. Preserve the existing numeric order on edit;
 * fall back to `Date.now()` for a new sponsor so new entries sort to the
 * end of their tier. The actual tie-breaking within a tier (list view
 * and admin reorder) sorts by `order` ascending, so a monotonically
 * increasing fallback keeps the admin's mental model simple.
 */
function deriveOrder(existing) {
  if (existing && Number.isFinite(Number(existing.order))) {
    return Number(existing.order);
  }
  return Date.now();
}

/**
 * The sponsor's own `order` if it's a finite number; otherwise a
 * deterministic `(idx + 1) * 1000` so a tier previously ordered only by
 * name still gets stable integer orders after a single reorder tap.
 * `bucket` is the tier's list sorted the same way the UI sorts it, so
 * the derived numbers preserve the on-screen position when the admin
 * taps a reorder arrow.
 * @param {object} sponsor
 * @param {object[]} bucket  the tier's full sorted list
 */
function effectiveOrder(sponsor, bucket) {
  const direct = Number(sponsor?.order);
  if (Number.isFinite(direct)) return direct;
  const idx = Math.max(0, bucket.findIndex((s) => s.id === sponsor?.id));
  return (idx + 1) * 1000;
}

/** Lowercase tier string, or empty when unrecognized. */
function tierKey(sponsor) {
  const raw = typeof sponsor?.tier === "string" ? sponsor.tier.toLowerCase() : "";
  return TIER_ORDER.includes(raw) ? raw : "";
}

/**
 * Group sponsors into the four known tiers in display order, dropping
 * out-of-enum sponsors into the admin editor entirely (unlike the
 * attendee view which keeps an "Other" bucket). The admin should fix
 * the tier via the Edit modal rather than silently reorder a bogus one.
 */
function groupByTier(sponsors) {
  const buckets = new Map();
  for (const t of TIER_ORDER) buckets.set(t, []);
  for (const s of sponsors) {
    const key = tierKey(s);
    if (!key) continue;
    buckets.get(key).push(s);
  }
  const result = [];
  for (const t of TIER_ORDER) {
    const rows = buckets.get(t);
    if (!rows || rows.length === 0) continue;
    rows.sort(sortSponsors);
    result.push({ tier: t, sponsors: rows });
  }
  return result;
}

/**
 * Primary sort by `order` ascending (missing/invalid → Infinity so they
 * sink to the bottom of their tier), tiebreaking by `name` ascending.
 */
function sortSponsors(a, b) {
  const oa = Number(a?.order);
  const ob = Number(b?.order);
  const oaN = Number.isFinite(oa) ? oa : Infinity;
  const obN = Number.isFinite(ob) ? ob : Infinity;
  if (oaN !== obN) return oaN - obN;
  const na = typeof a?.name === "string" ? a.name : "";
  const nb = typeof b?.name === "string" ? b.name : "";
  return na.localeCompare(nb, undefined, { sensitivity: "base" });
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
