#!/usr/bin/env node
// One-off local script: uploads knowledge_base.md to the project's Vercel
// Blob store (private access — this store doesn't allow public blobs) at a
// fixed pathname, so re-running it after editing the doc overwrites the same
// blob in place instead of minting a new URL each time.
//
// Run with:  node scripts/ingest-kb.mjs
//
// Auth: needs BLOB_READ_WRITE_TOKEN in the environment (or .env.local).
// Get it from the Vercel dashboard: Storage -> this Blob store -> Quickstart.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { put } from "@vercel/blob";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_PATH = path.join(__dirname, "..", "knowledge_base.md");
const ENV_LOCAL_PATH = path.join(__dirname, "..", ".env.local");

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

async function main() {
  loadEnvFile(ENV_LOCAL_PATH);

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error(
      "Missing BLOB_READ_WRITE_TOKEN. Copy it from the Vercel dashboard\n" +
        "(Storage -> this Blob store -> Quickstart) and either export it in\n" +
        "your shell for this command, or add it to .env.local."
    );
    process.exit(1);
  }

  if (!existsSync(KB_PATH)) {
    console.error(`knowledge_base.md not found at ${KB_PATH}`);
    process.exit(1);
  }

  const content = readFileSync(KB_PATH, "utf-8");

  const blob = await put("knowledge_base.md", content, {
    access: "private",
    contentType: "text/markdown; charset=utf-8",
    allowOverwrite: true,
    addRandomSuffix: false,
    // Pass the token explicitly — @vercel/blob otherwise prefers a linked
    // project's Vercel OIDC token over BLOB_READ_WRITE_TOKEN even when both
    // are present, and that OIDC token is scoped to "development" here,
    // which this store isn't connected for.
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });

  console.log("Uploaded knowledge base to Vercel Blob:");
  console.log(blob.url);
  console.log("\nSet KNOWLEDGE_BASE_URL to this value in:");
  console.log("  - TravelAgent-demo/cli/config.env (local CLI)");
  console.log("  - TravelAgent-demo/.env.local (local web dev)");
  console.log("  - Vercel project env vars (production/preview): vercel env add KNOWLEDGE_BASE_URL");
}

main().catch((err) => {
  console.error("Ingestion failed:", err.message || err);
  process.exit(1);
});
