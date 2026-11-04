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
}
