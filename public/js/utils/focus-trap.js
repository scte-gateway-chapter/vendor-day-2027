// utils/focus-trap.js — shared modal focus-trap helper.
//
// Extracted from the attendees-detail modal (Task 13) so the admin
// editors landing in Tasks 18-24 share the same trap behavior. The
// helper captures the previously-focused element on install, cycles
// Tab/Shift+Tab inside `container`, invokes `onEscape` on Escape, and
// returns an `uninstall()` that detaches listeners and restores focus
// to whatever had it when the trap went up.
//
// Deliberately minimal: no polling for focusable changes, no portal
// support. Callers that mutate the modal's DOM mid-render just re-query
// at the next Tab keypress — the handler walks the DOM each time.
"use strict";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Install a focus trap on `container`. Returns an `uninstall()` that
 * removes the keydown listener and restores focus to whatever was
 * focused when the trap was installed.
 *
 * @param {HTMLElement} container  The element containing the trap.
 *   Must be focusable itself (`tabindex="-1"` is fine) so the trap can
 *   fall back to it when the container contains no other focusable
 *   descendants (e.g. a bare "Loading…" state).
 * @param {object} [opts]
 * @param {() => void} [opts.onEscape]  Called when the user presses Escape.
 * @param {HTMLElement | (() => HTMLElement | null) | null} [opts.initialFocus]
 *   If provided (element or thunk), focus is moved to this element on
 *   install. Omitting leaves focus wherever it was — the caller may
 *   schedule its own `requestAnimationFrame` focus call instead.
 * @returns {() => void} uninstall
 */
export function installFocusTrap(container, opts = {}) {
  const { onEscape, initialFocus } = opts;

  const previousFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

  function onKeydown(ev) {
    if (ev.key === "Escape") {
      if (typeof onEscape === "function") {
        ev.preventDefault();
        onEscape();
      }
      return;
    }
    if (ev.key !== "Tab") return;
    const focusable = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter((el) => el.offsetParent !== null || el === container);
    if (focusable.length === 0) {
      ev.preventDefault();
      try { container.focus(); } catch (_err) { /* no-op */ }
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeEl = document.activeElement;
    if (ev.shiftKey) {
      if (activeEl === first || !container.contains(activeEl)) {
        ev.preventDefault();
        last.focus();
      }
    } else if (activeEl === last || !container.contains(activeEl)) {
      ev.preventDefault();
      first.focus();
    }
  }

  container.addEventListener("keydown", onKeydown);

  if (initialFocus != null) {
    const el = typeof initialFocus === "function" ? initialFocus() : initialFocus;
    if (el && typeof el.focus === "function") {
      try { el.focus(); } catch (_err) { /* no-op */ }
    }
  }

  return function uninstall() {
    container.removeEventListener("keydown", onKeydown);
    if (previousFocus && typeof previousFocus.focus === "function") {
      try { previousFocus.focus(); } catch (_err) { /* no-op */ }
    }
  };
}
