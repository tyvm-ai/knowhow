#!/usr/bin/env npx ts-node
/**
 * cache-miss-debug.ts
 *
 * Debug helper for analyzing usage.json files written by AgentSyncFs
 * (`.knowhow/processes/agents/<taskId>/usage.json`).
 *
 * Each entry in usage.json corresponds to one AI completion call and looks
 * like:
 *   {
 *     timestamp, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *     totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens,
 *     messages: [...]  // exact message chain sent to the model for that call
 *   }
 *
 * This script helps answer: "did a particular call miss the prompt cache?"
 * and "what changed in the message chain between call N and call N+1 that
 * broke the cache prefix?"
 *
 * Usage:
 *   npx ts-node scripts/cache-miss-debug.ts <path-to-usage.json> [options]
 *
 * Options:
 *   --summary              Print a per-call table of token/cache stats + hit/miss verdict (default if no other option given)
 *   --diff <a> <b>         Print a diff of the `messages` array between call index a and call index b (0-based)
 *   --dump <n>             Dump the full `messages` array for call index n as JSON
 *   --dump-message <n> <m> Dump a single message (index m) from call n's messages array
 *   --json                 Output the summary as JSON instead of a table
 *
 * Examples:
 *   npx ts-node scripts/cache-miss-debug.ts .knowhow/processes/agents/123-foo/usage.json
 *   npx ts-node scripts/cache-miss-debug.ts .knowhow/processes/agents/123-foo/usage.json --diff 1 2
 *   npx ts-node scripts/cache-miss-debug.ts .knowhow/processes/agents/123-foo/usage.json --dump 2
 */

import * as fs from "fs";
import * as path from "path";
import { diffJson } from "diff";

interface UsageEntry {
  timestamp?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  messages?: any[];
  [key: string]: any;
}

interface Verdict {
  index: number;
  timestamp: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cumulativeWritesBefore: number;
  status: "cold-start" | "hit" | "partial-hit" | "miss";
  note: string;
}

function loadUsage(filePath: string): UsageEntry[] {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected usage.json to contain a JSON array of call entries, got: ${typeof parsed}`
    );
  }
  return parsed as UsageEntry[];
}

/**
 * Compute a hit/miss verdict for each call by comparing cacheReadTokens
 * against the cumulative cacheWriteTokens available from all prior calls.
 *
 * - cold-start: first call, no cache could exist yet (cacheReadTokens ~ 0 expected)
 * - hit: cacheReadTokens roughly matches (or exceeds a large portion of) prior cumulative writes
 * - partial-hit: cacheReadTokens is nonzero but noticeably less than what was available
 * - miss: cacheReadTokens is 0 (or near 0) despite prior writes being available
 */
function computeVerdicts(entries: UsageEntry[]): Verdict[] {
  const verdicts: Verdict[] = [];
  let cumulativeWrites = 0;

  entries.forEach((entry, index) => {
    const cacheReadTokens = entry.cacheReadTokens ?? 0;
    const cacheWriteTokens = entry.cacheWriteTokens ?? 0;
    const cumulativeWritesBefore = cumulativeWrites;

    let status: Verdict["status"];
    let note = "";

    if (index === 0) {
      status = "cold-start";
      note = "First call — no prior cache expected.";
    } else if (cumulativeWritesBefore === 0) {
      status = cacheReadTokens > 0 ? "hit" : "cold-start";
      note = "No prior writes recorded to compare against.";
    } else if (cacheReadTokens === 0) {
      status = "miss";
      note = `Expected up to ${cumulativeWritesBefore} cached tokens available, got 0 reads — full cache miss.`;
    } else if (cacheReadTokens < cumulativeWritesBefore * 0.5) {
      status = "partial-hit";
      note = `Read ${cacheReadTokens} of up to ${cumulativeWritesBefore} available cached tokens — partial miss, prefix likely diverged partway through.`;
    } else {
      status = "hit";
      note = `Read ${cacheReadTokens} tokens, consistent with prior cumulative writes (${cumulativeWritesBefore}).`;
    }

    verdicts.push({
      index,
      timestamp: entry.timestamp || "unknown",
      inputTokens: entry.inputTokens ?? 0,
      cacheReadTokens,
      cacheWriteTokens,
      cumulativeWritesBefore,
      status,
      note,
    });

    cumulativeWrites += cacheWriteTokens;
  });

  return verdicts;
}


function fmtNum(n: number): string {
  return n.toLocaleString();
}

function statusEmoji(status: Verdict["status"]): string {
  switch (status) {
    case "cold-start":
      return "🧊";
    case "hit":
      return "✅";
    case "partial-hit":
      return "🟡";
    case "miss":
      return "🚨";
  }
}

function printSummaryTable(entries: UsageEntry[], verdicts: Verdict[]) {
  const header = [
    "#",
    "Time",
    "Input",
    "Output",
    "CacheRead",
    "CacheWrite",
    "Status",
  ];
  const rows = verdicts.map((v, i) => [
    String(v.index),
    v.timestamp,
    fmtNum(v.inputTokens),
    fmtNum(entries[i].outputTokens ?? 0),
    fmtNum(v.cacheReadTokens),
    fmtNum(v.cacheWriteTokens),
    `${statusEmoji(v.status)} ${v.status}`,
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );

  const printRow = (cols: string[]) =>
    console.log(
      "| " + cols.map((c, i) => c.padEnd(widths[i])).join(" | ") + " |"
    );

  printRow(header);
  printRow(widths.map((w) => "-".repeat(w)));
  rows.forEach(printRow);

  console.log("");
  const misses = verdicts.filter((v) => v.status === "miss");
  const partials = verdicts.filter((v) => v.status === "partial-hit");
  if (misses.length === 0 && partials.length === 0) {
    console.log("✅ No cache misses detected — caching looks healthy.");
  } else {
    console.log(
      `🚨 Found ${misses.length} full miss(es) and ${partials.length} partial-hit(s):`
    );
    [...misses, ...partials].forEach((v) => {
      console.log(`  - Call #${v.index} (${v.timestamp}): ${v.note}`);
    });
    console.log(
      "\nTip: use --diff <a> <b> to compare the message chains between two calls, e.g.:"
    );
    [...misses, ...partials].forEach((v) => {
      if (v.index > 0) {
        console.log(
          `  npx ts-node scripts/cache-miss-debug.ts <file> --diff ${
            v.index - 1
          } ${v.index}`
        );
      }
    });
  }
}

function printJsonSummary(verdicts: Verdict[]) {
  console.log(JSON.stringify(verdicts, null, 2));
}

/**
 * Diff the messages array of two calls. Uses a structural JSON diff so
 * additions/removals/reordering of individual messages (and fields within
 * them, like tool_call ids or content) are all visible.
 */
function printMessagesDiff(entries: UsageEntry[], aIdx: number, bIdx: number) {
  if (!entries[aIdx] || !entries[bIdx]) {
    throw new Error(
      `Invalid indices: file has ${entries.length} entries (valid range 0-${
        entries.length - 1
      })`
    );
  }

  const a = entries[aIdx].messages ?? [];
  const b = entries[bIdx].messages ?? [];

  console.log(
    `\nDiffing messages: call #${aIdx} (${entries[aIdx].timestamp}) -> call #${bIdx} (${entries[bIdx].timestamp})`
  );
  console.log(`  call #${aIdx}: ${a.length} messages`);
  console.log(`  call #${bIdx}: ${b.length} messages\n`);

  const diff = diffJson(a, b);
  diff.forEach((part) => {
    const color = part.added ? "\x1b[32m" : part.removed ? "\x1b[31m" : "";
    const reset = part.added || part.removed ? "\x1b[0m" : "";
    const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
    const lines = part.value.split("\n");
    lines.forEach((line, i) => {
      if (line === "" && i === lines.length - 1) return; // trailing empty line from split
      console.log(`${color}${prefix}${line}${reset}`);
    });
  });
}

function dumpMessages(entries: UsageEntry[], idx: number) {
  if (!entries[idx]) {
    throw new Error(
      `Invalid index ${idx}: file has ${entries.length} entries (valid range 0-${
        entries.length - 1
      })`
    );
  }
  console.log(JSON.stringify(entries[idx].messages ?? [], null, 2));
}

function dumpMessage(entries: UsageEntry[], callIdx: number, msgIdx: number) {
  if (!entries[callIdx]) {
    throw new Error(
      `Invalid call index ${callIdx}: file has ${entries.length} entries`
    );
  }
  const messages = entries[callIdx].messages ?? [];
  if (!messages[msgIdx]) {
    throw new Error(
      `Invalid message index ${msgIdx}: call #${callIdx} has ${messages.length} messages`
    );
  }
  console.log(JSON.stringify(messages[msgIdx], null, 2));
}


function printUsage() {
  console.log(`
cache-miss-debug.ts — inspect usage.json files for prompt-cache issues

Usage:
  npx ts-node scripts/cache-miss-debug.ts <path-to-usage.json> [options]

Options:
  --summary               Print a per-call table of token/cache stats + hit/miss verdict (default)
  --json                  Output the summary as JSON instead of a table
  --diff <a> <b>          Diff the messages array between call index a and call index b (0-based)
  --dump <n>              Dump the full messages array for call index n as JSON
  --dump-message <n> <m>  Dump a single message (index m) from call n's messages array

Examples:
  npx ts-node scripts/cache-miss-debug.ts .knowhow/processes/agents/123-foo/usage.json
  npx ts-node scripts/cache-miss-debug.ts .knowhow/processes/agents/123-foo/usage.json --diff 1 2
  npx ts-node scripts/cache-miss-debug.ts .knowhow/processes/agents/123-foo/usage.json --dump 2
  npx ts-node scripts/cache-miss-debug.ts .knowhow/processes/agents/123-foo/usage.json --dump-message 2 0
`);
}

function main() {
  const args = process.argv.slice(2);
  const filePath = args.find((a) => !a.startsWith("--"));

  if (!filePath || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(filePath ? 0 : 1);
  }

  const entries = loadUsage(filePath);

  if (entries.length === 0) {
    console.log("usage.json contains no entries.");
    return;
  }

  const diffFlagIdx = args.indexOf("--diff");
  const dumpFlagIdx = args.indexOf("--dump");
  const dumpMessageFlagIdx = args.indexOf("--dump-message");

  if (diffFlagIdx !== -1) {
    const a = parseInt(args[diffFlagIdx + 1], 10);
    const b = parseInt(args[diffFlagIdx + 2], 10);
    if (Number.isNaN(a) || Number.isNaN(b)) {
      console.error("--diff requires two numeric indices, e.g. --diff 1 2");
      process.exit(1);
    }
    printMessagesDiff(entries, a, b);
    return;
  }

  if (dumpMessageFlagIdx !== -1) {
    const callIdx = parseInt(args[dumpMessageFlagIdx + 1], 10);
    const msgIdx = parseInt(args[dumpMessageFlagIdx + 2], 10);
    if (Number.isNaN(callIdx) || Number.isNaN(msgIdx)) {
      console.error(
        "--dump-message requires two numeric indices, e.g. --dump-message 2 0"
      );
      process.exit(1);
    }
    dumpMessage(entries, callIdx, msgIdx);
    return;
  }

  if (dumpFlagIdx !== -1) {
    const idx = parseInt(args[dumpFlagIdx + 1], 10);
    if (Number.isNaN(idx)) {
      console.error("--dump requires a numeric index, e.g. --dump 2");
      process.exit(1);
    }
    dumpMessages(entries, idx);
    return;
  }

  // Default: summary
  const verdicts = computeVerdicts(entries);
  if (args.includes("--json")) {
    printJsonSummary(verdicts);
  } else {
    printSummaryTable(entries, verdicts);
  }
}

main();
