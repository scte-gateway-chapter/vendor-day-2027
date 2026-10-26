# Pre-Launch Checklist — Vendor Day 2027 PWA

## Overview

This checklist is the final gate before Vendor Day 2027 opens at the
Doubletree Chesterfield in Chesterfield, MO 63005. One or two Gateway
Chapter admins run it 7-10 days before the event, top to bottom, in a
single 2-3 hour sitting on a mix of a laptop and at least one iPhone and
one Android phone.

### How each item works

Every item below renders as a GitHub task row:

```
- [ ] 1. Short name — what to do; expected result.
```

Each section ends with a table where the admin records who ran the check,
when, and the pass/fail outcome. Failures do **not** mean "ignore and
move on." Open a follow-up task in
`.kiro/specs/vendor-day-app/tasks.md` for every failed item (the
`docs/followup-tasks-template.md` scaffold is there to copy) and either
resolve it before go-live or document the agreed workaround on the
Section 7 sign-off.

### Stop condition

The checklist is done when either:

- Every item in Sections 1-6 passes, or
- Every failed item has an opened, acknowledged follow-up ticket and the
  two sign-off admins in Section 7 have agreed it is acceptable to ship.

Do **not** ship with silent failures.

### How to fix a check that fails

This document deliberately does not duplicate the deployment or admin
instructions. When a check fails, pivot to:

- `docs/deployment.md` — Cloudflare Pages, R2, KV, Firebase, OneSignal,
  env var and binding fixes, deploy and rollback.
- `docs/admin-runbook.md` — admin UI workflows, content editors, push
  send, feedback and recap mechanics.

---

## Section 1 — Infrastructure

- [ ] 1. **DNS resolves to Cloudflare Pages.** From PowerShell:

      ```powershell
      nslookup 2027vendorday.gatewayscte.org
      ```

      The non-authoritative answer section lists a Cloudflare Pages
      hostname (CNAME chain into `<project>.pages.dev`). If it returns
      `can't find`, give DNS another 15 minutes and retry — see
      `docs/deployment.md` → Custom domain. _(Req 11.5, 12.11)_

- [ ] 2. **TLS cert valid and HSTS present.** From PowerShell:

      ```powershell
      curl.exe -I --ssl-no-revoke "https://2027vendorday.gatewayscte.org/"
      ```

      Status is `200 OK`, response includes a `strict-transport-security`
      header, and the certificate expiration (visible in the browser's
      lock icon) is at least 30 days out. Cloudflare auto-renews
      Universal SSL; a cert that is about to expire indicates a domain
      binding problem. _(Req 11.5, 12.11)_

- [ ] 3. **HTTPS redirect works.** From PowerShell:

      ```powershell
      curl.exe -I "http://2027vendorday.gatewayscte.org/"
      ```

      Status is `301` or `302` with a `Location:` header starting with
      `https://2027vendorday.gatewayscte.org/`. Cloudflare's "Always Use
      HTTPS" setting on the Pages project enforces this. _(Req 11.5)_

- [ ] 4. **Admin login renders.** In a browser, open
      `https://2027vendorday.gatewayscte.org/admin/`. The login card
      renders with a single passphrase input and a Sign in button. No
      console errors. _(Req 10.1)_

- [ ] 5. **Service worker registered and activated.** With the production
      URL open, DevTools → Application → Service Workers lists `/sw.js`
      with status `activated and running`, scope
      `https://2027vendorday.gatewayscte.org/`. The arrangement is one
      worker (`/sw.js`); if a second worker appears, see
      `docs/deployment.md` → Service worker arrangement. _(Req 11.1)_

- [ ] 6. **Three app caches populated.** DevTools → Application →
      Cache Storage lists three caches whose names start with `shell-v`,
      `content-v`, and `images-v`. The shell cache contains at least
      `/`, `/index.html`, `/admin/index.html`, the main CSS, and the
      main JS. _(Req 11.1, 11.2)_

- [ ] 7. **R2 bucket reachable from the public URL.** Before running
      this check, seed a 1-pixel PNG at
      `sponsors/_test.png` in the `vendor-day-2027-assets` bucket (one
      time, through the Cloudflare dashboard). Then open:

      ```
      <R2_PUBLIC_URL>/sponsors/_test.png
      ```

      The browser renders the image, not an XML access-denied response.
      Delete the test object after the check passes. _(Req 4.1, 11.2)_

- [ ] 8. **KV namespace bound.** Cloudflare → Pages → the project →
      Settings → Bindings (or Settings → Functions → KV namespace
      bindings on older dashboards) lists `ADMIN_LOGIN_RATE` bound to
      the KV namespace. Without this, the login rate limiter fails open.
      _(Req 10.3)_

- [ ] 9. **Firestore rules deployed and anonymous writes blocked.**
      From PowerShell:

      ```powershell
      curl.exe -i -X POST --ssl-no-revoke `
        "https://firestore.googleapis.com/v1/projects/scte-vendorday-2027/databases/(default)/documents/agenda/direct-write-test"
      ```

      Response body contains `PERMISSION_DENIED`. If it instead returns
      `200 OK` with a document body, the rules have not deployed; see
      `docs/deployment.md` → Firebase CLI operations → Deploy Firestore
      rules. _(Req 10.1, 10.4, 10.5)_

- [ ] 10. **All nine environment variables present.** Cloudflare → Pages
       → the project → Settings → Variables and Secrets lists the
       following for **both** Production and Preview scopes:

       | Variable | Scope | Type |
       | --- | --- | --- |
       | `NODE_VERSION` | Both | Text |
       | `FIREBASE_PROJECT_ID` | Both | Text |
       | `FIREBASE_WEB_API_KEY` | Both | Text |
       | `FIREBASE_SERVICE_ACCOUNT_JSON` | Both | Secret |
       | `ONESIGNAL_APP_ID` | Both | Text |
       | `ONESIGNAL_REST_API_KEY` | Both | Secret |
       | `ADMIN_PASSPHRASE_HASH` | Both | Secret |
       | `ADMIN_JWT_SECRET` | Both | Secret |
       | `R2_PUBLIC_URL` | Both | Text |

       Missing or misconfigured variables surface as `500 Server
       misconfigured` on `/api/*` endpoints — see `docs/deployment.md`
       → Smoke tests. _(Req 10.2, 12.8, 12.9, 12.11)_

### Section 1 sign-off

| Item | Status (Pass / Fail) | Who ran it | Date | Notes |
| --- | --- | --- | --- | --- |
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |
| 7 | | | | |
| 8 | | | | |
| 9 | | | | |
| 10 | | | | |

---

## Section 2 — Push notifications

- [ ] 1. **OneSignal Web Push channel active.** OneSignal → Settings →
      Keys & IDs for the Vendor Day 2027 app shows the Web Push channel
      enabled (not "activation pending"). If it reads pending, the
      setup wizard was not completed end-to-end — see
      `docs/deployment.md` → OneSignal. _(Req 2.2, 6.2)_

- [ ] 2. **iOS 16.4+ end-to-end delivery.** On an iPhone running iOS
      16.4 or later with Safari:

      1. Open `https://2027vendorday.gatewayscte.org/` in Safari.
      2. Install the PWA with Share → Add to Home Screen.
      3. Launch the installed app from the home screen icon.
      4. Open Announcements, tap Enable on the opt-in card, and accept
         the system prompt.
      5. From a laptop signed in to `/admin/`, compose and publish a
         test announcement with "Send as push notification" checked.

      The notification arrives on the iPhone within 10 seconds. Tapping
      it opens the installed app directly on the matching announcement
      card with the brief highlight. Delete the test announcement
      afterward. _(Req 2.2, 2.3, 2.6, 6.2, 6.3)_

- [ ] 3. **Android Chrome end-to-end delivery.** On an Android phone
      with Chrome:

      1. Open the production URL.
      2. Open Announcements, tap Enable on the opt-in card, and accept
         the system prompt.
      3. From admin, publish a second test announcement with push
         checked.

      The notification arrives within 10 seconds; tapping it opens the
      app on the matching announcement. Delete the test announcement
      afterward. (See `docs/deployment.md` → Known limitations for the
      iOS web push reliability caveat; Android is more consistent and
      is the primary reliability signal here.) _(Req 2.2, 6.2, 6.3)_

- [ ] 4. **Permission denial path.** On a second test device (fresh
      profile or a device that has never visited the production URL),
      open Announcements and **deny** the browser permission prompt.
      Return to Announcements; the "Notifications are turned off"
      banner renders. The opt-in card no longer re-prompts
      automatically on subsequent visits (the "Enable notifications"
      entry in About & Install still exists as the manual re-entry
      point). _(Req 2.4, 2.5)_

- [ ] 5. **Health strip green.** Sign in to `/admin/`. On the Dashboard,
      the health strip shows both pills green: Firestore reachable and
      OneSignal reachable. If either is red, see `docs/deployment.md`
      → Smoke tests before continuing. _(Req 10.4)_

### Section 2 sign-off

| Item | Status | Who ran it | Date | Device / OS version | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | — |

---

## Section 3 — Admin surface

- [ ] 1. **Login rate limiter trips at six wrong attempts.** From one
      browser, enter the **wrong** passphrase six times in rapid
      succession at `/admin/`. The sixth attempt returns the
      `Too many attempts. Try again in Xm Ys` message and the countdown
      ticks down toward zero. Wait out the window (or let a different
      IP continue) rather than resetting manually — the KV counter is
      per-IP and clears on expiry. _(Req 10.3)_

- [ ] 2. **Session expiry redirect.** Sign in at `/admin/`. Open
      DevTools → Application → Session Storage, delete the
      `vendorday2027.admin.jwt` entry. Attempt a save in any editor
      (e.g., change an agenda title and tap Save). The browser
      redirects to `/admin/?reason=expired` with the "Session expired
      — please sign in again" banner. _(Req 10.2, 10.8)_

- [ ] 3. **Session TTL is 12 hours.** Sign in at `/admin/`. In DevTools
      → Application → Session Storage, read the
      `vendorday2027.admin.expiresAt` value. The timestamp is
      approximately 12 hours ahead of the current wall clock. _(Req
      10.2)_

- [ ] 4. **Agenda editor round trip.** Admin → Agenda → Add session.
      Fill in a dummy session (`Pre-launch test`, start now, end 30
      minutes from now, room `TEST`). Save. Within 30 seconds the
      session appears on the attendee Agenda view in a second browser.
      Edit the title to `Pre-launch test — edited`; the attendee view
      updates. Delete the session; it disappears from the attendee
      view. _(Req 3.4, 10.4, 10.5)_

- [ ] 5. **Sponsor editor round trip.** Admin → Sponsors → Add sponsor.
      Fill in a dummy sponsor (`Pre-launch Test Co`, tier `Supporter`,
      upload a 100 KB PNG logo). Save. The sponsor appears in the
      attendee Sponsor directory with the logo rendering from the R2
      public URL. Delete the sponsor. _(Req 4.1, 4.2, 10.4)_

- [ ] 6. **Venue map upload replaces placeholder.** Admin → Venue Map →
      Replace image → upload a 1-2 MB PNG floor plan. Save. The
      attendee Map view renders the uploaded image (not the shipped
      placeholder) within 30 seconds. _(Req 5.1, 5.2, 10.4)_

- [ ] 7. **Announcement with push.** Admin → Announcements → compose
      `Pre-launch push test` + a short body → check Send as push →
      Publish. Verify delivery to the subscribed test device from
      Section 2 and that the admin's past-announcements list shows the
      `pushSent` chip (check mark) on the row. Delete the announcement.
      _(Req 6.1, 6.2, 10.6, 10.7)_

- [ ] 8. **Attendee CSV import honors opt-out.** Prepare a 5-row test
      CSV with columns `name,company,title`; one row's `name` is a
      placeholder you can recognize. Admin → Attendees → upload the
      CSV. In the preview, toggle one row to Opt-out. Click Merge. The
      attendee directory renders four rows; Firestore stores all five
      with the correct `optedOut` flag on the toggled row. Delete the
      test rows after. _(Req 7.5, 7.7, 10.4, 12.12)_

- [ ] 9. **Feedback form end-to-end.** Admin → Feedback → Form tab →
      add one rating question and one short-text question → flip
      Activate on. From a different browser (private window or second
      device), open the attendee Feedback view and submit a response.
      Admin → Feedback → Results tab shows the response within 30
      seconds. Deactivate the form after. _(Req 8.1, 8.2, 8.3, 8.6)_

- [ ] 10. **Recap publish/unpublish round trip.** Admin → Recap →
       enter a short thank-you message and acknowledgments → Publish
       with push unchecked. Within 60 seconds the attendee More menu
       shows the Recap entry and the Recap view renders the content.
       Unpublish; the Recap entry disappears from the More menu. _(Req
       9.1, 9.2, 9.4)_

- [ ] 11. **Admin collision warning on concurrent edit.** Open the same
       agenda session in two browser tabs (or two devices) through the
       admin editor. In the first tab, change the title and Save. In
       the second tab, change the title and Save. The second tab
       surfaces the "This content was edited by someone else —
       Overwrite / Reload" banner before the save lands. _(Req 10.9)_

### Section 3 sign-off

| Item | Status | Who ran it | Date | Notes |
| --- | --- | --- | --- | --- |
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |
| 7 | | | | |
| 8 | | | | |
| 9 | | | | |
| 10 | | | | |
| 11 | | | | |

---

## Section 4 — Attendee content coverage

- [ ] 1. **Empty states render intentionally.** Temporarily point a
      preview deployment at an empty Firestore project (or clear each
      content collection in a staging project — do **not** clear
      production). Walk Agenda, Sponsors, Map, Announcements,
      Attendees, Feedback, Recap. Each view renders its placeholder
      copy ("Agenda coming soon", "Sponsor list coming soon", etc.) —
      not an error state, not a blank page. _(Req 3.5, 4.5, 5.4, 6.4,
      7.6, 8.1, 9.4)_

- [ ] 2. **Welcome / install first run.** From a browser profile that
      has never visited the production URL (private window, cold cache,
      not installed), open the site. The Welcome card renders with
      event title, Doubletree Chesterfield, date (or placeholder),
      and chapter attribution. The install guidance matches the
      platform (iOS Safari shows the Add to Home Screen illustration;
      Android Chrome shows the Install app button; desktop Firefox
      shows the "Continue in browser" fallback). Dismissing with "I'll
      do this later" navigates to Home. _(Req 1.1, 1.2, 1.3, 1.6)_

- [ ] 3. **Push opt-in deferral.** On a fresh profile, confirm the push
      opt-in card renders **only** when first navigating to
      Announcements (not on Welcome, Home, Agenda, Sponsors, Map, or
      Attendees). On iOS Safari with the app not installed, the
      opt-in card variant explains that push requires Add to Home
      Screen and does **not** trigger the browser permission prompt.
      _(Req 2.1, 2.3)_

- [ ] 4. **Offline behavior.** Load the production URL with full
      connectivity, navigate through Agenda, Sponsors, Map, and
      Announcements so each view's data is cached. In DevTools →
      Network → Offline, reload. The app shell loads from cache and
      Agenda / Sponsors / Map render the last-known content with the
      yellow offline banner. (Known limitation: Home's "Latest
      announcement" card and the Attendee directory search revert to
      their empty state offline — see `docs/deployment.md` → Known
      limitations.) _(Req 3.6, 4.1, 5.5, 6.7, 11.2, 11.3)_

- [ ] 5. **ICS calendar export imports cleanly.** In the attendee
      Agenda view, open any session detail → tap Add to Calendar. The
      downloaded `.ics` file imports successfully into at least two of
      Google Calendar, Outlook (desktop or web), and Apple Calendar
      with the correct title, start/end, room, and description. _(Req
      3.2, 3.3)_

### Section 4 sign-off

| Item | Status | Who ran it | Date | Notes |
| --- | --- | --- | --- | --- |
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |

---

## Section 5 — Performance and accessibility

- [ ] 1. **Lighthouse PWA audit passes.** From desktop Chrome, run
      Lighthouse against `https://2027vendorday.gatewayscte.org/` in
      Desktop mode with the PWA category enabled. Every PWA check
      passes (installable, service worker registers, manifest valid,
      viewport, HTTPS, maskable icon). Capture the report HTML. _(Req
      11.1, 11.5, 12.1)_

- [ ] 2. **Lighthouse Accessibility score ≥ 95 on every top-level
      view.** Run Lighthouse (Desktop mode, Accessibility only) on each
      of these routes:

      - `https://2027vendorday.gatewayscte.org/#/`
      - `https://2027vendorday.gatewayscte.org/#/agenda`
      - `https://2027vendorday.gatewayscte.org/#/sponsors`
      - `https://2027vendorday.gatewayscte.org/#/map`
      - `https://2027vendorday.gatewayscte.org/#/announcements`
      - `https://2027vendorday.gatewayscte.org/#/attendees`
      - `https://2027vendorday.gatewayscte.org/#/feedback`
      - `https://2027vendorday.gatewayscte.org/admin/#/dashboard`
      - `https://2027vendorday.gatewayscte.org/admin/#/announcements`

      Each report scores at least 95. Note the exact score per route
      below so a regression can be spotted next year. _(Req 12.4, 12.5,
      12.6)_

- [ ] 3. **First meaningful content under 3 seconds.** On a mid-range
      phone (e.g., Pixel 7a or iPhone 12) over cellular (LTE or 5G, not
      venue Wi-Fi), cold-load the production URL and start a stopwatch
      the moment the browser confirms navigation. The Home view's
      welcome card and primary CTA buttons are visible before 3.0
      seconds. Record the measured time. _(Req 1.7, 12.1)_

- [ ] 4. **Tab-to-tab navigation under 500 ms.** With the same device
      from item 3 (now warm), tap each bottom tab in sequence. Each
      transition completes visibly within half a second. _(Req 12.2)_

- [ ] 5. **200% text scale readable.** In desktop Chrome, open the
      production URL, press `Ctrl+=` until the browser zoom reads 200%.
      Walk every top-level view (Home, Agenda, Sponsors, Map,
      Announcements, Attendees, Feedback). No text clips, no CTAs
      disappear off-screen, no overlapping elements. _(Req 12.7)_

- [ ] 6. **Keyboard-only walkthrough reaches every control.** Start on
      Home. Press Tab from the top. Confirm:

      - Focus is **visible** on every element (2px solid brand-green
        outline).
      - Order is top-to-bottom, left-to-right as it reads.
      - Every interactive element is reachable (bottom-tab arrow-key
        navigation, modal focus trap on Attendee detail, Escape closes
        modals).
      - Reach every top-level view this way. _(Req 12.4, 12.6)_

- [ ] 7. **Reduced-motion respected.** Toggle OS prefers-reduced-motion
      ON (Windows: Settings → Accessibility → Visual effects →
      Animation effects Off; macOS: System Settings → Accessibility →
      Display → Reduce motion). Reload the production URL. Confirm:

      - Toast slide-in is instant (no animation) or near-instant.
      - "App updated — tap to reload" banner appears without animation.
      - Announcement deep-link highlight pulse is static.
      - Map zoom transition is instant.

      _(Req 12.4)_

- [ ] 8. **Screen reader smoke test.** With VoiceOver on iOS (triple-
      click the side button) or TalkBack on Android (Settings →
      Accessibility → TalkBack), open the production URL and swipe
      through Home → Agenda → Announcements. Confirm the screen reader
      announces the three landmarks (header / main / navigation) in
      logical order and that the Home view's primary heading reads as
      an `<h1>`. _(Req 12.5)_

### Section 5 sign-off

| Item | Status | Who ran it | Date | Notes (score / timing / device) |
| --- | --- | --- | --- | --- |
| 1 | | | | PWA report URL: |
| 2 | | | | Home: __ / Agenda: __ / Sponsors: __ / Map: __ / Announcements: __ / Attendees: __ / Feedback: __ / Admin dashboard: __ / Admin announcements: __ |
| 3 | | | | measured __ s on __ |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |
| 7 | | | | |
| 8 | | | | VoiceOver / TalkBack version __ |

---

## Section 6 — Content prep

- [ ] 1. **Event date set.** Admin → Firestore (via the admin dashboard
      card for `appSettings`) → `singleton` → `eventDate` is a valid
      ISO date (`YYYY-MM-DD`) within the mid-May to early-June 2027
      event window. _(Req 1.1, 3.1)_

- [ ] 2. **Real venue map uploaded.** The attendee Map tab shows the
      final 2027 Doubletree Chesterfield floor plan, not the
      placeholder SVG with the "Final map will be posted before the
      event" watermark. _(Req 5.1, 5.3)_

- [ ] 3. **Agenda loaded with at least one real session.** The attendee
      Agenda view lists at least one real session (title, start / end,
      room). The full day does not need to be finalized — the schedule
      is editable up to and during the event. _(Req 3.1)_

- [ ] 4. **Platinum and Gold sponsors loaded with logos.** The attendee
      Sponsor directory has at least every Platinum and Gold tier
      sponsor present, each with a logo rendering from R2 (not the
      chapter-mark placeholder). Silver and Supporter tiers may be in
      progress. _(Req 4.1, 4.2)_

- [ ] 5. **Day-of-event opening announcement drafted.** A draft
      announcement for the morning of (title such as
      `Welcome to Vendor Day 2027`, body including the first session
      time and room) sits in the admin composer **saved** but
      **unpublished**. The admins publish it with push at 8:30 AM
      day-of. _(Req 6.1, 6.2)_

- [ ] 6. **Feedback questions prepared, form OFF.** Admin → Feedback →
      Form tab contains at least one rating question and one short-text
      question. The Activate toggle is **off**. Admins flip it on
      mid-event per the day-of cheat sheet in `docs/admin-runbook.md`.
      _(Req 8.1, 8.2)_

- [ ] 7. **Recap content drafted externally.** The thank-you message
      and acknowledgments text sit in a shared document (Google Docs,
      OneNote, etc.) ready to paste into the Recap editor the evening
      after the event. Photos may be TBD until the event is over. _(Req
      9.1, 9.2)_

### Section 6 sign-off

| Item | Status | Who ran it | Date | Notes |
| --- | --- | --- | --- | --- |
| 1 | | | | eventDate = |
| 2 | | | | |
| 3 | | | | session count = |
| 4 | | | | Platinum = __ / Gold = __ |
| 5 | | | | |
| 6 | | | | question count = |
| 7 | | | | doc URL = |

---

## Section 7 — Final go/no-go

- [ ] 1. **Sections 1-6 all pass, OR every failed item has a tracked
      follow-up.** List each opened follow-up ticket here with its
      resolution status.

      | Follow-up | Opened by | Date | Resolution status |
      | --- | --- | --- | --- |
      | | | | |
      | | | | |
      | | | | |

- [ ] 2. **Admin team briefed.** Every admin on the roster has:

      - Signed in at `/admin/` at least once with the current
        passphrase.
      - Walked the day-of cheat sheet in `docs/admin-runbook.md`.
      - Confirmed their phone or laptop can reach the admin area over
        cellular (not just venue Wi-Fi).

      | Admin name | Signed-in date | Cheat-sheet walked? |
      | --- | --- | --- |
      | | | |
      | | | |
      | | | |

- [ ] 3. **QR code generated and tested.** Generate the attendee QR
      code with any trusted generator (for example
      `https://www.qr-code-generator.com/`) using the content from
      `docs/qr-content.txt` as the exact string. Scan the generated
      code with at least one iPhone and one Android device; both land
      on the Welcome view at `https://2027vendorday.gatewayscte.org/`.
      _(Req 1.1)_

- [ ] 4. **QR code placed on event email AND check-in table signage.**
      Confirm the QR code image is embedded in the final pre-event
      attendee email (ready to send) and in the check-in table sign
      (printed, laminated or in a sign holder). _(Req 1.1)_

- [ ] 5. **Backup channel decided for total push failure.** In the
      event OneSignal or iOS push is unreachable, the chapter has
      agreed how to broadcast urgent updates during the event (PA
      announcement at the venue AND in-app announcements that
      attendees refresh on their own). Record the agreed channel
      below. _(Req 6.6, see also `docs/deployment.md` → Known
      limitations)_

      | Backup channel | Owner | Notes |
      | --- | --- | --- |
      | PA announcement | | |
      | In-app refresh ask | | |

- [ ] 6. **Sign-off.** Two admins sign off that the checklist is
      complete and the deployment is launch-ready.

      | Admin name | Role | Date signed off |
      | --- | --- | --- |
      | | | |
      | | | |

      Keep this file in the repo with the signatures captured in the
      PR that merges the completed checklist. The repository is the
      canonical record of what was verified.

---

## After-event cleanup

Not required pre-launch. The chapter runs this list the week after the
event to close the loop.

- [ ] 1. **Export the feedback CSV before year-end.** Admin → Feedback
      → Results → Export CSV. The export button is only visible during
      the active event year (2027); after Dec 31 2027 the raw export
      must happen through a developer. Save the CSV to the chapter's
      records.

- [ ] 2. **Publish the Recap.** Admin → Recap → paste in the drafted
      thank-you + acknowledgments, upload the day-of photos, flip
      Publish. Optionally send a push on publish.

- [ ] 3. **Rotate the admin passphrase.** See `docs/deployment.md` →
      Admin passphrase lifecycle → Rotation. Rotating both
      `ADMIN_PASSPHRASE_HASH` and `ADMIN_JWT_SECRET` in Cloudflare
      signs out every admin device in one step.

- [ ] 4. **Archive OR plan the 2028 rollover.** Decide whether to
      archive the Cloudflare project and the R2 bucket, or roll
      forward into the 2028 deployment. The yearly rollover playbook
      is in `docs/deployment.md` → Yearly rollover.
