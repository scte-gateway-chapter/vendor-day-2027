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

## Confirmed Context

These facts are confirmed and should be treated as inputs to the design, not assumptions:

- **Venue**: Doubletree Chesterfield, Chesterfield, MO 63005.
- **Date**: TBD, targeting mid-May to early June 2027. Placeholder dates are acceptable in the app until the board confirms.
- **Admins**: Approximately three named Gateway Chapter board members sharing a single admin passphrase.
- **Content layer**: Lightweight free-tier data store supporting admin writes without redeploying the app. Specific service to be chosen in design.
- **Attendee directory source**: Google Sheet maintained by the registration process.
- **Admin surface**: One responsive admin UI serves both the installed PWA on a phone and any desktop browser. No separate desktop-only console.
