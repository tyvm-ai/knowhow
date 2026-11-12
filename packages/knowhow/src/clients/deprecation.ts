/**
 * Helpers for surfacing model deprecation (from the pricing catalog's
 * `deprecated` / `deprecationDate` / `replacedBy` metadata) to CLI users.
 */
import { ALL_MODEL_CATALOG } from "./pricing/models";
import type { ModelCatalogEntry, ModelType } from "./pricing/types";

export interface ModelDeprecationInfo {
  id: string;
  provider: string;
  deprecationDate?: string;
  replacedBy?: string;
}

/**
 * Looks up a model in the catalog and returns deprecation info if it is
 * flagged `deprecated`. Handles proxied ids like "anthropic/claude-sonnet-4-20250514"
 * (the "knowhow" provider) by stripping leading "provider/" segments.
 */
export function getModelDeprecation(
  model: string | undefined,
  catalog: ModelCatalogEntry[] = ALL_MODEL_CATALOG
): ModelDeprecationInfo | undefined {
  if (!model) return undefined;

  const candidates = [model];
  if (model.includes("/")) {
    const parts = model.split("/");
    for (let i = 1; i < parts.length; i++) {
      candidates.push(parts.slice(i).join("/"));
    }
  }

  for (const candidate of candidates) {
    const entry = catalog.find((e) => e.id === candidate);
    if (entry) {
      if (!entry.deprecated) return undefined;
      return {
        id: entry.id,
        provider: entry.provider,
        deprecationDate: entry.deprecationDate,
        replacedBy: entry.replacedBy,
      };
    }
  }
  return undefined;
}

export function isModelDeprecated(model: string | undefined): boolean {
  return !!getModelDeprecation(model);
}

/** Returns the model id with " (deprecated)" appended when it is deprecated. */
export function formatModelLabel(model: string): string {
  return isModelDeprecated(model) ? `${model} (deprecated)` : model;
}

export function formatDeprecationWarning(info: ModelDeprecationInfo): string {
  const when = info.deprecationDate
    ? ` and is scheduled for retirement on ${info.deprecationDate}`
    : "";
  const instead = info.replacedBy ? ` Consider using ${info.replacedBy} instead.` : "";
  return `⚠️  Model '${info.id}' is deprecated${when}.${instead}`;
}

const warned = new Set<string>();

/**
 * Prints a one-time warning if the model is deprecated.
 * Returns the warning text if one was printed, otherwise undefined.
 */
export function warnIfModelDeprecated(
  model: string | undefined,
  log: (msg: string) => void = (m) => console.warn(m)
): string | undefined {
  const info = getModelDeprecation(model);
  if (!info || warned.has(info.id)) return undefined;
  warned.add(info.id);
  const message = formatDeprecationWarning(info);
  log(message);
  return message;
}

/** Test helper */
export function resetDeprecationWarnings() {
  warned.clear();
  routedWarned.clear();
}

// ─── Provider reroutes ───────────────────────────────────────────────────────

export interface ModelRoute {
  /** The model id that was requested (including any "provider/" prefix) */
  from: string;
  /** The model id requests should actually be sent to (prefix preserved) */
  to: string;
  /** ISO date the reroute took effect, if the provider announced one */
  effectiveDate?: string;
  /** Catalog provider that announced the reroute (e.g. "google") */
  provider: string;
  /** True when the requested id carried a "provider/" proxy prefix */
  proxied: boolean;
}

function isRouteInEffect(entry: ModelCatalogEntry, now: Date): boolean {
  if (!entry.routesTo) return false;
  if (!entry.routesToDate) return true;
  const effective = new Date(`${entry.routesToDate}T00:00:00Z`);
  return !isNaN(effective.getTime()) && now.getTime() >= effective.getTime();
}

/**
 * Returns where a model's requests should go when its provider has announced
 * that the endpoint transparently reroutes to another model (catalog
 * `routesTo` / `routesToDate`). Follows chains (A → B → C) and preserves
 * "provider/" prefixes used by proxy providers. Returns undefined when no
 * reroute is currently in effect.
 */
export function resolveModelRoute(
  model: string | undefined,
  now: Date = new Date(),
  catalog: ModelCatalogEntry[] = ALL_MODEL_CATALOG
): ModelRoute | undefined {
  if (!model) return undefined;

  // Split off any proxy prefix: try the full id first, then progressively
  // shorter suffixes ("knowhow/google/x" → "google/x" → "x").
  const parts = model.split("/");
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    let current = parts.slice(i).join("/");
    let entry = catalog.find((e) => e.id === current);
    if (!entry) continue;
    const routeProvider = entry.provider;

    let effectiveDate: string | undefined;
    const seen = new Set<string>([current]);
    while (entry && isRouteInEffect(entry, now)) {
      const next = entry.routesTo!;
      if (seen.has(next)) break; // guard against cycles
      effectiveDate = entry.routesToDate ?? effectiveDate;
      current = next;
      seen.add(current);
      entry = catalog.find((e) => e.id === current);
    }

    if (seen.size === 1) return undefined;
    return {
      from: model,
      to: prefix ? `${prefix}/${current}` : current,
      effectiveDate,
      provider: routeProvider,
      proxied: !!prefix,
    };
  }
  return undefined;
}

const routedWarned = new Set<string>();

/** Prints a one-time notice that a model is being rerouted. */
export function noteModelRerouted(
  route: ModelRoute,
  log: (msg: string) => void = (m) => console.warn(m)
): string | undefined {
  if (routedWarned.has(route.from)) return undefined;
  routedWarned.add(route.from);
  const message = `↪️  Model '${route.from}' is deprecated and rerouted by its provider; sending requests to '${route.to}'.`;
  log(message);
  return message;
}

// ─── replacedBy chains ───────────────────────────────────────────────────────

/**
 * `replacedBy` links come in two flavours:
 *  - deprecated models ("use X instead"), and
 *  - superseded-but-still-served models (e.g. gemini-3.1-flash-image → gemini-nano-banana-2.1): `replacedBy` is set
 *    but `deprecated` is not, so they keep working and stay selectable.
 * The helpers below follow those links. A "latest" model is one that is not deprecated and has no `replacedBy`.
 */

/** Finds a catalog entry by id, ignoring any leading "provider/" proxy segments. Returns the stripped prefix too. */
function findCatalogEntry(
  model: string,
  catalog: ModelCatalogEntry[]
): { entry?: ModelCatalogEntry; prefix: string } {
  const parts = model.split("/");
  for (let i = 0; i < parts.length; i++) {
    const id = parts.slice(i).join("/");
    const entry = catalog.find((e) => e.id === id);
    if (entry) return { entry, prefix: parts.slice(0, i).join("/") };
  }
  return { prefix: "" };
}

export interface ReplacementChainOptions {
  catalog?: ModelCatalogEntry[];
  /**
   * When true (default for `resolveNewestSuccessor`) every `replacedBy` link is followed, including links on models
   * that are only superseded. When false (default for `resolveSuccessor`) the walk stops at the first model that is
   * not deprecated.
   */
  throughSuperseded?: boolean;
}

/**
 * The ordered list of model ids reached by following `replacedBy`, starting with `model` itself.
 * Cycle safe (a link back to an id already visited ends the walk) and preserves "provider/" prefixes.
 * A successor id that is not in the catalog is included as the last element (nothing more is known about it).
 */
export function getReplacementChain(
  model: string | undefined,
  options: ReplacementChainOptions = {}
): string[] {
  if (!model) return [];
  const catalog = options.catalog ?? ALL_MODEL_CATALOG;
  const through = options.throughSuperseded ?? false;

  const { entry: first, prefix } = findCatalogEntry(model, catalog);
  const chain = [model];
  const seen = new Set<string>([first ? first.id : model]);
  let entry = first;

  while (entry && entry.replacedBy) {
    if (!through && !entry.deprecated) break;
    const next = entry.replacedBy;
    if (seen.has(next)) break; // cycle
    seen.add(next);
    chain.push(prefix ? `${prefix}/${next}` : next);
    entry = catalog.find((e) => e.id === next);
  }
  return chain;
}

/**
 * Resolves a deprecated model to the first non-deprecated successor by following `replacedBy`
 * (A → B → C, stopping at the first model that is not deprecated). Returns the input unchanged when the model is
 * not deprecated, unknown, or has no `replacedBy`. If a chain ends on a deprecated model with no successor, that
 * last model is returned.
 */
export function resolveSuccessor(
  model: string,
  catalog: ModelCatalogEntry[] = ALL_MODEL_CATALOG
): string {
  const chain = getReplacementChain(model, { catalog, throughSuperseded: false });
  return chain[chain.length - 1] ?? model;
}

/**
 * Resolves a model to the newest model of its lineage: follows every `replacedBy` link, including links on models
 * that are superseded but not deprecated (still served), until a model with no `replacedBy` (or a cycle).
 * Use this to pick "the newest" model of a family; use `resolveSuccessor` to merely escape deprecation.
 */
export function resolveNewestSuccessor(
  model: string,
  catalog: ModelCatalogEntry[] = ALL_MODEL_CATALOG
): string {
  const chain = getReplacementChain(model, { catalog, throughSuperseded: true });
  return chain[chain.length - 1] ?? model;
}

export interface LatestModelsOptions {
  catalog?: ModelCatalogEntry[];
  /** Drop models flagged `limitedAvailability`. Default false. */
  excludeLimitedAvailability?: boolean;
}

export type LatestModelsByProvider = Record<
  string,
  Partial<Record<ModelType, ModelCatalogEntry[]>>
>;

/** True for a model that is neither deprecated nor replaced by another model. */
export function isLatestModel(entry: ModelCatalogEntry): boolean {
  return !entry.deprecated && !entry.replacedBy;
}

/**
 * Per provider and modality, the "latest" models: not deprecated and not pointed away from by their own
 * `replacedBy` (i.e. the end of every replacedBy chain). A lineage with several live tiers (e.g. Flash and
 * Flash-Lite TTS) yields several entries; catalog order is preserved.
 */
export function listLatestModels(options: LatestModelsOptions = {}): LatestModelsByProvider {
  const catalog = options.catalog ?? ALL_MODEL_CATALOG;
  const out: LatestModelsByProvider = {};
  for (const entry of catalog) {
    if (!isLatestModel(entry)) continue;
    if (options.excludeLimitedAvailability && entry.limitedAvailability) continue;
    const byType = (out[entry.provider] ??= {});
    (byType[entry.type] ??= []).push(entry);
  }
  return out;
}

/** Convenience: the latest models for one provider + modality ([] when none). */
export function getLatestModels(
  provider: string,
  type: ModelType,
  options: LatestModelsOptions = {}
): ModelCatalogEntry[] {
  return listLatestModels(options)[provider]?.[type] ?? [];
}

/**
 * True once a deprecated model's `deprecationDate` has passed (the provider no longer serves it).
 * Deprecated models without a date, or with a future date, are not shut down yet and stay usable.
 * Unknown / non-deprecated models return false.
 */
export function isModelShutDown(
  model: string | undefined,
  now: Date = new Date(),
  catalog: ModelCatalogEntry[] = ALL_MODEL_CATALOG
): boolean {
  const info = getModelDeprecation(model, catalog);
  if (!info?.deprecationDate) return false;
  const when = new Date(`${info.deprecationDate}T00:00:00Z`);
  return !isNaN(when.getTime()) && now.getTime() >= when.getTime();
}
