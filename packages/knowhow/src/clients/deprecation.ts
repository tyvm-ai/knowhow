/**
 * Helpers for surfacing model deprecation (from the pricing catalog's
 * `deprecated` / `deprecationDate` / `replacedBy` metadata) to CLI users.
 */
import { ALL_MODEL_CATALOG } from "./pricing/models";
import type { ModelCatalogEntry } from "./pricing/types";

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
