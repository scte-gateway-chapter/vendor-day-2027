// views/map.js — attendee Venue Map view (Task 11).
//
// Subscribes to `appSettings/singleton` via the 15-second poll from
// firebase.js and renders either the admin-uploaded venue map image
// (`venueMapUrl`) or the shipped SVG placeholder when the field is null
// or falsy. The caption below the image is `venueMapCaption` with a
// hard-coded fallback drawn from design section 4 so attendees still
// read a useful legend even before the board customizes the field.
//
// Zoom is implemented two ways so both touch and desktop work without
// a second input:
//   - Pinch-to-zoom via CSS `touch-action: pinch-zoom` on the image frame.
//   - Double-tap zoom via a `pointerdown`/`pointerup` pair that toggles
//     the image between 1x and 2x scale centered on the tap coordinates.
//   - Visible `+ / -` buttons that adjust zoom in 0.5 steps within [1, 4].
// All three paths funnel through a single `setZoom()` closure per render
// so button-disabled state and transform-origin stay in sync.
//
// Cleanup follows the Task 9/10 pattern: a module-level __cleanup slot
// stops the appSettings poll; the router.beforeEach hook (via
// registerViewCleanup in app.js) drains it before the next view mounts.
"use strict";

import { initFirestore, onSnapshot } from "../firebase.js";
import * as ui from "../ui.js";
import { registerViewCleanup } from "../app.js";

const PLACEHOLDER_IMG = "/assets/placeholders/venue-map-placeholder.svg";

// Legend fallback — mirrors design section 4 verbatim so attendees have the
// full key available even if the admin has not customized `venueMapCaption`.
const FALLBACK_CAPTION =
  "Doubletree Chesterfield Exhibit Hall \u2014 ~46 numbered vendor booths; " +
  "specialty stations along the north wall; Jeopardy / Cable Tec Games " +
  "center floor; Registration Table by the Main Doors; Coffee & Water in " +
  "the secondary room.";

// Zoom bounds + step. Module constants per spec; `__zoomLevel` is reset to 1
// on every mount, then adjusted by the +/- buttons and the double-tap toggle.
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.5;

// Double-tap detection window. Two pointerup events whose timestamps are
// closer than this count as a double tap.
const DOUBLE_TAP_MS = 300;
// A single tap is anything that lifts within this many ms of pointerdown
// and barely moved; anything longer is a hold/pan and resets the double-tap
// counter.
const TAP_HOLD_MAX_MS = 500;
// If the pointer moves more than this many CSS px between down and up, we
// treat it as a drag rather than a tap.
const TAP_MOVE_SLACK_PX = 10;

/** Module-level cleanup slot. Set at the end of each renderMap call. */
let __cleanup = null;
/** Module-level zoom level per spec; reset to 1 on each mount. */
let __zoomLevel = 1;

/**
 * Render the Venue Map view into `host`.
 * @param {HTMLElement} host  typically `#view-root`.
 * @returns {Promise<void>}
 */
export async function renderMap(host) {
  // Drain any prior render's handles so retries don't leave two pollers
  // running against the same view root.
  runCleanup();

  host.innerHTML = "";
  __zoomLevel = 1;

  const sticky = buildStickyHeader();
  const container = document.createElement("section");
  container.className = "map-view-container";
  container.setAttribute("aria-label", "Venue map");

  const caption = document.createElement("p");
  caption.className = "map-caption";

  host.append(sticky, container, caption);

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    ui.showOfflineBanner();
  }

  // /api/config is cached on the Firestore client so this is a no-op after
  // the first bootstrap. We still await it before the first poll so the
  // initial fetch doesn't race the config load.
  const configReady = initFirestore().catch((err) => {
    console.warn("[map] /api/config load failed:", err);
    return null;
  });

  // State: cachedSettings is the last successful appSettings snapshot
  // (null during the first load); lastErr is the most recent error.
  // lastRenderedKey tracks the last payload we actually painted so a poll
  // that returns identical content doesn't nuke the user's current zoom.
  /** @type {object | null} */
  let cachedSettings = null;
  /** @type {Error | null} */
  let lastErr = null;
  let sawFirstResult = false;
  let lastRenderedKey = null;

  renderSkeleton(container);
  caption.textContent = "";

  function rerender() {
    if (lastErr && !cachedSettings) {
      renderErrorNoCache(container, () => restartSubscription());
      caption.textContent = "";
      lastRenderedKey = null;
      return;
    }
    if (!sawFirstResult) {
      renderSkeleton(container);
      caption.textContent = "";
      lastRenderedKey = null;
      return;
    }
    const settings = cachedSettings || {};
    // Only repaint when the fields we read actually changed. This keeps the
    // user's zoom intact on a quiet 15-second refresh cycle while still
    // repainting the moment an admin publishes a new map or edits the
    // caption.
    const key = [
      typeof settings.venueMapUrl === "string" ? settings.venueMapUrl : "",
      typeof settings.venueMapCaption === "string" ? settings.venueMapCaption : "",
      lastErr ? "err" : "ok",
    ].join("|");
    if (key === lastRenderedKey) return;
    lastRenderedKey = key;
    __zoomLevel = 1;
    renderMapView(container, caption, settings, {
      hasError: Boolean(lastErr),
      onRetry: () => restartSubscription(),
    });
  }

  /** @type {(() => void) | null} */
  let unsub = null;
  // Fire the "could not load" toast only once per subscription lifetime so
  // a flaky connection doesn't stack a toast on every 15-second tick.
  let errorToasted = false;
  async function startSubscription() {
    try { await configReady; } catch (_err) { /* non-fatal */ }
    unsub = onSnapshot(
      "appSettings/singleton",
      (data, err) => {
        if (err) {
          console.warn("[map] poll failed:", err);
          lastErr = err;
          if (typeof navigator !== "undefined" && navigator.onLine === false) {
            ui.showOfflineBanner();
          } else if (!cachedSettings && !errorToasted) {
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
      { intervalMs: 15000 },
    );
  }

  function restartSubscription() {
    if (unsub) { unsub(); unsub = null; }
    lastErr = null;
    cachedSettings = null;
    sawFirstResult = false;
    errorToasted = false;
    lastRenderedKey = null;
    renderSkeleton(container);
    caption.textContent = "";
    startSubscription();
  }

  startSubscription();

  __cleanup = () => {
    if (unsub) { unsub(); unsub = null; }
  };
  registerViewCleanup(() => runCleanup());

  document.title = "Venue Map \u2014 Vendor Day 2027";
}

export default renderMap;

function runCleanup() {
  if (!__cleanup) return;
  try {
    __cleanup();
  } catch (err) {
    console.warn("[map] cleanup failed:", err);
  }
  __cleanup = null;
}

/* ---------------- Sticky secondary header ---------------- */

function buildStickyHeader() {
  const el = document.createElement("header");
  el.className = "view-sticky-header";
  el.setAttribute("role", "banner");
  el.innerHTML = `<h2 class="view-sticky-header__title">Venue Map</h2>`;
  return el;
}

/* ---------------- Rendering states ---------------- */

function renderSkeleton(host) {
  // Single large shimmer rectangle sized to the image aspect ratio so the
  // view's footprint doesn't jump between the loading state and the final
  // image render.
  host.innerHTML = `<div class="skeleton-card map-skeleton" aria-hidden="true"></div>`;
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

/**
 * Paint the full map view: an optional error strip, the image frame
 * (which contains the image, the +/- controls, and optionally the
 * watermark overlay for the placeholder path), and the caption text.
 */
function renderMapView(host, captionEl, settings, { hasError, onRetry }) {
  host.innerHTML = "";

  if (hasError) {
    const strip = document.createElement("div");
    strip.className = "status-error map-error-strip";
    strip.setAttribute("role", "status");
    strip.innerHTML = `
      <span>Couldn't refresh. Showing last-saved map.</span>
      <button type="button" class="btn-secondary" data-retry>Retry</button>
    `;
    strip.querySelector("[data-retry]").addEventListener("click", onRetry);
    host.appendChild(strip);
  }

  const uploadedUrl = typeof settings.venueMapUrl === "string" ? settings.venueMapUrl.trim() : "";
  const isPlaceholder = !uploadedUrl;
  const imgSrc = isPlaceholder ? PLACEHOLDER_IMG : uploadedUrl;

  const frame = document.createElement("div");
  frame.className = "map-image-frame";

  const img = document.createElement("img");
  img.className = "map-image";
  img.src = imgSrc;
  // For the uploaded map, give screen readers an informative description.
  // For the placeholder, alt="" so SRs rely on the visible watermark and
  // caption rather than reading the SVG as a venue map.
  img.alt = isPlaceholder
    ? ""
    : "Venue floor plan for the Doubletree Chesterfield Exhibit Hall";
  img.draggable = false;
  frame.appendChild(img);

  if (isPlaceholder) {
    const watermark = document.createElement("div");
    watermark.className = "map-watermark";
    watermark.textContent = "Final map will be posted before the event";
    frame.appendChild(watermark);
  }

  const controls = buildZoomControls();
  frame.appendChild(controls);

  // Single setZoom closure wires the +/-, double-tap, and initial-state
  // paths together so the disabled state on the buttons and the
  // transform-origin always reflect __zoomLevel.
  const { inBtn, outBtn } = controls;

  function syncButtons() {
    inBtn.disabled = __zoomLevel >= ZOOM_MAX - 1e-6;
    outBtn.disabled = __zoomLevel <= ZOOM_MIN + 1e-6;
  }

  function setZoom(next, originClientX, originClientY) {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(next)));
    // Round to one decimal so successive +0.5 clicks don't drift.
    __zoomLevel = Math.round(clamped * 10) / 10;
    if (__zoomLevel <= ZOOM_MIN + 1e-6) {
      img.style.transformOrigin = "center center";
    } else if (originClientX != null && originClientY != null) {
      const rect = img.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const ox = clamp01(((originClientX - rect.left) / rect.width) * 100);
        const oy = clamp01(((originClientY - rect.top) / rect.height) * 100);
        img.style.transformOrigin = `${ox}% ${oy}%`;
      }
    }
    img.style.transform = `scale(${__zoomLevel})`;
    syncButtons();
  }

  inBtn.addEventListener("click", () => setZoom(__zoomLevel + ZOOM_STEP));
  outBtn.addEventListener("click", () => setZoom(__zoomLevel - ZOOM_STEP));

  wireDoubleTapZoom(frame, (clientX, clientY) => {
    // Double-tap toggles between 1x and 2x per spec.
    if (__zoomLevel <= ZOOM_MIN + 1e-6) {
      setZoom(2, clientX, clientY);
    } else {
      setZoom(1);
    }
  });

  // Initial paint: ensure buttons reflect the reset-to-1 state.
  setZoom(1);

  host.appendChild(frame);

  const captionText =
    typeof settings.venueMapCaption === "string" && settings.venueMapCaption.trim()
      ? settings.venueMapCaption.trim()
      : FALLBACK_CAPTION;
  captionEl.textContent = captionText;
}

/* ---------------- Zoom controls ---------------- */

/**
 * Build the top-right +/- zoom-control pair. Returns the wrapper plus
 * references to the two buttons so the caller can wire click handlers
 * and keep their `disabled` state in sync with __zoomLevel.
 */
function buildZoomControls() {
  const wrap = document.createElement("div");
  wrap.className = "map-zoom-controls";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Zoom controls");

  const inBtn = document.createElement("button");
  inBtn.type = "button";
  inBtn.className = "map-zoom-button";
  inBtn.setAttribute("aria-label", "Zoom in");
  inBtn.textContent = "+";

  const outBtn = document.createElement("button");
  outBtn.type = "button";
  outBtn.className = "map-zoom-button";
  outBtn.setAttribute("aria-label", "Zoom out");
  // Minus sign (U+2212) reads better than a hyphen in button type scale.
  outBtn.textContent = "\u2212";

  wrap.append(outBtn, inBtn);
  // Expose the buttons on the wrapper so the renderMapView closure can
  // reach them without a second query.
  wrap.inBtn = inBtn;
  wrap.outBtn = outBtn;
  return wrap;
}

/* ---------------- Double-tap detection ---------------- */

/**
 * Fire `onDoubleTap(clientX, clientY)` on a double-tap gesture inside
 * `frame`. A tap is a pointerdown/pointerup pair that lifted within
 * TAP_HOLD_MAX_MS and barely moved; a double tap is two such taps whose
 * pointerup timestamps are within DOUBLE_TAP_MS. The event handlers
 * attach to the frame rather than the image so the gesture still fires
 * on taps that land on the watermark overlay (which uses pointer-events:
 * none anyway) or in the control gutter around the image.
 */
function wireDoubleTapZoom(frame, onDoubleTap) {
  let downTime = 0;
  let downX = 0;
  let downY = 0;
  let lastTapTime = 0;

  const onDown = (ev) => {
    downTime = Date.now();
    downX = ev.clientX;
    downY = ev.clientY;
  };

  const onUp = (ev) => {
    // Reject taps that originate inside the +/- control panel so clicking
    // a zoom button doesn't accidentally arm the double-tap counter.
    const target = ev.target;
    if (target && typeof target.closest === "function" && target.closest(".map-zoom-controls")) {
      lastTapTime = 0;
      return;
    }
    const now = Date.now();
    const dx = Math.abs(ev.clientX - downX);
    const dy = Math.abs(ev.clientY - downY);
    const held = now - downTime;
    if (dx > TAP_MOVE_SLACK_PX || dy > TAP_MOVE_SLACK_PX || held > TAP_HOLD_MAX_MS) {
      lastTapTime = 0;
      return;
    }
    const gap = now - lastTapTime;
    if (lastTapTime > 0 && gap > 0 && gap < DOUBLE_TAP_MS) {
      onDoubleTap(ev.clientX, ev.clientY);
      lastTapTime = 0;
    } else {
      lastTapTime = now;
    }
  };

  frame.addEventListener("pointerdown", onDown);
  frame.addEventListener("pointerup", onUp);
}

/* ---------------- Small helpers ---------------- */

function clamp01(n) {
  if (Number.isNaN(n)) return 50;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}
