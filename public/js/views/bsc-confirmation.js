// views/bsc-confirmation.js — terminal BSC check-in confirmation screen.
//
// Rendered after `finalize(draft)` resolves (even partially — if ONE
// leg succeeded we still land here, with the `.bsc-leg-failure-banner`
// surfacing which leg failed so a BSC coordinator can reconcile).
"use strict";

import * as router from "../router.js";

/**
 * @param {HTMLElement} host
 * @param {{ draft: object, legFailure: "sheet" | "firestore" | null }} opts
 */
export function renderBscConfirmation(host, { draft, legFailure }) {
  host.innerHTML = "";
  document.title = "BSC Check-In Complete \u2014 Vendor Day 2027";

  if (legFailure === "sheet" || legFailure === "firestore") {
    const banner = document.createElement("div");
    banner.className = "bsc-leg-failure-banner";
    banner.setAttribute("role", "status");
    banner.textContent = legFailure === "sheet"
      ? "We recorded your check-in but could not sync with the registration sheet. Please notify a BSC coordinator."
      : "We submitted your check-in to the registration sheet but could not record it in the admin dashboard. Please notify a BSC coordinator.";
    host.append(banner);
  }

  const card = document.createElement("section");
  card.className = "card bsc-confirmation";
  card.setAttribute("aria-live", "polite");

  const title = document.createElement("h2");
  title.className = "bsc-confirmation__title";
  title.textContent = "You're checked in for the Broadband Skills Challenge";
  card.append(title);

  const name = document.createElement("p");
  name.className = "bsc-confirmation__name";
  name.textContent = draft.attendee_name || "";
  card.append(name);

  const badges = document.createElement("p");
  badges.className = "bsc-confirmation__badges";

  const entryChip = document.createElement("span");
  if (draft.entry_type === "pre-registered") {
    entryChip.className = "admin-bsc-chip admin-bsc-chip--pre-registered bsc-confirmation__chip";
    entryChip.textContent = "\u2713 Pre-registered";
  } else {
    entryChip.className = "admin-bsc-chip admin-bsc-chip--walk-up bsc-confirmation__chip";
    entryChip.textContent = "Walk-up";
  }
  badges.append(entryChip, document.createTextNode(" "));

  const waiverChip = document.createElement("span");
  if (draft.waiver_mode === "electronic") {
    waiverChip.className = "admin-bsc-chip admin-bsc-chip--electronic bsc-confirmation__chip";
    waiverChip.textContent = "Electronic waiver";
  } else {
    waiverChip.className = "admin-bsc-chip admin-bsc-chip--paper bsc-confirmation__chip";
    waiverChip.textContent = "Paper waiver";
  }
  badges.append(waiverChip);

  card.append(badges);

  if (draft.reference_id) {
    const ref = document.createElement("p");
    ref.className = "bsc-confirmation__ref";
    ref.innerHTML = `Reference: <code>${escapeHtml(draft.reference_id)}</code>`;
    card.append(ref);
  }

  if (draft.waiver_mode === "paper") {
    const reminder = document.createElement("p");
    reminder.className = "bsc-confirmation__reminder";
    reminder.textContent = "Please sign the paper waiver at the competition table before competing.";
    card.append(reminder);
  }

  const actions = document.createElement("div");
  actions.className = "signin-form__actions bsc-confirmation__actions";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-secondary";
  btn.textContent = "Back to Home";
  btn.addEventListener("click", () => router.navigate("/home"));
  actions.append(btn);
  card.append(actions);

  host.append(card);
}

export default renderBscConfirmation;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
