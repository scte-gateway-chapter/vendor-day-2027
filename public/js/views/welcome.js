// views/welcome.js — first-run Welcome / Install view (Task 7).
//
// Rendered at `#/` only when the attendee has not dismissed Welcome and is
// not already running the installed PWA. app.js owns both checks and the
// localStorage flag; this view's job is to paint the hero + install card
// and surface the right CTA for the platform.
//
// Push consent is NOT prompted here (deferred to Announcements per
// Requirement 2.1). OneSignal is NOT loaded here either (Task 12/25).
"use strict";

import { initFirestore, getDoc } from "../firebase.js";
import { loadAppSettings, isSignInEnabled } from "../app-settings.js";
import * as router from "../router.js";
import { getLastSignIn } from "./signin.js";

/** Hard-coded fallbacks when `appSettings/singleton` is unreachable. */
const FALLBACK_EVENT_TITLE = "SCTE Gateway Chapter Vendor Day 2027";
const FALLBACK_VENUE = "Doubletree Chesterfield, Chesterfield, MO 63005";

/**
 * Render the Welcome / Install view into `host`.
 *
 * If `display-mode: standalone` is detected on mount we treat it as a
 * belt-and-suspenders check and navigate to Home instead of rendering —
 * app.js already short-circuits this path, so under normal flow we never
 * hit the bailout here.
 *
 * @param {HTMLElement} host  typically `#view-root` (via `ui.showView`).
 * @param {{ onDismiss?: () => void }} [opts]
 *   `onDismiss` is invoked when the user taps "I'll do this later". The
 *   caller owns persisting the dismiss flag + routing to Home.
 * @returns {Promise<void>}
 */
export async function renderWelcome(host, opts = {}) {
  const { onDismiss } = opts;

  if (isStandalone()) {
    router.navigate("/home");
    return;
  }

  // Prime the shared appSettings cache so `isSignInEnabled()` is accurate
  // when we decide whether to render the Sign-In CTA below. The call is
  // cached across the session; this is a no-op after app.js's bootstrap
  // prime has resolved.
  try { await loadAppSettings(); } catch (_err) { /* fail-closed */ }

  host.innerHTML = "";

  const heroCard = document.createElement("section");
  heroCard.className = "card welcome-hero";
  heroCard.setAttribute("aria-live", "polite");
  heroCard.innerHTML = `
    <img
      class="welcome-hero__logo"
      src="/assets/brand/gateway-logo.svg"
      alt=""
      aria-hidden="true"
    />
    <div class="welcome-hero__text" data-event-info>
      <h2 class="welcome-hero__title">${escapeHtml(FALLBACK_EVENT_TITLE)}</h2>
      <p class="welcome-hero__venue">${escapeHtml(FALLBACK_VENUE)}</p>
    </div>
  `;
  host.append(heroCard);

  // Sign-In CTA sits between the hero and the install card so it reads as
  // a secondary action beneath the headline without competing with the
  // install prompt for the primary click. If the attendee has already
  // signed in on this device, it swaps to the shared `.signin-indicator`
  // treatment that mirrors the Home card. Both renderings are gated
  // behind the admin `signInEnabled` toggle so the CTA stays invisible
  // until the board opens sign-in close to event start.
  if (isSignInEnabled()) {
    host.append(buildWelcomeSignInCta());
  }

  const installCard = document.createElement("section");
  installCard.className = "card welcome-install-card";
  renderInstallCardBody(installCard);
  host.append(installCard);

  const footer = document.createElement("div");
  footer.className = "welcome-footer";
  footer.innerHTML = `
    <a class="welcome-later-link" href="#/home" data-later>I'll do this later</a>
    <p class="welcome-help">
      You can revisit install instructions anytime from the More tab \u2192 About &amp; Install.
    </p>
  `;
  host.append(footer);

  // Intercept normal left-click so we can run onDismiss; preserve default
  // anchor behavior for middle-click / ctrl-click / right-click so "open in
  // new tab" still works as it would for any other link.
  footer.querySelector("[data-later]").addEventListener("click", (ev) => {
    if (ev.defaultPrevented) return;
    if (ev.button !== 0) return;
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    if (typeof onDismiss === "function") onDismiss();
    else router.navigate("/home");
  });

  // Hero text fills in from Firestore when the config + doc arrive. On any
  // failure the hard-coded fallback above stays visible so Welcome never
  // renders blank.
  updateHeroFromFirestore(heroCard).catch((err) =>
    console.warn("[welcome] appSettings read failed:", err),
  );

  document.title = "Welcome \u2014 Vendor Day 2027";
}

export default renderWelcome;

/* ---------------- helpers ---------------- */

/**
 * Build the Sign-In CTA that sits below the hero. Two states, both
 * reach `#/sign-in` on activation:
 *   - Not signed in: a large outlined "Sign in for today" card that reads
 *     as a secondary CTA next to the install card's primary button.
 *   - Signed in: the shared `.signin-indicator` block with the attendee's
 *     name so the "already signed in" state is unmistakable at arm's
 *     length. The block stays interactive so the user can reach the view
 *     and reset.
 */
function buildWelcomeSignInCta() {
  const signedIn = getLastSignIn();

  if (signedIn) {
    const el = document.createElement("a");
    el.className = "signin-indicator welcome-signin-indicator";
    el.href = "#/sign-in";
    el.setAttribute(
      "aria-label",
      `You're signed in as ${signedIn.name}. Open sign-in view to update.`,
    );
    el.innerHTML = `
      <span class="signin-indicator__icon" aria-hidden="true">\u2713</span>
      <span class="signin-indicator__text">
        <span class="signin-indicator__primary">You're signed in</span>
        <span class="signin-indicator__name">as ${escapeHtml(signedIn.name)}</span>
        <span class="signin-indicator__hint">Tap to update</span>
      </span>
    `;
    return el;
  }

  const el = document.createElement("a");
  el.className = "welcome-signin-cta";
  el.href = "#/sign-in";
  el.innerHTML = `
    <span class="welcome-signin-cta__text">
      <span class="welcome-signin-cta__title">Sign in for today</span>
      <span class="welcome-signin-cta__hint">Record your attendance in the chapter's sign-in sheet.</span>
    </span>
    <span class="welcome-signin-cta__chevron" aria-hidden="true">\u203A</span>
  `;
  return el;
}

function isStandalone() {
  return (
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true
  );
}

/**
 * Classify the current browser just enough to pick the right install card.
 * iOS Safari is detected by UA + the absence of CriOS/FxiOS/EdgiOS tokens
 * (which indicate iOS Chrome / Firefox / Edge, where Add-to-Home-Screen is
 * not available). Android install-capability is inferred from the deferred
 * `beforeinstallprompt` event stashed by app.js on boot.
 */
function detectPlatform() {
  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isIOSSafari =
    isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  const hasInstallPrompt = !!window.__deferredInstallPrompt;
  return { isIOS, isIOSSafari, hasInstallPrompt };
}

async function updateHeroFromFirestore(heroCard) {
  await initFirestore();
  const settings = await getDoc("appSettings/singleton");
  if (!settings) return;
  const target = heroCard.querySelector("[data-event-info]");
  if (!target) return;
  const title = settings.eventTitle || FALLBACK_EVENT_TITLE;
  const place =
    [settings.venueName, settings.venueAddress].filter(Boolean).join(", ") ||
    FALLBACK_VENUE;
  target.innerHTML = `
    <h2 class="welcome-hero__title">${escapeHtml(title)}</h2>
    <p class="welcome-hero__venue">${escapeHtml(place)}</p>
  `;
}

function renderInstallCardBody(card) {
  const { isIOSSafari, hasInstallPrompt } = detectPlatform();

  if (isIOSSafari) {
    card.innerHTML = `
      <h2>Install this app on your iPhone</h2>
      <p>Add Vendor Day 2027 to your home screen so the app launches full-screen and push notifications can reach you.</p>
      ${iosInstallStepsSvg()}
      <p class="welcome-note">Push notifications on iOS require iOS 16.4 or later and the installed home-screen app.</p>
    `;
    return;
  }

  if (hasInstallPrompt) {
    card.innerHTML = `
      <h2>Install the Vendor Day app</h2>
      <p>Add Vendor Day 2027 to your home screen so the app launches full-screen and push notifications can reach you.</p>
      <button type="button" class="btn-primary welcome-install-button" data-install>Install app</button>
      <p class="welcome-note" data-install-status aria-live="polite"></p>
    `;

    const button = card.querySelector("[data-install]");
    const status = card.querySelector("[data-install-status]");
    button.addEventListener("click", async () => {
      const prompt = window.__deferredInstallPrompt;
      if (!prompt || typeof prompt.prompt !== "function") {
        status.textContent =
          "The install prompt is no longer available. Try reopening this page.";
        return;
      }
      button.disabled = true;
      try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        if (choice && choice.outcome === "accepted") {
          // Browser hid the native prompt and will transition to standalone;
          // remove the card so the user isn't nagged.
          card.remove();
          window.__deferredInstallPrompt = null;
        } else {
          status.textContent =
            "No worries \u2014 you can install later from the More tab.";
          button.disabled = false;
        }
      } catch (err) {
        console.warn("[welcome] install prompt failed:", err);
        status.textContent =
          "Install was interrupted. You can try again or install later from the More tab.";
        button.disabled = false;
      }
    });
    return;
  }

  // Fallback: desktop browsers, iOS Chrome/Firefox, desktop Firefox, etc.
  card.innerHTML = `
    <h2>Continue in your browser</h2>
    <p>Push notifications aren't available in this browser, but the rest of the app works. Continue below.</p>
  `;
}

/**
 * Inline SVG illustration of the three-step iOS Add-to-Home-Screen flow.
 * The visible text labels inside the SVG are read naturally by screen
 * readers; the outer `aria-label` provides a one-line summary for AT that
 * announces the figure before diving into its children.
 */
function iosInstallStepsSvg() {
  return `
    <svg
      class="install-steps-svg"
      viewBox="0 0 320 360"
      width="100%"
      role="img"
      aria-label="Three steps to install on iOS Safari: tap the Share button at the bottom of Safari, scroll in the share sheet and tap Add to Home Screen, then tap Add in the top-right of the dialog."
      xmlns="http://www.w3.org/2000/svg"
    >
      <!-- Step 1 -->
      <g>
        <rect x="4" y="4" width="312" height="104" rx="8" ry="8"
          fill="#FFFFFF" stroke="#CCC" stroke-width="1"/>
        <circle cx="32" cy="56" r="18" fill="#2E8B57"/>
        <text x="32" y="62" font-family="Roboto, Arial, sans-serif" font-size="18"
          font-weight="700" fill="#FFFFFF" text-anchor="middle">1</text>
        <!-- Share icon: upward arrow leaving a box -->
        <g transform="translate(70, 30)">
          <rect x="4" y="18" width="36" height="30" rx="4" ry="4"
            fill="none" stroke="#1F6B40" stroke-width="2.5"/>
          <line x1="22" y1="4" x2="22" y2="28"
            stroke="#1F6B40" stroke-width="2.5" stroke-linecap="round"/>
          <polyline points="14,12 22,4 30,12"
            fill="none" stroke="#1F6B40" stroke-width="2.5"
            stroke-linecap="round" stroke-linejoin="round"/>
        </g>
        <text x="128" y="54" font-family="Roboto, Arial, sans-serif" font-size="15"
          fill="#222">Tap the Share button</text>
        <text x="128" y="76" font-family="Roboto, Arial, sans-serif" font-size="13"
          fill="#555">at the bottom of Safari.</text>
      </g>

      <!-- Step 2 -->
      <g>
        <rect x="4" y="124" width="312" height="104" rx="8" ry="8"
          fill="#FFFFFF" stroke="#CCC" stroke-width="1"/>
        <circle cx="32" cy="176" r="18" fill="#2E8B57"/>
        <text x="32" y="182" font-family="Roboto, Arial, sans-serif" font-size="18"
          font-weight="700" fill="#FFFFFF" text-anchor="middle">2</text>
        <!-- Share-sheet rows icon -->
        <g transform="translate(70, 150)">
          <rect x="4" y="4" width="36" height="48" rx="4" ry="4"
            fill="none" stroke="#1F6B40" stroke-width="2.5"/>
          <line x1="10" y1="18" x2="34" y2="18"
            stroke="#1F6B40" stroke-width="2"/>
          <line x1="10" y1="28" x2="34" y2="28"
            stroke="#1F6B40" stroke-width="2"/>
          <line x1="10" y1="38" x2="34" y2="38"
            stroke="#1F6B40" stroke-width="2"/>
        </g>
        <text x="128" y="170" font-family="Roboto, Arial, sans-serif" font-size="15"
          fill="#222">Scroll in the share sheet</text>
        <text x="128" y="192" font-family="Roboto, Arial, sans-serif" font-size="13"
          fill="#555">and tap Add to Home Screen.</text>
      </g>

      <!-- Step 3 -->
      <g>
        <rect x="4" y="244" width="312" height="104" rx="8" ry="8"
          fill="#FFFFFF" stroke="#CCC" stroke-width="1"/>
        <circle cx="32" cy="296" r="18" fill="#2E8B57"/>
        <text x="32" y="302" font-family="Roboto, Arial, sans-serif" font-size="18"
          font-weight="700" fill="#FFFFFF" text-anchor="middle">3</text>
        <!-- Plus-in-box icon -->
        <g transform="translate(70, 270)">
          <rect x="4" y="4" width="40" height="40" rx="6" ry="6"
            fill="none" stroke="#1F6B40" stroke-width="2.5"/>
          <line x1="24" y1="14" x2="24" y2="34"
            stroke="#1F6B40" stroke-width="2.5" stroke-linecap="round"/>
          <line x1="14" y1="24" x2="34" y2="24"
            stroke="#1F6B40" stroke-width="2.5" stroke-linecap="round"/>
        </g>
        <text x="128" y="290" font-family="Roboto, Arial, sans-serif" font-size="15"
          fill="#222">Tap Add</text>
        <text x="128" y="312" font-family="Roboto, Arial, sans-serif" font-size="13"
          fill="#555">in the top-right of the dialog.</text>
      </g>
    </svg>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
