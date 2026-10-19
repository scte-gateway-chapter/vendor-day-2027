# Implementation Plan

This plan builds the Vendor Day 2027 PWA from an empty repo to a deploy-ready app on Cloudflare Pages, with the admin surface and OneSignal push wired end-to-end. Tasks are ordered so the next one always has what it needs from the previous one: provisioning first, then scaffold, then infrastructure (Firebase, Cloudflare, Pages Functions), then shared client primitives, then attendee features (which get real data from Firestore immediately), then admin editors (which depend on the attendee readers to verify writes), then push integration, then the service worker (last among client features so it caches a settled app shell), then the accessibility and error-handling passes, and finally runbooks and the pre-launch checklist.

Account creation (OneSignal, Firebase, GitHub, Cloudflare, GoDaddy DNS edits) is explicitly out of scope for the implementer — the implementer verifies credentials and installs them, but does not create accounts.

- [ ] 1. Verify provisioning and install secrets into Cloudflare Pages
  - Confirm the user has created the chapter-owned accounts listed in design section 15: Cloudflare, Firebase, OneSignal, and GitHub repo for the project, plus the GoDaddy CNAME for `2027vendorday.gatewayscte.org` already in place
  - Collect from the user: Firebase project id, Firebase Web API key, service-account JSON, OneSignal `app_id` and `REST API key`, chosen admin passphrase, and the chapter logo (SVG color + monochrome, or PNG 1024px fallback)
  - Run the PBKDF2-SHA-256 hashing routine locally (10 iterations, 310k, 16-byte random salt, both base64) against the chosen admin passphrase and record the resulting `ADMIN_PASSPHRASE_HASH`; generate a random 32-byte `ADMIN_JWT_SECRET`
  - Install the complete env var set in Cloudflare Pages for both Production and Preview scopes per design section 10: `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY`, `ADMIN_PASSPHRASE_HASH`, `ADMIN_JWT_SECRET`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_PROJECT_ID`, `FIREBASE_WEB_API_KEY`
  - Files: no code committed in this step; checklist tracked in `docs/provisioning-checklist.md`
  - Verify: Cloudflare Pages → Settings → Environment variables lists every key for both scopes; secret values are stored as `Encrypt`
  - _Requirements: 10.1, 10.2, 10.3, 12.8, 12.9, 12.11_

- [ ] 2. Scaffold the repository, tooling, and build pipeline
  - Create the exact folder tree in design section 10 (`public/`, `public/css/`, `public/js/`, `public/js/views/`, `public/admin/`, `public/admin/js/`, `public/assets/icons/`, `public/assets/placeholders/`, `public/assets/brand/`, `functions/`, `scripts/`, `docs/`, `.github/workflows/`)
  - Write `package.json` with no runtime deps and a `build` script that runs `node scripts/build-sw.js`; pin Node 18
  - Write `scripts/build-sw.js` as a ~30-line Node script that reads `BUILD_ID` from the environment (Cloudflare injects it; fall back to `Date.now()` locally), substitutes it into `public/sw.js`'s cache-name placeholder, and writes the file in place
  - Scaffold `public/sw.js` as a placeholder service worker containing the cache-name token the build script replaces, and empty `install`/`activate`/`fetch` handlers
  - Scaffold `public/index.html` (attendee shell with the five-tab bottom bar, logo header, and a `<main>` with placeholder copy) and `public/admin/index.html` (admin shell with left-rail nav on desktop and top drop-down on phone)
  - Scaffold `public/manifest.webmanifest` with the event title, chapter green theme color `#2E8B57`, `display: standalone`, and icon references (icon files added later)
  - Write `.gitignore` (ignore `node_modules/`, local Firebase service account files outside `functions/`, `.env*`, OS cruft) and a `README.md` summarizing the stack and pointing at the two spec documents
  - Files: `package.json`, `.gitignore`, `README.md`, `scripts/build-sw.js`, `public/sw.js`, `public/index.html`, `public/admin/index.html`, `public/manifest.webmanifest`, placeholder files in each new folder (`.gitkeep` where empty)
  - Verify: `npm run build` succeeds locally and `public/sw.js` ends up with a stamped cache name; `npx http-server public` serves `index.html` and `admin/index.html` without 404s
  - _Requirements: 11.1, 11.5_

- [ ] 3. Configure Firebase (Firestore, Storage, security rules)
  - In the Firebase console (user action), enable Firestore in native mode and enable Firebase Storage; the implementer validates both are reachable
  - Author `firestore.rules` enforcing public read on `agenda`, `sponsors`, `announcements`, `attendees` (with `optedOut == false`), `feedbackConfig`, `recap`, `appSettings`; deny all client writes; grant feedback response create via rules (public write-only, no read) OR require routing through `/api/firestore-write` — pick route-through for consistency with other writes and document it in the rule comments
  - Author `storage.rules` allowing public read on `/sponsors/`, `/venue-map/`, `/recap/`; deny all client writes (writes brokered server-side with the service-account key)
  - Deploy the rules through the Firebase CLI from a local developer machine (document the one-time steps in `docs/deployment.md`); do not commit the service-account JSON to the repo
  - Create the `appSettings/singleton` document with placeholder defaults from design section 5 so initial reads succeed
  - Files: `firestore.rules`, `storage.rules`, a short `firebase.json` scoping the rules deploy, seed script `scripts/seed-app-settings.js`
  - Verify: `firebase deploy --only firestore:rules,storage:rules` succeeds; a quick anonymous browser read against the `appSettings/singleton` document returns the seeded doc; an anonymous write attempt is rejected
  - _Requirements: 10.1, 10.4, 10.5, 12.9, 12.10, 12.11_

- [ ] 4. Create and bind the Cloudflare Pages project
  - Create a Pages project pointing at the GitHub repo scaffolded in task 2; configure Framework preset `None`, build command `npm run build`, output directory `public`, Node 18
  - Bind the custom domain `2027vendorday.gatewayscte.org` to the project and confirm the GoDaddy CNAME resolves (DNS was added by the user already); confirm Cloudflare has issued the Universal SSL cert and that `Always use HTTPS` is enabled
  - Confirm the env vars installed in task 1 are visible to both Production and Preview deploys
  - Push the task-2 scaffold to `main`; confirm the production deploy succeeds and the welcome shell renders at `https://2027vendorday.gatewayscte.org`
  - Push a throwaway branch; confirm a preview deploy renders at `<branch>.<project>.pages.dev` so every subsequent task can be reviewed on a preview URL
  - Files: no new code — a short Pages setup note in `docs/deployment.md` capturing the exact settings used
  - Verify: production URL serves the shell over HTTPS with a valid cert; preview URL serves the same shell; a `curl -I` to the production URL returns `strict-transport-security` and a 200
  - _Requirements: 11.5, 12.11_

- [ ] 5. Author the Pages Functions skeletons for admin login, Firestore writes, and push send
  - Implement `functions/admin-login.js`: POST handler that reads the submitted passphrase, re-derives PBKDF2 with the stored salt baked into `ADMIN_PASSPHRASE_HASH`, constant-time compares, issues a 12-hour HS256 JWT signed with `ADMIN_JWT_SECRET` on success, applies the Cloudflare-KV-backed rate limiter (5 failures / 10 min / IP → 429 with `Retry-After`), returns 401 on mismatch
  - Implement `functions/firestore-write.js`: POST handler that validates the admin JWT, loads the Firebase Admin SDK with `FIREBASE_SERVICE_ACCOUNT_JSON`, accepts `{ collection, docId, data, op: "set" | "update" | "delete" }`, writes, and returns the resulting server timestamp; rejects unknown collections and documents outside the whitelist of writable collections
  - Implement `functions/send-push.js`: POST handler that validates the admin JWT, calls `POST https://onesignal.com/api/v1/notifications` with `included_segments: ["All"]`, `headings`, `contents`, and a `url` of `https://2027vendorday.gatewayscte.org/#/announcements/<id>`; on OneSignal 200 performs a secondary `firestore-write` to flip `pushSent: true` and set `pushSentAt`; surfaces OneSignal error messages verbatim on non-200
  - Add a KV namespace binding `ADMIN_LOGIN_RATE` in Cloudflare for the login rate limiter and document the binding in `docs/deployment.md`
  - Files: `functions/admin-login.js`, `functions/firestore-write.js`, `functions/send-push.js`, `functions/_shared/jwt.js`, `functions/_shared/rate-limit.js`
  - Verify: deploy to Pages; `curl -X POST https://<preview>/api/admin-login -d '{"passphrase":"wrong"}'` returns 401 and increments the KV counter; six wrong attempts in rapid succession return 429; a correct passphrase returns a JWT; `/api/firestore-write` rejects a request without `Authorization: Bearer <jwt>` with 401
  - _Requirements: 6.2, 10.1, 10.2, 10.3, 10.6, 10.7_

- [ ] 6. Build the shared client primitives (router, Firestore read client, UI shell, palette)
  - Create `public/js/router.js` as a tiny hash-based router (`#/`, `#/agenda`, `#/agenda/<id>`, `#/sponsors`, `#/sponsors/<id>`, `#/map`, `#/announcements`, `#/announcements/<id>`, `#/attendees`, `#/attendees/<id>`, `#/feedback`, `#/recap`, `#/about-install`) with before/after hooks and a 404 route
  - Create `public/js/firebase.js` as a thin read-only Firestore client wired with `FIREBASE_PROJECT_ID` + `FIREBASE_WEB_API_KEY` injected at build time; expose `onSnapshot(collection)`, `getDoc(path)`, and `getCollection(path)` only
  - Create `public/js/ui.js` with the shared UI chrome: top header (logo + overflow menu), bottom tab bar (five tabs with `aria-selected`, arrow-key navigation, 44x44px targets, badge support for Announcements and Attendees), toast system (`success`, `error`, `info`) using the carry-forward palette, offline banner, and the "App updated — tap to reload" banner the service worker will trigger
  - Create `public/css/app.css` with CSS custom properties for the carry-forward palette (`--brand-green #2E8B57`, `--brand-green-text #1F6B40`, `--body-text #222`, `--secondary-text #555`, `--error-red #B30000`, `--error-bg #FFF0F0`, `--success-bg #EAFAF0`), base typography (16px root, `rem` throughout, `"Roboto", Arial, sans-serif`), focus-visible outlines (2px solid brand green with 2px offset), and layout clamps (`min(100%, 44rem)` for reading, `min(100%, 32rem)` for forms)
  - Create `public/js/app.js` to bootstrap: register the service worker (even if empty today), mount the shell, read `appSettings/singleton`, start the router, and route to Home by default
  - Files: `public/js/router.js`, `public/js/firebase.js`, `public/js/ui.js`, `public/js/app.js`, `public/css/app.css`
  - Verify: open the production URL; the shell renders with header + bottom tab bar; tab bar is keyboard navigable with arrow keys; toasts fire on a manual `window.ui.toast(...)` from the devtools console; the router changes views on hash change without reloading
  - _Requirements: 1.7, 11.2, 12.1, 12.2, 12.5, 12.6_

- [ ] 7. Build the Welcome / Install view with platform detection
  - Create `public/js/views/welcome.js` as the view rendered at `#/` for a first-time visitor; detect iOS Safari via UA, Android Chrome via `beforeinstallprompt` capture, and installed state via `display-mode: standalone` / `navigator.standalone`
  - Render platform-appropriate install card: iOS Safari gets a static "tap Share → Add to Home Screen" illustration (image sprite with alt text, no GIF/video); Android Chrome gets an "Install app" button that calls the stashed `deferredPrompt.prompt()`; unsupported browsers get the non-blocking "Push notifications aren't available in this browser, but the rest of the app works" notice
  - Add an "I'll do this later" link that routes to `#/home`; persist a `vendorday2027.welcome.dismissed` flag in `localStorage` so return visits skip Welcome
  - When `display-mode: standalone` is detected on launch, route directly to Home and never render Welcome
  - Expose the install instructions from the More tab as "About & Install" at `#/about-install` so the user can re-visit them
  - Do NOT prompt for push notifications on this view (deferred to Announcements per Requirement 2.1)
  - Files: `public/js/views/welcome.js`, `public/js/views/about-install.js`, `public/assets/placeholders/ios-install-steps.png`
  - Verify: open the production URL in a desktop browser → Welcome shows with the "Continue in browser" fallback; emulate iOS Safari in devtools → the Add to Home Screen illustration shows; after dismiss, reload → Welcome is skipped and routes to Home
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [ ] 8. Build the Home view
  - Create `public/js/views/home.js` rendering: welcome card with event title / Doubletree Chesterfield / date (reads `appSettings/singleton`), a "Happening now" strip computed from the current time against the `agenda` collection (falls back to "Starts at <next session time>" or an empty-state card), a "Latest announcement" card (title + 2-line snippet + timestamp from the newest `announcements` doc), and quick action buttons that route to Agenda, Map, and Sponsors
  - Wire the "Happening now" strip to refresh when the agenda snapshot updates and when the view regains focus (`document.visibilitychange`)
  - Implement empty, loading, and error states per design section 4 (skeleton rectangles during fetch; "Agenda coming soon" and "No announcements yet" placeholders when collections are empty; retry button + offline banner on error)
  - Files: `public/js/views/home.js`
  - Verify: open `#/home` with the seeded `appSettings` doc and empty `agenda`/`announcements` collections → both placeholder cards render; add a session in Firestore with `startAt` 10 minutes ago and `endAt` 20 minutes from now → "Happening now" strip updates within 30 seconds without a reload
  - _Requirements: 1.7, 3.4, 6.5_

- [ ] 9. Build the Agenda views (list and session detail)
  - Create `public/js/views/agenda.js` for the list and `public/js/views/agenda-detail.js` for the detail view
  - Wire the Firestore `agenda` collection snapshot listener and group sessions by their start-time slot in chronological order; render each card with title, speaker (if present), room, and chevron
  - Render the "Happening now" badge on the active session based on current time (same logic shared with Home via a small helper)
  - Implement deep link routing for `#/agenda/<id>`; render session detail with start-end time, room, speaker name + bio, description, and an "Add to calendar" ICS link generated client-side
  - Implement empty, loading, error, and offline states per design section 4 (placeholder "Agenda coming soon — check back closer to the event" when the collection is empty; shimmer rows during fetch; offline banner over cached data)
  - Files: `public/js/views/agenda.js`, `public/js/views/agenda-detail.js`
  - Verify: with a seeded 3-session agenda, `#/agenda` renders grouped by time; tapping a session navigates to `#/agenda/<id>`; editing a session's title in Firestore reflects on the open agenda view within 30 seconds; the "Add to calendar" link downloads a valid `.ics` file that imports into a calendar app
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 11.2_

- [ ] 10. Build the Sponsor Directory views (list and detail)
  - Create `public/js/views/sponsors.js` and `public/js/views/sponsors-detail.js`
  - Group sponsors by tier (Platinum, Gold, Silver, Supporter) with higher tiers first; render each row with the logo thumbnail (chapter-mark placeholder when `logoUrl` is null), company name, and booth number if present
  - Implement sponsor detail at `#/sponsors/<id>` with logo, tier chip, description, website link (`target="_blank" rel="noopener"`), booth number + "Find on map" link that routes to `#/map`, optional `mailto:` contact
  - Implement empty, loading, error, and offline states per design section 4 (placeholder "Sponsor list coming soon" when empty)
  - Files: `public/js/views/sponsors.js`, `public/js/views/sponsors-detail.js`, `public/assets/placeholders/logo-placeholder.svg`
  - Verify: seed one sponsor per tier in Firestore; `#/sponsors` renders tier groups in the required order; tapping a sponsor without a logo shows the placeholder; the website link opens in a new tab and does not replace the PWA
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 11. Build the Venue Map view
  - Create `public/js/views/map.js` rendering the venue map image from `appSettings.venueMapUrl` (or the shipped placeholder image when null), sized to the viewport
  - Implement pinch-to-zoom via `touch-action: pinch-zoom` on the image container and double-tap zoom via JS; wrap in a scrollable container so panning works at zoom
  - Render the caption / legend text from `appSettings.venueMapCaption` beneath the image
  - Implement empty, loading, error, and offline states per design section 4 (placeholder image with "Final map will be posted before the event" watermark when `venueMapUrl` is null; cached image served offline)
  - Files: `public/js/views/map.js`, `public/assets/placeholders/venue-map-placeholder.png`
  - Verify: `#/map` renders the placeholder with the watermark when `venueMapUrl` is null; pinch and double-tap zoom both work in a mobile emulator; after task 20 uploads a real map, `#/map` renders the uploaded image
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 11.2_

- [ ] 12. Build the Announcements view with the deferred push opt-in card
  - Create `public/js/views/announcements.js` rendering announcements in reverse chronological order; each card has title, markdown-rendered body (use a tiny vanilla markdown helper limited to bold/italic/links/lists — do not pull a heavy library), timestamp, and "Gateway Chapter Board" byline
  - Render the push opt-in card at the top on first visit, explaining what push will / won't be used for; the "Enable" button triggers the OneSignal flow built in task 25; the card dismisses once a decision is recorded (persist to `localStorage` key `vendorday2027.push.decision`)
  - On iOS Safari when not installed, render the opt-in card variant that explains push requires installing the app first (iOS 16.4+); never trigger the browser permission prompt in that case
  - When permission is denied at the OS level on next open, render a non-intrusive "Notifications are turned off. Enable them in your device settings." banner
  - Maintain an unread-count badge on the More-tab icon by tracking `last-viewed-at` in `localStorage` against the collection's `publishedAt` timestamps
  - Support deep link `#/announcements/<id>`; when the view opens from a push tap, scroll that card into view with a brief highlight (~2s)
  - Implement empty, loading, error, and offline states per design section 4 (placeholder "No announcements yet…" when empty; red toast on fetch failure; yellow offline banner over cached list)
  - Files: `public/js/views/announcements.js`, `public/js/markdown-mini.js`
  - Verify: with an empty `announcements` collection, the empty state and (on first visit) the push card render; seed one announcement in Firestore → it appears within 30 seconds without a reload; on an installed iOS build the opt-in triggers the OS prompt (requires task 25); unread badge count on the More tab increments and clears on view entry
  - _Requirements: 2.1, 2.3, 2.4, 2.5, 6.1, 6.3, 6.4, 6.5, 6.6, 6.7, 11.2_

- [ ] 13. Build the Attendee Directory views (list and detail)
  - Create `public/js/views/attendees.js` and `public/js/views/attendees-detail.js`
  - Read the `attendees` collection filtered to `optedOut == false`; render as a scrollable list with name on line 1, `company — title` on line 2 (title omitted when absent)
  - Add a debounced (150ms) search field at the top that filters by name and company client-side
  - Detail view at `#/attendees/<id>` opens a half-sheet modal (full-screen on narrow viewports) showing only the listed fields with the opt-out note at the bottom; no contact / messaging / QR exchange features
  - Implement empty, loading, error, and offline states per design section 4 ("Attendee list will populate as registrations finalize" when empty)
  - Files: `public/js/views/attendees.js`, `public/js/views/attendees-detail.js`
  - Verify: seed three attendee docs (one with no title, one with `optedOut: true`); the directory shows two entries with correct title handling; the opt-out row never appears; typing in search filters live within one frame
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 12.12_

- [ ] 14. Build the Feedback view
  - Create `public/js/views/feedback.js` that reads `feedbackConfig/singleton` and renders a form only when `active === true`; otherwise render the "Feedback opens during the event — check back soon." placeholder
  - Render each configured question by type: `rating` as a 1-5 radio group inside a `<fieldset><legend>`, `short` as a single-line text input (0-200), `long` as a textarea (0-2000); respect `required: true` with inline error messaging
  - On submit, POST a new `feedbackResponses/<uuid>` document via `/api/firestore-write` (route-through required because feedback writes are the only client-origin writes); on success show the inline confirmation card and set `localStorage` key `vendorday2027.feedback.submitted` to the server timestamp
  - On subsequent visits with the localStorage key set, render the confirmation card instead of the form (one-submission-per-device)
  - Offline behavior: fail loudly per the resolved decision — on submit, do a `navigator.onLine` check and surface the red "Feedback could not be submitted. Please check your connection and try again." inline banner with the user's answers preserved; no queueing
  - Files: `public/js/views/feedback.js`
  - Verify: with `feedbackConfig.active = false` the placeholder renders; flip to `true` with two rating questions and one short-text; submitting writes a new `feedbackResponses` doc visible in Firestore; reloading the view shows the confirmation card; toggling the browser offline and submitting shows the red banner without a Firestore write
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 11.3, 12.10_

- [ ] 15. Build the Recap view
  - Create `public/js/views/recap.js` rendering `recap/singleton`: thank-you message, acknowledgments (markdown), photo gallery with `<img loading="lazy">`, and any post-event links
  - Only register the Recap entry in the More tab when `recap.published === true`; while unpublished, the entry is hidden entirely
  - Keep Agenda, Sponsors, and Announcements reachable after the Recap is published (historical record)
  - Implement empty, loading, error, and offline states per design section 4
  - Files: `public/js/views/recap.js`, update `public/js/ui.js` to conditionally include the Recap entry in the More tab
  - Verify: with `recap.published = false` the More tab has no Recap entry; set `published = true` with sample content → the Recap entry appears and the view renders with lazy-loaded photos
  - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 16. Build the admin login flow, session storage, and rate limiting
  - Create `public/admin/js/login.js` with a single passphrase field, Sign in button, inline error messaging ("Incorrect passphrase"), and the rate-limit messaging that reads 429 responses from `/api/admin-login` and renders `Retry-After` as a countdown
  - On success, store the returned JWT in `sessionStorage` under `vendorday2027.admin.jwt` and redirect to `/admin` dashboard
  - On every admin fetch helper call, attach `Authorization: Bearer <jwt>`; on 401 responses (expired or missing JWT), clear the storage and redirect back to `/admin` with the "Session expired — please sign in again" banner
  - Implement a Log out button in the admin header that clears `sessionStorage` and routes to `/admin`
  - Depends on task 5 for `/api/admin-login` and the shared JWT helper
  - Files: `public/admin/js/login.js`, `public/admin/js/admin-auth.js`, `public/admin/js/admin-fetch.js`
  - Verify: visit `/admin` → login screen renders; enter the wrong passphrase 6 times → the sixth attempt returns 429 and the UI shows the countdown; enter the correct passphrase → redirect to the dashboard; manually expire the JWT in sessionStorage → the next admin call redirects back with the session-expired banner
  - _Requirements: 10.1, 10.2, 10.3, 10.8_

- [ ] 17. Build the admin dashboard
  - Create `public/admin/js/dashboard.js` rendering per-content-area cards showing `updatedAt` and `updatedBy` (format "updated 2h ago by Board member A"), the last 10 push sends with their `pushSentAt` and announcement title, and a health strip indicating Firestore reachability and OneSignal reachability (`GET /api/send-push?healthcheck=1` returns a lightweight 200 when both are reachable)
  - Each card links to its corresponding editor view
  - Collision warning scaffolding: each editor reads the snapshot `updatedAt` on open and the dashboard surfaces concurrent edits across editors ("Board member B is editing Agenda") only insofar as `updatedAt` reveals it — no live presence feature
  - Depends on task 16 for auth and task 5 for health
  - Files: `public/admin/js/dashboard.js`, `public/admin/js/collision-check.js`
  - Verify: with seed content, the dashboard renders the last-updated chips correctly; the health strip is green when both services respond; manually force a Firestore unreachable condition (temporarily rotate the service account) and the strip reports it
  - _Requirements: 10.4, 10.9_

- [ ] 18. Build the admin Agenda editor
  - Create `public/admin/js/agenda-editor.js` rendering the ordered session list with inline edit / delete, an "Add session" button, and the "Last edited X by Y" header
  - The edit modal captures `title` (1-120), `startAt` and `endAt` as datetime-local inputs (validated client-side so `endAt > startAt`), `room` (0-60), `speaker.name`, `speaker.bio`, `description` (0-2000)
  - On Save, call `/api/firestore-write` with `{ collection: "agenda", docId, data, op: "set" }` including a client-generated UUID for new sessions and the server `updatedAt`/`updatedBy` set in the function
  - Enforce the collision soft-safeguard from design section 6 — on save, re-read the current `updatedAt`; if it is newer than the snapshot taken when the modal opened, show the "This content was edited by someone else — Overwrite / Reload" banner before committing
  - Phone-usable at narrow widths: single-column modal, 44x44 touch targets, keyboard-friendly inputs
  - Depends on task 9 (viewer) and task 16 (admin auth)
  - Files: `public/admin/js/agenda-editor.js`, `public/admin/css/admin.css`
  - Verify: add a session as admin → it appears in the attendee Agenda view within 30 seconds; edit the same session from a second browser tab after the first opened its modal → the second's save surfaces the collision banner; delete flow prompts for confirmation and removes the doc
  - _Requirements: 10.4, 10.5, 10.9, 10.10_

- [ ] 19. Build the admin Sponsor editor
  - Create `public/admin/js/sponsors-editor.js` with the tier-grouped list, within-tier reorder handles (updates `order`), and an "Add sponsor" modal capturing `name`, `tier`, `boothNumber`, `website`, `email`, `description`, and `logo` file picker
  - On logo upload, POST the file through `/api/firestore-write` (or a parallel `/api/upload` function in `functions/upload.js` added here) which writes to Firebase Storage under `/sponsors/<id>/<filename>` with the Admin SDK and returns the public URL to store on the sponsor document
  - Validate URL fields: `website` must parse as `https://` if provided; `email` must look like `local@domain` if provided
  - Apply the same collision safeguard as the Agenda editor
  - Depends on task 10 (viewer) and task 16 (admin auth)
  - Files: `public/admin/js/sponsors-editor.js`, `functions/upload.js`
  - Verify: add a sponsor with a logo → sponsor appears on the attendee Sponsor view with the logo rendering from the Storage URL; reorder two sponsors in the same tier → the attendee list reflects the new order on next read
  - _Requirements: 10.4, 10.5, 10.9, 10.10_

- [ ] 20. Build the admin Venue Map uploader
  - Create `public/admin/js/map-uploader.js` with current-image preview, "Replace image" file picker (accepts `image/png` or `image/jpeg`, max 5 MB enforced client-side with inline error), caption textarea bound to `appSettings.venueMapCaption`, and a Save button
  - Upload goes through the same `/api/upload` function as sponsors but writes to `/venue-map/<timestamp>.<ext>`; on success, write `appSettings.venueMapUrl` and `venueMapCaption` through `/api/firestore-write`
  - Show an upload progress bar during the file transfer; keep the original image visible on failure with inline "Upload failed — try again"
  - Depends on task 11 (viewer) and task 16 (admin auth); this task is intentionally admin-first because without the uploader there is nothing to view beyond the placeholder
  - Files: `public/admin/js/map-uploader.js`
  - Verify: upload a 2 MB PNG → the attendee `#/map` view renders the new image within 30 seconds; upload a 6 MB file → inline error and no network request; upload a `.gif` → rejected with the format error
  - _Requirements: 5.1, 5.4, 10.4, 10.10_

- [ ] 21. Build the admin Announcement composer with push toggle
  - Create `public/admin/js/announcements-composer.js` showing past announcements (edit / delete inline) at the top and the composer below with `title`, `body` (markdown-friendly textarea with a live preview panel), the "Send as push notification" checkbox, the push preview showing title + first 120 chars of body, and the Publish button
  - On Publish: 1) POST to `/api/firestore-write` to create the announcement doc; 2) if "Send push" is checked, POST to `/api/send-push` with `{ announcementId, title, bodyPreview }`; 3) handle the three failure modes from design section 7 — Firestore failed (error toast, keep composer values), Firestore succeeded but push failed ("Published but push did not send — retry push?" state with a push-only retry button), OneSignal auth/quota error (surface the message verbatim)
  - Edit flow updates the Firestore doc but does NOT re-send a push; design section 7 explicitly notes pushes are fire-and-forget
  - Depends on task 12 (viewer), task 16 (admin auth), task 5 (`/api/send-push`)
  - Files: `public/admin/js/announcements-composer.js`
  - Verify: publish without push → announcement appears in the attendee feed and `pushSent === false`; publish with push → announcement appears, OneSignal returns 200, `pushSent` flips to `true`; force a push failure (temporarily break the OneSignal REST key) → the Firestore write still succeeds and the retry UI shows; retrying with a valid key flips `pushSent` to `true`
  - _Requirements: 6.1, 6.2, 6.6, 9.5, 10.4, 10.5, 10.6, 10.7, 10.10_

- [ ] 22. Build the admin Attendee importer with CSV parsing and per-row opt-out toggles
  - Create `public/admin/js/attendees-importer.js` with a `.csv` file picker that parses client-side (hand-rolled CSV parser for the known three-column schema `name,company,title` with case-insensitive header matching, since no bundler and no PapaParse)
  - Render the parsed rows in a preview table with: header mapping dropdowns if headers do not match the expected schema, per-row Include / Opt-out toggles, inline error markers for rows where `name` or `company` is empty or > 120 chars after trim
  - Two commit buttons: "Replace directory" (destructive, confirmed in a dialog, deletes all current `attendees` docs then writes the new set) and "Merge" (upsert by `name + company` composite key)
  - Writes go through `/api/firestore-write`; each row written as its own `attendees/<uuid>` doc with `optedOut: true` for the toggled rows and `optedOut: false` otherwise
  - Depends on task 13 (viewer) and task 16 (admin auth)
  - Files: `public/admin/js/attendees-importer.js`, `public/admin/js/csv-parse.js`
  - Verify: import a 25-row CSV; preview shows all rows with correct title handling; toggle three rows to opt-out; Replace commits → attendee view shows 22 entries, Firestore shows all 25 with correct `optedOut` flags; a CSV missing the `company` column prompts the column-mapping dropdowns
  - _Requirements: 7.5, 7.7, 10.4, 10.10, 12.12_

- [ ] 23. Build the admin Feedback config and results views
  - Create `public/admin/js/feedback-config.js` with two tabs: "Form" and "Results"
  - Form tab: ordered question list with type dropdown (`rating | short | long`), text, `required` toggle, reorder handles, and an "Activate form" toggle that flips `feedbackConfig.active`
  - Results tab: aggregated chart per rating question (bar count 1-5, computed client-side from `feedbackResponses`), scrollable list of free-text answers, and an "Export CSV" button that generates a CSV blob client-side and downloads it; the Export button is visible only when the current year matches the deployment year (hardcoded `2027` in a constant exposed from `appSettings`)
  - Depends on task 14 (viewer) and task 16 (admin auth)
  - Files: `public/admin/js/feedback-config.js`
  - Verify: build a 3-question form, activate it; submit two responses from the attendee feedback view; the Results tab shows two responses with correct bar counts and both free-text answers; Export CSV downloads a well-formed CSV
  - _Requirements: 8.1, 8.6, 10.4, 10.10_

- [ ] 24. Build the admin Recap editor
  - Create `public/admin/js/recap-editor.js` with: thank-you message textarea, acknowledgments textarea (markdown), photo uploader (same upload function as sponsors / map but writes to `/recap/<id>-<filename>`), drag-reorder of photos, Publish button, and a "Send a push when I publish" checkbox
  - On Publish, write `recap/singleton` with `published: true` and `publishedAt`; if the checkbox is checked, POST to `/api/send-push` with a short "The 2027 recap is up" message pointing at `#/recap`
  - Depends on task 15 (viewer), task 16 (admin auth), task 5 (`/api/send-push`)
  - Files: `public/admin/js/recap-editor.js`
  - Verify: upload 3 photos, reorder, publish with push off → the attendee Recap entry appears, no push sent; publish again with push on → announcement push arrives and tapping it opens `#/recap`
  - _Requirements: 9.1, 9.2, 9.4, 9.5, 10.4, 10.10_

- [ ] 25. Wire OneSignal end-to-end (SDK lazy load, subscription, deep-link on tap)
  - Create `public/js/onesignal.js` as a lazy-loader that is imported only when the Announcements view mounts; it dynamically injects the OneSignal Web SDK `<script>` with the `ONESIGNAL_APP_ID` config
  - Implement `initOneSignal()`, `requestPermissionAndSubscribe()`, and `getSubscriptionState()`; expose them to the Announcements view's opt-in card button
  - Platform guards: do not call `requestPermission` on iOS Safari when `navigator.standalone !== true` and `display-mode: standalone` is false; show the "install first" variant of the opt-in card instead (per Requirement 2.3 and design section 7)
  - Register the OneSignal `OneSignalSDKWorker.js` service worker file at the project root; verify it coexists with `/sw.js` by scoping (the OneSignal worker lives at `/OneSignalSDKWorker.js` with its own scope; the app's `/sw.js` lives at `/` — document the two-worker setup in `docs/deployment.md`)
  - Deep-link on tap: ensure the push payload sent from `/api/send-push` includes `url: https://2027vendorday.gatewayscte.org/#/announcements/<id>`; when the browser opens that URL from the notification, the router renders Announcements and scrolls the targeted card into view with a brief highlight
  - Handle the revoked-permission state on next open: read `Notification.permission` on app bootstrap and surface the "Notifications are turned off" banner on Announcements when it is `denied`
  - Add an "Enable notifications" entry in `#/about-install` that re-invokes the subscription flow (browsers will not re-prompt after denial, so this covers the user who dismissed without deciding)
  - Depends on task 5 (`/api/send-push`), task 12 (Announcements view)
  - Files: `public/js/onesignal.js`, `public/OneSignalSDKWorker.js` (download the current file from OneSignal's docs and commit it), update `public/js/views/announcements.js` and `public/js/views/about-install.js`
  - Verify: on Android Chrome, open Announcements → opt-in card renders → Enable triggers OS prompt → granting registers the subscription in OneSignal (confirm in OneSignal dashboard); publish an announcement with push on from admin → notification arrives → tapping it opens the app directly on that announcement card with the highlight; on desktop Firefox, the opt-in card shows "not supported in this browser" and no prompt fires
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 6.2, 6.3, 12.9_

- [ ] 26. Implement the service worker (shell, content, images strategies) and version stamping
  - Replace the task-2 stub `public/sw.js` with the tiered strategy from design section 8:
    - App shell (`/`, `/index.html`, `/admin/index.html`, main CSS, main JS, icon set, manifest, offline fallback page): cache-first in `shell-v<BUILD_ID>`; pre-cache the full list on `install`; delete older `shell-v*` caches on `activate`
    - Content JSON (Firestore REST responses matched by URL): network-first with cache fallback in `content-v<BUILD_ID>`; on fetch failure set a global offline flag the UI reads
    - Images (sponsor logos, venue map, recap photos matched by Firebase Storage URL): cache-first in `images-v<BUILD_ID>` with a simple "delete oldest N on quota" eviction when count > 60 or approximate total size > 15 MB
    - Feedback submissions: online-only, no queueing; let the client fail loudly per task 14
  - Call `self.skipWaiting()` on `install` and `self.clients.claim()` on `activate` so new deploys propagate on the next visit without a hard refresh
  - Emit a `message` event to clients when a new version activates; `public/js/ui.js` listens and renders the "App updated — tap to reload" bottom banner
  - Update `scripts/build-sw.js` to stamp the `BUILD_ID` into all three cache-name placeholders and to list the pre-cache manifest from `public/` at build time (walk the directory, filter to known shell assets)
  - Create `public/offline.html` as the shell's offline fallback
  - Files: `public/sw.js`, `public/offline.html`, update `scripts/build-sw.js`
  - Verify: open the production URL; devtools Application → Service Workers shows the registered worker; take the browser offline and reload → the app shell renders and Agenda / Sponsors / Map / Announcements / Attendees show their cached data with the offline banner; feedback submit while offline shows the red error inline without a network attempt; deploy a trivial CSS change → the "App updated — tap to reload" banner appears on next visit and reloading picks up the new version
  - _Requirements: 1.7, 3.6, 5.5, 6.7, 11.1, 11.2, 11.3, 11.4, 11.5, 12.3_

- [ ] 27. Accessibility pass across every view
  - Audit color contrast: verify the carry-forward palette combinations from design section 11 (brand green `#2E8B57` only on large text or UI boundaries, `#1F6B40` for text-weight brand use, body `#222` on white, secondary `#555` on white, error `#B30000` on `#FFF0F0`) with axe or Lighthouse on every attendee and admin view; fix any contrast failures by substituting the darker companion color
  - Audit focus states: ensure every interactive element shows the 2px solid brand-green focus outline on `:focus-visible`; no `outline: none` without an equivalent replacement; verify tab order is top-to-bottom logical on every view
  - Audit keyboard navigation on the bottom tab bar (ARIA tab pattern, arrow keys cycle, `aria-selected` updates), modals (focus trapped inside, Escape closes), and forms (submit on Enter where appropriate)
  - Audit ARIA labels: icon-only buttons in the tab bar and header overflow have `aria-label`; the icon glyphs themselves are `aria-hidden="true"`; status regions use `role="status"` / `aria-live="polite"` consistently with the carry-forward pattern
  - Verify 200% OS text scale: set browser zoom to 200% and set OS text size to large; no clipped or overlapping text on any view
  - Add axe-core via a CDN in a dev-only build mode and surface violations in the console; configure a Lighthouse CI GitHub Action if the user has time (optional per the task description)
  - Files: updates across `public/css/app.css`, each view file in `public/js/views/`, each admin view in `public/admin/js/`, `.github/workflows/lighthouse.yml` (optional)
  - Verify: axe or Lighthouse Accessibility score ≥ 95 on every top-level view; manual keyboard walkthrough reaches every control; VoiceOver (iOS) and TalkBack (Android) read a sensible landmark structure (header → main → nav) on at least Home, Agenda, Sponsors, Announcements
  - _Requirements: 12.4, 12.5, 12.6, 12.7_

- [ ] 28. Error-handling pass to confirm all four states on every content area
  - Walk through each row of the design section 13 table and confirm the attendee implementation renders: not-yet-published placeholder, fetch-failed online toast (with cached fallback where applicable), offline banner over cached data, and permission-needed card where relevant (Announcements only)
  - Walk through the admin section of the same table and confirm admin editors show area-specific empty states, per-operation error toasts that keep dialogs open with values preserved, "offline — admin changes require connectivity" toasts with the Save button disabled, and the session-expired redirect
  - Validate the input validation rules from design section 13: admin passphrase (required, trimmed, HTTPS-only), CSV import (name and company required 1-120), announcement composer (title 1-120, body 1-2000), agenda session (title 1-120, start/end ISO, end > start), sponsor (name 1-120, tier enum, website parses as https://), feedback submit (required answers, rating 1-5), venue map (png/jpeg, max 5 MB)
  - Ensure every failing fetch logs at `console.warn` with the view name per design section 13; ensure 4xx errors from Pages Functions surface verbatim and 5xx errors fall back to generic copy
  - Files: targeted edits across every view that is missing one of the four states (no new files expected)
  - Verify: manually induce each failure mode (empty collection, blocked network, offline, 401, 429, 500 from a function) and confirm the correct state renders; no un-handled promise rejections appear in the console
  - _Requirements: 3.5, 4.5, 5.4, 6.3, 7.6, 8.4, 11.3_

- [ ] 29. Author the deployment and admin runbooks
  - Write `docs/deployment.md` covering: Cloudflare Pages project settings (Framework None, build command, Node 18), the full env var table from design section 10 marked public vs secret, custom domain binding steps, the KV namespace binding for the login rate limiter, Firebase CLI steps for deploying `firestore.rules` and `storage.rules`, the two-service-worker arrangement (`/sw.js` and `/OneSignalSDKWorker.js`), how to rotate `ADMIN_JWT_SECRET` to invalidate all admin sessions, how to produce a new `ADMIN_PASSPHRASE_HASH` with the hashing script
  - Write `docs/admin-runbook.md` covering: how to sign in at `/admin`, how to edit each content area, how to compose an announcement with and without push, how to export the registration Google Sheet to CSV and import it, how to replace the venue map, how to activate the feedback form and export results, how to publish the recap, and the "sign out everywhere" procedure (rotate `ADMIN_JWT_SECRET`)
  - Document the Google Sheet URL as a reference link for the admins (so the sheet URL does NOT ship in the app code)
  - Files: `docs/deployment.md`, `docs/admin-runbook.md`, `docs/provisioning-checklist.md` (from task 1)
  - Verify: a reader following `docs/deployment.md` from a cold start can reproduce the Cloudflare and Firebase configuration without external assistance; a reader following `docs/admin-runbook.md` on a phone can post a push-enabled announcement end-to-end
  - _Requirements: 7.7, 10.6, 10.7, 10.9_

- [ ] 30. Execute the pre-launch verification checklist
  - DNS and TLS: `dig 2027vendorday.gatewayscte.org` resolves to the Cloudflare Pages hostname; `curl -I` returns a 200 over HTTPS with a valid cert and HSTS; `http://` requests redirect to `https://`
  - OneSignal web push on iOS 16.4+ installed PWA: install the app from Safari to the home screen on an iOS 16.4+ device, open Announcements, accept the opt-in, publish a push from admin, confirm the notification arrives and tapping it opens the app on the matching announcement card
  - OneSignal web push on Android Chrome: open Announcements on an Android Chrome device, accept the opt-in, publish a push, confirm delivery and deep-link
  - Firestore security: a `curl` POST attempting to write directly to any content collection without the admin JWT returns a Firestore rules deny; the same write through `/api/firestore-write` with a valid JWT succeeds
  - Admin login rate limiter: six wrong passphrase attempts in rapid succession from the same IP return 429 with `Retry-After`; a correct attempt within the window still succeeds after the backoff; successful login resets the counter
  - Admin JWT expiry: issue a JWT, manually set the system clock forward 12 hours (or wait), and confirm the next admin call returns 401 and the client redirects to `/admin` with the session-expired banner
  - Empty-state coverage: with every content collection empty, Agenda / Sponsors / Map / Announcements / Attendees / Feedback / Recap each render the correct not-yet-published placeholder from design section 13
  - Lighthouse PWA audit passes on the production URL; Lighthouse Accessibility score ≥ 95 on Home, Agenda, Sponsors, Announcements, Attendees, Feedback, and the Welcome view
  - Record every check in `docs/pre-launch-checklist.md` with the date and the tester's name; file any failures as follow-up tasks before launch day
  - Files: `docs/pre-launch-checklist.md`
  - Verify: every bullet above is marked done in the checklist file with evidence (screenshot path, dig output snippet, OneSignal delivery timestamp, Lighthouse report URL)
  - _Requirements: 1.7, 2.3, 6.2, 10.1, 10.2, 10.3, 11.1, 11.5, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12_
