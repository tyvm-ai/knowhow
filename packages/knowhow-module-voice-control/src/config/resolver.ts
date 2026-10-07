/**
 * ConfigResolver — the ONE place that reads `process.env.KNOWHOW_*` and `knowhow.json → voiceControl`.
 *
 *   env > knowhow.json (voiceControl.packs.<pack>.<key> / voiceControl.services.<service>.<key>) > default
 *
 * Every `get` re-reads both sources, so settings can change while the session runs.
 */

import type { ConfigField, ConfigSchema, ConfigValues } from "./schema";
import { parseBoolean } from "./schema";

export type ConfigSource = "env" | "knowhow.json" | "default";

export interface ConfigScope {
  kind: "packs" | "services";
  name: string;
}

export interface ResolvedConfigValue<T> {
  value: T;
  source: ConfigSource;
  /** The env var that supplied the value (source "env"). */
  envName?: string;
  /** The knowhow.json path that supplied the value (source "knowhow.json"). */
  jsonPath?: string;
}

export interface ConfigReportRow {
  scope: string;
  key: string;
  value: unknown;
  source: ConfigSource;
  /** Where it came from: the env var name, the json path, or "-". */
  origin: string;
  /** The env var(s) that can override it. */
  env: string;
  description: string;
}

export interface ConfigResolverOptions {
  /** Environment to read (default process.env, evaluated per call). */
  env?: () => NodeJS.ProcessEnv;
  /** The parsed knowhow.json (default: core's `getConfigSync()`, evaluated per call). */
  json?: () => unknown;
}

function defaultJson(): unknown {
  try {
    // required lazily: importing the sdk must not be needed just to build a resolver
    return (require("@tyvm/knowhow/sdk") as typeof import("@tyvm/knowhow/sdk")).getConfigSync();
  } catch {
    return {};
  }
}

export function scopePath(scope: ConfigScope, key: string): string {
  return `voiceControl.${scope.kind}.${scope.name}.${key}`;
}

function dig(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function parseWith<T>(field: ConfigField<T>, raw: unknown): T | undefined {
  if (field.parse) {
    if (raw === undefined || raw === null) return undefined;
    return field.parse(String(raw));
  }
  const d = field.default as unknown;
  if (typeof d === "number") {
    if (raw === "" || raw === undefined || raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? (n as unknown as T) : undefined;
  }
  if (typeof d === "boolean") {
    if (typeof raw === "boolean") return raw as unknown as T;
    return raw === undefined || raw === null ? undefined : (parseBoolean(String(raw)) as unknown as T | undefined);
  }
  if (typeof raw === "string") return raw.trim() ? (raw as unknown as T) : undefined;
  return undefined;
}

export class ConfigResolver {
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly json: () => unknown;
  private readonly schemas = new Map<string, { scope: ConfigScope; schema: ConfigSchema }>();

  constructor(options: ConfigResolverOptions = {}) {
    this.env = options.env ?? (() => process.env);
    this.json = options.json ?? defaultJson;
  }

  /** Resolve one setting and say where it came from. */
  resolve<T>(scope: ConfigScope, key: string, field: ConfigField<T>): ResolvedConfigValue<T> {
    const env = this.env();
    const envNames = field.env === undefined ? [] : typeof field.env === "string" ? [field.env] : field.env;
    for (const name of envNames) {
      const raw = env[name];
      if (raw === undefined || raw === "") continue;
      const value = parseWith(field, raw);
      if (value !== undefined) return { value, source: "env", envName: name };
    }
    const json = this.json();
    for (const path of [scopePath(scope, key), ...(field.legacyJson ?? [])]) {
      const raw = dig(json, path);
      if (raw === undefined || raw === null) continue;
      const value = parseWith(field, raw);
      if (value !== undefined) return { value, source: "knowhow.json", jsonPath: path };
    }
    return { value: field.default, source: "default" };
  }

  get<T>(scope: ConfigScope, key: string, field: ConfigField<T>): T {
    return this.resolve(scope, key, field).value;
  }

  /** Make a scope's settings known to `report()` (`voice-control config`). Idempotent. */
  register(scope: ConfigScope, schema: ConfigSchema): void {
    this.schemas.set(`${scope.kind}.${scope.name}`, { scope, schema });
  }

  /** Live typed view: each property is resolved (env > json > default) every time it is read. */
  view<C extends ConfigSchema>(scope: ConfigScope, schema: C): ConfigValues<C> {
    this.register(scope, schema);
    const out = {} as Record<string, unknown>;
    for (const key of Object.keys(schema)) {
      Object.defineProperty(out, key, {
        enumerable: true,
        get: () => this.get(scope, key, schema[key]),
      });
    }
    return out as ConfigValues<C>;
  }

  /** Effective value + source for every registered setting. */
  report(): ConfigReportRow[] {
    const rows: ConfigReportRow[] = [];
    for (const { scope, schema } of this.schemas.values()) {
      for (const [key, field] of Object.entries(schema)) {
        const r = this.resolve(scope, key, field);
        const envNames = field.env === undefined ? [] : typeof field.env === "string" ? [field.env] : field.env;
        rows.push({
          scope: `${scope.kind === "packs" ? "pack" : "service"}:${scope.name}`,
          key,
          value: r.value,
          source: r.source,
          origin: r.envName ?? r.jsonPath ?? "-",
          env: envNames.join(" | ") || "-",
          description: field.description ?? "",
        });
      }
    }
    return rows;
  }
}

export function formatConfigReport(rows: readonly ConfigReportRow[]): string {
  const cell = (v: unknown) => (v === undefined ? "(unset)" : typeof v === "string" ? v : JSON.stringify(v));
  const headers = ["SCOPE", "KEY", "VALUE", "SOURCE", "ORIGIN", "ENV"];
  const body = rows.map((r) => [r.scope, r.key, cell(r.value), r.source, r.origin, r.env]);
  const widths = headers.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (c: string[]) => c.map((s, i) => (i === c.length - 1 ? s : s.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n") + "\n";
}
