#!/usr/bin/env npx ts-node
/**
 * check-model-pricing.ts
 *
 * Compares models.dev live data against knowhow's registered providers & pricing.
 *
 * Usage:
 *   npx ts-node scripts/check-model-pricing.ts
 *   npx ts-node scripts/check-model-pricing.ts --provider groq
 *   npx ts-node scripts/check-model-pricing.ts --provider openai --show-all
 *
 * Options:
 *   --provider <name>   Only check a specific provider
 *   --show-all          Show all models, not just mismatches
 *   --free-only         Only show models with $0 cost on models.dev
 *   --output <file>     Write results to a markdown file (e.g. analysis.md)
 *   --include-deprecated  Include deprecated/retired models in gap analysis (default: excluded)
 */

import https from "https";
import { ALL_MODEL_CATALOG } from "../src/clients/pricing/models";
import { ModelCatalogEntry } from "../src/clients/pricing/types";
import { GroqTextPricing } from "../src/clients/pricing/groq";
import { DeepSeekTextPricing } from "../src/clients/pricing/deepseek";
import { MistralTextPricing } from "../src/clients/pricing/mistral";
import { NvidiaTextPricing, NvidiaImagePricing } from "../src/clients/pricing/nvidia";
import { GitHubModelsTextPricing } from "../src/clients/pricing/github";
import { OpenRouterTextPricing } from "../src/clients/pricing/openrouter";
import { LlamaTextPricing } from "../src/clients/pricing/llama";
import { CopilotTextPricing } from "../src/clients/pricing/copilot";
import { CerebrasTextPricing } from "../src/clients/pricing/cerebras";

// Build per-provider pricing maps for providers not yet in ALL_MODEL_CATALOG
const EXTRA_PROVIDER_PRICING: Record<string, Record<string, { input: number; output: number }>> = {
  groq: GroqTextPricing,
  deepseek: DeepSeekTextPricing,
  mistral: MistralTextPricing,
  nvidia: { ...NvidiaTextPricing, ...NvidiaImagePricing },
  github: GitHubModelsTextPricing,
  openrouter: OpenRouterTextPricing,
  llama: LlamaTextPricing,
  "github-copilot": CopilotTextPricing,
  cerebras: CerebrasTextPricing,
};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (flag: string) => {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
};
const hasFlag = (flag: string) => args.includes(flag);

const filterProvider = getArg("--provider");
const showAll = hasFlag("--show-all");
const freeOnly = hasFlag("--free-only");
const outputFile = getArg("--output");
const includeDeprecated = hasFlag("--include-deprecated");

// ---------------------------------------------------------------------------
// models.dev API types
// The API endpoint is https://models.dev/api.json
// It returns an object keyed by provider ID, each value has a `models` sub-object
// ---------------------------------------------------------------------------
interface ModelDevModel {
  id: string;
  name?: string;
  cost?: {
    input?: number | null;
    output?: number | null;
    input_cached?: number | null;
  };
  limit?: {
    context?: number;
    output?: number;
  };
}

interface ModelDevProvider {
  id: string;
  name?: string;
  models: Record<string, ModelDevModel>;
}

interface ModelDevApiResponse {
  [providerId: string]: ModelDevProvider;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------
function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "knowhow-pricing-check/1.0" } }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch (e) {
            reject(new Error(`Failed to parse response from ${url}: ${e}`));
          }
        });
      })
      .on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// models.dev provider ID → knowhow provider name mapping
// ---------------------------------------------------------------------------
const PROVIDER_MAP: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  "x-ai": "xai",
  xai: "xai",
  groq: "groq",
  mistral: "mistral",
  deepseek: "deepseek",
  nvidia: "nvidia",
  "github-models": "github",
  github: "github",
  openrouter: "openrouter",
  "github-copilot": "github-copilot",
  "meta-llama": "llama",
  llama: "llama",
  cerebras: "cerebras",
};

// Providers we have knowhow clients for
const SUPPORTED_PROVIDERS = new Set(Object.values(PROVIDER_MAP));

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------
interface ModelComparison {
  modelId: string;
  provider: string; // knowhow provider name
  devProvider: string; // models.dev provider id
  devInputPrice: number | null;
  devOutputPrice: number | null;
  khInputPrice: number | null;
  khOutputPrice: number | null;
  status:
    | "ok"
    | "price-mismatch"
    | "missing-in-knowhow"
    | "missing-pricing"
    | "extra-in-knowhow";
  details?: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("🔍 Fetching model data from models.dev...\n");

  // Flat list of all dev models with provider attached
  interface FlatDevModel extends ModelDevModel {
    provider: string;
  }

  let allDevModels: FlatDevModel[] = [];

  try {
    const response = await fetchJson<ModelDevApiResponse>("https://models.dev/api.json");
    for (const [providerId, providerData] of Object.entries(response)) {
      if (!providerData || typeof providerData.models !== "object") continue;
      for (const [modelId, model] of Object.entries(providerData.models)) {
        allDevModels.push({
          ...model,
          id: model.id || modelId,
          provider: providerId,
        });
      }
    }
  } catch (e: any) {
    console.error(`❌ Failed to fetch from models.dev: ${e.message}`);
    process.exit(1);
  }

  console.log(`✅ Fetched ${allDevModels.length} models from models.dev\n`);

  // Build static knowhow model catalog from ALL_MODEL_CATALOG + extra provider pricing maps
  // This does NOT require API keys — it uses the static pricing files directly.
  const khCatalogEntries: ModelCatalogEntry[] = [...ALL_MODEL_CATALOG];

  // Add entries for providers that have pricing maps but aren't yet in ALL_MODEL_CATALOG
  for (const [provider, pricingMap] of Object.entries(EXTRA_PROVIDER_PRICING)) {
    for (const [modelId, pricing] of Object.entries(pricingMap)) {
      khCatalogEntries.push({
        id: modelId,
        provider,
        type: "completion",
        pricing: { input: pricing.input, output: pricing.output },
      });
    }
  }

  // Build lookup maps
  const khPriceMap = new Map<string, ModelCatalogEntry>();
  const khModelsByProvider = new Map<string, Set<string>>();
  for (const entry of khCatalogEntries) {
    khPriceMap.set(`${entry.provider}:${entry.id}`, entry);
    if (!khModelsByProvider.has(entry.provider)) {
      khModelsByProvider.set(entry.provider, new Set());
    }
    khModelsByProvider.get(entry.provider)!.add(entry.id);
  }

  // ---------------------------------------------------------------------------
  // Fuzzy model matching helpers
  // models.dev often uses generic aliases (e.g. "grok-4", "grok-3")
  // while knowhow uses versioned IDs (e.g. "grok-4-0709", "grok-3-beta").
  // Also, anthropic uses base IDs in knowhow (e.g. "claude-opus-4") while
  // models.dev uses dated versions (e.g. "claude-opus-4-20250514").
  //
  // To avoid false matches like kh "gpt-5" matching dev "gpt-5-pro",
  // we only consider a suffix to be a "version suffix" if it looks like:
  //   - A date: all digits, e.g. "20250514", "1212", "0709"
  //   - A known version word: "beta", "latest", "preview"
  //   - A short alphanumeric version tag that starts with a digit, e.g. "001"
  // NOT accepted as version suffix: "pro", "mini", "nano", "fast", "turbo", etc.
  // ---------------------------------------------------------------------------
  const VERSION_SUFFIX_RE = /^(\d+|beta|latest|preview|exp|rc\d*|v\d+)$/i;

  function isVersionSuffix(part: string): boolean {
    return VERSION_SUFFIX_RE.test(part);
  }

  // We match if:
  //   1. Exact match, OR
  //   2. Any knowhow model ID starts with the dev model ID + "-" or "/"
  //      (e.g. dev "grok-4" matches kh "grok-4-0709")
  // ---------------------------------------------------------------------------
  function findKhEntry(khProvider: string, devModelId: string): ModelCatalogEntry | undefined {
    // 1. Exact match
    const exact = khPriceMap.get(`${khProvider}:${devModelId}`);
    if (exact) return exact;

    const khModels = khModelsByProvider.get(khProvider);
    if (!khModels) return undefined;

    // Collect all candidates and pick the longest match (most specific)
    let bestMatch: ModelCatalogEntry | undefined;
    let bestMatchLen = 0;

    for (const khId of khModels) {
      // 2. kh is more specific: kh ID starts with dev ID + "-" or "/"
      //    e.g. dev "grok-4" matches kh "grok-4-0709"
      if (khId.startsWith(devModelId + "-") || khId.startsWith(devModelId + "/")) {
        const suffix = khId.slice(devModelId.length + 1);
        // Only match if the extra suffix looks like a version (not a different model variant)
        if (suffix.split("-").every(isVersionSuffix)) {
          if (khId.length > bestMatchLen) {
            bestMatch = khPriceMap.get(`${khProvider}:${khId}`);
            bestMatchLen = khId.length;
          }
        }
      }
      // 3. dev is more specific: dev ID starts with kh ID + "-" or "/"
      //    e.g. dev "claude-opus-4-20250514" matches kh "claude-opus-4"
      //    e.g. dev "claude-3-7-sonnet-20250219" matches kh "claude-3-7-sonnet"
      if (devModelId.startsWith(khId + "-") || devModelId.startsWith(khId + "/")) {
        const suffix = devModelId.slice(khId.length + 1);
        // Only match if the extra suffix looks like a version (not a different model variant)
        if (suffix.split("-").every(isVersionSuffix)) {
          if (khId.length > bestMatchLen) {
            bestMatch = khPriceMap.get(`${khProvider}:${khId}`);
            bestMatchLen = khId.length;
          }
        }
      }
    }

    return bestMatch;
  }

  // ---------------------------------------------------------------------------
  // Compare
  // ---------------------------------------------------------------------------
  const results: ModelComparison[] = [];
  const checkedProviders = new Set<string>();

  for (const devModel of allDevModels) {
    const rawProvider = devModel.provider?.toLowerCase() || "";
    const khProvider = PROVIDER_MAP[rawProvider] || rawProvider;

    if (!SUPPORTED_PROVIDERS.has(khProvider)) continue;
    if (filterProvider && khProvider !== filterProvider && rawProvider !== filterProvider) continue;
    if (freeOnly && devModel.cost?.input !== 0) continue;

    checkedProviders.add(khProvider);

    const modelId = devModel.id;
    const devInputPrice = devModel.cost?.input ?? null;
    const devOutputPrice = devModel.cost?.output ?? null;

    // Check if model is registered in knowhow (exact or prefix match)
    const khEntry = findKhEntry(khProvider, modelId);
    const isRegistered = !!khEntry;

    // Skip deprecated/retired models — they shouldn't appear in coverage gaps
    if (!includeDeprecated && (khEntry?.deprecated || khEntry?.limitedAvailability || khEntry?.type === "live")) {
      continue;
    }

    const khInputPrice = khEntry?.pricing?.input ?? null;
    // For image models, prefer image_generation_per_1m_tokens for output comparison
    // since models.dev reports image output as per-1M-tokens rate
    const khOutputPrice =
      (khEntry?.pricing as any)?.image_generation_per_1m_tokens ??
      khEntry?.pricing?.output ??
      null;

    let status: ModelComparison["status"] = "ok";
    let details: string | undefined;

    if (!isRegistered) {
      status = "missing-in-knowhow";
      details = `Model not registered for provider "${khProvider}" in knowhow`;
    } else if (!khEntry) {
      status = "missing-pricing";
      details = `Model registered but no pricing data in knowhow`;
    } else {
      // If models.dev says FREE but we have a :free variant registered, it's not a mismatch —
      // models.dev is tracking the free tier while we also track the paid tier separately.
      const devIsFree = devInputPrice === 0 && devOutputPrice === 0;
      const hasFreeVariant = khModelsByProvider.get(khProvider)?.has(`${modelId}:free`);
      if (devIsFree && hasFreeVariant) {
        // models.dev tracks the free tier; we have both free and paid — skip comparison
      }

      // Check for price mismatches (allow 5% floating point tolerance)
      const inputMismatch =
        !(devIsFree && hasFreeVariant) &&
        devInputPrice !== null &&
        khInputPrice !== null &&
        Math.abs((devInputPrice - khInputPrice) / Math.max(devInputPrice, 0.0001)) > 0.05;
      const outputMismatch =
        !(devIsFree && hasFreeVariant) &&
        devOutputPrice !== null &&
        khOutputPrice !== null &&
        Math.abs((devOutputPrice - khOutputPrice) / Math.max(devOutputPrice, 0.0001)) > 0.05;

      if (inputMismatch || outputMismatch) {
        status = "price-mismatch";
        const parts: string[] = [];
        if (inputMismatch) {
          parts.push(
            `input: models.dev=$${devInputPrice}/1M, knowhow=$${khInputPrice}/1M`
          );
        }
        if (outputMismatch) {
          parts.push(
            `output: models.dev=$${devOutputPrice}/1M, knowhow=$${khOutputPrice}/1M`
          );
        }
        details = parts.join("; ");
      }
    }

    if (showAll || status !== "ok") {
      results.push({
        modelId,
        provider: khProvider,
        devProvider: rawProvider,
        devInputPrice,
        devOutputPrice,
        khInputPrice,
        khOutputPrice,
        status,
        details,
      });
    }
  }

  // Also check for models in knowhow that aren't on models.dev
  const devModelIds = new Set(allDevModels.map((m) => m.id));
  for (const [khProvider, models] of khModelsByProvider.entries()) {
    if (filterProvider && khProvider !== filterProvider) continue;
    if (!SUPPORTED_PROVIDERS.has(khProvider)) continue;
    for (const modelId of models) {
      // A kh model is "extra" only if no dev model is a prefix of it
      // (i.e. no dev model "grok-4" that would prefix-match kh "grok-4-0709")
      const hasDevAlias = [...devModelIds].some(
        (devId) =>
          modelId === devId ||
          modelId.startsWith(devId + "-") ||
          modelId.startsWith(devId + "/")
      );
      if (!hasDevAlias) {
        if (showAll) {
          results.push({
            modelId,
            provider: khProvider,
            devProvider: "",
            devInputPrice: null,
            devOutputPrice: null,
            khInputPrice: null,
            khOutputPrice: null,
            status: "extra-in-knowhow",
            details: "Model in knowhow but not found on models.dev",
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------
  const summary = generateReport(results, checkedProviders, allDevModels.length);
  console.log(summary);

  if (outputFile) {
    const fs = await import("fs");
    fs.writeFileSync(outputFile, summary, "utf-8");
    console.log(`\n📄 Report written to ${outputFile}`);
  }
}


function generateReport(
  results: ModelComparison[],
  checkedProviders: Set<string>,
  totalDevModels: number
): string {
  const lines: string[] = [];
  lines.push("# models.dev Pricing Comparison Report");
  lines.push(`\n> Generated: ${new Date().toISOString()}`);
  lines.push(`> models.dev total models fetched: ${totalDevModels}`);
  lines.push(`> Checked providers: ${[...checkedProviders].sort().join(", ")}`);
  lines.push("");

  // Summary counts
  const byStatus = new Map<string, ModelComparison[]>();
  for (const r of results) {
    const list = byStatus.get(r.status) || [];
    list.push(r);
    byStatus.set(r.status, list);
  }

  lines.push("## Summary");
  lines.push("");
  lines.push("| Status | Count |");
  lines.push("|--------|-------|");
  const statusLabels: Record<string, string> = {
    ok: "✅ OK (registered & priced correctly)",
    "missing-in-knowhow": "❌ Missing in knowhow (not registered)",
    "missing-pricing": "⚠️ Missing pricing data",
    "price-mismatch": "🔴 Price mismatch",
    "extra-in-knowhow": "ℹ️ In knowhow but not on models.dev",
  };
  for (const [status, label] of Object.entries(statusLabels)) {
    const count = byStatus.get(status)?.length || 0;
    if (count > 0) {
      lines.push(`| ${label} | ${count} |`);
    }
  }
  lines.push("");

  // Detailed sections
  const orderedStatuses = [
    "price-mismatch",
    "missing-pricing",
    "missing-in-knowhow",
    "extra-in-knowhow",
    "ok",
  ];

  for (const status of orderedStatuses) {
    const items = byStatus.get(status);
    if (!items || items.length === 0) continue;

    const label = statusLabels[status] || status;
    lines.push(`## ${label}`);
    lines.push("");
    lines.push(
      "| Provider | Model ID | models.dev Input | models.dev Output | knowhow Input | knowhow Output | Details |"
    );
    lines.push(
      "|----------|----------|-----------------|------------------|--------------|---------------|---------|"
    );

    for (const r of items.sort((a, b) =>
      `${a.provider}/${a.modelId}`.localeCompare(`${b.provider}/${b.modelId}`)
    )) {
      const fmt = (v: number | null) =>
        v === null ? "—" : v === 0 ? "**FREE**" : `$${v.toFixed(3)}`;
      lines.push(
        `| ${r.provider} | \`${r.modelId}\` | ${fmt(r.devInputPrice)} | ${fmt(r.devOutputPrice)} | ${fmt(r.khInputPrice)} | ${fmt(r.khOutputPrice)} | ${r.details || ""} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
