#!/usr/bin/env node
/**
 * hash-passphrase.js — produce the ADMIN_PASSPHRASE_HASH and ADMIN_JWT_SECRET
 * values that live in Cloudflare Pages environment variables.
 *
 * Prompts for the admin passphrase on stdin, runs PBKDF2-SHA-256 with
 * 310,000 iterations and a random 16-byte salt, and prints the hash in the
 * single-line format `pbkdf2$sha256$310000$<salt>$<hash>`. Also generates a
 * random 32-byte base64 ADMIN_JWT_SECRET.
 *
 * No npm dependencies — Node 18 standard library only.
 */
"use strict";

const crypto = require("node:crypto");
const readline = require("node:readline");

const ITERATIONS = 310000;
const KEY_LENGTH = 32; // 256 bits
const SALT_BYTES = 16;
const DIGEST = "sha256";
const JWT_SECRET_BYTES = 32;

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const passphrase = (await prompt("Enter admin passphrase: ")).trim();
  if (passphrase.length === 0) {
    console.error("No passphrase entered. Aborting.");
    process.exit(1);
  }

  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, KEY_LENGTH, DIGEST);
  const hash = `pbkdf2$sha256$${ITERATIONS}$${salt.toString("base64")}$${derived.toString("base64")}`;
  const jwtSecret = crypto.randomBytes(JWT_SECRET_BYTES).toString("base64");

  // Clear whatever the user typed off the visible scrollback before we print
  // secrets. This is cosmetic — a real audit trail still lives in shell
  // history unless the user disabled it before running the script.
  process.stdout.write("\x1Bc");

  console.log("ADMIN_PASSPHRASE_HASH:");
  console.log(hash);
  console.log("");
  console.log("ADMIN_JWT_SECRET:");
  console.log(jwtSecret);
  console.log("");
  console.log("Copy both values into Cloudflare Pages → Settings → Environment variables");
  console.log("as encrypted secrets for the Production and Preview scopes. Do NOT paste");
  console.log("the raw passphrase into Cloudflare, chat, email, or any file.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
