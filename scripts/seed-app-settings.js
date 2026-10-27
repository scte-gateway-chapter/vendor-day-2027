#!/usr/bin/env node
/**
 * seed-app-settings.js — one-time seed of the `appSettings/singleton` document.
 *
 * Writes the design-section-5 placeholder defaults so the attendee app's
 * initial reads succeed before the board has entered real content. Overwrites
 * any existing singleton (`set` with `{ merge: false }`); re-run after any
 * schema change.
 *
 * Usage
 * -----
 *   node scripts/seed-app-settings.js "C:\path\to\service-account.json"
 *
 * Or, with the service account path exported in the environment:
 *   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\service-account.json"
 *   node scripts/seed-app-settings.js
 *
 * The service account JSON is NEVER committed to the repo. It lives on the
 * admin's laptop (and inside Cloudflare Pages env vars for the Pages
 * Functions). See docs/deployment.md.
 */
"use strict";

const path = require("node:path");

function usageAndExit() {
  console.error("Usage: node scripts/seed-app-settings.js <path-to-service-account.json>");
  console.error("       (or set GOOGLE_APPLICATION_CREDENTIALS to the same path and omit the argument)");
  process.exit(2);
}

async function main() {
  const credentialPathArg = process.argv[2];
  const credentialPathEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const credentialPath = credentialPathArg || credentialPathEnv;

  if (!credentialPath) {
    usageAndExit();
  }

  const resolvedPath = path.resolve(credentialPath);

  // Firebase Admin SDK is a devDependency so it only installs when a developer
  // runs the seed script or Pages Functions locally. Use firebase-admin's
  // modular imports (v10+ API) because the default-namespace export was
  // removed in v12+ and `require("firebase-admin").credential` is now
  // undefined.
  let initializeApp;
  let cert;
  let getFirestore;
  let FieldValue;
  try {
    ({ initializeApp, cert } = require("firebase-admin/app"));
    ({ getFirestore, FieldValue } = require("firebase-admin/firestore"));
  } catch (err) {
    console.error("firebase-admin is not installed. Run `npm install` from the project root first.");
    process.exit(1);
  }

  let serviceAccount;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    serviceAccount = require(resolvedPath);
  } catch (err) {
    console.error(`Could not read service account JSON at: ${resolvedPath}`);
    console.error(err.message);
    process.exit(1);
  }

  const app = initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore(app);

  const appSettings = {
    eventTitle: "SCTE Gateway Chapter Vendor Day 2027",
    eventDate: null,
    venueName: "Doubletree Chesterfield",
    venueAddress: "Chesterfield, MO 63005",
    venueMapUrl: null,
    venueMapCaption:
      "Doubletree Chesterfield Exhibit Hall — final map will be posted before the event.",
    // Attendee Sign-In surfaces (Welcome CTA, Home quick-action, More
    // menu entry, #/sign-in route) are gated behind this flag. Default
    // false so a fresh seed hides sign-in until an admin flips the
    // toggle on from the admin Settings page close to event start.
    signInEnabled: false,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: "seed-script",
  };

  await db.doc("appSettings/singleton").set(appSettings, { merge: false });

  console.log("Seeded appSettings/singleton for project:", serviceAccount.project_id || "(unknown)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
