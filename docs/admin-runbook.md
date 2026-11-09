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

### Troubleshooting push delivery

If an attendee reports the **Enable notifications** button hangs with no
OS prompt, open the debug overlay (`?debug=1`) on that device and check
the event feed for `OneSignal.init failed`. The polyfill shipped in
the "Polyfill crypto.randomUUID so OneSignal SDK init works on older
browsers" commit handles the most common cause
(`crypto.randomUUID` missing in older browsers). If a different init
error appears, capture the debug text via the **Copy debug text** button
and share it with support — see **Debug overlay** below for how to
reach the panel.

#### iOS first-push warm-up

After a fresh subscribe on iOS, the very first push can drop silently
at Apple's end — the device shows no notification, no error, and no
entry in Notification Center. Every subsequent push to the same
subscription delivers reliably. This is **not** a bug in the app or
the admin composer; it is an iOS Apple Push Notification Service
quirk observed during Task 25 field testing and reproduced on more
than one iPhone.

Mitigation at venue setup: on the morning of the event, roughly 30-60
minutes before door-open, publish an announcement in the admin
composer with the push toggle on. A benign heading
("Welcome to Vendor Day") and a one-line body
("We're glad you're here — see you at check-in.") work well. This
real-but-harmless push warms up every subscription on the roster so
any first-push drops have already happened before the first real
announcement goes out. If someone's phone misses this warm-up push,
their second real push of the day still delivers.

If a specific attendee reports they never got any pushes:

1. Ask them to open the installed app with `?debug=1` appended to
   the URL and expand the **🐞 DEBUG** overlay.
2. Confirm `OneSignal.User.PushSubscription.optedIn` is **`true`** in
   the **OneSignal state** section. If it is `false`, they are not
   subscribed — walk them back through tapping **Enable
   notifications** in Announcements.
3. If `optedIn` is `true`, send another test push from the admin
   composer (or the OneSignal dashboard **Send to Subscribed
   Users**). The first fresh subscribe may have been dropped by the
   warm-up quirk; the follow-up almost always lands.
4. If a second push also fails to arrive, have the attendee **delete
   the PWA** from their home screen, open the production URL in
   Safari / Chrome again, re-install the PWA (Share → Add to Home
   Screen on iOS; Install app on Android Chrome), reopen
   Announcements, tap **Enable notifications**, and accept the
   system prompt. Send one more test push. If the overlay then shows
   a fresh subscription id and `optedIn: true` and the push arrives,
   the reinstall cleared the stale state. If the push still does not
   arrive, have them tap **Copy debug text** in the overlay and send
   the result to the on-site admin for escalation.

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
5. **If the in-app form fires but the row is missing, or you suspect a
   stale app shell on the test device,** open the attendee app with
   `?debug=1` appended to the URL and read the on-device debug overlay.
   It shows the BUILD_ID the device is actually running, whether
   `signInWebhookUrl` reached the device via `/api/config`, and a
   rolling event feed. See **Debug overlay** below.
6. **If some Sheet columns populate but others are blank,** the Zap's
   trigger sample is stale. See **Zapier staleness** below.

### Webhook URLs never land in committed files

**Rule:** raw Zapier Catch Hook URLs (and any other secret-shaped
value) live ONLY in Cloudflare Pages env vars. They must NEVER appear
in files committed to this repository — not in `public/`, not in
`docs/`, not in `.kiro/specs/`, not in test scripts, not in
troubleshooting examples, not in commit messages. When a doc needs to
reference a webhook URL, use the placeholder form of the env var name
(e.g., `<ZAPIER_BSC_WEBHOOK_URL>`).

**Why:** this repository is public on GitHub. Scanners like
GitGuardian flag committed webhook URLs within minutes, and anyone
can submit entries to the chapter's downstream systems using an
exposed URL. If a leak occurs, remediation requires rotating the Zap
in Zapier (not just removing the URL from current files, because git
history is permanent).

**Before any PR or commit touching docs/specs:** grep the diff for
the Zapier Catch Hook URL pattern (`https://` + `hooks.zapier.com` +
`/hooks/catch/`) and for any 7-character alphanumeric Catch Hook
short-ID that is NOT already behind a placeholder like
`<ZAPIER_*_WEBHOOK_URL>`. If a match appears, replace with the
placeholder form before committing.

**If a leak is detected after the fact:**

1. Rotate the Zap's Catch Hook URL in Zapier (delete the Zap and
   recreate, or use the trigger step's **Change URL** action if
   available). The leaked value becomes immediately useless.
2. Update the Cloudflare env var to the new URL. Retrigger the latest
   Pages deploy so the client picks up the new value.
3. If a GoDaddy page or any other external surface held the same URL,
   update that too. Republish.
4. Scrub the raw URL from the current files in the repo; replace with
   the placeholder form.
5. Commit the scrub with a clear message so audit logs show the fix.
6. Verify the rotation held: fire a test POST at the old URL from
   `curl` — it should return 404.

### Zapier staleness — why reused Zaps need re-sampling each year

This applies to both the sign-in Zap and the BSC Zap, and to any future
Zap we reuse to stay on the free tier.

**What happens:** Zapier's trigger step caches a "sample" of a past
webhook POST. The field mappings in each action step bind to names
from that cached sample. When the published Zap receives a new
webhook, Zapier runs the actions but **does NOT automatically refresh
the cached trigger sample**. If the app's payload field names change
between seasons (we added fields, renamed a field, or reused a Zap
across a schema change), the mapping dropdowns in the editor still
show the OLD field names and new fields never appear.

**The symptom:** some Sheet columns populate on new submissions, but
others go blank. The columns that match the OLD sample field names
work. The columns bound to field names that don't exist in the new
payload stay blank. The columns bound to new field names that aren't
yet in Zapier's cached sample can't be mapped at all.

**The fix (one-time per Zap, per schema change):**

1. In the Zap editor, open the Catch Hook trigger step.
2. Click **Test** or scroll to the Test section.
3. Click **Find new records** / **Load more** to force Zapier to pull
   recent webhook POSTs.
4. Pick a recent POST that reflects the current payload. If no recent
   POST exists, fire a test from the live app or send one with `curl`
   so Zapier has something fresh to catch.
5. Save the trigger step. The new fields are now available in the
   action step dropdowns.
6. Open each downstream action step (Google Sheets, Email, etc.) and
   re-verify every field mapping. Zapier does NOT auto-remap when the
   sample changes.
7. **Click Publish.** The editor badge shows `Draft` until you do, and
   the Zap keeps running the previously-published mappings even if the
   editor looks correct.

**Pre-launch verification pattern:**

For each reused Zap, fire a representative test POST (from the live
app, not just `curl`) and confirm every expected column appears in the
Sheet with the right value. Do this at least a week before the event
so there's time to fix a stale mapping without pressure.

Known caveat: `curl` POSTs from a laptop sometimes don't show up in
the Zapier editor's **"Find new records"** list even when the webhook
accepted them with HTTP 200. If `curl` samples don't appear, fire the
test from the real app URL in a browser and the sample will show up
reliably within a few seconds.

### Why some attendees show up twice in the sign-in Sheet

Attendees who signed in without checking the BSC box, were pre-registered
for the Broadband Skills Challenge, and clicked "Yes" on the resulting
prompt will appear in the sign-in Sheet as **two rows**:

- First row: `bsc_competitor = no` (what they submitted)
- Second row: `bsc_competitor = yes` (fired automatically when they accepted the prompt)

Both rows share the same `signed_in_at` timestamp and the same email.
Keep the `yes` row and discard the `no` row during post-event cleanup;
the authoritative BSC check-in record lives in the BSC Sheet regardless.

This is working as designed. The app does not try to update the first
row — Zapier's "Create Spreadsheet Row" action is insert-only, and
building an update-by-key path would mean a second Zap and a Sheet
lookup on every submit. For a one-day event the duplicate row is the
cheaper trade-off; the two rows correlate by the shared `signed_in_at`
timestamp so a manual dedupe is a sort-and-eyeball on the Sheet.

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

### Enabling and disabling attendee Sign-In

The in-app Sign-In surfaces (Welcome CTA, Home quick-action, More menu
entry, and the `#/sign-in` route itself) are gated behind an admin
toggle so the board can keep sign-in invisible during event setup and
flip it on close to door-open. The toggle lives on the admin Settings
page.

**To flip the toggle:**

1. Admin → **Settings** in the left rail (or the phone navigation
   dropdown).
2. Under **Attendee Sign-In**, tap the switch.
   - **LIVE** means attendees see the Sign-In form on the Welcome
     screen, Home, and the More menu, and `#/sign-in` renders the
     form.
   - **OFF** means attendees see no Sign-In surface anywhere in the
     app, and `#/sign-in` (if an attendee reaches it from a
     bookmark or deep link) renders a "Sign-in isn't available yet"
     placeholder instead of the form.
3. A success toast confirms the write. The small `updated X ago by Y`
   line in the Settings header updates on the next 30-second poll.

**When attendees see the change:** on the next refresh or launch of
the app. The attendee app does NOT poll for this flag — the design
reads `appSettings/singleton` once per page load, so an attendee who
had the app open when you flipped the toggle will keep seeing the
previous state until they reload or relaunch.

**Behavior for attendees who already signed in before you turned the
toggle off:** The Welcome CTA, Home quick-action, and More menu entry
all stay hidden regardless of local state — the chrome does not
reveal the gated feature. If one of those attendees navigates
directly to `#/sign-in` (e.g., from a bookmark), the view renders the
`Signed in as [name] ([company])` confirmation card for their
reassurance, but **without** the "Sign in as someone else" reset
button since re-signing is not offered while sign-in is off.

**Recommended operational pattern:** leave the toggle **OFF** during
all pre-event setup, back-of-house walkthroughs, and admin smoke
tests so stray test submissions don't land in the Google Sheet from
staff who happen to tap around the installed PWA. Flip it **LIVE** on
the morning of the event, roughly 30 minutes before door-open, so the
earliest attendees who already have the app on their phones see the
Sign-In entry when they open it at check-in. Flip it back **OFF**
after the sign-in rush subsides if the board wants to prevent late or
duplicate submissions.

**The GoDaddy page is NOT affected by this toggle.** It is the
chapter's public web form and keeps whatever availability controls
the GoDaddy site itself provides. If a pre-event blackout is desired,
hide the GoDaddy page separately through the chapter's GoDaddy site
settings. The two intake paths share one Zapier Catch Hook and one
Google Sheet, but their visibility is managed independently so the
board can run back-of-house tests against the GoDaddy page while the
in-app surface stays hidden.

---

## Broadband Skills Challenge check-in

The in-app Broadband Skills Challenge (BSC) check-in flow is the day-of
replacement for the paper BSC sign-in queue the chapter has run for
years. Competitors who were pre-registered through the chapter's
Broadband Skills Challenge Registration Zap arrive, open the installed
PWA, sign in on the main attendee form (checking the "I'm competing"
box, or getting the pre-reg prompt if they forgot), confirm their
roster details, sign the waiver (paper reminder or electronic — admin
toggled), and get a confirmation card with their reference id. Walk-up
competitors fall through to a fuller intake form with a required
manager-approval attestation.

### Operating the feature

The feature is gated by a `bscEnabled` toggle on the admin Settings
page. The toggle lives below the Sign-In section and reuses the same
ARIA switch chrome. **Default is OFF.** Flip it ON on event morning
once the Zap is confirmed firing, the roster is uploaded, and the
waiver copy is reviewed. The flip propagates to attendee devices on
their next page refresh — no live listener runs for this field, same
cadence as the Sign-In toggle.

When OFF: the sign-in form hides the BSC competitor checkbox, the
pre-reg prompt is suppressed, `#/bsc` renders a "BSC check-in isn't
available yet" placeholder with a Back-to-Home control, and the admin
dashboard at `#/bsc-checkins` renders a "BSC is currently disabled"
shell. The dashboard route itself remains reachable so you can
confirm state and flip the toggle without leaving the view.

When ON: the sign-in form shows the BSC checkbox, the pre-reg prompt
fires once per signed-in session for pre-registered attendees who
forgot the checkbox, `#/bsc` runs the full intake / waiver /
confirmation flow, and the dashboard polls `bscCheckins` every 30
seconds (gated on tab visibility) to render arriving competitors.

### Uploading the roster

Export the Broadband Skills Challenge Registration Google Sheet as
CSV. Expected columns (case-insensitive, whitespace-tolerant):
Competitor name, Email address, Company, Office location, Job role /
title, Supervisor / Manager name, Supervisor / Manager email,
Supervisor / Manager phone, SCTE member ID, Reference ID, Submitted
at. Required columns are Competitor name and Email address — missing
either fails the upload with a 400. Unknown extra columns are ignored
without rejection.

In the admin Settings page, under the Broadband Skills Challenge
section, click "Upload BSC roster (CSV)". The native file picker
opens filtered to `.csv`. On submit the file is POSTed to
`/api/bsc-roster-upload` via the admin JWT, parsed server-side, and
upserted into `bscPreReg` keyed by lowercased email. The response
renders inline below the upload button as "Processed N rows → M
competitors in roster (K duplicate rows merged by email). L skipped."
plus a `<details>` block listing any per-row errors. The reconciled
wording explains the gap between CSV row count and final roster
count: multiple rows with the same email collapse into one roster
entry (`K duplicate rows merged`), rows with missing name or email
are reported with their row number and counted into `L skipped`; the
import continues through the rest of the file.

**Re-upload is an upsert.** A second upload with the same emails
updates the existing rows in place rather than replacing the whole
collection. New emails are appended. The design intentionally has NO
bulk-delete / roster-edit / roster-export UI for v1 — those surfaces
would need a design pass of their own and the shared BSC Google Sheet
remains the system of record for roster edits. If you need to remove
a row, do it in Firestore directly before event-morning, or do it in
the shared Sheet and re-upload a fresh CSV before go-live.

After a successful upload the status line below the button updates
to "N competitors in roster · Last imported <relative time>" — this
reads back from `bscRosterCount` and `bscRosterLastImportedAt` on
`appSettings/singleton`, which the Function maintains by counting
`bscPreReg` pages after each upload. While the just-completed upload
summary is still visible above, the status line condenses to just
"Last imported <relative time>" so the roster count is not shown
twice. If the count refresh fails (network blip, 5xx) the import
itself still succeeded; the status line will show the stale count
until a subsequent upload refreshes it. The errors block will note
"Count refresh failed" so you know to re-run.

### Viewing the current roster

The admin Settings page's BSC section includes a **View roster**
button next to the upload button. Click it to expand a read-only
panel listing every pre-registered competitor currently in Firestore,
sorted by Competitor name ASC. Columns: Competitor name, Email,
Company, Office location, Supervisor name, Reference ID. Job role,
supervisor email/phone, and SCTE member ID are intentionally omitted
from this view to keep the table skimmable — they are still accessible
via the Firestore console if needed.

Use this panel to confirm a CSV upload landed with the expected data,
or to spot-check that a competitor's row has the fields the sign-in
flow will match against. The panel refreshes automatically after each
successful upload if it is already open. The panel is read-only: edit
or delete the roster by re-exporting the Google Sheet and re-uploading
the CSV.

**Current ceiling: 500 entries.** The underlying call reads up to 500
`bscPreReg` docs. The 2026 roster was 41 unique competitors; 2027 is
budgeted at roughly the same size. If the chapter ever grows the event
past 500 competitors, add pagination (or raise the limit server-side)
before re-opening the panel on a bigger roster.

### Flipping waiver mode

Two radios in the Settings page's BSC section: **Paper** (reminder
only — attendee sees "please sign the paper waiver at the competition
table before competing" and the check-in record has empty signature
fields) and **Electronic** (admin-authored text + agreement checkbox +
typed-name signature). The seed default is Paper so a mis-flip of
`bscEnabled` doesn't surface an empty waiver to attendees.

The `bscWaiverText` textarea below the radios holds the full waiver
text. The "Save waiver text" button is disabled until the local draft
differs from the server state. Paste legal-reviewed copy here — do
NOT invent waiver copy inline; chapter counsel must sign off before
go-live.

**Empty-text fallback.** When mode is set to Electronic but the text
is empty after trim, the attendee flow silently falls back to paper
mode (sees the "sign at the table" reminder) and the check-in record
is stamped `waiver_mode: "paper"`. The admin Settings page surfaces a
warning banner above the textarea in this state so you know the
fallback is active. The banner clears reactively as soon as you type
non-empty text.

### Interpreting the dashboard

`#/bsc-checkins` renders 10 columns in this order: Name, Email,
Company, Office location, Pre-reg status (green `✓ Pre-registered`
chip or neutral `Walk-up` chip), Manager approval (green `✓ Yes` or
warning `✗ No` for walk-ups; `—` for pre-reg where the field is empty
by design), Waiver mode (neutral `Paper` or brand `Electronic`),
Waiver signed (relative time + ISO on hover for electronic; literal
`At table` for paper), Signature name (typed name for electronic;
empty for paper), Check-in time (relative time + absolute ISO on
hover).

**Warning rows.** Walk-ups with `manager_approved: "no"` get a
warning-palette background and a leading warning icon with
`aria-label="Walk-up without manager approval"`. Scan for these
during a busy check-in — the attendee answered honestly, their row
is captured, and a BSC coordinator should follow up before competition
start.

**Filters and search.** Three segmented controls (Pre-reg status,
Manager approval, Waiver mode) plus a 150ms-debounced search box that
matches name OR email case-insensitively. A "Clear filters" button
appears when any non-default filter is active. Default sort is
check-in time DESC with reference id ASC as the stable tie-breaker;
Name and Check-in time column headers are `<button>` elements that
toggle `aria-sort`.

### Known ceilings and limitations

- **1000-row dashboard ceiling.** `adminReadCollection("bscCheckins",
  { limit: 1000 })` caps the live dashboard at 1000 rows with no
  "truncated" indicator. 2027 is budgeted at 200 rows across the
  entire competition so this is purely a documentation checkpoint. A
  multi-day deployment would need paging / a "showing N of M" banner
  before going near this limit.
- **Reference ID format.** Walk-ups generate `BSC-YYYYMMDD-HHMMSS`
  with second resolution and no random suffix — matching the 2026
  Zap's on-the-wire format exactly so downstream Sheet workflows that
  text-sort on the reference id keep working. Two walk-ups whose
  waiver-step submits land in the same wall-clock second produce the
  same reference id. At N=200 walk-ups within a 2-hour window the
  probability of at least one same-second pair is roughly 50% — this
  is expected, not a bug. The **pre-launch checklist Section 6b item
  12** duplicate scan on the shared BSC Google Sheet is the primary
  mitigation; the BSC coordinator scans the reference id column and
  resolves collisions by hand (renumbering the second duplicate or
  appending `-A` / `-B`) before any downstream workflow consumes the
  data. The Firestore `bscCheckins` rows are keyed by UUID and
  unaffected.
- **Paper waiver audit trail.** Paper mode writes empty signature
  fields on the check-in record. The paper form at the competition
  table is the signed artifact for insurance / legal purposes — the
  app only records that the attendee was reminded.
- **Public-get on the roster.** `bscPreReg` is readable by any
  attendee client that knows an email AND the public Firestore API key
  (anyone with the app can read any specific competitor's row
  including their manager's contact info). The collection is NOT
  list-able so the full roster cannot be enumerated. If a future
  revision adds attendee-visible fields to the roster schema,
  consider whether that field should be visible under the public-get
  posture or whether the lookup should move behind an authenticated
  Function.

### Troubleshooting

- **"We recorded your check-in but could not sync with the
  registration sheet" banner.** The Firestore write succeeded; the
  BSC Zap POST failed. Check the Zap in Zapier for recent errors on
  the Catch Hook or the Google Sheets step. The check-in IS in the
  admin dashboard; manually copy the row into the shared Sheet to
  reconcile, or ask the attendee to re-check-in after the Zap is
  restored (will produce a duplicate dashboard row, which the
  dashboard's sort-by-check-in-time view and the coordinator can
  dedupe).
- **"We submitted your check-in to the registration sheet but could
  not record it in the admin dashboard" banner.** The Zap POST
  succeeded; the Firestore `bscCheckins` write failed. The shared
  Sheet has the row; the admin dashboard will not show it until the
  attendee re-check-ins or an admin manually creates the Firestore
  doc.
- **Pre-reg lookup fails on `#/bsc`.** The orchestrator shows an
  inline error with a Retry button and does NOT silently fall through
  to walk-up intake (would quietly promote every pre-registered
  competitor to walk-up on a transient read error). Have the attendee
  tap Retry; if the error persists, flip them to the walk-up form by
  entering an email the roster doesn't contain (last resort).
- **Some BSC Sheet columns populate but others are blank** (e.g.,
  Competitor name and Email address stay empty while the rest fill
  in). The Zap's trigger sample is stale from a prior season.
  See **Zapier staleness** in the Sign-In Integration section above —
  the fix pattern is identical for the BSC Zap.
- **Stale count after a count-refresh failure.** The upload succeeded;
  the subsequent `bscPreReg` page-sum failed. Re-run the upload with
  the same CSV; the second pass refreshes the count without duplicating
  rows (upsert).

---

## Live sign-ins dashboard

Phase 1 adds a new admin tab at `#/signins` that reads the Firestore
`signIns` collection directly. Each attendee sign-in from the in-app
form writes two records today: the existing Google Sheet row (via the
Zap, unchanged) and a new one-row-per-attendee Firestore document.
The Sign-Ins tab is the admin-facing view on the Firestore side; the
Google Sheet keeps running as the audit + email backup.

**One row per attendee in Firestore vs two rows in the Sheet.** When
an attendee signs in without checking the BSC competitor box, is
found in the pre-reg roster, and then accepts the "We see you're
pre-registered — want to check in?" prompt, the Zapier Sheet row
pattern produces TWO rows (first `bsc_competitor=no`, then
`bsc_competitor=yes`, both sharing the original `signed_in_at`) —
that behavior is documented in the Sign-In Integration section above
and is unchanged in Phase 1. The Firestore side does better: the
retroactive accept PATCHes the SAME `signIns/{docId}` document from
`bsc_competitor=no` to `bsc_competitor=yes` (via the new public
`/api/signin-mark-bsc` endpoint) and sets `updatedAt`, so the
Sign-Ins dashboard reads one-row-per-attendee without a dedupe pass.

**Columns and controls.** Nine columns in order: Name, Company,
Office location, Email, Phone, SCTE member #, Sign-in time
(relative, with the ISO timestamp as the hover title), BSC Competitor
badge, Source badge. Default sort is Sign-in time DESC with Name ASC
as the tie-breaker; click Name or Sign-in time to re-sort. One filter
chip (BSC Competitor: All / Yes / No) and a 300ms-debounced search
that matches case-insensitive substring on name OR email. The header
strip reads `N sign-ins · M today` where "today" is a local-day
comparison (not a UTC-string slice) so an admin in US Central doesn't
see mid-evening sign-ins mis-counted into the next day.

**Live refresh behavior.** 30-second polling gated on
`document.visibilityState === "visible"`; cached rows preserved on
poll failure with an inline Retry banner; 1000-row read ceiling —
2027 is budgeted at ~200 sign-ins so the ceiling is documentary.
Offline banner surfaces when the browser loses connectivity and the
poll suspends until the `online` event fires.

**Download CSV.** The sticky header carries a Download CSV button
that fetches the collection fresh via the admin broker (not the
30-second cached rows), builds an RFC-4180 CSV with UTF-8 BOM and
snake_case headers, and triggers a browser download named
`signIns-YYYYMMDD-HHMMSS.csv`. The CSV emits every field on the row
INCLUDING `signed_in_at`, `createdAt`, and `updatedAt` so the Zapier
locale-string + the admin-side ISO timestamps all round-trip. Three
other admin tabs (BSC Check-Ins, BSC Pre-Reg roster panel in
Settings, Attendees) get the same button with the same semantics.

**Phase 1 → Phase 3 narrative.** Phase 1 lands this view
non-destructively — both the Zapier POST and the Firestore create
fire for every sign-in, and both the Google Sheet and this dashboard
show the same data. Phase 2 is a real-use validation window with
both sources running in parallel. Phase 3 retires the Zapier leg once
Firestore is proven stable, and the Google Sheet becomes a historical
archive. If the Firestore side ever disagrees with the Sheet during
Phase 1, the Sheet is authoritative — the board already knows how
to read it.

---

## BSC pre-registration page

Phase 1 adds a URL-only standalone pre-registration page at
`#/pre-register-bsc` for managers who want to pre-register their
technicians directly into Firestore without the Google Form hop. The
page is NOT linked from any attendee-facing navigation and is NOT
gated by the `bscEnabled` toggle, so managers can pre-register
before the day-of toggle flips.

**Sharing the URL.** Send the full URL (`https://<deployment-host>/#/pre-register-bsc`)
to managers out-of-band — email, chat, printed on the booth briefing
sheet. There is no auth and the only backstop against spam is the
server-side rate limit of 10 submissions per IP per hour (shared KV
counter, isolated prefix from the admin-login counter). If a group of
managers is pre-registering a batch from the same office IP and hits
the ceiling, they'll see a "Too many submissions from this network"
Retry message and should wait an hour or use the admin roster CSV
upload instead.

**Fields and merge semantics.** The form captures 9 fields:
Competitor name, Email, Company, Office location, Job role,
Supervisor name, Supervisor email, Supervisor phone, SCTE member #
(optional). On submit the server upserts `bscPreReg/{emailLowered}`
with set+merge semantics, generates a `BSC-YYYYMMDD-HHMMSS` reference
id (4-char hex suffix on collision), and refreshes the roster count
on `appSettings/singleton` so the Settings panel's status line
updates on the next refresh.

**Re-submission semantics.** Re-submissions by the same email
overwrite every stored field, **including `reference_id`**. The
latest confirmation card always shows the authoritative reference id
for a given email; any older `BSC-YYYYMMDD-HHMMSS` the manager wrote
down from a prior submit is NOT retrievable from the Firestore
roster. This is a deliberate departure from the CSV-import path
(which preserves the id from the sheet) because the standalone form
has no stable "original row" concept — if a manager needs the
historical id, pull it from the browser's visible history or the
Google Form Zap backup for that email.

**No email confirmation in Phase 1.** The standalone page does NOT
send a confirmation email on submit. The existing Broadband Skills
Challenge Registration 2026 Google Form keeps running and keeps
emailing confirmations for managers who prefer that intake path. The
two intake paths both write into the same `bscPreReg` collection
(the CSV upload re-syncs from the Google Form Sheet; the standalone
page upserts directly), and the admin runbook captures the preference
for the Google Form among older attendees who want an email receipt.
A future phase may add email confirmations to the standalone page if
the mix tilts away from the Google Form, but that is deliberately
deferred — the Zap-and-email stack is already working and Phase 1 is
not the right time to re-litigate it.

**Retiring the Google Form later.** Once the standalone page has
captured a season or two of pre-registrations and the admin team is
comfortable with the merge semantics, the Google Form Zap can be
retired. The retirement path: stop sharing the Google Form link,
replace the admin runbook's Google Form section with the
`#/pre-register-bsc` section, and (optionally) run the Google Form's
historical responses CSV through the Admin → Settings → "Upload BSC
roster (CSV)" button one last time to ensure every historical entry
is reflected in `bscPreReg` before the Form is archived.

---

## Vendor Registration — attendee reconciliation (TODO for a future phase)

The chapter's Vendor Day Vendor Registration form (hosted on
GoDaddy, HTML the chapter already owns) captures the person who
filled out the form and paid for the booth. That is NOT necessarily
the same person — or the only person — who actually attends the show
and staffs the booth. In practice some sponsors pay via one contact
and send a different (or multiple) technicians to the floor, so the
pre-event attendee directory import built from the GoDaddy
form-fed roster is less accurate than it could be.

**What a future phase could add.** A per-booth attendee-list capture
step at check-in — when a vendor arrives, the booth coordinator
collects or confirms the names of the people actually attending for
that booth and writes them into the attendee directory alongside the
payer record. This would turn the pre-event import list into a
reliable "expected attendees" roster rather than a payer roster.

**Why not in Phase 1.** The GoDaddy page uses the chapter's eCommerce
tools to collect payment, and disrupting that payment flow — or
trying to recreate it in the PWA — is more work and risk than the
current gap justifies. The current implementation leaves the GoDaddy
form unchanged, pays attention to the gap, and defers the fix to a
later phase when the PWA has fully absorbed the sign-in and BSC
intake paths and the Vendor Registration path is the last Zap-fed
holdout. Flagged here so an admin reading the runbook understands
why the Vendor Day attendee directory may not perfectly match the
list of booth payers.

---

## Debug overlay

The attendee app ships with a hidden on-device diagnostic overlay for
field troubleshooting. It is not linked from any UI; you have to type
it in on the device you want to inspect. Nothing in the overlay is a
secret (no passphrase, no OneSignal REST key, no webhook URL — just
whether those values _reached_ the device), so it is safe to leave
turned on for the duration of a troubleshooting session.

**When to use it:**

- The attendee says a push arrived on one device but not another and
  you need to confirm which build the other device is running.
- The **Enable notifications** button dims and never resolves. The
  overlay's **Recent events** feed shows whether the OneSignal SDK
  loaded, whether `optIn()` was called, and whether a result came back.
- You suspect a device is running a stale service worker shell after
  a redeploy. The **BUILD_ID (sw.js)** row reports the id the device
  is actually serving, which you can compare against the latest
  Cloudflare build id.
- A field tester reports an in-app Sign-In form that fires but doesn't
  land a row in the Google Sheet. The **Config endpoint** section shows
  whether `signInWebhookUrl` reached the device via `/api/config`.

**How to turn it on:**

1. On the test device, append `?debug=1` to the attendee app URL.
   Once activated via `?debug=1` in Safari (or any browser tab), the
   overlay will persist in the installed PWA because the flag is stored
   in localStorage.
2. A small `🐞 DEBUG` tab appears in the bottom-right (bottom-center on
   narrow phone screens). Tap it to expand the panel.
3. To turn it off, tap the dismiss (×) button in the overlay, or append
   `?debug=0` to the URL in any tab.

**What each section shows:**

- **App version** — the service worker's `BUILD_ID`, the service
  worker's controller URL, its scope, and whether the localStorage
  flag is sticky. If `BUILD_ID` differs from the latest Cloudflare
  build id, the device is on a stale shell; use the **Unregister SW**
  action below.
- **Config endpoint** — whether `/api/config` loaded and the names
  of the keys it returned. The OneSignal App ID line reports presence
  only, masked to the last four characters so you can tell apart two
  OneSignal apps without sharing the full id in a screenshot. The
  `signInWebhookUrl` line reports `yes` or `no` — no URL text.
- **OneSignal state** — whether the SDK's `OneSignal` global is on the
  page, the `User.PushSubscription.optedIn` boolean, whether a
  subscription id exists (last 6 characters only), the SDK's
  `Notifications.permission` boolean, and the browser-native
  `Notification.permission` string. A device that reports
  `OneSignal.Notifications.permission: true` but a browser
  `Notification.permission: default` is in a weird intermediate state —
  typical cause is a push token that didn't survive a factory reset
  of the device.
- **App settings** — whether `appSettings/singleton` has loaded,
  whether `signInEnabled` is on, and how long ago the cache was
  populated.
- **Recent events** — the last twenty entries from a rolling in-memory
  log emitted by the app at key points (SDK init, subscribe/unsubscribe
  calls, settings fetch, Enable Notifications button taps). Newest
  first with wall-clock timestamps.

**Actions at the bottom of the panel:**

- **Copy debug text** — serializes the entire overlay (every section
  plus the events feed) into a plaintext block and writes it to the
  clipboard. Paste it into a chat message, support ticket, or email so
  someone with access to the Cloudflare / OneSignal dashboards can
  compare the on-device state against what the services actually show.
- **Re-check state** — re-queries SDK state without waiting for the
  one-second poll. Useful after an SDK event just fired.
- **Unregister SW** — asks for confirmation, then unregisters every
  service worker on the origin. The page reloads afterward. For a
  truly stale device, follow up by clearing site data in browser
  settings before reloading (the overlay reminds you with an alert).
- **Reload** — a plain full-page reload. The service worker still
  serves cached assets; use **Unregister SW** instead if you need to
  defeat the cache.

**Sharing debug output with support:** tap **Copy debug text**, then
paste the result into whatever channel you use to reach the orchestrator
or the dev team. The paste includes no secrets, no PII, and no
subscription ids — just metadata about what the device thinks is going
on. It is a safe thing to send over Slack, email, or screen-share chat.

---

## Known operational quirks

These are not bugs in the app; they are platform or vendor behaviors
the chapter has observed in testing and should expect to see again
during the event. Document them here so an admin triaging day-of
doesn't lose time hunting a cause that doesn't exist.

- **OneSignal dashboard labels iPads as "iPhone".** The Users &
  Subscriptions and Messages pages read the device class from the
  Safari user agent, and iPadOS Safari identifies as mobile Safari
  rather than iPad Safari. An iPad subscription will show "iPhone" in
  the Device column. To tell two devices apart when they both read as
  "iPhone", compare the first-session timestamps on each row, or send
  a push from the admin composer and watch which physical device
  buzzes. This is purely a labeling issue — delivery is unaffected.
- **Uninstalling the PWA on iOS does not immediately drop the
  OneSignal subscription.** When an attendee deletes the home-screen
  icon on iOS, Apple does not notify OneSignal. The dashboard entry
  continues to show as **Subscribed** until enough APNs delivery
  failures accumulate for OneSignal to tombstone it, which can take
  days. During the event this is not a problem — stale subscriptions
  just silently absorb the pushes nobody sees. Do not interpret an
  elevated "Subscribed" count on the OneSignal Messages page as proof
  the audience is intact after a long gap between events.
- **iOS first-push warm-up.** Covered above under
  **Troubleshooting push delivery → iOS first-push warm-up**. Listed
  here so the "known quirks" section is a single landing spot for
  anyone orienting on day-of weirdness; the detail stays with the
  troubleshooting flow where it is operationally actionable.
