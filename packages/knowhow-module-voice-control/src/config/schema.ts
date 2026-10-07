/**
 * Config schema: what a pack (or a service) lets the user tune.
 *
 *   export const HINTS_CONFIG = {
 *     density: configField({ default: "all", env: "KNOWHOW_HINT_DENSITY", parse: oneOf("few", "normal", "more", "all"), description: "…" }),
 *   } satisfies ConfigSchema;
 *
 * Resolved by `ConfigResolver` in this order: env > knowhow.json (`voiceControl.packs.<pack>.<key>`
 * or `voiceControl.services.<service>.<key>`) > default. Values are read when used, never cached at import.
 */

export interface ConfigField<T> {
  /** Used when neither env nor knowhow.json provide a (valid) value. */
  default: T;
  /** Env override name(s); several names are tried in order (first one that is set and valid wins). */
  env?: string | readonly string[];
  /** Older knowhow.json locations (dotted paths, e.g. "voiceControl.smartType.model"), tried after the canonical path. */
  legacyJson?: readonly string[];
  description?: string;
  /**
   * Turn a raw env string (or a knowhow.json value, stringified) into a `T`. Return `undefined` when invalid:
   * the value is ignored and the next source is used. Default: by the type of `default` (number / boolean / string).
   */
  parse?(raw: string): T | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ConfigSchema = Record<string, ConfigField<any>>;

/** The value types of a schema: `ConfigValues<typeof HINTS_CONFIG>` → `{ density: HintDensity, … }`. */
export type ConfigValues<C extends ConfigSchema> = {
  [K in keyof C]: C[K] extends ConfigField<infer T> ? T : never;
};

/** Identity helper that keeps `T` inferred (so `default: "all"` doesn't widen the parse result). */
export function configField<T>(field: ConfigField<T>): ConfigField<T> {
  return field;
}

/** Accept only the listed strings (case-insensitive, returned in the listed spelling). */
export function oneOf<T extends string>(...values: readonly T[]): (raw: string) => T | undefined {
  return (raw) => values.find((v) => v === raw.trim().toLowerCase());
}

/** A finite number ≥ `min`. */
export function numberAtLeast(min: number): (raw: string) => number | undefined {
  return (raw) => {
    if (!raw.trim()) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? n : undefined;
  };
}

/** A non-empty string. */
export function nonEmpty(raw: string): string | undefined {
  const v = raw.trim();
  return v ? v : undefined;
}

export function parseBoolean(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
}
