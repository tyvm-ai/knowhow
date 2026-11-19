/**
 * One lookup for everything we know about a model beyond its price:
 * reasoning, prompt caching, tool additions, plus the catalog's deprecation /
 * reroute metadata. New capabilities are added as ModelInfo fields on the
 * catalog, not as new client methods.
 */
import { ALL_MODEL_CATALOG } from "./models";
import {
  ModelCatalogEntry,
  ModelInfo,
  PromptCacheInfo,
  PromptCacheTtl,
} from "./types";

export interface ResolvedModelInfo extends ModelCatalogEntry {
  /** Capabilities as served by the requested provider (always present). */
  info: ModelInfo;
  /** False when the model isn't in our catalog (info is then empty). */
  inCatalog: boolean;
  /** Provider the request goes to (may differ from the catalog provider). */
  servedBy: string;
}

/**
 * Proxies that forward our CompletionOptions to the native client on the
 * server: cache settings (long_ttl_cache) pass through, but newer request
 * shapes (deferred tools / tool_addition markers) depend on the server's
 * version, so they're not assumed.
 */
const FORWARDING_PROXIES = new Set(["knowhow"]);

/** Model id plus every suffix after a "provider/" prefix (proxy ids). */
function modelCandidates(model: string): string[] {
  const parts = model.split("/");
  return parts.map((_, i) => parts.slice(i).join("/"));
}

export function findCatalogEntry(
  model: string,
  provider?: string,
  catalog: ModelCatalogEntry[] = ALL_MODEL_CATALOG
): ModelCatalogEntry | undefined {
  for (const id of modelCandidates(model)) {
    const matches = catalog.filter((entry) => entry.id === id);
    if (!matches.length) continue;
    return matches.find((entry) => entry.provider === provider) ?? matches[0];
  }
  return undefined;
}

/**
 * Resolve a model's catalog entry and capabilities for a provider. When the
 * provider isn't the model's own (a proxy or another host), only intrinsic
 * model traits are kept: request-shape features need the native API, and the
 * cache is treated as best-effort unless the proxy forwards cache settings.
 */
export function getModelInfo(
  model: string,
  provider?: string,
  catalog: ModelCatalogEntry[] = ALL_MODEL_CATALOG
): ResolvedModelInfo {
  const entry = findCatalogEntry(model, provider, catalog);
  const servedBy = provider || entry?.provider || "";
  if (!entry) {
    return {
      id: model,
      provider: servedBy,
      type: "completion",
      pricing: {},
      info: {},
      inCatalog: false,
      servedBy,
    };
  }

  const info = entry.info ?? {};
  const native = !provider || provider === entry.provider;
  let served: ModelInfo = info;
  if (!native && FORWARDING_PROXIES.has(provider)) {
    served = { ...info, toolAdditions: false };
  } else if (!native) {
    const { toolAdditions: _t, promptCache: _p, ...traits } = info;
    served = { ...traits, promptCache: { mode: "automatic" } };
  }
  return { ...entry, info: served, inCatalog: true, servedBy };
}

/**
 * The cache lifetime a request uses: the provider default, or the model's
 * long TTL when `long` is set. Undefined for best-effort / no caching, where
 * no lifetime is guaranteed.
 */
export function promptCacheTtl(
  cache: PromptCacheInfo | undefined,
  long = false
): PromptCacheTtl | undefined {
  if (cache?.mode !== "explicit" || !cache.ttls?.length) return undefined;
  if (long && cache.longTtl) {
    return cache.ttls.find((ttl) => ttl.id === cache.longTtl) ?? cache.ttls[0];
  }
  return cache.ttls[0];
}
