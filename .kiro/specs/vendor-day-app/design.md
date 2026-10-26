# Design — SCTE Gateway Chapter Vendor Day 2027 PWA

## 1. Overview

This is a single-year, mobile-first Progressive Web App for the SCTE Gateway Chapter Vendor Day 2027, held at the Doubletree Chesterfield in Chesterfield, MO 63005 on a date to be confirmed between mid-May and early June 2027. Attendees reach it by scanning a QR code in their event email or at the check-in table and land at `2027vendorday.gatewayscte.org`. From the browser they are guided through installing the app to their home screen, after which it behaves like a native event app, including push notifications for schedule changes and announcements. There is no app-store presence. A small admin surface, protected by a shared passphrase, lets about three Gateway Chapter board members update the agenda, sponsor directory, venue map, attendee directory, feedback form, and recap, and broadcast push notifications during the event.

The app ships as vanilla HTML, CSS, and JavaScript with no framework and no build chain beyond a small optional static asset pass. Only free-tier external services are used: Cloudflare Pages for hosting, OneSignal for push, and a free-tier document store for mutable content. The implementer may use tiny vanilla libraries (e.g., `idb-keyval` for IndexedDB access, a UUID helper) when it genuinely reduces code. All attendee-facing features work without login, and no third-party analytics or trackers are included.

## 2. Architecture

### Static front-end
The site is a plain static bundle served from **Cloudflare Pages**, deployed from a GitHub repository. All HTML, CSS, JS, images, icons, and the service worker ship as flat files. Cloudflare provides automatic TLS, global CDN edge caching, and PR preview deployments at no cost on the free tier. The custom subdomain `2027vendorday.gatewayscte.org` is pointed at the Pages project via a CNAME at GoDaddy.

### Content data layer

Candidates considered:
- **Firebase Firestore (free Spark plan)**: real-time listeners, generous free quota (1 GiB storage, 50k reads/day, 20k writes/day), well-documented JS SDK, works with anonymous or custom-token auth. Vendor-lockish but no code lock-in beyond field names.
- **Supabase (free tier)**: hosted Postgres with REST and realtime over websockets. Powerful but heavier than needed for a dozen content documents and a few hundred attendees.
- **Cloudflare D1 / KV via Pages Functions**: same-vendor as hosting. Would require writing Pages Functions in JS, adding one more deploy artifact and a build step. Overkill for low-write content.
- **GitHub-committed JSON**: lightest possible, but every admin edit becomes a commit, which is awkward from a phone and requires either a GitHub token in the browser or an intermediary. Rejected for admin ergonomics.

**Decision: Firebase Firestore on the Spark free plan.** It is the lightest free-tier option that gives us (a) direct browser writes from the admin UI with no server component, (b) a real-time snapshot API so attendee devices get agenda and announcement updates within seconds, (c) sufficient free quota for an event of a few hundred attendees for an entire year, and (d) no new deploy pipeline. Writes are gated by the admin passphrase check at the application layer, and Firestore security rules enforce "reads are public, writes require a specific Firebase App Check token issued only to admins" (details in section 6). Vendor-lock risk is low because the data model is a flat set of JSON documents and could be migrated to Supabase or JSON files later.

**Admin reads of restricted collections.** Firestore rules deny client reads of `feedbackResponses` entirely and restrict `attendees` reads to `optedOut == false`. Admin UIs that need to read those collections (feedback results, attendee importer dedup) do so through the Pages Function `/api/firestore-read`, which validates the admin JWT and reads via the service account with Admin-SDK-equivalent privileges — same pattern as `/api/firestore-write`.

### Asset storage: Cloudflare R2

User-uploaded images (sponsor logos, the venue map, and recap photos) live in a **Cloudflare R2** bucket named `vendor-day-2027-assets`. The original design called for Firebase Storage, but Firebase changed its policy in 2026 to require the paid Blaze plan for any Storage usage, which breaks our free-tier posture. R2's free tier (10 GB storage, 1 M writes/month, 10 M reads/month, zero egress) is a clean replacement and keeps every runtime dependency in Cloudflare.

Public reads are served directly from the bucket's **public access URL** — a `https://pub-<hash>.r2.dev` hostname that Cloudflare assigns when public access is enabled on the bucket. The attendee client renders these URLs in plain `<img src>` tags; there is no proxy, no signed URL, and no egress cost. The absolute URL is stored on the Firestore document (`sponsors[*].logoUrl`, `appSettings.venueMapUrl`, `recap.photos[*].url`), so view code never has to compose a URL.

Writes go through a new Pages Function `functions/api/upload.js`, gated by the same admin JWT as `/api/firestore-write`. The function reads `multipart/form-data` (field names `file`, `kind`, `id`) and writes to R2 via the Pages-bound namespace `env.ASSETS_BUCKET`. Object keys follow a stable convention so re-uploads are predictable:

- Sponsor logos: `sponsors/<sponsorId>/<timestamp>.<ext>` (timestamped so cached copies invalidate on replace)
- Venue map: `venue-map/<timestamp>.<ext>` (same reason)
- Recap photos: `recap/<photoId>.<ext>` (stable key per photo id; display order lives on the recap document)

The R2 public hostname is also exposed to the browser via `/api/config` as `assetsBaseUrl` for future callers that want to resolve a bare object key — v1 does not need this because the Firestore docs carry absolute URLs.

### Push notifications
**OneSignal free tier** (unlimited web push subscribers, broadcast sends). The attendee side uses the OneSignal Web SDK to request permission and register the subscription. The admin side composes an announcement in the in-app admin UI, which then calls OneSignal's REST API `POST /notifications` to broadcast. The OneSignal REST API key is stored as a secret environment variable at Cloudflare Pages and reached through a tiny Pages Function (`/api/send-push`) so the key never ships to the browser.

### Registration ingest

Candidates considered for pulling attendee rows from the registration Google Sheet into the Attendee Directory:
- **Admin exports CSV from the sheet and uploads via admin UI**: PII stays with the admin and the Google account. Admin runs it on demand (typically once a few days out, then again the morning of the event). Simple to implement with the `File` API and `PapaParse`-style CSV parsing, or even hand-rolled parsing for the known column set.
- **App reads a Published-to-Web Sheets URL as CSV**: Convenient, but Published-to-Web makes the sheet publicly readable at a guessable URL and would expose attendee PII to anyone who finds it. Rejected.
- **Google Apps Script Web App with a shared secret**: Admin deploys a one-page Apps Script bound to the sheet; the Script accepts GET with a `?key=` header, returns JSON. Flexible but adds a second system to maintain and a secret to rotate.

**Decision: Admin CSV upload.** PII never flows through a public URL, there is no additional Google-side artifact to maintain, and the admin is already in the Google Sheet to confirm registrations before the event. The admin UI accepts a `.csv` drop or picker, previews a parsed table with per-row opt-out toggles, and writes the final list to the Firestore `attendees` collection on confirm.

### Diagram

```
                 QR code / email link
                          |
                          v
             +---------------------------+
             |  2027vendorday.           |
             |  gatewayscte.org          |   (CNAME at GoDaddy)
             +------------+--------------+
                          |
                          v
             +---------------------------+
             |  Cloudflare Pages         |
             |   - static HTML/CSS/JS    |
             |   - service worker        |
             |   - /api/send-push (fn)   |---> OneSignal REST (push broadcast)
             |   - /api/upload   (fn)    |---> Cloudflare R2
             +------+-----------+--------+     (vendor-day-2027-assets)
                    |           |                  ^
       public read  |           | admin writes     | admin uploads via
                    v           v                  | env.ASSETS_BUCKET
             +---------------------------+   +---------------------------+
             |  Firebase Firestore       |   |  Cloudflare R2            |
             |   agenda, sponsors,       |   |  (vendor-day-2027-assets) |
             |   announcements,          |   |   sponsors/<id>/*,        |
             |   attendees, feedback,    |   |   venue-map/*,            |
             |   recap, appSettings      |   |   recap/*                 |
             +---------------------------+   +---------------------------+
                                                     ^
                                                     | public image reads
                                                     | (pub-<hash>.r2.dev)
                                                 Attendee browser

   Attendee browser  <------ OneSignal Web SDK ------> OneSignal push service
   Admin browser     ------  CSV upload (Google Sheet export) ------> Firestore attendees
```

## 3. Information Architecture & Navigation

The attendee app uses a mobile-first bottom tab bar with five tabs, plus a Home view reached by the app icon or logo in the header. The tab bar is sticky, has large touch targets (minimum 44 x 44 CSS px), and uses labeled icons with ARIA labels. The five tabs are:

1. **Home** — welcome card, "happening now" strip from the agenda, latest announcement, quick links to Map and Sponsors.
2. **Agenda** — chronological list of sessions, deep-linkable to individual sessions.
3. **Sponsors** — grouped by tier.
4. **Map** — static venue map, pinch to zoom.
5. **More** — hub for Attendees, Announcements, Feedback, Recap (once published), About/Install, and the hidden Admin entry.

Announcements and Attendees are frequent-use enough that their badges (unread announcement count, directory count) appear on the More tab's icon.

Deep-linking: each session, sponsor, announcement, and attendee has a hash route (`#/agenda/<id>`, `#/sponsors/<id>`, `#/announcements/<id>`, `#/attendees/<id>`). The service worker uses hash routing so the single `index.html` can serve all views offline.

**Admin area** lives at `/admin` on the production domain. Once authenticated, it uses its own left-rail navigation on desktop and a top drop-down on phone:
- Dashboard (last-updated summary + push send log)
- Agenda editor
- Sponsors editor
- Venue map
- Announcements composer
- Attendees importer
- Feedback (config + results)
- Recap editor
- Settings (passphrase rotation note, OneSignal diagnostic)
- Log out

## 4. Screen Designs (text wireframes)

Every screen renders inside the same shell: a fixed top header with the Gateway Chapter mark on the left and a small overflow menu on the right; a scrollable main region; and (for attendee views) the fixed bottom tab bar. All screens expose three UX states where applicable: **empty** (data not yet published), **loading** (initial fetch), and **error** (fetch failed or offline). Primary CTAs use the chapter green `#2E8B57`; destructive actions use `#B30000` on `#FFF0F0`.

### Attendee screens

**Welcome / Install (first run)**
- Header: Gateway Chapter logo + "SCTE Gateway Chapter Vendor Day 2027"
- Body: event summary card (date placeholder, Doubletree Chesterfield, Chesterfield MO), then a platform-detected install card ("Tap Share, then Add to Home Screen" with an inline illustration on iOS Safari; "Install app" button triggering `beforeinstallprompt` on Android Chrome; a plain "Continue in browser" fallback)
- Secondary: "I'll do this later" link that routes to Home
- Empty: n/a (static)
- Loading: skeleton of the install card for ~200ms (no real fetch happens here)
- Error: n/a — this view does not fetch

**Home**
- Header: logo, overflow menu
- Body: "Welcome" card; "Happening now" strip (current session title + room, or "Starts at ..."); "Latest announcement" card (title + 2-line snippet + timestamp); quick action buttons: Open Agenda, Open Map, Open Sponsors
- Empty: "Agenda coming soon" and "No announcements yet" placeholder copy
- Loading: skeleton rectangles for each card
- Error: inline retry button, "Showing last-saved content" banner when offline

**Agenda (list)**
- Header: logo, overflow menu; sticky secondary header "Agenda — <event date>" or "Agenda" if date TBD
- Body: time-slot groups ("9:00 — 10:00 AM", "10:15 — 11:00 AM", ...). Each session card shows title, speaker (if any), room, and a chevron. "Happening now" badge on the active session.
- Empty: friendly placeholder ("Agenda coming soon — check back closer to the event")
- Loading: 4 shimmer rows
- Error: retry + offline banner; cached list rendered beneath

**Agenda Session Detail**
- Header: back arrow, session title truncated
- Body: start-end time, room, speaker name + bio paragraph, description, "Add to calendar" ICS link
- Empty: n/a (routed only when a session exists)
- Loading: skeleton
- Error: "Could not load this session" + Back

**Sponsors (list)**
- Header: logo + "Sponsors"
- Body: tiered groups (Platinum, Gold, Silver, Supporter) with a header per tier. Each entry: logo thumbnail (or chapter-mark placeholder), company name, booth number if present
- Empty: "Sponsor list coming soon"
- Loading: tile skeletons
- Error: retry + offline banner

**Sponsor Detail**
- Header: back + sponsor name
- Body: logo, tier chip, description paragraph, website link (opens in-app browser via `target="_blank" rel="noopener"`), booth number + "Find on map" link that jumps to Map view, optional contact email as `mailto:`
- Empty/Loading/Error: as above

**Venue Map**
- Header: logo + "Venue Map"
- Body: zoomable image container (CSS `touch-action: pinch-zoom`, with double-tap zoom via JS). Caption area below shows map legend text ("Doubletree Chesterfield Exhibit Hall — ~46 numbered vendor booths; specialty stations along the north wall; Jeopardy / Cable Tec Games center floor; Registration Table by the Main Doors; Coffee & Water in the secondary room").
- Empty: placeholder image with watermark "Final map will be posted before the event"
- Loading: shimmer rectangle
- Error: offline banner over cached image or the placeholder

**Announcements**
- Header: logo + "Announcements"
- Body: on first visit, a push opt-in card appears at the top explaining why to enable notifications; "Enable" button triggers `Notification.requestPermission()` via OneSignal SDK. The card dismisses once a decision is recorded. Below the card, announcements in reverse chronological order, each as a card with title, body (markdown-rendered), timestamp, and "Gateway Chapter Board" byline.
- Empty: "No announcements yet. We will post schedule changes and reminders here throughout the event."
- Loading: 3 shimmer cards
- Error: retry; offline banner

**Attendee Directory**
- Header: logo + "Attendees"
- Body: search field (debounced 150ms, filters name + company), list of rows each showing name on the first line and `company — title` on the second (title omitted when absent). Taps open the detail sheet.
- Empty: "Attendee list will populate as registrations finalize"
- Loading: shimmer rows
- Error: retry + offline banner

**Attendee Detail**
- Half-sheet modal (full screen on narrow viewports)
- Body: large name, company, title (if any). No contact info. A note at the bottom: "Attendees are listed by the registration list. To opt out, see the check-in table."
- Empty/Loading/Error: n/a (opened only when loaded)

**Feedback**
- Header: logo + "Event Feedback"
- Body: short description, then the configured questions (star-rating rows and a free-text box), submit button. If already submitted on this device, show a confirmation card with the submission date instead and no form.
- Empty: "Feedback opens during the event — check back soon."
- Loading: skeleton of the question list
- Error: when submit fails or the device is offline, inline red banner "Feedback could not be submitted. Please check your connection and try again." The user's answers remain filled in. No local queueing.

**Recap**
- Header: logo + "Recap"
- Body: thank-you message, acknowledgments, photo gallery (lazy-loaded `<img loading="lazy">`), optional links to post-event content.
- Empty: this view is not shown in the More menu until an admin publishes a recap.
- Loading: skeleton gallery
- Error: retry + offline banner

### Admin screens

**Admin Login (`/admin`)**
- Header: minimal logo + "Admin"
- Body: single passphrase field, "Sign in" button, inline error "Incorrect passphrase" with rate-limit messaging after 5 attempts in 10 minutes
- Loading: button spinner during hash check
- Error: as inline message

**Admin Home (Dashboard)**
- Header: logo + "Admin — Dashboard" + logout
- Body: cards showing last-updated metadata for each content area (`agenda — updated 2h ago by admin`), last 10 push sends, system health (Firestore reachable, OneSignal reachable). Each card links to its editor.
- Empty: "No content published yet" per card
- Loading: skeleton cards
- Error: per-card retry

**Agenda Editor**
- Header: logo + "Admin — Agenda" + logout
- Body: ordered list of sessions with inline edit/delete; "Add session" button. Edit opens a modal with title, start/end time, room, speaker name, speaker bio, description. Save writes to Firestore and surfaces a toast; the dashboard "last updated" chip reflects the save.
- Empty: "No sessions yet — Add one"
- Loading: skeleton rows
- Error: toast on save failure, dialog stays open with values intact

**Sponsor Editor**
- Header: logo + "Admin — Sponsors" + logout
- Body: tier-grouped list with reorder handles within a tier; "Add sponsor" button. Modal captures name, tier, booth number, website, email, description, logo file (uploaded via `/api/upload` to Cloudflare R2, public URL stored on the sponsor document).
- Empty / Loading / Error: as agenda

**Venue Map Uploader**
- Header: logo + "Admin — Venue Map" + logout
- Body: current image preview, "Replace image" file picker (accepts PNG, JPG, max 5 MB), caption textarea, "Save" button
- Empty: default placeholder shown with "No map uploaded yet"
- Loading: upload progress bar
- Error: inline "Upload failed — try again" with the original image still visible

**Announcement Composer + Push Toggle**
- Header: logo + "Admin — Announcements" + logout
- Body: list of past announcements (edit / delete inline) at the top, then composer below: title, body (markdown-friendly textarea), checkbox "Send as push notification", push preview (title + first 120 characters), "Publish" button
- When "Send push" is checked, publishing calls `/api/send-push` after the Firestore write
- Loading: button spinner during publish
- Error: toast "Could not publish — try again"; the push toggle is remembered; if the Firestore write succeeded but the push send failed, show an explicit "Published but push did not send — retry push?" state

**Attendee Directory Importer**
- Header: logo + "Admin — Attendees" + logout
- Body: file picker accepting `.csv`; after parse, a preview table of parsed rows with per-row "Include" / "Opt out" toggles; column mapping dropdowns if headers don't match the expected schema; "Replace directory" (destructive) and "Merge" (upsert by email) buttons
- Empty: no file selected — show instructions ("Export the registration Google Sheet as CSV, then upload here")
- Loading: parse spinner, then save spinner
- Error: inline per-row error for malformed rows; a top banner for whole-file errors

**Feedback Config + Results**
- Header: logo + "Admin — Feedback" + logout
- Body: tabs for "Form" and "Results". Form tab: ordered list of questions with type (rating 1-5, short text, long text) and reorder handles; "Activate form" toggle. Results tab: aggregated chart per rating question (count per star) and a scrollable list of free-text answers; "Export CSV" button (available only in the active event year).
- Empty: "No responses yet" on the Results tab
- Loading: skeleton charts
- Error: retry + toast

**Recap Editor**
- Header: logo + "Admin — Recap" + logout
- Body: thank-you message editor, acknowledgments editor, photo uploader with drag-reorder, "Publish recap" button, checkbox "Send a push when I publish"
- Empty: all sections unfilled
- Loading: upload progress per photo
- Error: inline retry per photo; publish surfaces a toast

## 5. Data Model

All documents live in Firestore in a single project. Collections are flat and document-friendly. All timestamps are ISO 8601 strings in UTC. All ids are v4 UUIDs generated client-side.

### `agenda/{id}` — AgendaSession
```
{
  id:          string (uuid, required)
  title:       string (required, 1-120)
  description: string (optional, 0-2000)
  startAt:     string (ISO 8601, required)
  endAt:       string (ISO 8601, required, must be > startAt)
  room:        string (optional, 0-60)
  speaker:     { name: string, bio: string } | null
  order:       number (fallback sort when start times tie)
  updatedAt:   string (ISO 8601)
  updatedBy:   string (admin display name — "Board member A", "Board member B", ...)
}
```

### `sponsors/{id}` — Sponsor
```
{
  id:          string (uuid, required)
  name:        string (required, 1-120)
  tier:        "platinum" | "gold" | "silver" | "supporter" (required)
  description: string (optional, 0-2000)
  website:     string (optional, URL)
  email:       string (optional, email)
  boothNumber: string (optional, free-text so "A3" is valid)
  logoUrl:     string (optional, Cloudflare R2 public URL — key `sponsors/<id>/<timestamp>.<ext>`)
  order:       number (within-tier sort)
  updatedAt:   string
  updatedBy:   string
}
```

### `announcements/{id}` — Announcement
```
{
  id:         string (uuid, required)
  title:      string (required, 1-120)
  body:       string (required, 1-2000, markdown allowed)
  publishedAt:string (ISO 8601, required)
  pushSent:   boolean (default false — flipped true after /api/send-push returns 200)
  pushSentAt: string | null
  updatedAt:  string
  updatedBy:  string
}
```

### `attendees/{id}` — Attendee
```
{
  id:        string (uuid, required)
  name:      string (required, 1-120)
  company:   string (required, 1-120)
  title:     string | null (optional, 0-120)
  optedOut:  boolean (default false — set true to hide from directory)
  importedAt:string (ISO 8601)
  updatedBy: string
}
```
Note: no email, phone, or SCTE member number is stored client-readable in Firestore. The source CSV may contain more fields; the importer discards them before writing.

### `feedbackConfig/singleton` — FeedbackConfig (one doc)
```
{
  active:    boolean (default false — attendees see empty state until true)
  questions: [
    {
      id:   string (uuid)
      type: "rating" | "short" | "long"
      text: string (required, 1-200)
      required: boolean (default false)
      order: number
    }
  ]
  updatedAt: string
  updatedBy: string
}
```

### `feedbackResponses/{id}` — FeedbackResponse
```
{
  id:          string (uuid)
  submittedAt: string (ISO 8601)
  answers: [
    { questionId: string, value: number | string }
  ]
  // No attendee identity. Device dedupe uses localStorage key, not server-side.
}
```

### `recap/singleton` — RecapContent (one doc)
```
{
  published:    boolean (default false)
  publishedAt:  string | null
  thanksMessage:string (optional, 0-2000)
  acknowledgments: string (optional, 0-2000, markdown allowed)
  photos: [
    { id: string, url: string (Cloudflare R2 public URL — key `recap/<id>.<ext>`), caption: string, order: number }
  ]
  updatedAt: string
  updatedBy: string
}
```

### `appSettings/singleton` — AppSettings
```
{
  eventTitle:   string (default "SCTE Gateway Chapter Vendor Day 2027")
  eventDate:   string | null (ISO 8601 date, no time — placeholder until confirmed)
  venueName:    string (default "Doubletree Chesterfield")
  venueAddress: string (default "Chesterfield, MO 63005")
  venueMapUrl:  string | null (Cloudflare R2 public URL for the uploaded map — key `venue-map/<timestamp>.<ext>`)
  venueMapCaption: string
  updatedAt:    string
  updatedBy:    string
}
```

Relationships are intentionally minimal: there are no foreign keys between sponsors and sessions, between attendees and feedback, or between announcements and anything else. All reads are either whole-collection or single-document.

## 6. Admin Authentication

The admin surface uses a single shared passphrase, chosen out-of-band by the Gateway Chapter board and communicated to roughly three admins. The passphrase itself never ships in the repo; a **salted PBKDF2-SHA-256 hash** (310,000 iterations, 16-byte random salt, both base64-encoded) is stored as a Cloudflare Pages environment variable `ADMIN_PASSPHRASE_HASH` and read at runtime by a Pages Function `/api/admin-login`. The function accepts a POST with the submitted passphrase, re-derives the hash with the stored salt, performs a constant-time comparison, and on success returns a short-lived signed JWT (HS256, 12-hour expiry) using a secret `ADMIN_JWT_SECRET`. The client stores that JWT in `sessionStorage` and attaches it as `Authorization: Bearer <jwt>` on every admin API call (`/api/send-push`, Firestore writes brokered through `/api/firestore-write`).

Firestore security rules are configured as **public read on all content collections, writes denied by default**. Admin writes do not go directly from the browser to Firestore — they go through a tiny Pages Function (`/api/firestore-write`) that validates the admin JWT first, then uses the Firebase Admin SDK with a service account key stored in `FIREBASE_SERVICE_ACCOUNT_JSON` to perform the write. This keeps the Firestore write-side locked down without needing Firebase Authentication for the admins themselves.

**Rate limiting** on `/api/admin-login` is enforced by Cloudflare: a Durable Objects or KV-backed counter (whichever the free Workers tier offers; implementer can start with KV) blocks more than 5 failed attempts from a single IP within 10 minutes, returning HTTP 429 with a `Retry-After` header for 10 minutes. Successful logins reset the counter for that IP.

**Session revocation** is coarse: because the JWT is self-contained, the only way to invalidate active sessions early is to rotate `ADMIN_JWT_SECRET`, which invalidates every outstanding token. This is acceptable for a ~3-admin, event-week deployment. A "sign out everywhere" button in Settings documents this and triggers a redeploy with a rotated secret.

**Logout** on the client clears the JWT from `sessionStorage` and redirects to `/admin`.

**Concurrent edits.** Last-write-wins is acceptable for a shared passphrase group of three. Every writable document carries `updatedAt` and `updatedBy`, surfaced in the admin dashboard and in each editor's header ("Last edited 3 minutes ago by Board member A"). An editor opens a document with a snapshot timestamp and, before saving, checks the current server `updatedAt`; if it is newer than the snapshot, a non-blocking banner warns "This content was edited by someone else since you opened it — your save will overwrite their change" with an explicit "Overwrite" or "Reload" choice. This is a soft safeguard, not a lock.

## 7. Push Notification Flow

### Attendee subscription
- The OneSignal Web SDK is loaded on the Announcements view only (not on first paint of the whole app), via a dynamic `<script>` import to keep the initial payload small.
- On a user's **first visit to Announcements**, the opt-in card renders. If the user taps "Enable", the SDK calls `OneSignal.Notifications.requestPermission()` which triggers the browser-level prompt and, on acceptance, registers the device with OneSignal.
- On iOS Safari, the SDK will not even offer this flow unless the app is running from the installed home-screen icon on iOS 16.4+. The opt-in card detects this (via `navigator.standalone` or `display-mode: standalone`) and shows a different variant: "Install this app first to receive notifications. Tap the Share button and then Add to Home Screen."
- The subscription id is managed by OneSignal; the app does not store any user identity.
- If permission is granted and later revoked at the OS level, on next app open the client reads `Notification.permission` and, if it is `"denied"`, surfaces a non-intrusive banner on Announcements: "Notifications are turned off. Enable them in your device settings." No automatic re-prompt (browsers block re-prompts after denial).

### Admin send
- In the Admin Announcements composer, when the "Send as push notification" box is checked and the admin taps Publish:
  1. The client calls `/api/firestore-write` to create the announcement document.
  2. On success, the client calls `/api/send-push` with `{ announcementId, title, bodyPreview }` and the admin JWT.
  3. `/api/send-push` validates the JWT, then calls `POST https://onesignal.com/api/v1/notifications` with the OneSignal `app_id`, the `ONESIGNAL_REST_API_KEY` as the `Authorization: Basic` header, `included_segments: ["All"]`, headings, contents, and a `url` field set to `https://2027vendorday.gatewayscte.org/#/announcements/<announcementId>`.
  4. On OneSignal's 200 response, the function performs a secondary Firestore write to set `pushSent: true` and `pushSentAt`.
- Failure modes:
  - Firestore write fails: show composer error, offer retry, do not send push.
  - Firestore write succeeds but push send fails: show "Published, but push did not send — retry push?" state with a button that re-calls `/api/send-push` only.
  - OneSignal returns a quota or auth error: surface the specific error message to the admin; log it on the server side.

### Deep link on tap
When OneSignal delivers a notification with a `url` field, the browser opens that URL on tap. The service worker intercepts the fetch, routes to the hash path `#/announcements/<id>`, and the Announcements view scrolls that announcement into view (with a brief highlight style for ~2 seconds).

### Secrets layout
- `ONESIGNAL_APP_ID` — public, can live in a JS config file.
- `ONESIGNAL_REST_API_KEY` — secret, Cloudflare Pages environment variable, server-side only.
- `ADMIN_PASSPHRASE_HASH`, `ADMIN_JWT_SECRET`, `FIREBASE_SERVICE_ACCOUNT_JSON` — secrets, Cloudflare Pages environment variables, server-side only.

## 8. Service Worker & Offline Strategy

The service worker (`/sw.js`) uses a tiered cache strategy:
- **App shell** (`/`, `/index.html`, main CSS, main JS, icon set, manifest, offline fallback page): **cache-first** with a versioned cache name (`shell-v<build-timestamp>`). On install, pre-cache the full shell. On activate, delete older shell caches.
- **Content JSON** (Firestore responses for agenda, sponsors, announcements, attendees, recap, feedback config): **network-first with cache fallback** in a cache named `content-v<build-timestamp>`. On successful fetch, update the cache. On fetch failure (offline or 5xx), serve from cache and set a global "offline" flag that the UI reads to show a non-intrusive banner.
- **Images** (sponsor logos, venue map, recap photos): **cache-first** with an LRU-ish cap. The service worker tracks entries in the `images-v<build>` cache; once count exceeds 60 or total approximate size exceeds 15 MB (estimated via `Response.clone().arrayBuffer().byteLength` samples), the oldest entries are evicted. Full-fidelity LRU is not required — a simple "delete oldest N on quota" is sufficient.
- **Feedback submission**: **online-only**, per the resolved decision. The client's submit handler does a `navigator.onLine` check and, if offline, surfaces the "could not submit" error without hitting the network. If online but the request fails, no queue is kept.

**Service worker versioning**: cache names include the build timestamp injected at deploy time by a small Pages build step (`npm run build` runs a 30-line Node script that reads `package.json` version + timestamp and writes `/sw.js` with placeholders filled). On each new deploy, the service worker's `install` event pre-caches the new shell, `activate` deletes the previous shell cache, and `self.skipWaiting()` + `clients.claim()` are called so attendees pick up the new version on their next visit without a hard refresh.

**Update notice.** When the service worker detects a new version available, a non-blocking "App updated — tap to reload" banner shows at the bottom of the screen.

## 9. PWA Installation UX

### First-run flow
1. Platform detection runs synchronously on the Welcome screen: `/iPhone|iPad|iPod/.test(navigator.userAgent)` for iOS, `beforeinstallprompt` listener for Android Chrome, `navigator.standalone` / `display-mode: standalone` to detect "already installed".
2. If already installed → skip Welcome and route to Home.
3. On iOS Safari, show a card with an animated "tap Share → scroll → Add to Home Screen" sequence (a static image set with alt text; no animated GIF, no video).
4. On Android Chrome, show an "Install app" button; when the user taps it, call `deferredPrompt.prompt()` from the stashed `beforeinstallprompt` event. On outcome, dismiss the card.
5. On unsupported browsers (desktop Firefox, older iOS), show a notice: "Push notifications aren't available in this browser, but the rest of the app works."
6. "Continue in browser" is always available.

### Post-install return
If the app detects `display-mode: standalone` on launch, it skips the Welcome screen on all subsequent visits and routes to Home.

### Install access later
From the More tab, "About & Install" opens a view with the same platform-specific instructions, reachable at any time.

### Push subscription prompt deferral
Per the resolved decision and Requirement 2.1, the push opt-in is not shown during Welcome. It is shown as a card at the top of the Announcements view on the user's first visit. Once dismissed (either accepted, declined, or closed), the card does not re-appear automatically. A persistent "Enable notifications" entry remains available in About & Install for re-prompt.

## 10. Hosting, Build, and Deploy

### Repository structure
```
/
├── public/              # everything deployed as static
│   ├── index.html       # single entry; hash router handles views
│   ├── manifest.webmanifest
│   ├── sw.js            # service worker (built with cache name injected)
│   ├── css/
│   │   └── app.css
│   ├── js/
│   │   ├── app.js       # bootstrapping, router, state
│   │   ├── firebase.js  # read-only Firestore client wiring
│   │   ├── onesignal.js # lazy-loaded on Announcements first-visit
│   │   └── views/       # one file per view (agenda.js, sponsors.js, ...)
│   ├── admin/
│   │   ├── index.html   # admin shell (served at /admin)
│   │   └── js/          # admin-only JS
│   ├── assets/
│   │   ├── icons/       # PWA icons (192, 512, maskable)
│   │   ├── placeholders/# default map image, logo placeholder
│   │   └── brand/       # chapter logo variants
│   └── api/             # (Cloudflare Pages Functions mirror)
├── functions/           # Cloudflare Pages Functions source
│   ├── admin-login.js
│   ├── firestore-read.js
│   ├── firestore-write.js
│   ├── send-push.js
│   └── upload.js        # multipart upload broker → Cloudflare R2
├── scripts/
│   └── build-sw.js      # 30-line Node script to stamp sw.js
├── docs/
│   ├── admin-runbook.md
│   └── deployment.md
├── package.json         # scripts only — no runtime deps
└── .github/workflows/   # optional CI
```

### Build
- `npm run build` runs `scripts/build-sw.js`, which reads a `BUILD_ID` env var (Cloudflare provides one), substitutes it into `public/sw.js`'s cache name placeholder, and writes the file in place.
- No bundler, no transpiler. Everything is served as-is.
- Cloudflare Pages settings: **Framework preset: None**, **Build command: `npm run build`**, **Build output directory: `public`**, **Node version: 18**.

### Branch workflow
- `main` is the production branch. Pushes to `main` deploy to `2027vendorday.gatewayscte.org`.
- Any other branch creates a preview deployment at `<branch>.<project>.pages.dev`. Previews are useful for review before merging agenda or feedback copy changes.
- There is no separate staging environment. The event is one day; previews on branches are the pre-prod story.

### Custom domain
At GoDaddy, add a CNAME record for the host `2027vendorday` on the `gatewayscte.org` zone pointing at `<project>.pages.dev`. Cloudflare auto-provisions a Universal SSL certificate. HTTPS is enforced via Cloudflare's "Always use HTTPS" page rule equivalent (the Pages default).

### Environment variables (Cloudflare Pages → Settings → Environment variables)
Production and Preview scopes:
- `ONESIGNAL_APP_ID` — public (safe for the client to read)
- `ONESIGNAL_REST_API_KEY` — **secret**, server-only
- `ADMIN_PASSPHRASE_HASH` — **secret**, server-only
- `ADMIN_JWT_SECRET` — **secret**, server-only
- `FIREBASE_SERVICE_ACCOUNT_JSON` — **secret**, server-only (full service account JSON pasted as a single-line string; used by `/api/firestore-write` for Firestore REST calls)
- `FIREBASE_PROJECT_ID` — public
- `FIREBASE_WEB_API_KEY` — public (used for read-only Firestore client auth; locked down by security rules)
- `R2_PUBLIC_URL` — public (plain-text), the `https://pub-<hash>.r2.dev` hostname Cloudflare assigns to the `vendor-day-2027-assets` R2 bucket. Also returned to the client via `/api/config.assetsBaseUrl`.

### R2 bindings (Cloudflare Pages → Settings → Functions → R2 bucket bindings)
Not environment variables — bindings. Production and Preview scopes:
- `ASSETS_BUCKET` → `vendor-day-2027-assets`. The upload Function reads `env.ASSETS_BUCKET.put(key, body, opts)`.

## 11. Accessibility Plan

### Color palette and contrast
Primary green `#2E8B57` on white gives a contrast ratio of 3.76:1 — adequate for large text and UI boundaries, but not for body text. The design uses a darker companion `#1F6B40` for text on white where the chapter green appears as a text color, giving 5.4:1 (passes WCAG AA for body text). Attendee-facing body text uses `#222` on `#FFFFFF` (16:1). Secondary text uses `#555` on white (7.5:1). Error red `#B30000` on `#FFF0F0` meets 4.8:1 for its usage.

### Typography and scaling
Base font size is 16px (1rem). All text sizes are expressed in `rem` so the OS text-size setting multiplies cleanly. The design supports 200% OS text scaling with no clipped text (verified by reflow at an effective 32px base). Line heights are `1.4` for body, `1.2` for headings.

### Landmark structure
Every page has `<header>`, `<nav>` (bottom tab bar), `<main>`, and `<footer role="contentinfo">` only where applicable. The top-level app skeleton exposes `role="application"` on nothing — plain HTML landmarks are used throughout so screen readers get native semantics. Each view's `<main>` has a dynamically updated `<h1>` matching the view title. A visually hidden "Skip to content" link is the first focusable element on each page.

### Focus and interactive elements
All interactive elements (buttons, links, inputs, tab bar entries) have a 2px solid outline in `#2E8B57` with a 2px offset, triggered on `:focus-visible`. No outline is removed. Minimum touch target is 44 x 44 CSS px. The bottom tab bar is keyboard-navigable with arrow keys (ARIA tab pattern) and announces active state via `aria-selected`.

### Forms
Every input has an associated `<label>` (either wrapping or with `for=`). Error messages are associated via `aria-describedby`. The admin passphrase field is `type="password"` with `autocomplete="current-password"`. Rating inputs in Feedback use `<fieldset>` + `<legend>` for the question, with radio inputs for stars.

### Screen-reader-only text
A `.sr-only` utility class (`position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0);`) hides text visually while keeping it in the accessibility tree. Icons in the tab bar use `aria-label` on the surrounding button and `aria-hidden="true"` on the icon glyph.

### Known limits
Automated tooling (axe, Lighthouse) will be run on every view in CI. Full WCAG 2.1 AA compliance verification requires manual testing with screen readers (VoiceOver on iOS, TalkBack on Android, NVDA on Windows) and keyboard-only walkthroughs. These are called out as pre-launch tasks, not design assertions.

## 12. Carry-Forward from Prior Vendor Day Pages

Reading the three HTML modules at `C:\Users\phunter\OneDrive - Charter Communications\Documents\Kiro\Vendor Day HTML\` (Vendor Day Pre-Registration, Vendor Day Registration, Vendor Day Sign In), the recurring design language is clear and worth carrying forward:

**Carry forward:**
- **Primary brand green `#2E8B57`** on all primary CTAs and section-header surfaces. Used identically across all three prior modules.
- **Status pattern**: success message block with `background: #EAFAF0; border: 1px solid #C7F0D6; color: #2E7D32`, error block with `background: #FFF0F0; border: 1px solid #F2C6C6; color: #7A1B1B`. These two patterns are visible on every prior module and will be reused for app-wide toasts, inline validation errors, and offline banners.
- **Required-field asterisk** in red (`#B30000` here, slight normalization from `red`/`#b30000` in the originals).
- **Rounded corners** at 4-5px on buttons and cards.
- **Input baseline**: 10px padding, 16px font-size (prevents iOS zoom), 1px `#CCC` border, 4px radius.
- **Font**: Arial / sans-serif fallback with Roboto as a progressive enhancement where it was already loaded. Keeping the stack as `"Roboto", Arial, sans-serif` matches the registration module without penalizing devices that can't load Roboto.
- **`aria-live="polite"`** regions for status messages — all three prior modules already use this pattern.
- **Simple, high-contrast, mobile-first styling** with no decorative gradients or heavy shadows.

**Retiring or rethinking:**
- Prior modules use **inline styles** throughout. The PWA will consolidate to an external stylesheet (`css/app.css`) with CSS custom properties for the palette so the brand is editable in one place.
- Prior modules each use a different **max-width** (600px, 980px). The PWA uses a mobile-first fluid layout with content clamped to `min(100%, 44rem)` for reading comfort on desktop; forms clamp to `min(100%, 32rem)`.
- Prior modules bake form submission into **Zapier webhooks** and **EmailJS**. Those integrations are not relevant to the PWA's architecture — content moves through Firestore and OneSignal instead. Zapier/EmailJS are retired for this app.
- Prior modules do not have a **logo** rendered inline; the PWA requires chapter branding at the top of every view and in the manifest icons. The implementer will source the Gateway Chapter mark from the board (listed in section 15 as a provisioning task) and ship it as both color and monochrome SVG.

## 13. Error Handling & Empty States

For every content area the UI distinguishes four conditions:

| Area | Not yet published | Fetch failed online | Offline | Permission needed |
|---|---|---|---|---|
| Agenda | "Agenda coming soon" placeholder card | Red toast "Could not load agenda. Retry." + cached list if any | Yellow banner "You're offline — showing last-saved agenda" over cached data | n/a |
| Sponsors | "Sponsor list coming soon" | Same pattern | Same pattern | n/a |
| Venue Map | Placeholder image + "Final map will be posted before the event" | Red toast, cached map if any | Yellow banner over cached map | n/a |
| Announcements | "No announcements yet..." empty state | Red toast, cached list if any | Yellow banner over cached list | On first visit, the push opt-in card. If permission is denied at OS level, "Notifications are turned off" banner. |
| Attendees | "Attendee list will populate as registrations finalize" | Red toast + cached list | Yellow banner + cached list | n/a |
| Feedback | "Feedback opens during the event" (when `feedbackConfig.active === false`) | Red toast on form fetch; red inline on submit | Red inline on submit ("No connection — please try again") | n/a |
| Recap | Entry hidden from More menu until published | Red toast + cached recap | Yellow banner + cached recap | n/a |
| Admin editors | Area-specific empty states ("Add session", etc.) | Red toast per operation; the dialog stays open with values intact | Red toast "You're offline — admin changes require connectivity" and the save button is disabled | Login required: redirect to `/admin` |

**General error handling rules:**
- Every failing fetch logs to the browser console at `warn` level with the view name and the error for admin diagnostics; no third-party error reporting is added.
- Server-side (Pages Functions) failures return HTTP status + `{ error: "<message>" }` JSON. The client surfaces the message verbatim for 4xx and a generic "Something went wrong — try again" for 5xx.
- Admin JWT expired → redirect to `/admin` with a "Session expired — please sign in again" banner.
- OneSignal errors are surfaced to the admin verbatim and logged server-side for correlation.

**Validation rules per external input:**
- Admin passphrase: required, min 1 char, trimmed. Submitted over HTTPS only. Rate-limited server-side.
- CSV import: must have at least `name` and `company` columns (case-insensitive match). Each row's `name` and `company` must be 1-120 chars after trim. Rows that fail validation are shown in the preview with a red marker and excluded unless the admin fixes them in the source and re-uploads.
- Announcement composer: `title` required 1-120 chars; `body` required 1-2000 chars.
- Agenda session: `title` required 1-120; `startAt`/`endAt` required valid ISO; `endAt > startAt` enforced client-side with inline error.
- Sponsor: `name` required 1-120; `tier` required from the enum; `website` must parse as an `https://` URL if provided.
- Feedback submit: all `required: true` questions must have an answer; rating answers must be integers 1-5; short-text 0-200; long-text 0-2000.
- Venue map upload: file must be `image/png` or `image/jpeg`, max 5 MB. Larger files are rejected client-side with an inline message.

**Invariants and owners:**
- "One submission per device per form" — owned by the client via `localStorage` key `vendorday2027.feedback.submitted`. Firestore does not enforce this; the server trusts the client. This is acceptable because the data is anonymous feedback with no incentive to spoof.
- "Attendee opt-out is honored" — owned by the admin importer; `optedOut: true` rows are still stored but filtered out of attendee reads. The client enforces the filter on display, and the Firestore read query filters `optedOut == false`.
- "Published recap is visible" — owned by `recap.published`. The More menu checks this before rendering the Recap entry.
- "Push sent reflects delivery" — owned by `/api/send-push`. Only flipped to `true` on OneSignal 200.

## 14. Analytics & Privacy

Per NFR 12.11, **no third-party analytics or trackers** are included. No Google Analytics, no Plausible, no Fathom, no Hotjar, nothing. The service worker does not report back. OneSignal does track push subscription state (that's its job); it does not track page views and the integration is scoped to the Announcements view.

If the board wants visit counts in a future iteration, the natural low-cost addition is a first-party counter: a Pages Function `/api/visit` incremented via Cloudflare KV, with no cookies and no IP storage. This is called out as a future enhancement, not shipped in v1.

Firebase Analytics is explicitly **not** initialized in the Firestore client wiring.

## 15. Open Questions for Implementation

These are provisioning tasks, not design decisions. Implementer should raise them with the user before each becomes a blocker:

- **Admin passphrase value.** The actual passphrase to be chosen by the Gateway Chapter board. The implementer runs the hashing script locally with the chosen passphrase and installs the resulting `ADMIN_PASSPHRASE_HASH` in Cloudflare Pages.
- **OneSignal account setup.** The user (or whoever owns the chapter's accounts) creates a OneSignal account, creates a Web Push app for `2027vendorday.gatewayscte.org`, and provides the `ONESIGNAL_APP_ID` and `ONESIGNAL_REST_API_KEY` for the Cloudflare Pages environment.
- **Firebase project.** A new Firebase project needs to be created for Vendor Day 2027. Implementer needs the project ID, Web API key, and a downloaded service-account JSON for Pages Functions. (Firestore only — Firebase Storage is not used; see the R2 bucket task below.)
- **Cloudflare R2 bucket.** Create an R2 bucket named `vendor-day-2027-assets`, enable public access, and note the `https://pub-<hash>.r2.dev` URL Cloudflare assigns. In the Pages project, add the R2 bucket binding `ASSETS_BUCKET` → `vendor-day-2027-assets` and set the env var `R2_PUBLIC_URL` to the public URL from the previous step (Production + Preview scopes).
- **GoDaddy DNS access.** The CNAME for `2027vendorday` at the `gatewayscte.org` zone has already been added (per the user's earlier confirmation). Implementer verifies propagation and that Cloudflare has issued the certificate.
- **Chapter logo asset.** The implementer needs the Gateway Chapter mark as an SVG (color + monochrome variants) to use in the header, manifest icons, and placeholder states. If only a raster logo exists, implementer requests PNG at 1024px square.
- **Registration Google Sheet URL (for admin reference only).** The admins export CSV from this sheet. The URL is not stored in the app; it is documented in `docs/admin-runbook.md` so admins can bookmark it.
- **Event date confirmation.** When the board locks the date, an admin edits `appSettings.eventDate` through the admin UI. Placeholder language ships until then.
- **Floor plan PDF or image.** When the final floor plan is ready, an admin uploads it through the Venue Map Uploader. A placeholder image ships until then.

## 16. In-App Attendee Sign-In (post-launch)

The 2026 show used a public web form hosted on the chapter's GoDaddy site to capture a check-in record (name, company, office location, phone, email, SCTE member number). That page submits form-encoded data to a Zapier Catch Hook, which appends a row to a Google Sheet. For 2027 the board wants an equivalent sign-in flow inside the installed PWA so attendees who already have the app open do not need to pull up the GoDaddy page.

**Shared-webhook pattern.** The in-app Sign-In view (`public/js/views/signin.js`) and the GoDaddy page both POST to the SAME Zapier Catch Hook URL and use the SAME field names (`attendee_name`, `company`, `office_location`, `phone`, `email`, `scte_member_number`, `signed_in_at`). One Zap maps those fields into one Google Sheet, which becomes the single source of truth for check-in records regardless of intake path. The in-app form sends `Content-Type: application/x-www-form-urlencoded` so Zapier parses the body identically to the GoDaddy page — no Zap-side mapping change was required.

**No new Firestore collection.** Sign-ins are not duplicated into Firestore. A `signIns` collection would add a write path, a dedup problem across the two intake routes, and a reconciliation burden; the Google Sheet already fills that role and is where the board reads attendance anyway. The in-app form fire-and-forgets to Zapier; a failed POST surfaces inline with a Retry button and preserves the user's typed values rather than queueing a background write.

**Webhook URL configuration.** The webhook URL is NOT hardcoded in the client. A Cloudflare Pages env var `ZAPIER_SIGNIN_WEBHOOK_URL` carries the current value, and `/api/config` (see section 2 and `functions/api/config.js`) returns it to the browser as `signInWebhookUrl`. Rotating the webhook is a Cloudflare env-var edit plus a redeploy — no code change. When the env var is unset the client sees `signInWebhookUrl: null` and renders a "Sign-in is not yet configured" placeholder instead of throwing, matching the degrade-gracefully pattern used by other config-driven features (OneSignal, R2 assets).

**Local "already signed in" indicator.** On a successful POST, the client writes `{name, company, submittedAt}` to `localStorage` under `vendorday2027.signin.lastSubmission`. On re-visit, the Sign-In view short-circuits to a confirmation card ("Signed in as [name] ([company])") with a "Sign in as someone else" reset link that clears the stored submission and re-renders the form. This mirrors the one-submission-per-device pattern used by the Feedback view (section 13 invariants) and keeps the client-side signal cheap. The Google Sheet remains the authoritative record; the localStorage flag is a UX convenience, not an enforcement mechanism (an attendee can clear site data and sign in again, which is fine — the Sheet will show the duplicate and the board can decide).

**Office Location in the Sheet, not the directory.** Office Location is captured by the Sign-In form and sent to Zapier because the board wants it in the attendance Sheet. It is NOT surfaced in the Attendee Directory view, which continues to display only Name, Company, and Title per Requirement 7.2. The Sign-In form and the Attendee Directory are two independent features with different sources — the form writes to the Sheet via Zapier, the directory reads from the Firestore `attendees` collection seeded from the admin CSV importer.

**Spam protection.** Matches the GoDaddy form: client-side required-field validation and loose email / phone format checks, no honeypot, no CAPTCHA. The threat model is a small, in-person event with a QR-code audience; a drive-by submission from a bot would still land in the Sheet where the board would notice it. If this becomes a problem in a future year, Zapier Filters can be added without touching the client.

**Entry points.** The Sign-In view is reachable from two places in the attendee shell:
- Home view: a quick-action card in the shared `.home-quick-actions` row (first position). The card reads "Sign in" by default and "✓ Signed in" when the localStorage key is present; both states route to `#/sign-in` so the user can reach the view and reset.
- Overflow menu in the app header: a "Sign In" entry sits at the top of the More menu, above Recap and About & Install.

The Welcome / install flow is intentionally untouched so the first-run install path stays clean. The service worker's precache list is build-time generated by `scripts/build-sw.js`, which walks `public/` on every deploy — the new `signin.js` module lands in the shell cache automatically on the next build; no manual precache edit required.
