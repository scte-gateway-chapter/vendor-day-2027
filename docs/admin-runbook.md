# Admin Runbook — Vendor Day PWA

## Overview

This runbook is for Gateway Chapter board members with admin access to the
Vendor Day PWA. It covers everything you can do from the admin area: editing
the agenda, sponsors, venue map, announcements, attendees, feedback, and
recap, plus sending push notifications to subscribed devices.

It does **not** cover changing the code, redesigning the layout, adding new
sections, or anything that requires a Cloudflare / Firebase / OneSignal
dashboard. Those steps live in `docs/deployment.md`.

The admin area is phone-usable; most editors have been tested on an iPhone
and an iPad in portrait. A laptop is nicer for CSV imports and bulk edits.

Where this runbook refers to `<year>`, substitute the current event year
(e.g. `2027`).

---

## Signing in

1. Visit `https://<year>vendorday.gatewayscte.org/admin/` on any browser
   (phone, tablet, or laptop). The URL works from both the installed PWA
   and any plain browser.
2. Enter the shared admin passphrase and tap **Sign in**.
3. The session lasts **12 hours** before auto-expiring. After 12 hours the
   next click redirects you to the login screen with a "Session expired"
   banner.
4. **Logging out one device.** Tap **Log out** in the admin header. The
   JWT in that browser's `sessionStorage` is cleared; attendee-side views
   still work on the same device.
5. **Signing out everywhere.** This is a deploy-side operation (rotate
   `ADMIN_JWT_SECRET` — see `docs/deployment.md` → **Admin passphrase
   lifecycle**). On the admin side there is nothing to do; after the
   rotation, the next admin action on each device redirects to the login
   screen and requires the new passphrase.

### Login rate limiting

The server rate-limits failed sign-ins at **5 attempts per 10 minutes per
IP**. The sixth wrong try returns a `Too many attempts` message with a
countdown. A correct passphrase from the same IP during the countdown
still works. A successful sign-in clears the counter.

If several board members share an office or hotel Wi-Fi, their attempts
all count against the same IP. Spread sign-ins out, or sign in from a
cellular connection, if the counter is in the way.

---

## Dashboard

The Dashboard is the first screen after sign-in.

- **Per-area cards** show the last-edited timestamp and the board member
  who made the change (`updated 2h ago by Board member A`). Click a card
  to open that editor.
- **Health strip** reports Firestore and OneSignal reachability. Both
  green means the Pages Functions can reach both services and admin
  writes / push sends will go through. A red card means something is
  wrong on the backend side — see `docs/deployment.md` for diagnostics;
  the admin UI itself cannot fix connectivity.
- **Recent push sends** lists the last ten announcements that triggered a
  push, with the send timestamp and the announcement title.

If two board members edit the same content area at the same time, the
dashboard will not warn you about it in real time — the per-editor
"edited by someone else" banner (see **Content area editors** below)
handles collision warnings at save time instead.

---

## Content area editors

### Agenda

**What it controls:** The sessions attendees see on the Agenda tab —
title, start / end time, room, speaker name and bio, and session
description.

**Where to click:** Dashboard → **Agenda** card, or **Agenda** in the
left rail / nav dropdown.

**Add / edit / delete:**

- **Add a session.** Tap **Add session**. Fill in title (required, 1-120
  chars), start and end times (end must be after start), room, speaker
  name, speaker bio, description. Tap **Save**.
- **Edit a session.** Tap **Edit** on the row. The modal opens with the
  current values; make changes and tap **Save**. The modal validates
  client-side before contacting the server.
- **Delete a session.** Tap **Delete** on the row. A confirmation dialog
  appears before the delete lands.

**Gotchas:**

- Times are entered as datetime-local inputs, which use the local time
  zone of the editing device. Be consistent — pick one editor's time
  zone (Central Time for a St. Louis event) and stick with it.
- The "edited by someone else" banner appears on save if another admin
  updated the same session after you opened the editor. Pick **Overwrite**
  or **Reload** before your save lands.

**Propagation:** Edits land on attendee devices within **30 seconds**
(the attendee agenda polls Firestore).

### Sponsors

**What it controls:** The Sponsor Directory — tier (Platinum / Gold /
Silver / Supporter), company name, booth number, website, description,
logo image.

**Where to click:** Dashboard → **Sponsors**, or **Sponsors** in the
nav.

**Add / edit / delete:**

- **Add a sponsor.** Tap **Add sponsor**. Fill in name, tier, booth
  number (optional), website (must parse as `https://` if provided),
  email (optional), description, and pick a logo image. Save.
- **Edit a sponsor.** Tap **Edit** on the row. Same modal as Add.
- **Reorder within a tier.** Use the up / down handles on the row.
  Reordering only applies within a tier — Platinum always renders first.
- **Delete a sponsor.** Tap **Delete**, confirm.

**Gotchas:**

- Logo file is capped at 5 MB. Accepted formats: PNG, JPEG, WebP, SVG.
- Deleting a sponsor removes the Firestore record but leaves the
  previously uploaded logo in R2. Storage is cheap enough that this is
  rarely worth cleaning up, but if the board cares, delete the object
  directly from the Cloudflare R2 dashboard.
- Sponsors with no logo render a placeholder (chapter mark). That is
  intentional — some sponsors never send a logo.

**Propagation:** Edits land on attendee devices within 30 seconds.

### Venue Map

**What it controls:** The static map image on the Map tab and the caption
beneath it.

**Where to click:** Dashboard → **Venue Map**, or **Venue Map** in the
nav.

**How to use:**

1. **Replace image.** Tap the file picker. Accepted formats: PNG, JPEG,
   WebP. Max 5 MB. The uploader shows the current image on the left and
   the new upload on the right while the request is in flight.
2. **Edit caption.** Independent of the image — type into the caption
   textarea and tap **Save**. The caption is required (the attendee view
   shows it as a legend beneath the map).
3. The image and caption save as a single operation; a failed upload
   leaves the previous image intact.

**Propagation:** The attendee Map tab picks up the new image within 30
seconds. The service worker caches the previous image until it fetches
the new one.

### Announcements

**What it controls:** Announcements shown on the Announcements tab, and
optionally a push notification to subscribed devices.

**Where to click:** Dashboard → **Announcements**, or **Announcements**
in the nav.

**Composer workflow:**

1. **Title** — required, 1-120 characters. This is also the push
   notification heading.
2. **Body** — required, 1-2000 characters. Supports basic markdown
   (bold, italic, links, lists). The composer renders a live preview.
3. **Send as push notification** — check this to send a push on
   Publish. The preview panel shows what subscribers will see: the
   title plus the first 120 characters of the body.
4. **Publish**. The composer writes the announcement to Firestore first;
   if the push is checked, it then calls OneSignal. See **Sending push
   notifications** below for the failure modes.

**Editing an existing announcement:**

- Tap **Edit** on the row. Same composer, pre-filled.
- Editing an existing announcement **does not re-send a push**, even if
  "Send as push" is checked. That is intentional — pushes are
  fire-and-forget. If you need to re-notify, delete the announcement and
  compose a new one.

**Deleting:** The delete removes the announcement from the attendee feed.
Pushes already delivered to devices stay delivered — the OS has no
server-side recall for a notification that already fired.

**Propagation:** New announcements appear within 30 seconds on attendee
devices. Subscribed devices that are online receive the push within a
few seconds.

### Attendees

**What it controls:** The Attendee Directory. See **Attendee directory
import** below for the full CSV workflow.

**Where to click:** Dashboard → **Attendees**, or **Attendees** in the
nav.

**Day-to-day edits:**

- Tap **Edit** on a row to update name, company, title, or toggle
  `optedOut`. An opt-out hides the row from the attendee directory but
  keeps the record so the next merge import does not resurrect it.
- Tap **Delete** on a row to remove the record entirely. Prefer
  **opt-out** over delete so the next CSV import does not re-add the
  attendee.

### Feedback

**What it controls:** The feedback form definition and the results view.
See **Activating the feedback form** below.

**Where to click:** Dashboard → **Feedback**, or **Feedback** in the
nav.

### Recap

**What it controls:** The Recap entry in the attendee More menu. See
**Publishing the recap** below for the publish workflow.

**Where to click:** Dashboard → **Recap**, or **Recap** in the nav.

---

## Sending push notifications

### Composer flow

1. **Announcements → compose**. Fill in title (also the push heading)
   and body (markdown supported).
2. **Check "Send as push notification"**. Review the preview — subscribers
   see the title and the first 120 characters of the body.
3. **Publish**. The composer:
   1. Writes the announcement to Firestore. If the write fails, you see
      an error toast and the composer values stay — try again.
   2. If the write succeeded and the push was requested, calls OneSignal.
      If OneSignal returns an error, the composer shows a **Retry push**
      banner. The announcement is still published; the retry only
      re-sends the push.
   3. On both succeeding, the row shows a check mark and the push send
      is logged on the Dashboard's recent-pushes list.

### What subscribers see

A notification with your title as the heading and the first 120
characters of the body as the preview. Tapping the notification opens
the app directly to that announcement card with a brief highlight.

### Rules of thumb

- **Edits don't re-send pushes.** If an announcement needs a correction
  that subscribers should see, delete and recompose.
- **Deletes don't recall pushes.** A notification that already fired on
  someone's phone cannot be recalled. Think twice before publishing with
  push, especially during a session.
- **One push per announcement.** The Retry push banner only exists for
  the OneSignal-failure case. Clicking Publish again on an existing
  announcement never fires a second push.

---

## Attendee directory import

The chapter maintains attendee registrations in a shared Google Sheet.
The admin importer takes CSV exports of that sheet.

### Export from Google Sheets

1. Open the registration sheet (see URL below).
2. **File → Download → Comma Separated Values (.csv)**.
3. Save the file somewhere findable on your laptop or phone.

**Registration sheet URL:** _<insert the Gateway Chapter board's shared
registration sheet URL here>_

The URL is intentionally not committed to the repo. Each board cohort
pastes the current sheet URL into this runbook (and bookmarks it in
their browser). Changing boards means updating this line.

### Import into the app

1. **Admin → Attendees**. Drag the CSV file into the **Upload CSV** card,
   or tap the card to open a file picker.
2. The importer parses the file client-side and renders a preview table.
   Expected columns: `name`, `company`, `title` (title is optional). If
   the headers do not match, column-mapping dropdowns appear so you can
   point `Name`, `Company`, and `Title` at the right source columns.
3. Review the preview. Rows with empty `name` or empty `company` are
   flagged — fix them in the Google Sheet, re-export, and re-import.
4. **Per-row Include / Opt-out toggles.** Toggle Opt-out for anyone who
   asked at check-in not to appear in the directory.
5. Pick a commit mode:
   - **Merge** — upsert by name + company. Preserves the current
     opt-out state on existing rows unless you explicitly toggled it in
     the preview. Safe to run repeatedly as new registrations come in.
   - **Replace directory** — destructive. Deletes every existing
     attendee record first, then writes the preview rows. Confirms in a
     dialog before running. Use only when the sheet is the single source
     of truth and you are willing to lose any admin-side edits made
     since the previous import.

### Opt-out mechanics

- An attendee who asks to opt out at check-in: toggle Opt-out on their
  row in the preview before committing, or edit their row in the
  attendee list after import.
- Opt-out keeps the record in Firestore with `optedOut: true` so the
  next merge import does not resurrect them in the attendee directory.
  Deleting the row instead would re-add them on the next merge if they
  still appear in the sheet.

---

## Updating the venue map

1. **Admin → Venue Map**. The current image renders on the left.
2. **Replace image** → pick a PNG, JPEG, or WebP file up to 5 MB.
3. **Edit caption** if the legend or the floor plan notes have changed.
4. **Save**. On success, the attendee Map tab serves the new image
   within 30 seconds (and sooner on devices with a fresh page load).

Attendees who had the old image cached will see it until the service
worker fetches the new one — usually on the next hard refresh or when
the service worker's content cache expires. For an urgent change (wrong
map in production), post an announcement pointing at the correct map so
attendees know to reload.

---

## Activating the feedback form

**Admin → Feedback.** Two tabs: **Form** and **Results**.

### Form tab

1. **Add question.** Tap **Add question**. Pick a type:
   - **Rating** — a 1 through 5 radio group.
   - **Short text** — a single-line input, up to 200 characters.
   - **Long text** — a textarea, up to 2000 characters.
2. Edit the question text, set **Required** on or off, and use the
   reorder handles to arrange the question order.
3. **Activate form.** Flip the **Activate** toggle on. The attendee
   Feedback tab now renders the form instead of the "coming soon"
   placeholder.
4. **Deactivate** flips the toggle back off at any time. Submitted
   responses remain in the database; the form just becomes unavailable
   to attendees.

### Results tab

1. **Rating questions** render as per-question bar charts (counts of 1
   through 5 responses), computed client-side on page open.
2. **Short and long text answers** render as a scrollable list, newest
   first.
3. **Export CSV** downloads every response as a CSV file. The button is
   only visible during the active event year — i.e., `2027` for the 2027
   deployment. After the deployment year passes, exports happen through
   the admin or deployment runbook (ask a developer).

---

## Publishing the recap

**Admin → Recap.** The recap editor controls the Recap entry that
appears in the attendee More menu after the event.

1. **Thanks message** and **Acknowledgments** are editable text fields.
   Acknowledgments supports markdown; the attendee view renders bold,
   italic, links, and lists.
2. **Photos** — upload with the file picker. Accepts PNG, JPEG, and
   WebP. Drag the thumbnails to reorder. Re-uploading a photo with the
   same slot replaces the previous image in R2.
3. **Save draft** persists the current state without making the Recap
   visible to attendees. Use this to prepare the recap before the event
   finishes.
4. **Publish** flips `recap.published` to `true`. The Recap entry
   appears in the attendee More menu within 30 seconds.
5. **Send a push on Publish** — optional checkbox. If checked, Publish
   also sends a push notification pointing at the Recap view ("The
   <year> recap is up"). Same mechanics as the Announcements push flow.
6. **Unpublish** hides the Recap entry from the attendee menu but keeps
   the draft intact — you can republish without re-entering content.

---

## Day-of-event quick reference

Cheat sheet for the morning of. All destinations are two or fewer taps
from the admin landing screen.

- **Edit a session.** Admin → **Agenda** → **Edit** on the row. Attendee
  devices pick up the change within 30 seconds.
- **Add a new session.** Admin → **Agenda** → **Add session**.
- **Change a room assignment.** Admin → **Agenda** → **Edit** on the
  affected session → update the Room field → **Save**.
- **Post an announcement with push.** Admin → **Announcements** →
  compose → check **Send as push notification** → **Publish**.
- **Post an announcement without push.** Same path, leave the checkbox
  unchecked. Useful for schedule notes that don't need to interrupt
  anyone.
- **Replace the venue map.** Admin → **Venue Map** → **Replace image**
  → pick file → **Save**.
- **Toggle an attendee's opt-out.** Admin → **Attendees** → **Edit** on
  the row → flip **Opt out** → **Save**.
- **Deactivate the feedback form at end-of-day.** Admin → **Feedback**
  → **Form** tab → flip **Activate** off.
- **Export feedback results.** Admin → **Feedback** → **Results** tab →
  **Export CSV**.
- **Publish the recap.** Admin → **Recap** → **Publish** (with or
  without the push toggle).

If something is not responding (saves failing, dashboard cards red,
pushes not arriving), check the Dashboard health strip first. If both
cards are green and the problem is specific to one editor, try a hard
refresh (`Ctrl+Shift+R` on desktop, close-and-reopen on the installed
PWA). Persistent failures across editors are an infrastructure problem;
hand off to whoever owns the Cloudflare and Firebase accounts and point
them at `docs/deployment.md`.

---

## Sign-In Integration

The chapter captures Vendor Day attendance through two independent intake
paths that both land rows in the same Google Sheet:

1. **Public GoDaddy page** — the `Vendor Day Sign In HTML` module embedded
   on the chapter's GoDaddy site. Anyone with the URL can sign in.
2. **In-app Sign-In view** — reachable at `#/sign-in` from inside the
   installed PWA (Home quick-action and More menu entry).

Both paths POST a form-encoded body with the SAME field names
(`attendee_name`, `company`, `office_location`, `phone`, `email`,
`scte_member_number`, `signed_in_at`) to a single Zapier Catch Hook. A
single Zap writes each submission as a row into one shared Google Sheet.

### Updating the webhook URL

The in-app view reads the webhook URL from the Cloudflare env var
`ZAPIER_SIGNIN_WEBHOOK_URL` (via the `/api/config` endpoint). The webhook
URL is **not** hardcoded in the app bundle.

1. Cloudflare → **Pages** → the Vendor Day project → **Settings** →
   **Variables and Secrets**.
2. Edit `ZAPIER_SIGNIN_WEBHOOK_URL` (or add it if missing) for both the
   **Production** and **Preview** scopes.
3. Save and trigger a redeploy (any `git push` to main, or **Deployments
   → Retry deploy** on the latest build).
4. Verify by submitting a test sign-in from the app and confirming a new
   row appears in the Sheet within ~15 seconds.

If `ZAPIER_SIGNIN_WEBHOOK_URL` is not set, the in-app Sign-In view
renders a "Sign-in is not yet configured" placeholder instead of the
form. The GoDaddy page is unaffected — it carries its own hardcoded URL
in the HTML module (see **Rotating the webhook** below).

### Pointing the Zap at a different Google Sheet

The Zap lives in the chapter's Zapier account.

1. Zapier dashboard → open the Vendor Day sign-in Zap.
2. **Trigger** step stays as the Catch Hook (keep the URL stable so
   neither intake path needs changes). If a URL rotation is required,
   see **Rotating the webhook** below.
3. **Action** step is a Google Sheets "Create Spreadsheet Row" action.
   Open it, click **Change** on the Spreadsheet or Worksheet field, and
   pick the new destination.
4. Re-run the field mapping if the new Sheet has a different column
   layout. The source fields coming from the Catch Hook are
   `attendee_name`, `company`, `office_location`, `phone`, `email`,
   `scte_member_number`, and `signed_in_at`. Map them onto whichever
   columns the new Sheet uses.
5. **Publish** / turn the Zap back on and verify with a test sign-in.

### Rotating the webhook

A new Catch Hook URL is required only if the Zap is deleted and
rebuilt or if the chapter moves to a different Zapier account. When
that happens:

1. Grab the new URL from the Catch Hook trigger step.
2. Update the Cloudflare env var as described in **Updating the webhook
   URL** above and redeploy the app.
3. Open the GoDaddy module at
   `Vendor Day HTML/Vendor Day Sign In HTML` and update the hardcoded
   `ZAPIER_WEBHOOK` constant in the inline script to the same URL. Save
   and republish the GoDaddy page.

Both intake paths must be rotated or sign-ins from one path will stop
appearing in the Sheet.

### Troubleshooting

Sign-ins not landing in the Sheet:

1. **Check the Zap's task history.** Zapier dashboard → the sign-in Zap
   → **History** tab. Each submission should show a successful task
   firing within a few seconds. A failed task shows the error from
   Google Sheets (usually a permission or sharing issue on the Sheet).
2. **Verify the env var in Cloudflare.** Pages → Settings → Variables
   and Secrets. `ZAPIER_SIGNIN_WEBHOOK_URL` should be present for both
   Production and Preview and should match the Catch Hook URL from the
   Zap exactly.
3. **Test the webhook directly** from PowerShell:

   ```powershell
   curl.exe -X POST `
     -H "Content-Type: application/x-www-form-urlencoded" `
     -d "attendee_name=Admin Test&company=Diagnostics&office_location=Remote&phone=5555555555&email=admin@example.com&scte_member_number=&signed_in_at=$(Get-Date -Format o)" `
     "<ZAPIER_WEBHOOK_URL>"
   ```

   A 200 response from Zapier plus a row in the Sheet within ~15 seconds
   confirms the webhook and Sheet are working. If the webhook returns a
   non-200, the Zap is off or the URL is wrong.
4. **Compare the two intake paths.** If the GoDaddy page works but the
   in-app form doesn't, the Cloudflare env var is the usual suspect. If
   the in-app form works but the GoDaddy page doesn't, the hardcoded
   URL in the GoDaddy HTML is stale. If neither works, the Zap itself
   or the Sheet is the problem — start at step 1.

### Attendees who sign in and the Attendee Directory

The Sign-In form and the Attendee Directory are two independent
features with two different data sources:

- Sign-In writes to the Google Sheet via Zapier. Office Location is
  captured here.
- Attendee Directory reads from the Firestore `attendees` collection,
  seeded by the admin CSV importer. See **Attendee directory import**
  above.

Signing in through the app does NOT add the attendee to the directory,
and listing someone in the directory does NOT mark them as signed in.
Office Location is intentionally captured only on the Sign-In form —
it is a Sheet-only field and does not appear anywhere in the directory
view.
