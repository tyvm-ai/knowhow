import type {
  WorkerConfigWithTelemetry,
  WorkerTelemetryModuleConfig,
} from "./types";

export const DEFAULT_INTERVAL_MS = 15_000;
export const MIN_INTERVAL_MS = 5_000;
export const MAX_INTERVAL_MS = 300_000;

export const DEFAULT_JITTER_MS = 1500;
export const MAX_JITTER_MS = 0.25 * DEFAULT_INTERVAL_MS;

export const DEFAULT_COLLECTOR_TIMEOUT_MS = 2_000;
export const DEFAULT_TOTAL_BUDGET_MS = 3_500;

export type ResolvedTelemetryConfig = {
  enabled: boolean;
  intervalMs: number;
  jitterMs: number;
  collectorTimeoutMs: number;
  totalCollectionBudgetMs: number;
  systemEnabled: boolean;
  gpuEnabled: boolean;
};

function asFiniteInt(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  return Math.floor(value);
}

export function resolveTelemetryConfig(
  config: unknown
): ResolvedTelemetryConfig {
  const cfg = config as WorkerConfigWithTelemetry;
  const raw = (cfg?.worker?.telemetry ?? {}) as WorkerTelemetryModuleConfig;

  const enabled = raw.enabled !== false;

  const intervalMs = Math.min(
    MAX_INTERVAL_MS,
    Math.max(
      MIN_INTERVAL_MS,
      asFiniteInt(raw.intervalMs) ?? DEFAULT_INTERVAL_MS
    )
  );

  const jitterMsRaw = asFiniteInt(raw.jitterMs);
  const jitterMsCap = Math.floor(intervalMs * 0.25);
  const jitterMs = Math.min(
    jitterMsCap,
    Math.max(0, jitterMsRaw ?? Math.min(DEFAULT_JITTER_MS, jitterMsCap))
  );

  const collectorTimeoutMs = Math.min(
    intervalMs,
    Math.max(
      250,
      asFiniteInt(raw.collectorTimeoutMs) ?? DEFAULT_COLLECTOR_TIMEOUT_MS
    )
  );

  const totalCollectionBudgetMs = Math.min(
    intervalMs,
    Math.max(
      250,
      asFiniteInt(raw.totalCollectionBudgetMs) ?? DEFAULT_TOTAL_BUDGET_MS
    )
  );

  const systemEnabled = raw.system?.enabled !== false;
  const gpuEnabled = raw.gpu?.enabled === true;

  return {
    enabled,
    intervalMs,
    jitterMs,
    collectorTimeoutMs,
    totalCollectionBudgetMs,
    systemEnabled,
    gpuEnabled,
  };
}
