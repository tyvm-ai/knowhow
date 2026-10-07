/**
 * GazeClient — the ONE client for the eye-tracking hub (`knowhow eye-tracking`).
 *
 * Every consumer (automation SDK `sdk.ext.gaze`, hints pack, gaze-follow,
 * smart selector, hints CLI, GazePlugin, voice session) goes through this
 * file, so the hub URL, timeouts, sample validation and error radius are
 * defined exactly once.
 *
 * Hub URL resolution (config service `gaze.url`; first match wins):
 *   0. knowhow.json → voiceControl.services.gaze.url (only when no env var below is set)
 *   1. `KNOWHOW_EYE_HUB_URL`            — the canonical setting
 *   2. `KNOWHOW_EYE_URL`                — DEPRECATED legacy alias
 *   3. `KNOWHOW_GAZE_URL`               — DEPRECATED legacy alias (a full
 *                                          `…/api/gaze` endpoint URL; the
 *                                          `/api/gaze` suffix is stripped)
 *   4. http://127.0.0.1:7465
 */

import type { GazeSample } from "./eyeTracking";
import { ConfigResolver, DEFAULT_HUB_URL, GAZE_SERVICE_CONFIG, getDefaultConfig } from "./config";

export { DEFAULT_HUB_URL };

/**
 * Gaze estimate error radius in desktop pixels (x, y). The single shared
 * constant: how far from the reported gaze point the user might really be
 * looking. Used to bound candidate searches.
 */
export const GAZE_ERROR_RADIUS: Readonly<{ x: number; y: number }> = Object.freeze({ x: 200, y: 260 });

/** Named request timeouts (ms). */
export const GAZE_TIMEOUT = {
  /** High-frequency polling loops (gaze-follow / magnetic cursor ticks). */
  tick: 100,
  /** On the command-latency path (speech-onset lookups, hint targeting). */
  fast: 150,
  /** Ordinary one-shot requests. */
  normal: 500,
  /** Bulk / non-latency-sensitive requests (history, CLI start-up). */
  slow: 1500,
} as const;

export type GazeTimeoutPreset = keyof typeof GAZE_TIMEOUT;

/** Resolve the hub base URL (no trailing slash). Evaluated on every call. */
export function resolveGazeHubUrl(source?: NodeJS.ProcessEnv | ConfigResolver): string {
  const config =
    source instanceof ConfigResolver
      ? source
      : source
        ? new ConfigResolver({ env: () => source, json: () => ({}) })
        : getDefaultConfig();
  return config.get({ kind: "services", name: "gaze" }, "url", GAZE_SERVICE_CONFIG.url);
}

export interface GazeRequestOptions {
  /** Request timeout in ms (default GAZE_TIMEOUT.normal). */
  timeoutMs?: number;
}

export interface GazeCurrentOptions extends GazeRequestOptions {
  /** Reject samples older than this (ms). Omit to accept any sample. */
  maxAgeMs?: number;
}

export interface GazeAtOptions extends GazeRequestOptions {
  /** How far back before `epochMs` to fetch history (default 5000). */
  windowMs?: number;
}

export interface GazeClientOptions {
  hubUrl?: string;
  /** Where the hub URL comes from when `hubUrl` isn't given (read at call time). Default: the process-wide resolver. */
  config?: ConfigResolver;
  /** Test seam; defaults to global fetch. */
  fetch?: typeof fetch;
}

function finite(sample: Partial<GazeSample> | null | undefined): sample is GazeSample {
  return !!sample && Number.isFinite(sample.x) && Number.isFinite(sample.y);
}

/** Pure: the sample whose timestamp is nearest `epochMs`. */
export function nearestSample<T extends { timestamp: number }>(samples: T[], epochMs: number): T | undefined {
  if (!samples.length) return undefined;
  let best = samples[0];
  let bestDist = Math.abs(best.timestamp - epochMs);
  for (const s of samples) {
    const d = Math.abs(s.timestamp - epochMs);
    if (d < bestDist) { best = s; bestDist = d; }
  }
  return best;
}

export class GazeClient {
  private readonly fixedUrl?: string;
  private readonly config?: ConfigResolver;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: GazeClientOptions = {}) {
    this.fixedUrl = opts.hubUrl?.replace(/\/$/, "");
    this.config = opts.config;
    this.fetchImpl = opts.fetch;
  }

  /** The hub base URL: the explicit one, else resolved from config on every use. */
  get hubUrl(): string {
    return this.fixedUrl ?? resolveGazeHubUrl(this.config);
  }

  private doFetch(path: string, init: RequestInit & { timeoutMs: number }): Promise<Response> {
    const { timeoutMs, ...rest } = init;
    const f = this.fetchImpl ?? fetch;
    return f(`${this.hubUrl}${path}`, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  }

  /** The shared error radius (a copy — callers may mutate it). */
  errorRadius(): { x: number; y: number } {
    return { ...GAZE_ERROR_RADIUS };
  }

  /** Latest gaze sample, or null when the hub is down / no valid or fresh sample. Never throws. */
  async current(opts: GazeCurrentOptions = {}): Promise<GazeSample | null> {
    try {
      const res = await this.doFetch("/api/gaze", { timeoutMs: opts.timeoutMs ?? GAZE_TIMEOUT.normal });
      if (!res.ok) return null;
      const sample = (await res.json()) as GazeSample;
      if (!finite(sample)) return null;
      if (opts.maxAgeMs !== undefined && sample.timestamp && Date.now() - sample.timestamp > opts.maxAgeMs) return null;
      return sample;
    } catch {
      return null;
    }
  }

  /** Gaze samples recorded since `sinceMs` (epoch ms). Never throws. */
  async history(sinceMs: number, opts: GazeRequestOptions = {}): Promise<GazeSample[]> {
    try {
      const res = await this.doFetch(`/api/gaze/history?sinceMs=${sinceMs}`, {
        timeoutMs: opts.timeoutMs ?? GAZE_TIMEOUT.slow,
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { samples?: GazeSample[] };
      return Array.isArray(data.samples) ? data.samples : [];
    } catch {
      return [];
    }
  }

  /** Sample nearest `epochMs` (e.g. speech onset), or null. Never throws. */
  async at(epochMs: number, opts: GazeAtOptions = {}): Promise<GazeSample | null> {
    const samples = await this.history(epochMs - (opts.windowMs ?? 5000), { timeoutMs: opts.timeoutMs });
    return nearestSample(samples, epochMs) ?? null;
  }

  /** Tell the hub where the user really looked (calibration correction). Best-effort. */
  async correct(target: { x: number; y: number }, opts: GazeRequestOptions = {}): Promise<void> {
    try {
      await this.doFetch("/api/correct", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target),
        timeoutMs: opts.timeoutMs ?? GAZE_TIMEOUT.slow,
      });
    } catch {
      // best-effort
    }
  }

  /** Re-centre gaze drift correction on the current position. Best-effort. */
  async recenter(opts: GazeRequestOptions = {}): Promise<void> {
    try {
      await this.doFetch("/api/gaze/recenter", { method: "POST", timeoutMs: opts.timeoutMs ?? GAZE_TIMEOUT.normal });
    } catch {
      // best-effort
    }
  }
}

/** Convenience: a client for `hubUrl` (default: resolved from env at call time). */
export function createGazeClient(hubUrl?: string, fetchImpl?: typeof fetch): GazeClient {
  return new GazeClient({ hubUrl, fetch: fetchImpl });
}
