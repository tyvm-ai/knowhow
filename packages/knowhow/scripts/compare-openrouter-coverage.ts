#!/usr/bin/env npx ts-node
/**
 * compare-openrouter-coverage.ts
 *
 * Fetches the live OpenRouter model list and compares it against knowhow's
 * registered providers and models.
 *
 * Usage:
 *   npx ts-node scripts/compare-openrouter-coverage.ts
 *   npx ts-node scripts/compare-openrouter-coverage.ts --provider anthropic
 *   npx ts-node scripts/compare-openrouter-coverage.ts --output coverage.md
 *   npx ts-node scripts/compare-openrouter-coverage.ts --missing-providers
 *
 * Options:
 *   --provider <name>      Filter to a specific OpenRouter provider slug
 *   --output <file>        Write results to a markdown file
 *   --missing-providers    Only show providers we don't support at all
 *   --show-ours-only       Show models we have that OpenRouter doesn't
 *   --include-deprecated   Include deprecated/retired models in coverage comparison (default: excluded)
 */

import https from "https";
import fs from "fs";
import path from "path";

// ─── Our model registries ────────────────────────────────────────────────────
import { OpenAiTextPricing } from "../src/clients/pricing/openai";
import { AnthropicTextPricing } from "../src/clients/pricing/anthropic";
import { GeminiTextPricing } from "../src/clients/pricing/google";
import { XaiTextPricing } from "../src/clients/pricing/xai";
import { GroqTextPricing } from "../src/clients/pricing/groq";
import { DeepSeekTextPricing } from "../src/clients/pricing/deepseek";
import { MistralTextPricing } from "../src/clients/pricing/mistral";
import { NvidiaTextPricing } from "../src/clients/pricing/nvidia";
import { LlamaTextPricing } from "../src/clients/pricing/llama";
import { CerebrasTextPricing } from "../src/clients/pricing/cerebras";
import { ALL_MODEL_CATALOG } from "../src/clients/pricing/models";

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag: string) => {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
};
const hasFlag = (flag: string) => args.includes(flag);

const filterProvider = getArg("--provider");
const outputFile = getArg("--output");
const missingProvidersOnly = hasFlag("--missing-providers");
const showOursOnly = hasFlag("--show-ours-only");
const includeDeprecated = hasFlag("--include-deprecated");

// ─── Our providers: map OpenRouter provider slug → set of model IDs ──────────
// OpenRouter model IDs are in the format "provider/model-name"
// We map our internal provider names to their OpenRouter slug equivalents.
//
// Note: We intentionally EXCLUDE "openrouter" itself from this comparison
// since we're comparing *against* OpenRouter, not our openrouter passthrough.
//
// By default, deprecated/retired models are excluded from coverage comparison.
// Pass --include-deprecated to include them.

// Build a set of deprecated/limitedAvailability model IDs from the catalog
const excludedModelIds = new Set(
  ALL_MODEL_CATALOG
    .filter((e) => e.deprecated === true || e.limitedAvailability === true || e.type === "live")
    .map((e) => e.id.toLowerCase())
);

// All models (including deprecated) — used for coverage matching so deprecated
// models we DO have are not counted as gaps
function allModels(pricing: Record<string, any>): Set<string> {
  return new Set(Object.keys(pricing));
}

// Active (non-deprecated) models — used for "we have X models" count
function activeModels(pricing: Record<string, any>): Set<string> {
  return new Set(
    Object.keys(pricing).filter(
      (id) => includeDeprecated || !excludedModelIds.has(id.toLowerCase())
    )
  );
}

const OUR_PROVIDERS: Record<string, Set<string>> = {
  openai:    activeModels(OpenAiTextPricing),
  anthropic: activeModels(AnthropicTextPricing),
  google:    activeModels(GeminiTextPricing),
  "x-ai":    activeModels(XaiTextPricing),   // OpenRouter uses "x-ai" for xai
  groq:      activeModels(GroqTextPricing),
  deepseek:  activeModels(DeepSeekTextPricing),
  mistralai: activeModels(MistralTextPricing), // OpenRouter uses "mistralai"
  nvidia:    activeModels(NvidiaTextPricing),
  meta:      new Set<string>(), // populated below from nvidia & llama
  llama:     activeModels(LlamaTextPricing),
  cerebras:  activeModels(CerebrasTextPricing),
};

// All models including deprecated — for coverage matching only
const ALL_OUR_PROVIDERS: Record<string, Set<string>> = {
  openai:    allModels(OpenAiTextPricing),
  anthropic: allModels(AnthropicTextPricing),
  google:    allModels(GeminiTextPricing),
  "x-ai":    allModels(XaiTextPricing),
  groq:      allModels(GroqTextPricing),
  deepseek:  allModels(DeepSeekTextPricing),
  mistralai: allModels(MistralTextPricing),
  nvidia:    allModels(NvidiaTextPricing),
  meta:      new Set<string>(),
  llama:     allModels(LlamaTextPricing),
  cerebras:  allModels(CerebrasTextPricing),
};

// Normalize our model IDs to bare model names (strip "provider/" prefix if present)
// so we can compare against OpenRouter's model names within a provider
function stripProvider(modelId: string): string {
  const parts = modelId.split("/");
  if (parts.length > 1) return parts.slice(1).join("/");
  return modelId;
}

// Normalize a model ID for fuzzy matching:
//   - lowercase
//   - replace dots with dashes (e.g. "claude-opus-4.7" → "claude-opus-4-7")
//   - strip variant suffixes like ":thinking", ":free", ":extended"
//   - strip known trailing date suffixes like "-20250514", "-20251001", etc.
//   - strip trailing "-beta", "-preview", "-latest", "-exp"
const DATE_SUFFIX_RE = /-\d{8}$/;
const KNOWN_VERSION_SUFFIXES = /-(beta|preview|latest|exp|rc\d*)$/i;

function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/\./g, "-")           // dots to dashes
    .replace(/:[^:]+$/, "")        // strip :thinking, :free, :extended, etc.
    .replace(DATE_SUFFIX_RE, "")   // strip -20250514 style date suffix
    .replace(KNOWN_VERSION_SUFFIXES, ""); // strip -beta, -preview, etc.
}

// Check if an OR model ID matches one of our model IDs.
// Returns true if:
//   1. Exact normalized match, OR
//   2. Our model starts with OR model (we have a dated variant, OR has generic alias)
//      e.g. OR "claude-opus-4-5" matches our "claude-opus-4-5-20251101"
//   3. OR model starts with our model (OR has more specific, we have base name)
function modelMatches(orBareId: string, ourBareModels: Set<string>): boolean {
  const orNorm = normalizeModelId(orBareId);
  for (const ourId of ourBareModels) {
    const ourNorm = normalizeModelId(ourId);
    if (orNorm === ourNorm) return true;
    // Our model is a dated variant of the OR model (e.g. claude-opus-4-5 vs claude-opus-4-5-20251101)
    if (ourNorm.startsWith(orNorm + "-") && /^\d+$/.test(ourNorm.slice(orNorm.length + 1))) return true;
    // OR model is more specific than ours (e.g. or has grok-4-0709, we have grok-4)
    if (orNorm.startsWith(ourNorm + "-") && /^\d+$/.test(orNorm.slice(ourNorm.length + 1))) return true;
    // OR model has a non-numeric variant suffix (e.g. claude-opus-4-6-fast vs claude-opus-4-6)
    if (orNorm.startsWith(ourNorm + "-") && /^[a-z]+$/.test(orNorm.slice(ourNorm.length + 1))) return true;
  }
  return false;
}

// ─── Fetch OpenRouter models ──────────────────────────────────────────────────
interface OpenRouterModel {
  id: string;           // e.g. "anthropic/claude-3.5-sonnet"
  name: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;    // USD per token (as string)
    completion?: string;
  };
  architecture?: {
    modality?: string;
  };
}

function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "openrouter.ai",
      path: "/api/v1/models",
      method: "GET",
      headers: {
        "HTTP-Referer": "https://github.com/knowhow",
        "X-Title": "knowhow-coverage-check",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.data || []);
        } catch (e) {
          reject(new Error(`Failed to parse OpenRouter response: ${e}`));
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

// ─── Pricing helpers ──────────────────────────────────────────────────────────

/** Convert OpenRouter per-token price string to per-1M-token USD */
function orPricePerMillion(pricePerToken: string | undefined): number | null {
  if (!pricePerToken) return null;
  const v = parseFloat(pricePerToken);
  if (isNaN(v)) return null;
  return v * 1_000_000;
}

function formatPrice(v: number | null): string {
  if (v === null) return "n/a";
  if (v === 0) return "$0 (free)";
  return `$${v.toFixed(4)}/1M`;
}

// ─── Analysis ─────────────────────────────────────────────────────────────────
interface MissingModel {
  id: string;          // bare model name (without provider/ prefix)
  fullId: string;      // full OR id e.g. "anthropic/claude-..."
  orInputPer1M: number | null;
  orOutputPer1M: number | null;
}

interface ProviderComparison {
  orProvider: string;
  weHaveProvider: boolean;
  ourProviderKey: string | null;
  orModels: string[];
  modelsWeHave: string[];       // OR models we also have
  modelsWeMiss: MissingModel[]; // OR models we don't have (with pricing)
  modelsOnlyWe: string[];       // our models not on OR
  orModelCount: number;
  coveragePct: number;
}

function normalizeProviderName(orProvider: string): string | null {
  // Map OpenRouter provider slugs to our internal provider keys
  const MAP: Record<string, string> = {
    "openai":     "openai",
    "anthropic":  "anthropic",
    "google":     "google",
    "x-ai":       "x-ai",
    "groq":       "groq",
    "deepseek":   "deepseek",
    "mistralai":  "mistralai",
    "nvidia":     "nvidia",
    "meta-llama": "meta",
    "llama":      "llama",
    "cerebras":   "cerebras",
  };
  return MAP[orProvider] ?? null;
}

function computeProviderComparison(
  orProvider: string,
  orModels: OpenRouterModel[],
): ProviderComparison {
  const ourKey = normalizeProviderName(orProvider);
  const ourModels = ourKey ? OUR_PROVIDERS[ourKey] : null;
  const weHaveProvider = ourKey !== null && ourModels !== undefined;

  // All models (including deprecated) for matching — so deprecated models aren't shown as gaps
  const allOurModels = ourKey ? ALL_OUR_PROVIDERS[ourKey] : null;

  // OR model IDs within this provider (bare, without provider/ prefix)
  const orModelEntries = orModels.map((m) => {
    const parts = m.id.split("/");
    const bareId = parts.slice(1).join("/");
    return {
      bareId,
      fullId: m.id,
      orInputPer1M: orPricePerMillion(m.pricing?.prompt),
      orOutputPer1M: orPricePerMillion(m.pricing?.completion),
    };
  });

  const orModelIds = orModelEntries.map((e) => e.bareId);

  if (!weHaveProvider || !ourModels) {
    return {
      orProvider,
      weHaveProvider: false,
      ourProviderKey: null,
      orModels: orModelIds,
      modelsWeHave: [],
      modelsWeMiss: orModelEntries.map((e) => ({
        id: e.bareId,
        fullId: e.fullId,
        orInputPer1M: e.orInputPer1M,
        orOutputPer1M: e.orOutputPer1M,
      })),
      modelsOnlyWe: [],
      orModelCount: orModelIds.length,
      coveragePct: 0,
    };
  }

  // Normalize our model IDs for comparison
  // Use ALL models (including deprecated) for matching to avoid showing deprecated as gaps
  const allOurBareModels = new Set([...(allOurModels ?? ourModels)].map(stripProvider));

  const modelsWeHave: string[] = [];
  const modelsWeMiss: MissingModel[] = [];
  for (const entry of orModelEntries) {
    if (modelMatches(entry.bareId, allOurBareModels)) {
      modelsWeHave.push(entry.bareId);
    } else {
      modelsWeMiss.push({
        id: entry.bareId,
        fullId: entry.fullId,
        orInputPer1M: entry.orInputPer1M,
        orOutputPer1M: entry.orOutputPer1M,
      });
    }
  }

  // Models we have but OR doesn't list
  const modelsOnlyWe: string[] = [...ourModels]
    .map(stripProvider)
    .filter((ourId) => !orModelEntries.some((entry) => modelMatches(entry.bareId, new Set([ourId]))));

  const coveragePct =
    orModelIds.length > 0
      ? Math.round((modelsWeHave.length / orModelIds.length) * 100)
      : 100;

  return {
    orProvider,
    weHaveProvider: true,
    ourProviderKey: ourKey,
    orModels: orModelIds,
    modelsWeHave,
    modelsWeMiss,
    modelsOnlyWe,
    orModelCount: orModelIds.length,
    coveragePct,
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────
function pct(n: number) {
  return `${n}%`;
}

function formatMarkdown(comparisons: ProviderComparison[]): string {
  const lines: string[] = [];

  lines.push("# OpenRouter vs Knowhow Model Coverage");
  lines.push("");
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push("");

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push("| Provider | We Support? | OR Models | We Have | We Miss | Coverage |");
  lines.push("|----------|-------------|-----------|---------|---------|----------|");

  for (const c of comparisons) {
    const support = c.weHaveProvider ? "✅" : "❌";
    lines.push(
      `| ${c.orProvider} | ${support} | ${c.orModelCount} | ${c.modelsWeHave.length} | ${c.modelsWeMiss.length} | ${pct(c.coveragePct)} |`
    );
  }
  lines.push("");

  // Providers we don't support at all
  const missing = comparisons.filter((c) => !c.weHaveProvider);
  if (missing.length > 0) {
    lines.push("## ❌ Providers We Don't Support");
    lines.push("");
    for (const c of missing) {
      lines.push(`### ${c.orProvider} (${c.orModelCount} models on OpenRouter)`);
      lines.push("");
      lines.push("| Model | Input/1M | Output/1M |");
      lines.push("|-------|----------|-----------|");
      for (const m of c.modelsWeMiss) {
        lines.push(`| \`${m.fullId}\` | ${formatPrice(m.orInputPer1M)} | ${formatPrice(m.orOutputPer1M)} |`);
      }
      lines.push("");
    }
  }

  // Providers we support — model-level gaps
  const supported = comparisons.filter((c) => c.weHaveProvider);
  if (supported.length > 0) {
    lines.push("## ✅ Providers We Support — Model Gaps");
    lines.push("");
    for (const c of supported) {
      lines.push(
        `### ${c.orProvider} (${pct(c.coveragePct)} coverage — ${c.modelsWeHave.length}/${c.orModelCount} OR models)`
      );
      lines.push("");

      if (c.modelsWeMiss.length > 0) {
        lines.push("**Missing from us (OpenRouter has these):**");
        lines.push("");
        lines.push("| Model | Input/1M | Output/1M |");
        lines.push("|-------|----------|-----------|");
        for (const m of c.modelsWeMiss) {
          lines.push(`| \`${m.fullId}\` | ${formatPrice(m.orInputPer1M)} | ${formatPrice(m.orOutputPer1M)} |`);
        }
        lines.push("");
      }

      if (showOursOnly && c.modelsOnlyWe.length > 0) {
        lines.push("**We have (OpenRouter doesn't list these):**");
        lines.push("");
        for (const m of c.modelsOnlyWe) {
          lines.push(`- ${m}`);
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

function printConsole(comparisons: ProviderComparison[]) {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║     OpenRouter vs Knowhow Model Coverage Report      ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // Summary
  console.log("┌─ SUMMARY ──────────────────────────────────────────────────────────┐");
  console.log(
    sprintf("│ %-25s %-12s %8s %8s %8s %8s │",
      "Provider", "We Support?", "OR Models", "We Have", "We Miss", "Coverage")
  );
  console.log("├" + "─".repeat(70) + "┤");
  for (const c of comparisons) {
    const support = c.weHaveProvider ? "✅ yes" : "❌ no";
    console.log(
      sprintf("│ %-25s %-12s %8d %8d %8d %7s │",
        c.orProvider, support, c.orModelCount, c.modelsWeHave.length, c.modelsWeMiss.length, pct(c.coveragePct))
    );
  }
  console.log("└" + "─".repeat(70) + "┘\n");

  // Providers we don't support
  const missing = comparisons.filter((c) => !c.weHaveProvider);
  if (missing.length > 0) {
    console.log("❌ PROVIDERS WE DON'T SUPPORT:");
    for (const c of missing) {
      console.log(`\n  ${c.orProvider} — ${c.orModelCount} models on OpenRouter:`);
      for (const m of c.modelsWeMiss.slice(0, 10)) {
        const inputStr = formatPrice(m.orInputPer1M).padEnd(14);
        const outputStr = formatPrice(m.orOutputPer1M);
        console.log(`    • ${c.orProvider}/${m.id}  [in: ${inputStr} out: ${outputStr}]`);
      }
      if (c.modelsWeMiss.length > 10) {
        console.log(`    … and ${c.modelsWeMiss.length - 10} more`);
      }
    }
    console.log();
  }

  // Model gaps per supported provider
  const supported = comparisons.filter((c) => c.weHaveProvider && c.modelsWeMiss.length > 0);
  if (supported.length > 0 && !missingProvidersOnly) {
    console.log("📋 MODEL GAPS (models on OpenRouter we don't have):");
    for (const c of supported) {
      console.log(`\n  ${c.orProvider} — ${pct(c.coveragePct)} coverage (missing ${c.modelsWeMiss.length} models):`);
      for (const m of c.modelsWeMiss.slice(0, 15)) {
        const inputStr = formatPrice(m.orInputPer1M).padEnd(14);
        const outputStr = formatPrice(m.orOutputPer1M);
        console.log(`    • ${c.orProvider}/${m.id}  [in: ${inputStr} out: ${outputStr}]`);
      }
      if (c.modelsWeMiss.length > 15) {
        console.log(`    … and ${c.modelsWeMiss.length - 15} more`);
      }
    }
    console.log();
  }

  // Models we have but OR doesn't
  if (showOursOnly) {
    const weOnly = comparisons.filter((c) => c.weHaveProvider && c.modelsOnlyWe.length > 0);
    if (weOnly.length > 0) {
      console.log("🔵 MODELS WE HAVE (NOT on OpenRouter):");
      for (const c of weOnly) {
        console.log(`\n  ${c.orProvider} — ${c.modelsOnlyWe.length} exclusive models:`);
        for (const m of c.modelsOnlyWe) {
          console.log(`    • ${m}`);
        }
      }
      console.log();
    }
  }
}

// Minimal sprintf-like helper for fixed-width columns
function sprintf(fmt: string, ...args: (string | number)[]): string {
  let i = 0;
  return fmt.replace(/%-?(\d+)[sd]/g, (match, width) => {
    const val = String(args[i++] ?? "");
    const w = parseInt(width);
    const leftAlign = match[1] === "-";
    if (leftAlign) return val.padEnd(w);
    return val.padStart(w);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("⏳ Fetching OpenRouter model list...");
  let allModels: OpenRouterModel[];
  try {
    allModels = await fetchOpenRouterModels();
  } catch (e) {
    console.error("❌ Failed to fetch OpenRouter models:", e);
    process.exit(1);
  }
  console.log(`✅ Fetched ${allModels.length} models from OpenRouter\n`);

  // Group by provider (first segment of model ID)
  const byProvider = new Map<string, OpenRouterModel[]>();
  for (const model of allModels) {
    const parts = model.id.split("/");
    const provider = parts[0];
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider)!.push(model);
  }

  // Apply provider filter if specified
  let providers = [...byProvider.keys()].sort();
  if (filterProvider) {
    providers = providers.filter((p) =>
      p.toLowerCase().includes(filterProvider.toLowerCase())
    );
    if (providers.length === 0) {
      console.error(`❌ No OpenRouter providers matching "${filterProvider}"`);
      process.exit(1);
    }
  }

  // Compute comparisons
  const comparisons: ProviderComparison[] = providers.map((p) =>
    computeProviderComparison(p, byProvider.get(p)!)
  );

  // Sort: providers we support first (by coverage asc), then unsupported
  comparisons.sort((a, b) => {
    if (a.weHaveProvider !== b.weHaveProvider)
      return a.weHaveProvider ? -1 : 1;
    return a.coveragePct - b.coveragePct;
  });

  // Filter if --missing-providers
  const toShow = missingProvidersOnly
    ? comparisons.filter((c) => !c.weHaveProvider)
    : comparisons;

  // Print to console
  printConsole(toShow);

  // Write markdown if requested
  if (outputFile) {
    const md = formatMarkdown(toShow);
    const outPath = path.resolve(process.cwd(), outputFile);
    fs.writeFileSync(outPath, md, "utf-8");
    console.log(`📄 Written to ${outPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
