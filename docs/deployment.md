# Deployment Runbook — Vendor Day PWA

## Overview

This runbook is written for the Gateway Chapter board members who deploy and
operate the Vendor Day PWA without a developer in the loop. It walks through
the one-time provisioning for a fresh event year, the environment variables
and bindings the app needs, how deploys and rollbacks work on Cloudflare
Pages, and the smoke tests to run after each deploy.

It covers the systems the app actually runs on:

- **GitHub** — the chapter-owned repo hosting the source.
- **Cloudflare Pages** — static hosting plus the Pages Functions in
  `functions/api/`.
- **Cloudflare R2** — object storage for user-uploaded assets (sponsor logos,
  venue map, recap photos).
- **Cloudflare KV** — the namespace backing the admin-login rate limiter.
- **Firebase Firestore** — the mutable content store (agenda, sponsors,
  announcements, attendees, feedback, recap, appSettings).
- **OneSignal** — the Web Push provider.
- **GoDaddy DNS** — where the chapter's `gatewayscte.org` zone lives.

It does **not** cover writing code. The implementation lives in the spec at
`.kiro/specs/vendor-day-app/`.

Where this runbook refers to `<year>`, substitute the current event year
(e.g. `2027`). The 2027 deployment is the template for everything that
follows.

---

## First-time project setup

Follow these steps when provisioning a brand-new year's deployment. For a
year that reuses an existing deployment, jump to the **Yearly rollover**
section at the end.

### 1. Fork or clone the repo

The chapter maintains one GitHub repository per event year. Preferred
approach: **clone the previous year's repo into a new repo** named
`vendor-day-<year>` under the chapter's GitHub org, then update any
year-specific strings in `package.json`, `.firebaserc`, and the admin shell
in `public/admin/index.html`. A new repo (rather than a branch inside the
previous year's repo) keeps the previous year's `main` branch pointing at
its own production deployment indefinitely.

Alternative: create a new long-lived branch (e.g. `vendor-day-<year>`)
inside a single evergreen repo. This is simpler but means both years share
GitHub Actions, issues, and PR history. The chapter has used the per-year
repo approach for 2027 and that is the recommended path.

### 2. Cloudflare Pages

1. Sign in to **Cloudflare dashboard → Workers & Pages → Create → Pages →
   Connect to Git** with the chapter Cloudflare account.
2. Authorize GitHub if prompted, pick the `vendor-day-<year>` repo, pick
   the `main` branch.
3. Build settings:
   - Framework preset: **None**
   - Build command: `npm run build`
   - Build output directory: `public`
   - Root directory: leave empty (project root)
4. Under **Environment variables (build)**, add `NODE_VERSION` with value
   `20`. Cloudflare's default build image otherwise ships an older Node
   that cannot import the `jose` v6 dependency used by the Functions.
5. Click **Save and Deploy**. The first deploy will fail cleanly until the
   remaining env vars and bindings in the next sections are installed.

### 3. Custom domain

1. At GoDaddy, open the DNS editor for `gatewayscte.org` and add a CNAME
   record:
   - **Type:** CNAME
   - **Name:** `<year>vendorday` (e.g. `2027vendorday`)
   - **Value:** the Cloudflare target shown in step 4 below (something
     like `vendor-day-<year>.pages.dev`)
   - **TTL:** 1 hour
2. Save. GoDaddy's DNS edits typically propagate in under 15 minutes but
   can take up to an hour.
3. Verify propagation from PowerShell:

   ```powershell
   nslookup <year>vendorday.gatewayscte.org
   ```

   The non-authoritative answer section should list a Cloudflare Pages
   hostname. If `nslookup` returns `*** can't find`, give DNS another
   15 minutes and retry.
4. In the Pages project → **Custom domains → Set up a custom domain** →
   enter `<year>vendorday.gatewayscte.org`. Cloudflare detects the
   existing CNAME and marks the domain **Active** within a few minutes.
5. Confirm **Universal SSL** is active (Cloudflare issues this automatically)
   and that **Always Use HTTPS** is on under the Pages project settings.
6. Open `https://<year>vendorday.gatewayscte.org` in a browser; it should
   serve the PWA shell over a valid certificate.

### 4. Cloudflare R2

User-uploaded assets (sponsor logos, venue map, recap photos) live in a
Cloudflare R2 bucket. R2's free tier (10 GB storage, 1M writes/month,
10M reads/month, zero egress) comfortably covers an event of a few
hundred attendees.

1. Cloudflare dashboard → **R2** (left sidebar). On first use, agree to
   the R2 terms. R2 does not require a paid plan for free-tier usage,
   but Cloudflare requires a credit card on file as a prerequisite.
2. **Create bucket** → name `vendor-day-<year>-assets` → Location
   **Automatic** → **Create bucket**.
3. Open the bucket → **Settings → Public access** → toggle **Allow
   public access** on and confirm. This exposes every object under a
   `https://pub-<hash>.r2.dev/...` URL. That is intentional — all three
   asset classes (sponsor logos, venue map, recap photos) are public by
   design.
4. Copy the **Public URL** shown on the Settings page. It looks like
   `https://pub-abc123def456.r2.dev` with no trailing slash.
5. In the Pages project → **Settings → Bindings** (or **Settings →
   Functions → R2 bucket bindings** on older dashboards) → **Add
   binding**:
   - Variable name: `ASSETS_BUCKET` (exact — the function code reads
     `env.ASSETS_BUCKET`)
   - R2 bucket: `vendor-day-<year>-assets`
   - Save.
6. The Public URL from step 4 is installed as the `R2_PUBLIC_URL`
   environment variable in the next section.

### 5. Cloudflare KV

The admin-login rate limiter stores failed-attempt counters in a KV
namespace. If the namespace is not bound, the handler fails open (logs
a warning and allows unlimited login attempts). Bind it before go-live.

1. Cloudflare dashboard → **Workers & Pages → KV → Create a namespace**
   → name it `vendor-day-<year>-admin-login-rate`.
2. In the Pages project → **Settings → Functions → KV namespace
   bindings** → **Add binding**:
   - Variable name: `ADMIN_LOGIN_RATE` (exact — the function code reads
     `env.ADMIN_LOGIN_RATE`)
   - KV namespace: the one created above.
   - Save.

### 6. Firebase

1. Open [Firebase Console](https://console.firebase.google.com/) signed
   in as `gatewayscte@gmail.com`.
2. **Add project** → name `scte-vendorday-<year>` → **Spark (free) plan**.
   Do not enable Google Analytics for the project.
3. In the new project → **Build → Firestore Database → Create database**
   → **Native mode** → pick a region close to the venue (`us-central1`
   is fine).
4. **Project Settings → Service Accounts → Generate new private key**.
   Save the downloaded JSON somewhere outside the repo, for example
   `C:\Users\<you>\Documents\scte-vendorday-<year>.firebase-service-account.json`.
   This file is a secret: never commit it. The repo's `.gitignore`
   excludes `*.firebase-service-account.json` and `firebase-adminsdk*.json`
   so keep one of those suffixes if the file lands inside the project
   folder.
5. **Project Settings → General → Your apps → Add app → Web** (the `</>`
   icon). Nickname it `Vendor Day <year>`. Firebase prints a config
   object — capture only the `apiKey` string; the rest are either derived
   or unused by this app. Do **not** enable Firebase Hosting.
6. Later in this runbook, under **Firebase CLI operations**, deploy
   `firestore.rules` and seed `appSettings/singleton` from a local
   machine using the service account.

### 7. OneSignal

1. Create or sign in to the chapter's OneSignal account.
2. **New App/Website** → name it `Vendor Day <year>` → choose **Web** →
   **Typical Site** integration.
3. Site URL: `https://<year>vendorday.gatewayscte.org` (must match the
   custom domain exactly, including the `https://` and no trailing slash).
4. **Complete the setup wizard end-to-end.** Skipping any step leaves
   OneSignal's Push channel in an "activation pending" state and no
   notifications will deliver. This has bitten the chapter before —
   expect to click through all four wizard steps even if the defaults
   are fine.
5. After the wizard completes, open **Settings → Keys & IDs** and
   capture:
   - **OneSignal App ID** — public, UUID shape (`xxxxxxxx-xxxx-xxxx-...`).
     Safe to expose client-side.
   - **REST API Key** — secret, long opaque string. Shown **once** at
     creation; if you miss it, generate a new one and update the env var.

---

## Environment variables and bindings

All env vars live in Cloudflare Pages → **Settings → Environment variables**
and must be added to **both** the Production and Preview scopes. Mark the
rows labeled Secret with Cloudflare's **Encrypt** toggle so the value is
not visible after save.

| Variable | Type | Source |
| --- | --- | --- |
| `NODE_VERSION` | Text | Hardcoded `20`. Required so the build image resolves `jose` v6. |
| `FIREBASE_PROJECT_ID` | Text | The Firebase project id (`scte-vendorday-<year>`). |
| `FIREBASE_WEB_API_KEY` | Text | Firebase Console → Project settings → General → Web app config → `apiKey`. Safe to be client-side; locked down by `firestore.rules`. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Secret | The full service account JSON downloaded in step 6, flattened to a single line. See the PowerShell helper below. |
| `ONESIGNAL_APP_ID` | Text | OneSignal → Settings → Keys & IDs → OneSignal App ID. UUID. |
| `ONESIGNAL_REST_API_KEY` | Secret | OneSignal → Settings → Keys & IDs → REST API Key. Shown once at creation. |
| `ADMIN_PASSPHRASE_HASH` | Text (or Secret) | Output of `npm run hash-passphrase`. One-way PBKDF2 hash; strictly speaking it does not need encryption, but marking it Secret is reasonable defense in depth. |
| `ADMIN_JWT_SECRET` | Secret | The second value printed by `npm run hash-passphrase` (random 32-byte base64). |
| `R2_PUBLIC_URL` | Text | The `https://pub-<hash>.r2.dev` URL from the R2 bucket's **Public access** settings. No trailing slash. |

### Flattening the service account JSON on Windows

Cloudflare's env var UI accepts one line of text per value. The service
account JSON contains newlines, which the UI preserves. The function
expects the raw JSON string — pasted exactly as the file contents. The
easiest way on Windows:

```powershell
Get-Content "C:\path\to\scte-vendorday-<year>.firebase-service-account.json" -Raw | Set-Clipboard
```

Then paste into Cloudflare's **Add variable → Value** box. The newlines
inside the string are JSON-legal (they live inside the quoted
`private_key` field as `\n` escape sequences) and the Functions parse it
with `JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON)`.

### Bindings (not env vars)

Bindings are configured under **Settings → Bindings** (or **Settings →
Functions** on older dashboards), separately from env vars:

| Binding | Target | Used by |
| --- | --- | --- |
| `ASSETS_BUCKET` | R2 bucket `vendor-day-<year>-assets` | `/api/upload` for sponsor / map / recap uploads |
| `ADMIN_LOGIN_RATE` | KV namespace `vendor-day-<year>-admin-login-rate` | `/api/admin-login` for per-IP rate limiting |

Env vars and bindings apply on the **next** deploy. After installing them,
either push a trivial commit or go to **Deployments → latest → ⋯ → Retry
deployment** so the live Functions pick them up without waiting for the
next code change.

---

## Service worker arrangement

The app runs **one** service worker at `/sw.js`. That worker is the file
OneSignal registers for Web Push, and it is the file the attendee app
registers for its own shell / content / image caching. The arrangement:

- `public/sw.js` has `importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js")`
  as the **first executable line**. OneSignal's push, notificationclick,
  and pushsubscriptionchange handlers register against the same global
  scope before our own `install` / `activate` / `fetch` listeners wire up.
- `public/js/onesignal.js` initializes the OneSignal Web SDK with
  `serviceWorkerPath: "sw.js"` and `serviceWorkerParam: { scope: "/" }`
  so the SDK points at our worker instead of registering a second one.
- `public/OneSignalSDKWorker.js` still exists at the project root as a
  no-op redirect but is **not** the registered worker.

### Why this matters

The original design (`.kiro/specs/vendor-day-app/design.md` section 8)
called for two service workers: `/sw.js` for the app shell and
`/OneSignalSDKWorker.js` for push, each with scope `/`. On iOS 16.4+
installed PWAs this caused a silent scope conflict — the OS granted
notification permission, OneSignal registered a subscription, but push
events never reached either worker and no notifications arrived. This
was discovered during Task 25 iteration on physical iPhone and iPad
devices.

The current one-worker arrangement is the fix. If a future admin or
developer tries to "clean up" the extra `importScripts` line in
`public/sw.js`, or switches `serviceWorkerPath` back to the OneSignal
default, iOS push delivery breaks again. Leave it alone unless you have
a confirmed replacement for the two concerns the import solves (push
event handling + pushsubscriptionchange rotation).

---

## Firebase CLI operations

Deploying Firestore rules and seeding `appSettings/singleton` happen from
a local machine, not from Cloudflare. Commands assume PowerShell with the
current directory at the project root (where `firebase.json` lives).

### One-time: install the CLI

```powershell
npm install -g firebase-tools
```

Confirm:

```powershell
firebase --version
```

### Sign in

```powershell
firebase login
```

Sign in with `gatewayscte@gmail.com`. On a shared laptop, use
`firebase login --no-localhost` and `firebase logout` after the session.

### Select the project

```powershell
firebase use scte-vendorday-<year>
```

The CLI reads `.firebaserc`. The output must read `Now using project
scte-vendorday-<year>` before you deploy anything.

### Deploy Firestore rules

```powershell
firebase deploy --only firestore:rules
```

A successful deploy prints `Deploy complete!`. The rules in
`firestore.rules` grant public read on `agenda`, `sponsors`,
`announcements`, `attendees` (filtered to `optedOut == false`),
`feedbackConfig`, `recap`, and `appSettings`, and deny all client writes.
All writes route through `/api/firestore-write` with the admin JWT.

### Seed `appSettings/singleton`

The seed script writes placeholder defaults (event title, venue, nulled
date and map URL) so the attendee app's first reads succeed before the
board enters real content. Run once from a laptop with `npm install`
completed:

```powershell
node scripts/seed-app-settings.js "C:\path\to\scte-vendorday-<year>.firebase-service-account.json"
```

Or export the path first:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\scte-vendorday-<year>.firebase-service-account.json"
node scripts/seed-app-settings.js
```

On success the script prints a line like `Seeded appSettings/singleton
for project: scte-vendorday-<year>`. The script overwrites the singleton
on every run (`set` with `{ merge: false }`); do not re-run it after
admins have entered real content — they will lose edits.

---

## Admin passphrase lifecycle

### Generating a new passphrase hash

Run locally from the project root:

```powershell
npm run hash-passphrase
```

The script prompts for the passphrase, derives a PBKDF2-SHA-256 hash
(100,000 iterations, 16-byte random salt, both base64), and prints two
values:

1. `ADMIN_PASSPHRASE_HASH` — the single-line `pbkdf2$sha256$...$...$...`
   string.
2. `ADMIN_JWT_SECRET` — a fresh random 32-byte base64 string.

The script clears the terminal with `\x1Bc` before printing so the raw
passphrase does not sit on-screen. The shell history can still contain
the keystrokes depending on your PowerShell profile.

### Installing in Cloudflare

Paste both values into Cloudflare Pages → **Settings → Environment
variables** for the **Production and Preview** scopes. Retry the latest
deployment so the running Functions pick up the new values.

### Rotation (also known as "sign out everywhere")

To rotate the passphrase AND invalidate every outstanding admin session
in one step:

1. Run `npm run hash-passphrase` with the new passphrase.
2. Replace **both** `ADMIN_PASSPHRASE_HASH` **and** `ADMIN_JWT_SECRET` in
   Cloudflare. Rotating only the hash leaves existing sessions valid for
   up to 12 hours; rotating only the secret leaves the old passphrase
   working.
3. **Deployments → latest → ⋯ → Retry deployment**.

Any outstanding admin JWTs stop verifying immediately because they were
signed with the previous `ADMIN_JWT_SECRET`. The next admin page load
redirects to the login screen. The new passphrase is required.

### Lost passphrase

The hash is one-way; there is no recovery. Rotate (above) with a fresh
passphrase and share it with the board through the chapter's usual
out-of-band channel.

---

## Deploys and rollbacks

### Normal deploys

Every push to `main` triggers a Cloudflare Pages build + deploy. There is
no separate publish step for Pages Functions — the static site in
`public/` and the Functions under `functions/api/` deploy atomically.

Builds typically complete in under two minutes. The build log is visible
under **Deployments → latest**.

### Preview deploys

Any push to a branch other than `main` creates a preview deployment at
`<branch>.<project>.pages.dev` with the same env vars and bindings as
production. Previews are the pre-production story; there is no separate
staging environment.

### Rollback

1. In the Pages project → **Deployments**, scroll to the last known-good
   deploy.
2. Click the three-dot menu on that row → **Rollback to this deployment**
   (wording varies slightly across dashboard versions — look for
   "rollback" or "promote to production").
3. Cloudflare re-points the production URL at the older build within
   seconds.

**Rolling back Cloudflare does not roll back Firestore.** Any content
writes committed by admins since the earlier deploy remain in the
database. If a deploy regression was accompanied by bad content edits,
restore the content separately through the admin editors.

---

## Smoke tests

Run these from a PowerShell window after any production deploy. Replace
`<domain>` with `<year>vendorday.gatewayscte.org`.

```powershell
# Public config — expect 200 with firebaseProjectId, firebaseWebApiKey,
# oneSignalAppId, assetsBaseUrl in the JSON body.
curl.exe -i --ssl-no-revoke "https://<domain>/api/config"

# Admin login with no body — expect 400 "Invalid JSON body".
curl.exe -i --ssl-no-revoke -X POST "https://<domain>/api/admin-login"

# Firestore write without a JWT — expect 401 Unauthorized.
curl.exe -i --ssl-no-revoke -X POST "https://<domain>/api/firestore-write"

# Upload without a JWT — expect 401 Unauthorized.
curl.exe -i --ssl-no-revoke -X POST "https://<domain>/api/upload"
```

Red flags:

- `/api/config` returns `500 Server misconfigured` — `FIREBASE_PROJECT_ID`
  or `FIREBASE_WEB_API_KEY` is missing. Fix the env vars and redeploy.
- `/api/admin-login` returns `500 Server misconfigured` — the hash env
  var is unset or malformed. Re-run `npm run hash-passphrase` and
  reinstall.
- Any endpoint returns `404` — Pages Functions did not deploy; check the
  build log for errors.

### Push delivery smoke test

The curl smoke tests above do not exercise OneSignal. To confirm push:

1. On a device with the app installed and notifications enabled, open
   Announcements and confirm the opt-in card is dismissed (device is
   subscribed).
2. Sign in to OneSignal → **Messages → New Push** → compose a one-line
   test → **Send to Subscribed Users** → send.
3. The device should receive the notification within a few seconds.
   Tapping it should open the app.

Alternatively, publish a test announcement from the admin composer with
"Send push" checked, then delete the announcement from the admin after
you have verified the push arrived.

---

## Known limitations

- **Browser compatibility floor.** The app shell polyfills
  `crypto.randomUUID` (via `public/js/polyfills.js` on the page and an
  inline block at the top of `public/sw.js` for the service worker), so
  the effective minimum requirement is any browser that exposes
  `crypto.getRandomValues` — universal in HTTPS contexts since ~2015.
  Older browsers without that method cannot run the app regardless.
- **iOS web push reliability.** Delivery on iOS depends heavily on the
  installed PWA state, screen-on state, and the specific iOS version /
  device. The chapter has observed some iPhones that stop receiving
  pushes after a few hours even when nothing in our code changed. There
  is no fix from our side — the quirks live in iOS's Apple Push
  Notification Service bridge. Document the expectation to board members:
  push is best-effort, not guaranteed.
- **Filtered Firestore views don't persist offline.** The service worker
  caches Firestore `GET` list responses, so Agenda and Sponsors render
  from cache when offline. Views that rely on filtered queries use
  Firestore's `:runQuery` POST endpoint, which the service worker does
  not cache. That affects the Home view's **Latest announcement** card
  and the **Attendee directory** search — both revert to their empty
  state when offline rather than showing last-seen data.
- **OneSignal free-plan dashboard.** Push delivery works normally on the
  free plan, but the **Users & Subscriptions** detail page is gated
  behind a paid plan. Subscription counts and per-message delivery stats
  are still visible on the Messages page; only the user-level drill-down
  is paywalled.

---

## Yearly rollover

At the end of each year, the board decides whether to reuse the existing
Cloudflare / Firebase / OneSignal accounts or start fresh. Reusing saves
setup time; starting fresh gives a clean slate (useful if the previous
year's quotas or spam flags matter).

Checklist:

1. Decide: reuse accounts (preferred) or create fresh.
2. At GoDaddy, add a CNAME for the new subdomain
   `<new-year>vendorday.gatewayscte.org` pointing at the Pages project's
   `.pages.dev` hostname.
3. **If reusing**:
   - Create a new repo (or branch) for `vendor-day-<new-year>`.
   - Repoint the existing Cloudflare Pages project at the new repo or
     bind a second Pages project — whichever the board prefers for
     keeping both years live during the transition.
   - Bind the new custom domain.
   - Update `FIREBASE_PROJECT_ID`, re-generate and reinstall
     `FIREBASE_SERVICE_ACCOUNT_JSON` and `FIREBASE_WEB_API_KEY` for the
     new Firebase project.
   - Create a new OneSignal Web Push app for the new site URL (do not
     reuse the previous year's app — Site URL is immutable after
     subscriptions exist) and update `ONESIGNAL_APP_ID` and
     `ONESIGNAL_REST_API_KEY`.
   - Rotate `ADMIN_PASSPHRASE_HASH` and `ADMIN_JWT_SECRET` for the new
     year.
   - Create a fresh R2 bucket `vendor-day-<new-year>-assets`, update
     `R2_PUBLIC_URL`, and re-bind `ASSETS_BUCKET`.
   - Create a fresh KV namespace and re-bind `ADMIN_LOGIN_RATE`.
4. **If starting fresh**: redo the entire **First-time project setup**
   section above with the new year's values.
5. Seed `appSettings/singleton` with the new year's venue, event title,
   and placeholder date (the admins update the date through the editor
   once it is confirmed).
6. Optional: delete or archive the previous year's R2 bucket after the
   recap is captured in the new year's deployment, if the chapter
   prefers to retain tight storage-usage visibility.
