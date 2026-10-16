#!/usr/bin/env node
/**
 * Migration script: Compress usage.json files in .knowhow/processes/agents/
 *
 * The old format writes the full message thread with every usage entry, causing
 * exponential file growth. This script applies the same compression logic as the
 * new appendUsageEntry code: if entry[N].messages is a prefix of entry[N+1].messages,
 * replace entry[N].messages with [{ PREV_CACHE_HIT: true }].
 *
 * Usage:
 *   node scripts/migrate-usage-json.js            # dry run (shows space savings)
 *   node scripts/migrate-usage-json.js --migrate  # actually migrates files
 */

const fs = require("fs");
const path = require("path");

const AGENTS_DIR = path.join(
  __dirname,
  "../.knowhow/processes/agents"
);

const DRY_RUN = !process.argv.includes("--migrate");

if (DRY_RUN) {
  console.log("=== DRY RUN (pass --migrate to actually migrate) ===\n");
} else {
  console.log("=== MIGRATING FILES ===\n");
}

function compressEntries(entries) {
  let compressed = 0;
  for (let i = 0; i < entries.length - 1; i++) {
    const curr = entries[i];
    const next = entries[i + 1];
    const prevMessages = curr?.messages;
    const nextMessages = next?.messages;

    // Skip if already compressed
    if (
      Array.isArray(prevMessages) &&
      prevMessages.length === 1 &&
      prevMessages[0]?.PREV_CACHE_HIT
    ) {
      continue;
    }

    if (
      Array.isArray(prevMessages) &&
      Array.isArray(nextMessages) &&
      prevMessages.length > 0 &&
      nextMessages.length >= prevMessages.length &&
      JSON.stringify(nextMessages.slice(0, prevMessages.length)) ===
        JSON.stringify(prevMessages)
    ) {
      curr.messages = [{ PREV_CACHE_HIT: true }];
      compressed++;
    }
  }
  return compressed;
}

let totalOriginalBytes = 0;
let totalNewBytes = 0;
let totalFilesProcessed = 0;
let totalFilesChanged = 0;
let totalEntriesCompressed = 0;
let errors = 0;

const agentDirs = fs.readdirSync(AGENTS_DIR);

for (const dir of agentDirs) {
  const usagePath = path.join(AGENTS_DIR, dir, "usage.json");

  if (!fs.existsSync(usagePath)) continue;

  try {
    const originalContent = fs.readFileSync(usagePath, "utf8");
    const originalBytes = Buffer.byteLength(originalContent, "utf8");
    totalOriginalBytes += originalBytes;
    totalFilesProcessed++;

    let entries;
    try {
      entries = JSON.parse(originalContent);
    } catch (e) {
      console.warn(`  [SKIP] ${dir}/usage.json - invalid JSON: ${e.message}`);
      errors++;
      continue;
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      totalNewBytes += originalBytes;
      continue;
    }

    const compressed = compressEntries(entries);
    totalEntriesCompressed += compressed;

    const newContent = JSON.stringify(entries, null, 2);
    const newBytes = Buffer.byteLength(newContent, "utf8");
    totalNewBytes += newBytes;

    const savedBytes = originalBytes - newBytes;
    const savedPct = ((savedBytes / originalBytes) * 100).toFixed(1);

    if (compressed > 0) {
      totalFilesChanged++;
      console.log(
        `  ${dir}/usage.json: ${compressed} entries compressed, ` +
          `${(originalBytes / 1024).toFixed(1)}KB -> ${(newBytes / 1024).toFixed(1)}KB ` +
          `(-${(savedBytes / 1024).toFixed(1)}KB, ${savedPct}%)`
      );

      if (!DRY_RUN) {
        fs.writeFileSync(usagePath, newContent, "utf8");
      }
    }
  } catch (e) {
    console.error(`  [ERROR] ${dir}: ${e.message}`);
    errors++;
  }
}

const totalSaved = totalOriginalBytes - totalNewBytes;
const totalSavedPct = ((totalSaved / totalOriginalBytes) * 100).toFixed(1);

console.log("\n=== SUMMARY ===");
console.log(`Files found with usage.json:  ${totalFilesProcessed}`);
console.log(`Files with compressible data: ${totalFilesChanged}`);
console.log(`Total entries compressed:     ${totalEntriesCompressed}`);
console.log(
  `Total size before: ${(totalOriginalBytes / 1024 / 1024).toFixed(2)} MB`
);
console.log(
  `Total size after:  ${(totalNewBytes / 1024 / 1024).toFixed(2)} MB`
);
console.log(
  `Space saved:       ${(totalSaved / 1024 / 1024).toFixed(2)} MB (${totalSavedPct}%)`
);
if (errors > 0) console.log(`Errors: ${errors}`);

if (DRY_RUN && totalFilesChanged > 0) {
  console.log(
    "\nRun with --migrate to apply changes (backups written as .bak files)."
  );
}
