# Deployment Runbook

This runbook captures the one-time and recurring steps to deploy the Vendor Day
2027 PWA. Sections are added as the matching implementation task lands.

## Firebase (Firestore + Storage + initial seed)

The app's content lives in Firebase project **`scte-vendorday-2027`** (Firestore
in native mode, plus Firebase Storage for uploaded sponsor logos, venue map
images, and recap photos). This section covers deploying the security rules in
`firestore.rules` and `storage.rules` and seeding the `appSettings/singleton`
document so the attendee app's first read succeeds.

Run these steps from a Windows laptop with PowerShell. All commands assume the
current directory is the project root (the folder that contains `firebase.json`
and `package.json`).

### Prerequisites

- A chapter Google account with Owner access to the Firebase project
  (`gatewayscte@gmail.com`).
- Node 18 or newer on the machine running the deploy.
- A service account JSON key for the Firebase project, downloaded from
  **Firebase Console → Project Settings → Service Accounts → Generate new
  private key** and saved somewhere outside this repository (for example
  `C:\Users\<you>\Documents\scte-vendorday-2027.firebase-service-account.json`).
  This file is a secret: it must NEVER be committed. The repository
  `.gitignore` excludes files matching `*.firebase-service-account.json` and
  `firebase-adminsdk*.json` — keep one of those suffixes if the key is ever
  placed inside the repo folder, and double-check `git status` before any
  `git add`.

### 1. Install the Firebase CLI

```powershell
npm install -g firebase-tools
```

Confirm:

```powershell
firebase --version
```

### 2. Sign in with the chapter Google account

```powershell
firebase login
```

A browser window opens. Sign in with `gatewayscte@gmail.com`. If the laptop is
shared, use `firebase login --no-localhost` and `firebase logout` after the
session.

### 3. Select the project

```powershell
firebase use scte-vendorday-2027
```

This confirms the alias defined in `.firebaserc` and prints the active project.
If the output does not read `Now using project scte-vendorday-2027`, stop and
re-check the file.

### 4. (One-time) Enable Firebase Storage

Firestore is already enabled in native mode. Firebase Storage may still be
unprovisioned. If step 5 fails with a message mentioning Storage not being
set up, open **Firebase Console → Build → Storage → Get started**, choose
**Production mode**, and pick the **us-central** location. Then retry step 5.

### 5. Deploy the Firestore and Storage rules

```powershell
firebase deploy --only firestore:rules,storage:rules
```

A successful deploy prints `Deploy complete!` and lists the two rules sources
by file name. The posture after deploy:

- `agenda`, `sponsors`, `announcements`, `feedbackConfig`, `recap`, and
  `appSettings` are publicly readable; client writes are denied.
- `attendees` reads require `optedOut == false` (the attendee app's query
  includes the matching `where` filter).
- `feedbackResponses` accept client `create` only (no read, update, or
  delete).
- Firebase Storage paths `/sponsors/**`, `/venue-map/**`, and `/recap/**` are
  publicly readable; all client writes are denied. Admin uploads flow through
  `/api/upload` (added in a later task) with the Admin SDK.

### 6. Seed the `appSettings/singleton` document

The seed script is written in plain Node and uses the Firebase Admin SDK,
which lives in `devDependencies`. Install dev deps once:

```powershell
npm install
```

Then run the seed. Pass the service account JSON path as the first argument
(use double quotes around any path containing spaces):

```powershell
node scripts/seed-app-settings.js "C:\Users\<you>\Documents\scte-vendorday-2027.firebase-service-account.json"
```

Or export the path to the environment first and omit the argument:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\Users\<you>\Documents\scte-vendorday-2027.firebase-service-account.json"
node scripts/seed-app-settings.js
```

On success the script prints a single confirmation line like
`Seeded appSettings/singleton for project: scte-vendorday-2027`.

### 7. Verify

Anonymous read of the seeded document (public read is allowed):

```powershell
curl.exe "https://firestore.googleapis.com/v1/projects/scte-vendorday-2027/databases/(default)/documents/appSettings/singleton"
```

The response is a JSON body containing the fields set by the script
(`eventTitle`, `venueName`, `venueAddress`, `venueMapCaption`, and null-valued
`eventDate` and `venueMapUrl`).

Anonymous write attempt (should be denied by the rules):

```powershell
curl.exe -X PATCH `
  -H "Content-Type: application/json" `
  --data "{ `"fields`": { `"eventTitle`": { `"stringValue`": `"nope`" } } }" `
  "https://firestore.googleapis.com/v1/projects/scte-vendorday-2027/databases/(default)/documents/appSettings/singleton"
```

Expect a `403` with a message containing `Missing or insufficient permissions`
or `PERMISSION_DENIED`. If this write succeeds, stop and re-check the rules
deploy in step 5.

### Re-deploying after a rules edit

Any time `firestore.rules` or `storage.rules` changes:

```powershell
firebase deploy --only firestore:rules,storage:rules
```

The seed script only needs to run once (and again after any schema change in
section 5 of the design doc).

### Note on Pages Function routing

Cloudflare Pages maps files under `functions/` to URL routes by directory
structure, with the `api/` subdirectory serving as the API prefix. The server
code in this repo lives at `functions/api/*.js`:

- `functions/api/admin-login.js` → `/api/admin-login`
- `functions/api/firestore-write.js` → `/api/firestore-write`
- `functions/api/send-push.js` → `/api/send-push`

The design doc (section 10) sketches these as `functions/admin-login.js` etc.
The code uses the `api/` subdirectory because Cloudflare's routing requires it
to produce `/api/...` URLs. Shared helpers live under `functions/_shared/`
with filenames that begin with `_` so Cloudflare skips them when generating
routes.

## Cloudflare Pages

The static site plus the three Pages Functions in `functions/api/` ship from
one Cloudflare Pages project connected to the GitHub repo. There is no
separate publish step for Functions — every push to `main` rebuilds the site
and redeploys the Functions atomically. Feature branches get isolated preview
deployments at `<branch>.<project>.pages.dev`.

### 1. Create the Pages project

1. Sign in to **Cloudflare dashboard → Workers & Pages → Create → Pages →
   Connect to Git** with the chapter Cloudflare account.
2. Authorize GitHub if prompted, pick the repo
   `scte-gateway-chapter/vendor-day-2027`, pick the `main` branch.
3. Framework preset: **None**.
4. Build command: `npm run build`.
5. Build output directory: `public`.
6. Root directory: project root (leave empty).
7. Environment variables (build) → add **`NODE_VERSION`** with value `20`.
   Cloudflare's default build image otherwise ships an older Node that cannot
   import `jose` v6. The runtime for Pages Functions is the Workers runtime,
   so this setting only affects the build-time `npm run build` + `scripts/
   build-sw.js`.
8. Click **Save and Deploy**.

### 2. Bind the custom domain

1. In the Pages project → **Custom domains** → **Set up a custom domain** →
   enter `2027vendorday.gatewayscte.org`.
2. Cloudflare will show the CNAME target (something like
   `scte-vendorday-2027.pages.dev`). The user has already added that CNAME at
   GoDaddy. Cloudflare should show the custom domain as **Active** within a
   few minutes once DNS propagates.
3. Confirm **Universal SSL** is active (Cloudflare issues this automatically)
   and that **Always Use HTTPS** is on for the project.
4. Verify in a browser: `https://2027vendorday.gatewayscte.org` serves the
   PWA with a valid certificate.

### 3. Install environment variables (Production and Preview scopes)

In Cloudflare Pages → **Settings → Environment variables**, add every row
below to both the **Production** and **Preview** scopes. Each secret is
provisioned by Task 1 and listed in `docs/provisioning-checklist.md`.

| Name                            | Scope        | Type       | Source                                           |
|---------------------------------|--------------|------------|--------------------------------------------------|
| `ONESIGNAL_APP_ID`              | Prod + Preview | Plaintext | OneSignal → App → Settings → Keys & IDs          |
| `ONESIGNAL_REST_API_KEY`        | Prod + Preview | **Encrypt** | OneSignal → App → Settings → Keys & IDs          |
| `ADMIN_PASSPHRASE_HASH`         | Prod + Preview | **Encrypt** | `npm run hash-passphrase` (chapter laptop)       |
| `ADMIN_JWT_SECRET`              | Prod + Preview | **Encrypt** | `npm run hash-passphrase` (chapter laptop)       |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Prod + Preview | **Encrypt** | Firebase Console → Service accounts → Generate key, paste the full JSON as one line |
| `FIREBASE_PROJECT_ID`           | Prod + Preview | Plaintext | `scte-vendorday-2027`                            |
| `FIREBASE_WEB_API_KEY`          | Prod + Preview | Plaintext | Firebase Console → Project settings → General   |

Every row marked **Encrypt** must use Cloudflare's encrypted secret toggle so
the value is never visible after save. Rotation is a two-step process:
replace the value, redeploy.

### 4. Create and bind the KV namespace for admin-login rate limiting

The `/api/admin-login` handler reads failed-attempt counters from a Cloudflare
KV namespace. If the namespace is not bound, the handler **fails open** (logs
a console warning and allows unlimited login attempts). Bind it before going
live.

1. **Workers & Pages → KV → Create a namespace** → name it
   `vendor-day-2027-admin-login-rate` (or any name; the binding name is what
   matters).
2. In the Pages project → **Settings → Functions → KV namespace bindings** →
   **Add binding**:
   - Variable name: `ADMIN_LOGIN_RATE` (exact — the function code reads
     `env.ADMIN_LOGIN_RATE`).
   - KV namespace: the one created above.
3. Save and trigger a redeploy (Pages applies new bindings on the next
   deploy; a trivial empty commit works, or push a branch and merge).

### 5. Verify (smoke tests)

Run these from a terminal after the first production deploy. Replace
`<domain>` with `2027vendorday.gatewayscte.org` for production or
`<branch>.<project>.pages.dev` for a preview deploy.

```powershell
# Admin login: missing passphrase → 400
curl.exe -X POST "https://<domain>/api/admin-login" `
  -H "Content-Type: application/json" `
  --data "{}"

# Admin login: wrong passphrase → 401 (and increments the KV counter)
curl.exe -X POST "https://<domain>/api/admin-login" `
  -H "Content-Type: application/json" `
  --data "{ `"passphrase`": `"not-the-passphrase`" }"

# Admin login: six wrong attempts in rapid succession → the sixth returns 429
# with a Retry-After header
for ($i = 1; $i -le 6; $i++) {
  curl.exe -i -X POST "https://<domain>/api/admin-login" `
    -H "Content-Type: application/json" `
    --data "{ `"passphrase`": `"wrong-$i`" }"
}

# Firestore write: no Authorization header → 401
curl.exe -i -X POST "https://<domain>/api/firestore-write" `
  -H "Content-Type: application/json" `
  --data "{ `"collection`": `"agenda`", `"docId`": `"test`", `"op`": `"set`", `"data`": {} }"

# Firestore write: bad JWT → 401
curl.exe -i -X POST "https://<domain>/api/firestore-write" `
  -H "Authorization: Bearer not-a-jwt" `
  -H "Content-Type: application/json" `
  --data "{ `"collection`": `"agenda`", `"docId`": `"test`", `"op`": `"set`", `"data`": {} }"

# Send push: no Authorization → 401
curl.exe -i -X POST "https://<domain>/api/send-push" `
  -H "Content-Type: application/json" `
  --data "{ `"announcementId`": `"a`", `"title`": `"t`", `"bodyPreview`": `"b`" }"

# Healthcheck (admin-authenticated). Replace <jwt> with a token returned by a
# successful /api/admin-login call.
curl.exe -i "https://<domain>/api/send-push?healthcheck=1" `
  -H "Authorization: Bearer <jwt>"
```

Expected results:

- The missing-passphrase POST returns `400` with `{"error":"Missing passphrase"}`.
- Wrong-passphrase returns `401` with `{"error":"Incorrect passphrase"}`.
- The sixth wrong attempt returns HTTP `429`, a `Retry-After: 600` header, and
  `{"error":"Too many attempts","retryAfterSec":600}`.
- Both firestore-write smoke calls return `401 Unauthorized`.
- The send-push smoke call returns `401 Unauthorized`.
- The healthcheck returns `200` with `{"firestore":"ok","onesignal":"ok"}`
  when all three services are reachable. If either reads `"fail"`, inspect the
  Pages function logs for the detail.

### 6. Function deployment model

Function source lives in `functions/api/*.js` and `functions/_shared/*.js`.
Cloudflare Pages picks them up on every deploy; there is **no separate
`wrangler publish`** step. A `git push` to `main` is the sole deploy signal
for both the static assets in `public/` and the three Functions endpoints.

If `jose` ever fails to run on the Workers runtime (not expected — `jose` is
built for the Web Crypto / Workers environment), the fallback is to add a
`wrangler.toml` at the repo root with `compatibility_flags = ["nodejs_compat"]`
and `compatibility_date = "2024-09-23"` and swap in `firebase-admin` on the
server side. Document that fallback here if it is ever used.

