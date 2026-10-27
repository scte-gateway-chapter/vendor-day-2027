#!/usr/bin/env node
/**
 * Generates the attendee QR code for the Vendor Day 2027 PWA.
 *
 * Writes docs/vendor-day-app-qr.png — a 1024px PNG with high error correction
 * (survives moderate print damage, folds, and partial occlusion). Rerun this
 * script if the public URL changes.
 *
 * Usage:
 *   npm run qr          # default URL (docs/qr-content.txt)
 *   node scripts/generate-qr.js https://example.com   # custom URL
 */

const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const ROOT = path.resolve(__dirname, "..");
const CONTENT_FILE = path.join(ROOT, "docs", "qr-content.txt");
const OUTPUT_FILE = path.join(ROOT, "docs", "vendor-day-app-qr.png");

function resolveUrl() {
  const fromArg = process.argv[2];
  if (fromArg && /^https?:\/\//i.test(fromArg)) return fromArg.trim();
  if (!fs.existsSync(CONTENT_FILE)) {
    throw new Error(
      `Missing ${CONTENT_FILE}. Pass a URL as the first argument or create the file.`
    );
  }
  const raw = fs.readFileSync(CONTENT_FILE, "utf8").trim();
  if (!raw) throw new Error(`${CONTENT_FILE} is empty.`);
  return raw.split(/\r?\n/)[0].trim();
}

async function main() {
  const url = resolveUrl();
  await QRCode.toFile(OUTPUT_FILE, url, {
    errorCorrectionLevel: "H", // ~30% damage tolerance — safest for print
    width: 1024,
    margin: 2, // quiet zone of 2 modules; scanners need it
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  console.log(`QR code generated: ${path.relative(ROOT, OUTPUT_FILE)}`);
  console.log(`Encoded URL: ${url}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
