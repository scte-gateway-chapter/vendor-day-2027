// debug-overlay.js — floating on-device diagnostic panel.
//
// Mounted from app.js boot only when `isDebugEnabled()` is true. Shows
// BUILD_ID of the shipped service worker (so a stale shell is obvious),
// current /api/config shape (keys only — no values), OneSignal SDK state
// (optedIn, subscription id, permission), appSettings cache state, and
// a rolling feed of events emitted by the hook-site modules via
// `pushDebugLog`. Four actions let a field tester copy the overlay to
// clipboard, re-query state, unregister service workers, and reload.
//
// Not linked from anywhere in the UI. Discoverable only via `?debug=1`.
"use strict";

import {
  getDebugLog,
  subscribeToDebugLog,
  isDebugEnabled,
  setDebugEnabled,
  getDebugActivationSource,
  pushDebugLog,
} from "./debug-log.js";
import { getConfig } from "./firebase.js";
import { getAppSettings, isSignInEnabled, getAppSettingsCachedAt } from "./app-settings.js";

const STORAGE_KEY = "vendorday2027.debug";
const POLL_MS = 1000;
const MAX_EVENTS_SHOWN = 20;
const BUILD_ID_PATTERN = /const\s+BUILD_ID\s*=\s*"([^"]*)"/;

let mounted = false;

/**
 * Mount the overlay DOM, bind listeners, and start the state poll.
 * No-op when debug mode is disabled or when the overlay is already
 * mounted. Safe to call multiple times.
 */
export function mountDebugOverlay() {
  if (mounted) return;
  if (!isDebugEnabled()) return;
  mounted = true;

  // One-liner at the top of the feed so a field tester can tell at a
  // glance whether the overlay is here because of this page's URL or
  // because of a persisted flag (which is how the overlay reaches the
  // installed PWA on iOS — see debug-log.js for the storage story).
  const source = getDebugActivationSource();
  if (source === "localStorage") {
    pushDebugLog("overlay", "restored from localStorage");
  } else if (source === "url") {
    pushDebugLog("overlay", "activated via URL param");
  }

  const root = buildOverlayDom();
  document.body.appendChild(root);

  let collapsed = true;
  let pollTimer = null;
  let swBuildId = null;
  let swBuildIdFetchedAt = 0;

  const tab = root.querySelector("[data-tab]");
  const panel = root.querySelector("[data-panel]");
  const dismissBtn = root.querySelector("[data-action=dismiss]");
  const copyBtn = root.querySelector("[data-action=copy]");
  const recheckBtn = root.querySelector("[data-action=recheck]");
  const unregisterBtn = root.querySelector("[data-action=unregister]");
  const reloadBtn = root.querySelector("[data-action=reload]");

  function setCollapsed(next) {
    collapsed = Boolean(next);
    tab.hidden = !collapsed;
    panel.hidden = collapsed;
    tab.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (collapsed) {
      stopPolling();
      // Return keyboard focus to the tab so continued tab navigation
      // starts from the overlay again rather than from <body>.
      try { tab.focus(); } catch (_err) { /* ignore */ }
    } else {
      refreshState();
      startPolling();
      // Move focus into the panel so Esc (handled below) collapses it.
      try { panel.focus(); } catch (_err) { /* ignore */ }
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(refreshState, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function refreshState() {
    // The SW BUILD_ID lives in /sw.js. Fetch it once per minute at most
    // so the poll stays cheap while still catching a mid-session SW
    // update that didn't trigger our normal `sw-updated` message path.
    const now = Date.now();
    if (swBuildId === null || now - swBuildIdFetchedAt > 60_000) {
      swBuildIdFetchedAt = now;
      fetchSwBuildId()
        .then((id) => {
          swBuildId = id || "unknown";
          renderState(panel, swBuildId);
        })
        .catch(() => {
          swBuildId = "unknown";
          renderState(panel, swBuildId);
        });
    }
    renderState(panel, swBuildId || "loading…");
  }

  tab.addEventListener("click", () => setCollapsed(false));
  tab.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      setCollapsed(false);
    }
  });

  dismissBtn.addEventListener("click", () => {
    // Flip the stored flag off (the brief: dismiss button writes
    // `debug: 'off'`), tear down the overlay DOM, and stop polling.
    // `setDebugEnabled` writes to localStorage, so the next page load
    // (including from the installed PWA) stays dismissed.
    setDebugEnabled(false);
    stopPolling();
    root.remove();
    mounted = false;
  });

  copyBtn.addEventListener("click", async () => {
    const text = serializeOverlay(panel);
    const ok = await writeToClipboard(text);
    pushDebugLog(
      "debug",
      ok ? "copied overlay to clipboard" : "clipboard copy failed",
      ok ? null : "navigator.clipboard not available",
    );
  });

  recheckBtn.addEventListener("click", () => {
    refreshState();
    pushDebugLog("debug", "state re-checked");
  });

  unregisterBtn.addEventListener("click", async () => {
    const ok = window.confirm(
      "This will unregister the service worker. The app will reload. Continue?",
    );
    if (!ok) return;
    try {
      if (!("serviceWorker" in navigator)) {
        pushDebugLog("debug", "unregister failed", "navigator.serviceWorker unavailable");
        return;
      }
      const regs = await navigator.serviceWorker.getRegistrations();
      let count = 0;
      for (const reg of regs) {
        try {
          const unregistered = await reg.unregister();
          if (unregistered) count++;
        } catch (err) {
          pushDebugLog("debug", "unregister entry failed", String(err && err.message || err));
        }
      }
      pushDebugLog("debug", `unregistered ${count} service worker(s)`);
      window.alert(
        "Service worker(s) unregistered. For a full reset, clear site data in browser settings before reloading.",
      );
      window.location.reload();
    } catch (err) {
      pushDebugLog("debug", "unregister failed", String(err && err.message || err));
    }
  });

  reloadBtn.addEventListener("click", () => {
    pushDebugLog("debug", "reloading page");
    window.location.reload();
  });

  // Esc collapses the panel without dismissing the overlay. Scoped to
  // the overlay root so it doesn't swallow Esc elsewhere in the app.
  root.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !collapsed) {
      ev.stopPropagation();
      setCollapsed(true);
    }
  });

  subscribeToDebugLog(() => {
    // Live-refresh the events feed on every push, even when the panel
    // is collapsed — the badge count on the tab reflects the count.
    renderEvents(panel.querySelector("[data-events]"));
    updateTabBadge(tab);
  });

  renderState(panel, "loading…");
  updateTabBadge(tab);
  // Fire-and-forget initial SW BUILD_ID fetch so the first expand paints
  // something useful without waiting for the first poll tick.
  fetchSwBuildId()
    .then((id) => {
      swBuildId = id || "unknown";
      swBuildIdFetchedAt = Date.now();
      if (!collapsed) renderState(panel, swBuildId);
    })
    .catch(() => { /* non-fatal */ });
}

/* ---------------- DOM scaffolding ---------------- */

function buildOverlayDom() {
  const root = document.createElement("div");
  root.className = "debug-overlay";
  root.setAttribute("role", "complementary");
  root.setAttribute("aria-label", "Debug overlay");
  root.innerHTML = `
    <button
      type="button"
      class="debug-overlay__tab"
      data-tab
      aria-expanded="false"
      aria-controls="debug-overlay-panel"
    >
      <span aria-hidden="true">\u{1F41E}</span>
      <span class="debug-overlay__tab-label">DEBUG</span>
      <span class="debug-overlay__tab-badge" data-tab-badge hidden></span>
    </button>
    <section
      id="debug-overlay-panel"
      class="debug-overlay__panel"
      data-panel
      role="region"
      aria-label="Diagnostic details"
      hidden
      tabindex="-1"
    >
      <header class="debug-overlay__header">
        <h2 class="debug-overlay__title">Debug overlay</h2>
        <button
          type="button"
          class="debug-overlay__dismiss"
          data-action="dismiss"
          aria-label="Dismiss debug overlay"
          title="Dismiss"
        >\u00D7</button>
      </header>
      <div class="debug-overlay__sections" data-sections></div>
      <div class="debug-overlay__events-wrap">
        <h3 class="debug-overlay__section-title">Recent events</h3>
        <ol class="debug-overlay__events" data-events aria-live="polite"></ol>
      </div>
      <div class="debug-overlay__actions">
        <button type="button" class="btn-secondary debug-overlay__action" data-action="copy">Copy debug text</button>
        <button type="button" class="btn-secondary debug-overlay__action" data-action="recheck">Re-check state</button>
        <button type="button" class="btn-secondary debug-overlay__action" data-action="unregister">Unregister SW</button>
        <button type="button" class="btn-secondary debug-overlay__action" data-action="reload">Reload</button>
      </div>
    </section>
  `;
  return root;
}

/* ---------------- Rendering ---------------- */

function renderState(panel, swBuildId) {
  const sections = panel.querySelector("[data-sections]");
  if (!sections) return;
  const state = collectState(swBuildId);
  sections.innerHTML = "";
  sections.appendChild(buildSection("App version", state.appVersion));
  sections.appendChild(buildSection("Config endpoint", state.config));
  sections.appendChild(buildSection("OneSignal state", state.oneSignal));
  sections.appendChild(buildSection("App settings", state.appSettings));
  renderEvents(panel.querySelector("[data-events]"));
}

function buildSection(title, rows) {
  const el = document.createElement("section");
  el.className = "debug-overlay__section";
  const h = document.createElement("h3");
  h.className = "debug-overlay__section-title";
  h.textContent = title;
  const dl = document.createElement("dl");
  dl.className = "debug-overlay__kv";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.className = "debug-overlay__kv-label";
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.className = "debug-overlay__kv-value";
    dd.textContent = v;
    dl.append(dt, dd);
  }
  el.append(h, dl);
  return el;
}

function renderEvents(host) {
  if (!host) return;
  const entries = getDebugLog().slice(-MAX_EVENTS_SHOWN).reverse();
  host.innerHTML = "";
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "debug-overlay__event debug-overlay__event--empty";
    li.textContent = "no events yet";
    host.appendChild(li);
    return;
  }
  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "debug-overlay__event";
    const ts = document.createElement("span");
    ts.className = "debug-overlay__event-ts";
    ts.textContent = formatTime(entry.ts);
    const cat = document.createElement("span");
    cat.className = "debug-overlay__event-cat";
    cat.textContent = entry.category;
    const msg = document.createElement("span");
    msg.className = "debug-overlay__event-msg";
    msg.textContent = entry.message;
    li.append(ts, cat, msg);
    const preview = truncatedDataPreview(entry.data);
    if (preview) {
      const data = document.createElement("span");
      data.className = "debug-overlay__event-data";
      data.textContent = preview;
      li.appendChild(data);
    }
    host.appendChild(li);
  }
}

function updateTabBadge(tab) {
  const badge = tab.querySelector("[data-tab-badge]");
  if (!badge) return;
  const count = getDebugLog().length;
  if (count === 0) {
    badge.hidden = true;
    badge.textContent = "";
  } else {
    badge.hidden = false;
    badge.textContent = count > 99 ? "99+" : String(count);
  }
}

/* ---------------- State collection ---------------- */

function collectState(swBuildId) {
  return {
    appVersion: collectAppVersion(swBuildId),
    config: collectConfig(),
    oneSignal: collectOneSignal(),
    appSettings: collectAppSettings(),
  };
}

function collectAppVersion(swBuildId) {
  const rows = [];
  rows.push(["BUILD_ID (sw.js)", swBuildId || "unknown"]);
  let controller = "none";
  try {
    controller = navigator.serviceWorker?.controller?.scriptURL || "none";
  } catch (_err) { /* feature-detect */ }
  rows.push(["SW controller", controller]);
  let scope = "n/a";
  let readyState = "pending";
  // navigator.serviceWorker.ready is a promise; show whether a
  // registration is already available on the sync-visible side without
  // awaiting it in the state collector.
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
      // No await here — we read the cached registration if the SDK has
      // already settled it. For a live scope string we'd need to await.
      // The `ready` promise is awaited in the periodic poll below; the
      // row updates on the next refresh after it resolves.
    }
    if (window.__debugSwScope) scope = window.__debugSwScope;
    if (window.__debugSwReady) readyState = "ready";
  } catch (_err) { /* ignore */ }
  rows.push(["SW scope", scope]);
  rows.push(["SW ready", readyState]);
  let flag = "off";
  try {
    flag = localStorage.getItem(STORAGE_KEY) || "off";
  } catch (_err) { /* storage blocked */ }
  rows.push(["localStorage debug", flag]);
  return rows;
}

function collectConfig() {
  const rows = [];
  let config = null;
  try {
    config = getConfig();
  } catch (_err) {
    rows.push(["/api/config", "not loaded"]);
    return rows;
  }
  if (!config) {
    rows.push(["/api/config", "empty"]);
    return rows;
  }
  const keys = Object.keys(config).sort();
  rows.push(["/api/config", `keys: ${keys.join(", ")}`]);
  const osId = typeof config.oneSignalAppId === "string" ? config.oneSignalAppId : "";
  if (osId) {
    rows.push(["OneSignal App ID", `yes (…${osId.slice(-4)})`]);
  } else {
    rows.push(["OneSignal App ID", "no"]);
  }
  rows.push(["signInWebhookUrl", config.signInWebhookUrl ? "yes" : "no"]);
  return rows;
}

function collectOneSignal() {
  const rows = [];
  const ns = typeof window !== "undefined" ? window.OneSignal : undefined;
  rows.push(["OneSignal global", ns ? "yes" : "no"]);
  // v16: User.PushSubscription exposes { optedIn, id, token }. The
  // overlay never prints the full subscription id — a last-6 window
  // is enough for a human to confirm it changed across sessions.
  const sub = ns && ns.User && ns.User.PushSubscription;
  let optedIn = "n/a";
  let subId = "absent";
  if (sub) {
    try {
      optedIn = typeof sub.optedIn === "boolean" ? String(sub.optedIn) : "n/a";
    } catch (_err) { optedIn = "n/a"; }
    try {
      const id = typeof sub.id === "string" ? sub.id : "";
      subId = id ? `present (…${id.slice(-6)})` : "absent";
    } catch (_err) { subId = "n/a"; }
  }
  rows.push(["User.PushSubscription.optedIn", optedIn]);
  rows.push(["User.PushSubscription.id", subId]);
  // v16 exposes `OneSignal.Notifications.permission` as a boolean — see
  // the SDK reference. We report both that boolean AND the browser
  // Notification.permission string so a tester can tell when the two
  // diverge (classic symptom of a stale push token after a factory
  // reset of the device).
  let notifPerm = "n/a";
  try {
    const value = ns && ns.Notifications && ns.Notifications.permission;
    if (typeof value === "boolean") notifPerm = String(value);
  } catch (_err) { notifPerm = "n/a"; }
  rows.push(["OneSignal.Notifications.permission", notifPerm]);
  let browserPerm = "n/a";
  try {
    if (typeof Notification !== "undefined") browserPerm = Notification.permission;
  } catch (_err) { /* some iOS pre-install contexts throw */ }
  rows.push(["Notification.permission (browser)", browserPerm]);
  return rows;
}

function collectAppSettings() {
  const rows = [];
  const settings = (() => {
    try { return getAppSettings(); } catch (_err) { return null; }
  })();
  let signInFlag = "unknown";
  try {
    signInFlag = String(isSignInEnabled());
  } catch (_err) { /* ignore */ }
  rows.push(["signInEnabled", signInFlag]);
  rows.push(["cache state", settings ? "loaded" : "empty"]);
  let cachedAt = null;
  try {
    cachedAt = getAppSettingsCachedAt();
  } catch (_err) { /* older build without the accessor */ }
  if (cachedAt) {
    const ageSec = Math.max(0, Math.floor((Date.now() - cachedAt) / 1000));
    rows.push(["cache age", `${ageSec}s`]);
  } else {
    rows.push(["cache age", "n/a"]);
  }
  return rows;
}

/* ---------------- SW BUILD_ID fetch ---------------- */

async function fetchSwBuildId() {
  try {
    // `cache: "no-store"` so we read what Cloudflare is actually
    // serving today, not the copy the SW already pre-cached. If this
    // request itself hits the SW cache it still tells us the right
    // thing — the SW ships the same BUILD_ID constant as the shell it
    // was built for.
    const res = await fetch("/sw.js", { cache: "no-store" });
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(BUILD_ID_PATTERN);
    return m ? m[1] : null;
  } catch (_err) {
    return null;
  }
}

/* ---------------- Clipboard ---------------- */

async function writeToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_err) {
    // Fall through to the textarea-based fallback below.
  }
  // Fallback for browsers that block the async Clipboard API on PWAs
  // without a secure gesture. The <textarea>+execCommand path has been
  // supported everywhere this app runs for years.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return Boolean(ok);
  } catch (_err) {
    return false;
  }
}

function serializeOverlay(panel) {
  const lines = ["Vendor Day 2027 debug overlay", `copied: ${new Date().toISOString()}`, ""];
  const sections = panel.querySelectorAll(".debug-overlay__section");
  for (const sec of sections) {
    const title = sec.querySelector(".debug-overlay__section-title")?.textContent || "";
    lines.push(`## ${title}`);
    const labels = sec.querySelectorAll(".debug-overlay__kv-label");
    const values = sec.querySelectorAll(".debug-overlay__kv-value");
    for (let i = 0; i < labels.length; i++) {
      lines.push(`- ${labels[i].textContent}: ${values[i]?.textContent || ""}`);
    }
    lines.push("");
  }
  lines.push("## Recent events (newest first)");
  const entries = getDebugLog().slice(-MAX_EVENTS_SHOWN).reverse();
  if (entries.length === 0) {
    lines.push("- (none)");
  } else {
    for (const e of entries) {
      const preview = truncatedDataPreview(e.data);
      lines.push(`- [${formatTime(e.ts)}] ${e.category}: ${e.message}${preview ? ` ${preview}` : ""}`);
    }
  }
  return lines.join("\n");
}

/* ---------------- Formatting ---------------- */

function formatTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function truncatedDataPreview(data) {
  if (data === null || data === undefined) return "";
  let s;
  try {
    s = typeof data === "string" ? data : JSON.stringify(data);
  } catch (_err) {
    s = String(data);
  }
  if (!s) return "";
  const MAX = 120;
  return s.length > MAX ? `${s.slice(0, MAX)}\u2026` : s;
}

/* ---------------- SW readiness tracker ----------------
 * The overlay wants to show a definitive "SW ready" line without
 * awaiting navigator.serviceWorker.ready on every poll tick. We attach
 * one-shot listeners at module load that stash the resolved scope on
 * `window.__debugSw*` so collectAppVersion() can read it synchronously.
 * This is scoped behind the debug flag so there's no cost in production. */
if (typeof navigator !== "undefined" && "serviceWorker" in navigator && isDebugEnabled()) {
  try {
    navigator.serviceWorker.ready
      .then((reg) => {
        try {
          window.__debugSwReady = true;
          window.__debugSwScope = reg?.scope || "n/a";
        } catch (_err) { /* ignore */ }
      })
      .catch(() => { /* non-fatal */ });
  } catch (_err) { /* feature-detect */ }
}
