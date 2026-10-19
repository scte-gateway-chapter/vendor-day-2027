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
  // runs the seed script or Pages Functions locally. Load it lazily so running
  // the script with no args prints the usage message without needing the
  // package installed.
  let admin;
  try {
    admin = require("firebase-admin");
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

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  const db = admin.firestore();

  const appSettings = {
    eventTitle: "SCTE Gateway Chapter Vendor Day 2027",
    eventDate: null,
    venueName: "Doubletree Chesterfield",
    venueAddress: "Chesterfield, MO 63005",
    venueMapUrl: null,
    venueMapCaption:
      "Doubletree Chesterfield Exhibit Hall — final map will be posted before the event.",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: "seed-script",
  };

  await db.doc("appSettings/singleton").set(appSettings, { merge: false });

  console.log("Seeded appSettings/singleton for project:", serviceAccount.project_id || "(unknown)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
