# Requirements — SCTE Gateway Chapter Vendor Day 2027 PWA

## Introduction

This spec describes a Progressive Web App (PWA) for the SCTE Gateway Chapter Vendor Day, targeted for the mid-May to early June 2027 event window (exact date still TBD). The venue is locked as the **Doubletree Chesterfield in Chesterfield, MO 63005**. The audience is attendees and vendors of the show — primarily on phones, with a smaller share on laptops at the registration table and on the admin side. The app is installable to the home screen on iOS and Android so it can receive push notifications and feel like a native event app, but it ships as a web experience first — no app store presence. Distribution is a QR code printed on event emails and placed at the check-in table.

Version 1 ships with placeholder content for every section. Real agenda, sponsor, venue, and attendee data will replace the placeholders through the in-app admin interface as it becomes available. The Gateway Chapter board is the owner and the editorial voice. Three or so named board members will share admin credentials to post updates and send announcements before and during the event.

The app's year is baked in — 2027. Each future year gets a fresh deployment under its own subdomain, so no multi-year navigation is in scope.

## Requirements

### Requirement 1 — QR Landing & First-Run Onboarding

**User Story:** As an attendee arriving at the Vendor Day, I want scanning the QR code to drop me straight into the event app and walk me through installing it to my home screen, so that I can get to the agenda quickly and still receive push updates during the day.

#### Acceptance Criteria

1. WHEN a user opens the app URL (`2027vendorday.gatewayscte.org`) for the first time THEN the system SHALL display a short welcome screen that identifies the event, the date, and the Gateway Chapter board as the host.
2. WHEN a user is on the welcome screen on a mobile browser THEN the system SHALL show platform-appropriate install instructions (Add to Home Screen on iOS Safari, Install App on Android Chrome) with visual guidance.
3. IF the user is on iOS Safari AND has not installed the app THEN the system SHALL explain that push notifications require installing the app to the home screen first.
4. WHEN the user has launched the app from the installed home-screen icon THEN the system SHALL skip the install prompt and go directly to the home view.
5. WHEN the user dismisses the install prompt without installing THEN the system SHALL still allow full use of the app and SHALL make the install instructions reachable from a settings or "about" entry point for later.
6. WHEN the user is on a browser that does not support PWA installation (e.g., older iOS, desktop Firefox) THEN the system SHALL show a non-blocking notice that the app can still be used in the browser without push notifications.
7. WHEN the user lands on the app THEN the system SHALL render first meaningful content within 3 seconds on a typical mid-range phone on event-venue cellular.

### Requirement 2 — Push Notification Subscription

**User Story:** As an attendee, I want to opt in to push notifications once, so that I get alerted to room changes, schedule shifts, and announcements without having to keep the app open.

#### Acceptance Criteria

1. WHEN the user first navigates to the Announcements view THEN the system SHALL present a clear opt-in explaining what push notifications will be used for (schedule changes, room changes, announcements) and what they will not be used for (marketing, non-event messages). The push opt-in SHALL NOT be presented during install onboarding.
2. WHEN the user accepts the opt-in THEN the system SHALL trigger the browser-level permission prompt and register the device with the push service.
3. IF the user is on iOS AND has not installed the app to the home screen THEN the system SHALL NOT present the push opt-in and SHALL explain that push on iOS requires the installed app (iOS 16.4 or later).
4. WHEN the user declines or dismisses the push opt-in THEN the system SHALL continue to function fully and SHALL expose a "Enable notifications" control somewhere persistent (e.g., Announcements screen or settings) that re-prompts.
5. WHEN the user later revokes notification permission at the OS level THEN the system SHALL detect the revoked state on next open and surface a non-intrusive reminder that notifications are off.
6. WHEN a push subscription is created THEN the system SHALL store only what the push service requires to deliver notifications and SHALL NOT associate the subscription with a user identity in the app.

### Requirement 3 — Agenda

**User Story:** As an attendee, I want to see the day's agenda on my phone with session titles, times, speakers, and rooms, so that I can plan where to be and know where to go next.

#### Acceptance Criteria

1. WHEN the user opens the Agenda view THEN the system SHALL display the event schedule in chronological order, grouped visibly by time slot.
2. WHEN a session has a defined speaker, description, or room THEN the system SHALL display those fields with the session.
3. WHEN the user taps a session THEN the system SHALL show the full session detail (description, speaker bio if present, room, start/end time).
4. WHEN the agenda has been updated by an admin THEN the system SHALL show the current version to any user who opens the app or returns from background within 30 seconds, without requiring a hard reload.
5. IF the agenda data has not been published yet THEN the system SHALL display a placeholder state that reads as intentional ("Agenda coming soon — check back closer to the event") rather than an empty list or error.
6. WHEN the user is offline AND has previously loaded the Agenda view THEN the system SHALL display the last-cached agenda with a visible "offline" indicator.

### Requirement 4 — Sponsor Directory

**User Story:** As an attendee, I want to browse the sponsors supporting the Vendor Day, so that I know who's exhibiting and can decide whom to visit on the floor.

#### Acceptance Criteria

1. WHEN the user opens the Sponsor Directory THEN the system SHALL display a list of sponsors with company name and logo (or a logo placeholder if none provided).
2. WHEN sponsors are grouped by tier (e.g., Platinum, Gold, Silver) in the data THEN the system SHALL display them grouped by tier, with higher tiers shown first.
3. WHEN the user taps a sponsor THEN the system SHALL show the sponsor's detail view with a short description, website link, booth location (if provided), and contact information (if provided).
4. WHEN a sponsor's website link is tapped THEN the system SHALL open the link in the device's default browser or in an in-app browser view, not replace the PWA.
5. IF no sponsor content has been loaded yet THEN the system SHALL show a placeholder state communicating that sponsors will be listed as the event approaches.

### Requirement 5 — Venue Map

**User Story:** As an attendee, I want to see a venue floor plan so that I can find rooms, exhibitor booths, and amenities without wandering.

#### Acceptance Criteria

1. WHEN the user opens the Venue Map view THEN the system SHALL display a static venue image (sourced from a PDF floor plan) sized to fit the device viewport.
2. WHEN the user pinches or double-taps the map image THEN the system SHALL support zoom and pan so attendees can read labels.
3. WHEN the map includes a legend or booth key THEN the system SHALL display it either on the same screen or in a clearly linked companion view.
4. IF a final venue map is not yet available THEN the system SHALL display a placeholder image that reads as intentional, with a note that the final map will be posted before the event.
5. WHEN the user is offline AND has previously viewed the map THEN the system SHALL serve the cached map image.

### Requirement 6 — Announcements Feed & Push Delivery

**User Story:** As an attendee, I want a running feed of event announcements inside the app and matching push notifications on my phone, so that I never have to ask whether I missed something.

#### Acceptance Criteria

1. WHEN an admin posts an announcement THEN the system SHALL add that announcement to the in-app Announcements feed with timestamp and author attribution (board role, not personal identity if preferred).
2. WHEN an admin posts an announcement AND chooses to send a push THEN the system SHALL send a push notification containing the announcement title and a short preview to every subscribed device.
3. WHEN the user taps the push notification THEN the system SHALL open the app directly to the matching announcement in the feed.
4. WHEN the user opens the Announcements view THEN the system SHALL show announcements in reverse chronological order (newest first).
5. WHEN the user has unread announcements since their last visit to the feed THEN the system SHALL display an unread indicator (e.g., a badge dot on the Announcements tab).
6. IF an announcement is deleted or edited by an admin THEN the system SHALL reflect the current state in the in-app feed; previously delivered push notifications do not need to be recalled.
7. WHEN the user is offline THEN the system SHALL show the last-cached list of announcements and SHALL display new announcements once connectivity returns.

### Requirement 7 — Attendee Directory

**User Story:** As an attendee, I want to see who else is attending the Vendor Day, so that I can look for familiar names, spot people I want to meet, and get a feel for the room.

#### Acceptance Criteria

1. WHEN the user opens the Attendee Directory THEN the system SHALL display a scrollable, searchable list of attendees.
2. WHEN the directory list is shown THEN the system SHALL display name, company, and title for each attendee. Title is optional and SHALL be omitted from display when absent in the source data.
3. WHEN the user types in the directory's search field THEN the system SHALL filter the list by name and company as the user types.
4. WHEN the directory is tapped on an entry THEN the system SHALL open a lightweight detail view with the attendee's listed fields. The system SHALL NOT provide any messaging, friending, QR-exchange, or peer-to-peer contact mechanism.
5. IF an attendee has requested not to be listed THEN the system SHALL omit that attendee from the directory.
6. IF the final attendee list is not yet available THEN the system SHALL display a placeholder state communicating that the directory will populate as registrations finalize.
7. WHEN the directory is populated THEN the system SHALL source attendee records from a Google Sheet maintained by the registration process. The specific ingest mechanism (admin CSV upload, published-to-web URL read, or Google Apps Script endpoint) SHALL be chosen in the design phase.

### Requirement 8 — Session Feedback & Surveys

**User Story:** As an attendee, I want to leave quick feedback on sessions and the event overall, so that the Gateway Chapter board can make next year's show better.

#### Acceptance Criteria

1. WHEN the event is in-progress or has concluded AND the admin has enabled feedback THEN the system SHALL expose a single, event-wide "Leave feedback" entry point as a top-level view. Per-session feedback is explicitly out of scope for v1.
2. WHEN the user opens a feedback form THEN the system SHALL show a short set of rating and short-answer questions, mobile-sized and keyboard-friendly.
3. WHEN the user submits feedback THEN the system SHALL confirm the submission inline and SHALL NOT require login or personal identification.
4. IF the device is offline when feedback is submitted THEN the system SHALL queue the submission locally and send it when connectivity returns, or SHALL clearly tell the user it could not be submitted (behavior to be chosen in design).
5. WHEN the user has already submitted the event-wide feedback form in this installation THEN the system SHALL indicate that it was submitted and SHALL prevent re-submission by default (one submission per device for the single event-wide form).
6. WHEN admins view responses THEN the system SHALL present aggregated results (counts and averages) in the admin area; raw responses MAY be exportable.

### Requirement 9 — Post-Event Recap

**User Story:** As an attendee or sponsor, I want a thank-you and recap view after the event, so that I can revisit highlights, photos, and acknowledgments after I've gone home.

#### Acceptance Criteria

1. WHEN the event date has passed AND an admin has published recap content THEN the system SHALL show a Recap view as a top-level section of the app.
2. WHEN the Recap view is open THEN the system SHALL display a thank-you message from the Gateway Chapter board, sponsor acknowledgments, and any photos or links the admins have added.
3. WHEN the Recap view is published THEN the system SHALL still allow access to the Agenda, Sponsors, and Announcements views as a historical record for the remainder of the deployment's life.
4. IF the Recap has not been published yet THEN the system SHALL NOT surface the Recap entry point.
5. WHEN an admin publishes the Recap THEN the system MAY send a push notification announcing the recap (configurable at post time).

### Requirement 10 — Admin Content Management

**User Story:** As a Gateway Chapter board member with admin access, I want to log into the app on my laptop or phone and update content, so that I can keep the agenda current, add sponsors, and broadcast announcements without a developer in the loop.

#### Acceptance Criteria

1. WHEN a user navigates to the admin entry point THEN the system SHALL require a shared passphrase before granting admin access.
2. WHEN the passphrase is entered correctly THEN the system SHALL grant admin access for a session with a defined expiration (e.g., 12 hours), after which re-entry is required.
3. WHEN the passphrase is entered incorrectly THEN the system SHALL deny access and SHALL rate-limit repeated failures from the same device to deter brute force.
4. WHEN an admin is logged in THEN the system SHALL present edit flows for Agenda sessions, Sponsors, Venue Map image, Attendee Directory entries, Feedback form definitions, and Recap content.
5. WHEN an admin edits a content item THEN the system SHALL save the change and make it visible to attendees within the refresh window defined in Requirement 3.4.
6. WHEN an admin composes an announcement THEN the system SHALL allow the admin to choose whether a push notification is also sent, preview the push, and confirm before broadcasting.
7. WHEN an admin broadcasts a push THEN the system SHALL show a confirmation of successful send and SHALL log the send with timestamp and author for the other admins to see.
8. WHEN an admin logs out OR their session expires THEN the system SHALL return the app to attendee mode on that device.
9. IF multiple admins edit the same content item concurrently THEN the system SHALL at minimum preserve the most recent save without silently losing content (collision strategy to be chosen in design).
10. WHEN the admin area is opened on a phone THEN the system SHALL render usable edit controls at phone widths (not just a shrunken desktop layout).

### Requirement 11 — Offline Behavior & Service Worker

**User Story:** As an attendee in a crowded venue with spotty connectivity, I want the app to keep working for the things I've already loaded, so that bad signal doesn't stop me from checking the agenda or map.

#### Acceptance Criteria

1. WHEN the app is first loaded with connectivity THEN the system SHALL register a service worker that caches the app shell (HTML, CSS, JS, icons) for offline use.
2. WHEN the user revisits the app offline THEN the system SHALL load the app shell from cache and display the last-known state of Agenda, Sponsors, Venue Map, Announcements, and Attendee Directory.
3. WHEN the user is offline AND attempts an action that requires connectivity (e.g., submitting feedback, admin edits, sending a push) THEN the system SHALL inform the user that the action requires connectivity and SHALL NOT silently fail.
4. WHEN the app is reopened online after being offline THEN the system SHALL refresh cached content on next view entry.
5. WHEN a new version of the app is deployed THEN the system SHALL update the service worker cache on next load and SHALL avoid serving stale app shell indefinitely.

### Requirement 12 — Non-Functional Requirements

**User Story:** As an attendee on a mid-range phone, I want the app to feel fast, be readable, and respect my privacy, so that it's actually usable at the event and I don't feel surveilled.

#### Performance Acceptance Criteria

1. WHEN the app is loaded on a mid-range Android phone over typical venue cellular THEN the system SHALL render the home view's first meaningful content within 3 seconds.
2. WHEN the user navigates between top-level views (Agenda, Sponsors, Map, Announcements, Attendees) in a warm session THEN the system SHALL complete the navigation visibly within 500 ms.
3. WHEN images are shipped (sponsor logos, venue map, recap photos) THEN the system SHALL serve them at appropriate dimensions for a mobile viewport rather than full-resolution originals.

#### Accessibility Acceptance Criteria

4. WHEN the app is evaluated against WCAG 2.1 Level AA THEN the system SHALL meet AA for color contrast, text sizing, and keyboard operability of interactive elements. (Full AA compliance verification requires manual testing with assistive technologies; the system SHALL be built with AA as the design target.)
5. WHEN a screen reader is used on any top-level view THEN the system SHALL expose a logical reading order with meaningful landmark structure (header, main, nav).
6. WHEN form inputs are rendered (feedback, admin, search) THEN the system SHALL associate labels with inputs and SHALL support focus states visible on both touch and keyboard.
7. WHEN text is rendered THEN the system SHALL remain legible when the OS text-size setting is scaled up to at least 200%.

#### Privacy Acceptance Criteria

8. WHEN a user installs or uses the app THEN the system SHALL NOT require any login, personal account, or sign-up to access attendee-facing features.
9. WHEN push subscriptions are created THEN the system SHALL collect only the device-level subscription token required by the push service and SHALL NOT tie it to a user identity.
10. WHEN feedback or survey responses are submitted THEN the system SHALL collect only the response content and SHALL NOT collect identifying information unless the response explicitly asks for it.
11. WHEN the app is loaded THEN the system SHALL NOT include third-party analytics or advertising trackers.
12. WHEN the Attendee Directory is populated THEN the system SHALL include only fields that attendees knew would be published, with an opt-out path (see Requirement 7.5).

### Requirement 13 — In-App Attendee Sign-In

**User Story:** As an attendee walking into the vendor show, I want to sign in from inside the app the same way I would from the chapter's web page, so that my attendance is recorded in the same Google Sheet the board uses to confirm who showed up, without having to pick which form to use.

#### Acceptance Criteria

1. WHEN the user opens the Sign-In view THEN the system SHALL render a form with Name, Company, Office Location, Phone Number, Email Address, and SCTE Member Number fields; Name, Company, Office Location, Phone Number, and Email Address SHALL be required and SCTE Member Number SHALL be optional (matching the public GoDaddy sign-in page).
2. WHEN the user submits a valid form THEN the system SHALL POST the submission as `application/x-www-form-urlencoded` to the Zapier Catch Hook URL provided by `/api/config` as `signInWebhookUrl`, using the same field names as the public GoDaddy page so a single Zap writes rows from both intake paths into one shared Google Sheet.
3. WHEN the submission succeeds THEN the system SHALL store the submitter's name, company, and ISO timestamp in `localStorage` under `vendorday2027.signin.lastSubmission` and SHALL replace the form with a confirmation card that identifies the signed-in person and offers a "Sign in as someone else" reset link.
4. WHEN the user re-visits the Sign-In view on a device that has already submitted THEN the system SHALL show the confirmation card instead of the form; tapping the reset link SHALL clear the stored submission and re-render the form.
5. WHEN the submission fails (network error, non-2xx response, offline) THEN the system SHALL show an inline error with a Retry affordance and SHALL preserve the user's typed values; the system SHALL NOT silently drop or queue the submission.
6. IF `signInWebhookUrl` is missing from `/api/config` (the `ZAPIER_SIGNIN_WEBHOOK_URL` env var is unset) THEN the system SHALL render a "Sign-in is not yet configured" placeholder and SHALL log a console warning rather than throwing.
7. WHEN sign-in records are created THEN the system SHALL NOT write them to any Firestore collection; the Google Sheet (reached via Zapier) is the single source of truth, and Office Location SHALL NOT be surfaced in the attendee directory view.
8. WHEN the Sign-In view is reachable THEN the system SHALL expose a Sign-In entry point from three locations: a prominent card on the Home view, a prominent CTA on the Welcome / Install view (below the hero and above the install card), and an entry at the top of the overflow menu in the app header.
9. WHEN a prior sign-in submission is stored on the device THEN the Home and Welcome Sign-In entry points SHALL display a high-contrast confirmation using the shared success palette, showing a check icon, a bold "You're signed in" line, the stored attendee name, and a muted "Tap to update" hint; both treatments SHALL remain clickable and SHALL route to `#/sign-in` so the attendee can reach the view and reset.
10. IF `signInEnabled` is false in `appSettings/singleton` (the fail-closed default — missing, false, or any non-true value) THEN the Welcome CTA, the Home quick-action, the More menu entry, and the Sign-In form on the `#/sign-in` route SHALL all be hidden. The `#/sign-in` route SHALL render a friendly "Sign-in isn't available yet" placeholder for new attendees, OR the stored confirmation card (without the "Sign in as someone else" reset button) for attendees with a prior submission on this device. The admin flips `signInEnabled` through the admin Settings page; the attendee app picks up the new value on the next refresh / launch (no live Firestore listener).

### Requirement 14 — Broadband Skills Challenge Check-In

**User Story:** As a Vendor Day attendee who is also competing in the Broadband Skills Challenge, I want to check in for the competition from inside the app after I sign in, so that my pre-registration is confirmed (or captured on the fly if I'm walking up), I sign the required waiver, and the BSC coordinators know I've arrived — without a second paper form queue at the hotel.

#### 14.1 Admin Gating (`bscEnabled`)

1. WHEN the admin opens the admin Settings page THEN the system SHALL render a `bscEnabled` ARIA switch using the same chrome as the existing `signInEnabled` toggle (pill + "LIVE/OFF" copy slot).
2. WHEN the admin flips `bscEnabled` THEN the system SHALL write `{ bscEnabled: <bool> }` to `appSettings/singleton` via `/api/firestore-write` using `op: "update"` so other fields on the document are preserved.
3. IF `bscEnabled` is `false` on `appSettings/singleton` (including missing, null, or any non-`true` value — fail-closed) THEN the system SHALL hide the BSC competitor checkbox from the sign-in form, hide every attendee-side entry point to `#/bsc` and `#/bsc/*`, and SHALL NOT present the "pre-registered — want to check in?" prompt described in 14.6.
4. IF `bscEnabled` is `false` AND an attendee navigates directly to `#/bsc` (or any `#/bsc/*` subroute) by bookmark or deep link THEN the system SHALL render a friendly "BSC check-in isn't available yet" placeholder with a Back-to-Home control and SHALL NOT execute any roster lookup, waiver, or submit logic.
5. IF `bscEnabled` is `false` AND the admin navigates to `#/bsc-checkins` THEN the system SHALL render the dashboard shell with a "BSC is currently disabled" notice in place of the live list; the route itself SHALL remain reachable so admins can confirm the state and flip the toggle without leaving the view.
6. WHEN the attendee app loads `appSettings/singleton` THEN the system SHALL read it through the shared one-shot cache in `public/js/app-settings.js` (same path as `signInEnabled`) and SHALL NOT establish a live Firestore listener for `bscEnabled` on the attendee side; admin changes take effect on the next page refresh or route change, matching the existing `signInEnabled` cadence.
7. WHEN `bscEnabled` flips from `true` to `false` while an attendee is partway through a BSC form THEN the system SHALL allow the in-progress submit to complete so a check-in isn't lost mid-flow; subsequent attempts SHALL honor the new `false` state.

#### 14.2 Sign-In Form Integration

1. WHEN `bscEnabled` is `true` AND the sign-in form is rendered THEN the system SHALL add a labeled "I'm competing in the Broadband Skills Challenge today" checkbox below the existing fields and above the submit button, with keyboard focus order placing the checkbox between SCTE Member Number and Submit.
2. WHEN the sign-in form is submitted THEN the system SHALL append a `bsc_competitor` field (lowercase `"yes"` if the checkbox is checked, `"no"` otherwise) to the existing `application/x-www-form-urlencoded` POST payload sent to `signInWebhookUrl`; no other sign-in payload fields SHALL change behavior.
3. WHEN the sign-in form submission succeeds THEN the system SHALL extend the `localStorage` record at `vendorday2027.signin.lastSubmission` to include `email`, `phone`, `office_location`, and `scte_member_number` fields in addition to the existing `name`, `company`, and `submittedAt`.
4. IF the stored submission object on this device lacks any of `email`, `phone`, `office_location`, or `scte_member_number` (e.g., it was written by a prior build) THEN the system SHALL treat each missing field as an empty string (`""`), never `null` or `undefined`, so downstream consumers can rely on the shape.
5. WHEN the sign-in submission succeeds AND the BSC checkbox was checked AND `bscEnabled` is `true` THEN the system SHALL navigate the attendee to `#/bsc` after the confirmation toast, carrying the just-captured sign-in values as the starting data for the BSC flow.
6. WHEN the sign-in form is rendered AND the device arrives from a `#/bsc` → `#/sign-in` redirect (see 14.4) THEN the system SHALL pre-check the BSC checkbox so the attendee does not have to re-tick it before submitting.

#### 14.3 Pre-Reg Roster Lookup

1. WHEN an attendee lands on `#/bsc` with starting data available THEN the system SHALL look the attendee up in Firestore `bscPreReg` using the lowercased, trimmed email as the document id, via the same client-side read pattern used by other attendee Firestore views (no new Pages Function).
2. WHEN the `bscPreReg` document exists for the attendee's email THEN the system SHALL render a "Confirm your Broadband Skills Challenge check-in" view pre-populating every field known from the roster (competitor name, email, company, office location, job role, supervisor name, supervisor email, supervisor phone, SCTE member id, reference id) in editable but clearly-identified-as-prefilled inputs, SHALL mark the attendee as `entry_type: "pre-registered"`, and SHALL skip the manager-approval attestation.
3. WHEN the `bscPreReg` document does not exist for the attendee's email THEN the system SHALL render the walk-up intake form described in 14.4, defaulting any starting-data fields (name, email, company, office location, SCTE member) from the sign-in payload while leaving BSC-only fields (job role, supervisor name, supervisor email, supervisor phone) empty, and SHALL mark the attendee as `entry_type: "walk-up"`.
4. WHEN the pre-reg lookup fails (network error, Firestore 5xx, timeout) THEN the system SHALL show an inline error with a Retry affordance; the system SHALL NOT fall back to the walk-up form on lookup failure (a transient read error must not silently promote a pre-registered competitor to a walk-up).
5. WHEN the attendee is pre-registered THEN the system SHALL reuse the roster's existing reference id (column 10 of the CSV) in the check-in record and in the Zap payload rather than generating a new one.
6. IF the attendee's starting data is missing an email (e.g., they haven't signed in on this device yet) THEN the system SHALL redirect to `#/sign-in` with the BSC pre-check flag set (see 14.2.6) and SHALL NOT attempt a lookup against a blank id.

#### 14.4 Walk-Up Intake

1. WHEN the walk-up form is rendered THEN the system SHALL show inputs for competitor name (required), email (required), company (required), office location (required), job role / title (required), supervisor name (required), supervisor email (required), supervisor phone (required), SCTE member id (optional), and a manager-approval attestation (see 14.5).
2. WHEN the walk-up form is submitted THEN the system SHALL validate client-side using the same permissive rules used by the existing sign-in form (non-empty for required text fields, basic email shape for email fields, at least seven digits for phone fields) and SHALL focus the first invalid field on failure.
3. WHEN the walk-up form submits successfully THEN the system SHALL generate a fresh reference id on the client in the format `BSC-YYYYMMDD-HHMMSS` using local device time, matching the 2026 Zap's format.
4. WHEN an attendee navigates to `#/bsc` without having completed the Vendor Day sign-in on this device (no `vendorday2027.signin.lastSubmission` record OR a record missing `email`) THEN the system SHALL redirect to `#/sign-in` with a session flag that pre-checks the BSC box (14.2.6) and routes the attendee back to `#/bsc` upon successful sign-in.
5. WHEN starting data includes an email, name, company, office location, or SCTE member number from the sign-in form THEN the system SHALL pre-populate those fields in the walk-up form; the attendee SHALL still be able to edit any pre-populated value.
6. WHEN the walk-up form is submitted THEN the walk-up SHALL NOT be rejected on the basis of the attendee declining manager approval; the record SHALL be captured with `manager_approved: "no"` and flagged in the admin dashboard per 14.5.

#### 14.5 Manager-Approval Attestation

1. WHEN the walk-up form is rendered THEN the system SHALL show a clearly labeled manager-approval attestation ("I have my manager's approval to compete today") as a two-choice control (Yes / No) with no default selection, placed above the submit button.
2. IF the attendee selects "Yes" THEN the system SHALL record `manager_approved: "yes"` in the Firestore `bscCheckins` document and in the Zap webhook payload.
3. IF the attendee selects "No" THEN the system SHALL record `manager_approved: "no"` and SHALL allow the submission to proceed to the waiver step; the dashboard presentation requirements in 14.8.3 apply.
4. IF the attendee submits the walk-up form without picking Yes or No THEN the system SHALL show an inline validation error on the attestation control, focus it, and block the submit until a choice is made.
5. WHEN a pre-registered attendee flows through 14.3 THEN the system SHALL NOT display the manager-approval attestation and SHALL write `manager_approved: ""` (empty string, not null or absent) in the check-in record and Zap payload.

#### 14.6 Pre-Reg Prompt After Regular Sign-In

1. WHEN the sign-in form submits successfully AND the submitter did NOT check the BSC checkbox AND `bscEnabled` is `true` AND a `bscPreReg` document exists for the submitter's lowercased email THEN the system SHALL show a non-blocking prompt on top of (or inline with) the sign-in confirmation card worded along the lines of "We see you're pre-registered for the Broadband Skills Challenge today. Want to check in for that now?" with two actions: "Yes, take me there" and "No thanks".
2. WHEN the attendee taps "Yes, take me there" THEN the system SHALL navigate to `#/bsc` carrying the just-captured sign-in values as starting data (identical to the pre-check path in 14.2.5).
3. WHEN the attendee taps "No thanks" THEN the system SHALL dismiss the prompt, return to the normal sign-in confirmation card, and SHALL write a `localStorage` flag that suppresses the prompt for the remainder of the current `vendorday2027.signin.lastSubmission` so page refreshes do not re-nag.
4. WHEN the attendee resets their sign-in (clears `vendorday2027.signin.lastSubmission` via the "Sign in as someone else" link) THEN the suppression flag in 14.6.3 SHALL be cleared along with the submission record so a new attendee on the same device still gets prompted if applicable.
5. IF the `bscPreReg` lookup required for the prompt fails (network error, Firestore 5xx) THEN the system SHALL silently skip the prompt rather than blocking the sign-in confirmation UX; a missed prompt is strictly less bad than a stalled success state.
6. WHEN the prompt is open THEN the system SHALL expose it to assistive tech with `role="dialog"` and a labeled heading, trap focus until it is dismissed, and support Escape-to-close (equivalent to "No thanks").
7. WHEN the attendee accepts the pre-reg prompt ("Yes, take me there") THEN the app SHALL fire a second POST to the sign-in Zapier webhook with the original payload fields and `bsc_competitor` overridden to `yes`, preserving the original `signed_in_at` timestamp. The retroactive POST is best-effort: if it fails or times out after 5 seconds, the navigation to `#/bsc` proceeds anyway and the failure is logged to the debug overlay. The "No thanks" button, the Escape key, and the backdrop / X dismiss paths SHALL NOT fire a retroactive POST — those paths represent the attendee declining BSC and the first POST's `bsc_competitor=no` remains correct.

#### 14.7 Waiver Step and Mode Fallback

1. WHEN an attendee submits either the pre-reg confirmation form (14.3.2) or the walk-up form (14.4) THEN the system SHALL route them to the waiver step before writing the check-in to Firestore or POSTing to the BSC Zap.
2. WHEN the waiver step is rendered THEN the system SHALL read `bscWaiverMode` and `bscWaiverText` from the shared `appSettings/singleton` cache; `bscWaiverMode` SHALL be `"paper"` by default and `"paper"` or `"electronic"` otherwise.
3. IF `bscWaiverMode` is `"paper"` THEN the system SHALL render a reminder screen stating "Please sign the paper waiver at the competition table before competing", a prominent Confirm button, and SHALL NOT capture any typed signature or agreement checkbox; the resulting check-in record SHALL set `waiver_mode: "paper"`, `waiver_signature: ""`, and `waiver_signed_at: ""`.
4. IF `bscWaiverMode` is `"electronic"` AND `bscWaiverText` is a non-empty string after trimming THEN the system SHALL render the waiver text inside a scrollable panel, an "I have read and agree" checkbox, a "Type your full legal name as signature" text input, and a Submit button that is disabled until both the checkbox is checked AND the signature field contains a non-empty trimmed string.
5. IF `bscWaiverMode` is `"electronic"` AND `bscWaiverText` is empty (missing, null, or whitespace-only) THEN the attendee-side waiver step SHALL defensively fall back to paper mode (render the paper reminder in 14.7.3) and SHALL write `waiver_mode: "paper"` on the resulting check-in record; the admin Settings page SHALL display a warning in this state per 14.9.5.
6. WHEN the attendee submits an electronic waiver THEN the system SHALL set `waiver_mode: "electronic"`, `waiver_signature: <trimmed-signature-string>`, and `waiver_signed_at: <ISO timestamp at submit>` in both the Firestore check-in record and the Zap payload.
7. WHEN the waiver submit succeeds THEN the system SHALL show a confirmation screen summarizing the attendee's name, entry type (Pre-registered / Walk-up), waiver mode, reference id, and (for paper mode) the "sign at the table" reminder.
8. WHEN the waiver submit fails (network error, non-2xx response from Firestore write or the Zap webhook) THEN the system SHALL show an inline error with Retry, preserve the attendee's typed signature value, and SHALL NOT silently drop the submission.

#### 14.8 Check-In Persistence and Admin Dashboard

1. WHEN the waiver step submits successfully THEN the system SHALL write a `bscCheckins` document to Firestore containing `attendee_name`, `email` (lowercased), `company`, `office_location`, `job_role`, `supervisor_name`, `supervisor_email`, `supervisor_phone`, `scte_member_id`, `reference_id`, `submitted_at`, `entry_type`, `manager_approved`, `waiver_mode`, `waiver_signature`, `waiver_signed_at`, and a server timestamp for ordering; the client SHALL also POST the same shape (minus the server timestamp) as `application/x-www-form-urlencoded` to the BSC Zap webhook URL in `bscWebhookUrl` from `/api/config`.
2. WHEN the admin opens `#/bsc-checkins` THEN the system SHALL render columns in this order: Name, Email, Company, Office location, Pre-reg status (badge: ✓ Pre-registered / Walk-up), Manager approval (walk-ups only: ✓ Yes / ✗ No; pre-registered rows show `—`), Waiver mode (Paper / Electronic), Waiver signed (ISO timestamp for electronic, `"At table"` for paper), Signature name (electronic only, empty for paper), Check-in time.
3. WHEN a walk-up row has `manager_approved: "no"` THEN the system SHALL visually mark that row prominently (e.g., warning-colored status chip and an accessible label) so the BSC coordinator can follow up during the event.
4. WHEN the dashboard is rendered THEN the system SHALL expose sort controls on Name and Check-in time, filter controls for Pre-reg status, Manager-approval status, and Waiver mode, and a search box that filters by name or email (case-insensitive substring match on the trimmed field values).
5. WHEN the dashboard is open THEN the system SHALL poll `bscCheckins` on the same 30-second cadence used by other admin editors (no real-time Firestore listener per the out-of-scope list in the brief).
6. WHEN the dashboard poll fails THEN the system SHALL preserve the last-rendered rows, show an inline error banner with Retry, and SHALL NOT clear the table or scroll state on transient read errors.
7. IF `bscEnabled` is `false` THEN the dashboard SHALL render the "BSC is currently disabled" state per 14.1.5 instead of fetching rows.
8. WHEN the Zap webhook POST fails but the Firestore write succeeds (or vice versa) THEN the system SHALL log a console warning identifying which leg failed; the attendee SHALL see a non-fatal "we recorded your check-in but could not sync with the registration sheet, please notify a BSC coordinator" message rather than a hard failure, so a Sheet-only outage does not block check-ins.

#### 14.9 Admin Settings Additions

1. WHEN the admin opens the Settings page THEN the system SHALL render, in this order below the existing Sign-In toggle: `bscEnabled` toggle, `bscWaiverMode` two-state control (Paper / Electronic), `bscWaiverText` textarea, "Upload BSC roster (CSV)" button, and a read-only status line showing the current roster count and the last-import timestamp.
2. WHEN the `bscWaiverMode` control is interacted with THEN the system SHALL write `{ bscWaiverMode: "paper" | "electronic" }` to `appSettings/singleton` via `/api/firestore-write` with `op: "update"` and SHALL toast success / failure using the same inline banner pattern as the Sign-In toggle.
3. WHEN the admin edits the `bscWaiverText` textarea THEN the system SHALL expose a save control (button or blur-driven save, matching whatever pattern is already in the admin UI for similarly-sized text fields) and SHALL write `{ bscWaiverText: <string> }` to `appSettings/singleton` via `/api/firestore-write` with `op: "update"`; the textarea SHALL show a placeholder "Paste your legal-approved waiver text here. Required when waiver mode is set to Electronic." and SHALL NOT be pre-populated with any invented waiver copy.
4. WHEN the admin UI anywhere else surfaces a character count on textareas THEN the `bscWaiverText` textarea SHALL show a character count using the same component; otherwise no character count is required.
5. IF `bscWaiverMode` is `"electronic"` AND `bscWaiverText` is empty (trimmed) THEN the Settings page SHALL show a visible warning next to the waiver controls stating that the attendee flow will fall back to paper mode until waiver text is populated; the warning SHALL NOT block saving either field independently.
6. WHEN the admin clicks "Upload BSC roster (CSV)" THEN the system SHALL open the native file picker filtered to `.csv`, POST the chosen file as `multipart/form-data` to `/api/bsc-roster-upload`, and show an inline progress / result message of the form "Imported 41 pre-registered competitors. 0 skipped." derived from the server response.
7. WHEN the upload completes successfully THEN the system SHALL refresh the roster-count and last-imported-at status line without a full page reload.
8. WHEN the upload fails THEN the system SHALL render the server-side error list (`errors[]` in the response) in a readable form and SHALL NOT update the local status line.

#### 14.10 Pre-Reg Roster Upload (`/api/bsc-roster-upload`)

1. WHEN a request arrives at `/api/bsc-roster-upload` THEN the system SHALL require the admin JWT using the same auth pattern as `/api/firestore-write`; unauthenticated or expired-token requests SHALL return `401` and SHALL NOT touch Firestore.
2. WHEN an authenticated request arrives with a `multipart/form-data` body containing a CSV file field THEN the system SHALL parse the CSV, matching headers case-insensitively and whitespace-tolerantly against the known schema (Competitor name, Email address, Company, Office location, Job role / title, Supervisor / Manager name, Supervisor / Manager email, Supervisor / Manager phone, SCTE member ID, Reference ID, Submitted at). Unknown extra columns SHALL NOT cause rejection; they SHALL be ignored.
3. IF the uploaded file is not a CSV, exceeds a reasonable upper bound (choose a sensible limit at design time; the 2026 file has 41 rows), or cannot be parsed at all THEN the system SHALL return `400` with a JSON body `{ imported: 0, skipped: 0, errors: [<human-readable message>] }`.
4. WHEN parsing each row THEN the system SHALL trim whitespace around every value and SHALL skip any row missing either competitor name or email; skipped rows SHALL increment the `skipped` counter and SHALL be reported in the `errors` array with the row number.
5. WHEN upserting a valid row THEN the system SHALL use `set` with `merge: true` on `bscPreReg/<lowercased-trimmed-email>`, writing every field from the row plus `importedAt: serverTimestamp()`; an existing document for the same email SHALL be updated in place rather than replaced wholesale, preserving any additional fields written by future features.
6. WHEN the upload completes THEN the system SHALL update `appSettings/singleton.bscRosterCount` to the current `bscPreReg` collection count and `bscRosterLastImportedAt` to a server timestamp, both via the service account's Firestore client.
7. WHEN the upload completes THEN the response SHALL be a JSON body of the shape `{ imported: <n>, skipped: <m>, errors: [<string>, ...] }` with a `200` status; `imported` SHALL count only rows that were upserted successfully.
8. WHEN a re-upload is performed after a late addition THEN the system SHALL add the new person without deleting prior roster entries; the brief explicitly rules out any bulk-delete, roster-edit, or roster-export UI for v1.

#### 14.11 Seed and Configuration

1. WHEN `scripts/seed-app-settings.js` runs THEN it SHALL include `bscEnabled: false`, `bscWaiverMode: "paper"`, `bscWaiverText: ""`, `bscRosterCount: 0`, and `bscRosterLastImportedAt: null` in the seeded `appSettings/singleton` document, alongside the existing fields.
2. WHEN `/api/config` responds THEN the body SHALL include `bscWebhookUrl: env.ZAPIER_BSC_WEBHOOK_URL || null` alongside the existing fields; no other secret SHALL be added.
3. IF `ZAPIER_BSC_WEBHOOK_URL` is unset in the Cloudflare env THEN the attendee BSC flow SHALL render a graceful "BSC check-in is not yet configured" placeholder on `#/bsc` (same pattern as the sign-in view handles a missing `signInWebhookUrl`) and SHALL log a console warning rather than throwing.
4. WHEN any client code reads the BSC Zap URL THEN it SHALL come from `bscWebhookUrl` on `/api/config`; the system SHALL NOT hardcode `https://hooks.zapier.com/hooks/catch/26705916/ux6k1ic/` (or any webhook URL) anywhere in `public/`.

## Resolved Decisions

The following decisions have been confirmed by the user and are locked for design:

- **Agenda shape**: Single-track schedule. No parallel tracks for Vendor Day 2027.
- **Attendee directory fields**: Name, company, and title (title optional, omitted when absent). Source data comes from the registration Google Sheet; attendees request opt-out at check-in rather than opt-in.
- **Feedback scope**: Event-wide only for v1. One feedback form that becomes available during and after the event. No per-session feedback.
- **Push consent order**: Deferred to the user's first visit to the Announcements view. Not shown during install onboarding.
- **Survey response retention**: Two years post-event. Admins view aggregated results in the admin area; raw CSV export is available only during the active event year.
- **Admin access path**: No separate subdomain. Admin area is reachable from inside the installed PWA via a hidden menu entry and at `/admin` in any browser for the shared production domain.
- **Announcement authorship**: Unified voice as "Gateway Chapter Board" on every post. Individual board member names are not displayed to attendees.
- **Offline feedback submission**: Fail loudly with retry. No local queue of pending submissions.
- **Recap push**: Admin choice at publish time (consistent with the per-announcement push toggle in Requirement 6).
- **Venue map interactivity**: Static zoomable image. No tappable booths or embedded sponsor hotspots in v1.
- **In-app sign-in intake**: The in-app Sign-In view and the public GoDaddy sign-in page both POST to the same Zapier Catch Hook, which writes rows into a single shared Google Sheet. The webhook URL is deployed as the Cloudflare env var `ZAPIER_SIGNIN_WEBHOOK_URL` and exposed to the client through `/api/config` as `signInWebhookUrl` — no hardcoded URL in the app. Sign-ins are not written to any Firestore collection; the Google Sheet is the source of truth.
- **Office Location field**: Captured by the Sign-In form and sent to the Sheet, but intentionally not surfaced in the in-app attendee directory.
- **Sign-in spam protection**: Client-side validation only, matching the GoDaddy form. No honeypot, no CAPTCHA.
- **Attendee Sign-In admin gate**: The in-app Sign-In surfaces (Welcome CTA, Home quick-action, More menu entry, and the `#/sign-in` route itself) are gated behind a `signInEnabled` boolean on `appSettings/singleton`. Default is `false` (fail-closed — a missing or non-true value is treated as off), and the attendee app picks up admin changes on the next refresh / launch (no live listener). Admins flip the toggle from the admin Settings page. The gate only governs in-app surfaces; the GoDaddy sign-in page is independent and keeps its own availability controls.
- **Broadband Skills Challenge check-in**: BSC check-in is gated by a fail-closed `bscEnabled` toggle on `appSettings/singleton` (default `false`). Waiver mode defaults to `"paper"` (reminder only, no e-signature); electronic mode is admin-authored text + typed-name signature with a defensive fallback to paper when the text is empty. The pre-registration roster is managed by uploading a CSV through the admin UI (merge-upsert keyed by lowercased email; no bulk-delete / edit / export UI in v1). The BSC Zap and the Firestore `bscCheckins` collection are both authoritative for different consumers: the shared BSC Google Sheet is the BSC coordinator's single source of truth; `bscCheckins` powers the admin dashboard. Reference id format `BSC-YYYYMMDD-HHMMSS` matches the 2026 Zap; the pre-launch duplicate scan is the primary mitigation for same-second collisions among walk-ups.
- **Retroactive sign-in update on pre-reg prompt acceptance (duplicate row is accepted)**: When an attendee signs in without checking the BSC competitor box, is found in the pre-reg roster, and then accepts the "We see you're pre-registered — want to check in?" prompt, the app fires a second form-encoded POST to the sign-in Zap with the original payload and `bsc_competitor` flipped to `yes`. Zapier's "Create Spreadsheet Row" action is insert-only, so this intentionally produces a duplicate row in the sign-in Google Sheet for that attendee (one `bsc_competitor=no`, one `bsc_competitor=yes`, both sharing the original `signed_in_at` so they correlate). The trade-off is accepted: data clarity on the primary analytical path (did the attendee compete?) is more valuable than a single-row-per-attendee invariant in the raw Sheet. Dedup by email is a post-event operational task on the Sheet, NOT an in-app feature — the app does not surface the duplicate to the attendee, does not attempt to update the first row, and does not coalesce the two POSTs. The authoritative BSC check-in record remains the `bscCheckins` Firestore collection and the shared BSC Google Sheet; the sign-in Sheet's `bsc_competitor` column is a convenience signal only.

## Confirmed Context

These facts are confirmed and should be treated as inputs to the design, not assumptions:

- **Venue**: Doubletree Chesterfield, Chesterfield, MO 63005.
- **Date**: TBD, targeting mid-May to early June 2027. Placeholder dates are acceptable in the app until the board confirms.
- **Admins**: Approximately three named Gateway Chapter board members sharing a single admin passphrase.
- **Content layer**: Lightweight free-tier data store supporting admin writes without redeploying the app. Specific service to be chosen in design.
- **Attendee directory source**: Google Sheet maintained by the registration process.
- **Admin surface**: One responsive admin UI serves both the installed PWA on a phone and any desktop browser. No separate desktop-only console.
- **Pre-registration roster source**: Google Sheet maintained by the chapter via the existing Broadband Skills Challenge Registration 2026 Zap; exported as CSV and uploaded through the admin UI.
