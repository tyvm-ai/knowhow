/**
 * Offline replay: what a recorded agent run would have cost under different
 * prompt-cache TTL / compaction policies. No API calls.
 *
 * Input is an agent's usage.json (one row per request: timestamp, fresh /
 * cache-read / cache-write / output tokens). Each request's context growth is
 * taken from the recording; each policy decides TTLs and compactions and is
 * priced with the catalog rates (5m writes 1.25×, 1h writes 2×, reads, output).
 *
 * Policies:
 *   old       5m for the first 5 minutes, then 1h in place; compaction at 70%
 *             of the context window (what the pob-buddy run actually did)
 *   price     same TTL switch in place, plus the price-aware threshold
 *   new       thread TTL fixed; at 5 minutes compact on the warm 5m cache and
 *             start the new thread on 1h (or switch in place when small);
 *             price-aware threshold afterwards (the current agent)
 *   5m-only   for comparison: never use 1h
 * Except "old", policies also compact on the warm cache when the next request
 * comes after the pre-expiry check would fire (3m / 51m) and that pays off.
 *
 * Compactions are modelled as: each compaction call reads the context from
 * cache (2 calls), ~6k output tokens of summary, and the new thread restarts
 * from C0 = first request + summary. Model behaviour after compaction (extra
 * requests to re-read files) is not modelled.
 *
 * Run: npx tsx tests/manual/compression/ttlPolicyReplay.ts <usage.json> [model]
 */
import * as fs from "fs";
import {
  COMPACTION_OUTPUT_TOKENS,
  SUMMARY_TOKENS,
  chooseLongTtlSwitch,
  getContextPrices,
  optimalCompactionThreshold,
  shouldCompactBeforeCacheExpiry,
  cacheExpiryCheckDelayMs,
} from "../../../src/agents/base/compactionPolicy";
import { ContextLimits } from "../../../src/clients/contextLimits";

const [file, model = "claude-fable-5-2"] = process.argv.slice(2);
if (!file) {
  console.error("usage: ttlPolicyReplay.ts <usage.json> [model]");
  process.exit(1);
}
const rows: any[] = JSON.parse(fs.readFileSync(file, "utf8"));
const prices = getContextPrices(model, "anthropic")!;
const contextLimit = (ContextLimits as any)[model] ?? 1_000_000;
const SHORT = 5 * 60_000;
const LONG = 60 * 60_000;
const t0 = Date.parse(rows[0].timestamp);
const prompt = (r: any) => r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
const base = prompt(rows[0]) + SUMMARY_TOKENS;

type Policy = "old" | "price" | "new" | "5m-only";

function total(c: { read: number; write: number; output: number; compaction: number }) {
  return c.read + c.write + c.output + c.compaction;
}

function replayThreads(policy: Policy, data: any[]) {
  let ctx = 0;
  let threadLong = false;
  let threadStart = 0;
  let threadRequests = 0;
  let lastAt = -Infinity;
  let lastLong = false;
  let compactions = 0;
  let pending = false;
  const cost = { read: 0, write: 0, output: 0, compaction: 0 };
  const log: string[] = [];

  data.forEach((row, i) => {
    const at = Date.parse(row.timestamp) - t0;
    let growth = i === 0 ? prompt(row) : Math.max(0, prompt(row) - prompt(data[i - 1]));
    let warmPrefix = ctx;
    if (pending) {
      pending = false;
      warmPrefix = 0; // new thread: nothing of it is cached yet
      growth += base; // write the compacted prefix (system + tools + summary)
      ctx = 0;
      threadRequests = 0;
    }
    const long =
      policy === "5m-only"
        ? false
        : policy === "new"
        ? threadRequests === 0
          ? at > SHORT
          : threadLong
        : at > SHORT;
    if (threadRequests === 0) threadLong = long;
    const ttlMs = lastLong ? LONG : SHORT;
    const warm = warmPrefix > 0 && long === lastLong && at - lastAt <= ttlMs;
    const writeRate = long ? prices.writeLong : prices.write;
    const next = warmPrefix + growth;
    if (warm) {
      cost.read += prices.read * warmPrefix;
      cost.write += writeRate * growth;
    } else {
      if (warmPrefix > 0) {
        log.push(`#${i} ${(at / 1000).toFixed(0)}s full re-write of ${next} tokens at ${long ? "1h" : "5m"} (${long === lastLong ? "cache expired" : "TTL changed"})`);
      }
      cost.write += writeRate * next;
    }
    cost.output += prices.output * row.outputTokens;
    ctx = next;
    lastAt = at;
    lastLong = long;
    threadRequests++;
    if (threadRequests === 1) threadStart = next;

    const compact = (reason: string) => {
      cost.compaction += 2 * prices.read * ctx + prices.output * COMPACTION_OUTPUT_TOKENS;
      compactions++;
      pending = true;
      log.push(`#${i} ${(at / 1000).toFixed(0)}s compact ${ctx} tokens on the warm ${long ? "1h" : "5m"} cache (${reason})`);
    };
    if (i + 1 >= data.length) return;
    const c0 = threadStart + (compactions === 0 ? SUMMARY_TOKENS : 0);
    const growthPerRequest =
      threadRequests >= 3 ? (ctx - threadStart) / (threadRequests - 1) : 5_000;
    const threshold =
      policy === "old"
        ? contextLimit * 0.7
        : Math.min(
            contextLimit * 0.7,
            optimalCompactionThreshold({ prices, baseTokens: c0, growthPerRequest, longTtl: long })
          );
    if (ctx > threshold) return compact(`over ${Math.round(threshold / 1000)}k threshold`);
    if (policy !== "old") {
      // Pre-expiry check: fires 3m (5m TTL) / 51m (1h TTL) after a request.
      const ttl = long ? LONG : SHORT;
      const gap = Date.parse(data[i + 1].timestamp) - Date.parse(row.timestamp);
      if (
        gap > cacheExpiryCheckDelayMs(ttl) &&
        shouldCompactBeforeCacheExpiry({ prices, contextTokens: ctx, baseTokens: c0, compactionCalls: 2, longTtl: long })
      ) {
        return compact(`next request in ${Math.round(gap / 1000)}s, cache expires first`);
      }
    }
    if (policy === "new" && !threadLong && at > SHORT) {
      const decision = chooseLongTtlSwitch({ prices, contextTokens: ctx, baseTokens: c0, compactionCalls: 2 });
      if (decision === "compact") return compact("5m → 1h switch");
      threadLong = true;
      log.push(`#${i} ${(at / 1000).toFixed(0)}s switch ${ctx} tokens to 1h in place`);
    }
  });
  return { cost, compactions, log };
}


console.log(
  `${rows.length} requests, ${model}, run ${((Date.parse(rows[rows.length - 1].timestamp) - t0) / 60_000).toFixed(1)} min, final context ${prompt(rows[rows.length - 1])}`
);
for (const policy of ["old", "price", "new", "5m-only"] as Policy[]) {
  const { cost: c, compactions, log } = replayThreads(policy, rows);
  console.log(
    `\n${policy.padEnd(6)} total $${total(c).toFixed(2)}  (reads $${c.read.toFixed(2)}, writes $${c.write.toFixed(2)}, output $${c.output.toFixed(2)}, compaction calls $${c.compaction.toFixed(2)}; ${compactions} compactions)`
  );
  for (const line of log) console.log(`       ${line}`);
}
