# SCTE Gateway Chapter Vendor Day 2027 PWA

A single-year, mobile-first Progressive Web App for the SCTE Gateway Chapter Vendor Day 2027 at the Doubletree Chesterfield in Chesterfield, MO. Attendees reach it by scanning a QR code and land at `2027vendorday.gatewayscte.org`.

## Stack

- **Front end**: vanilla HTML, CSS, and JS (ES modules) served as a flat static bundle. No framework, no bundler.
- **Hosting**: Cloudflare Pages (free tier) with Cloudflare Pages Functions for the small server surface (admin login, Firestore write broker, push send).
- **Content store**: Firebase Firestore (Spark free plan). Reads are public; writes go through a Pages Function that validates an admin JWT and uses the Firebase Admin SDK.
- **Push notifications**: OneSignal Web SDK (free tier), triggered server-side by `/api/send-push`.
- **Service worker**: cache-first app shell, network-first content JSON, cache-first images.

## Spec

The authoritative design lives under `.kiro/specs/vendor-day-app/`:

- `requirements.md` — user stories and acceptance criteria.
- `design.md` — architecture, data model, screens, auth, carry-forward palette.
- `tasks.md` — ordered implementation plan.

Treat those three files as the source of truth. This README is a reader's quick-start.

## Repository layout

```
public/            static site root (deployed as-is)
  index.html         attendee shell
  manifest.webmanifest
  sw.js              service worker (cache name stamped at build)
  css/               styles
  js/                attendee JS modules
    views/             one file per view (added in Task 6+)
  admin/             admin shell + admin-only JS/CSS
  assets/
    icons/             PWA icons (added in Task 7)
    placeholders/      default map image, logo placeholder (added later)
    brand/             chapter logo variants
functions/         Cloudflare Pages Functions source (added in Task 5)
  _shared/
scripts/           build + utility scripts (Node 18 stdlib only)
docs/              runbooks (added in Tasks 1 and 29)
.github/workflows/ reserved for optional CI (Task 27)
```

## Running locally

```
npm run build
npm start
```

- `npm run build` runs `scripts/build-sw.js`, which stamps a `BUILD_ID` into the service worker's cache name constants. Cloudflare injects `BUILD_ID` at deploy time; locally the script falls back to `Date.now()`.
- `npm start` runs `npx http-server public -p 8080` so the shell is reachable at `http://localhost:8080/` (attendee) and `http://localhost:8080/admin/` (admin). `npx` runs `http-server` on demand with no installed dependency.

## Next steps (for a human reader)

1. Create the chapter-owned GitHub repository under `https://github.com/scte-gateway-chapter` (suggested name: `vendor-day-2027`), `git init` this working tree, and push to `main`. The scaffold is intentionally left uncommitted so you can review before pushing.
2. Run `npm run hash-passphrase` to generate `ADMIN_PASSPHRASE_HASH` and `ADMIN_JWT_SECRET`. Paste both into Cloudflare Pages → Settings → Environment variables as encrypted values. Do not commit either, and do not paste the raw passphrase anywhere else.
3. Create the Cloudflare Pages project pointing at the GitHub repo. Framework preset: None. Build command: `npm run build`. Build output directory: `public`. Node version: 18. Bind the custom domain `2027vendorday.gatewayscte.org`.
4. Install the full env var set in Cloudflare Pages per `design.md` section 10 (OneSignal, Firebase, admin). Scope every secret to both Production and Preview.
5. Continue through `tasks.md` starting at Task 3.

## Scope boundaries

- No app-store presence. Install is through the browser's "Add to Home Screen" / "Install app" affordance.
- One-year scope. Each future year's event gets a fresh deployment under its own subdomain.
- No login for attendees. The admin area is passphrase-gated.
- No third-party analytics or trackers.
