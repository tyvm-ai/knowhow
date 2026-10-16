/**
 * Voice command latency reporting: one human-readable line per command plus a
 * JSON line appended to ~/.cache/knowhow/voice/latency.jsonl.
 */

import { promises as fs } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { UtteranceTiming } from "./types";

export const DEFAULT_LATENCY_LOG = join(homedir(), ".cache", "knowhow", "voice", "latency.jsonl");

export interface LatencyBreakdown {
  speechMs: number;
  endpointMs: number;
  queueMs: number;
  sttMs: number;
  dispatchMs: number;
  totalMs: number;
}

const ms = (value: number) => Math.max(0, Math.round(value));

export function latencyBreakdown(timing: UtteranceTiming, dispatchedAt = timing.dispatchedAt ?? timing.sttEndAt): LatencyBreakdown {
  return {
    speechMs: ms(timing.speechEndAt - timing.spokenAt),
    endpointMs: ms(timing.finalizedAt - timing.speechEndAt),
    queueMs: ms(timing.sttStartAt - timing.finalizedAt),
    sttMs: ms(timing.sttEndAt - timing.sttStartAt),
    dispatchMs: ms(dispatchedAt - timing.sttEndAt),
    totalMs: ms(dispatchedAt - timing.spokenAt),
  };
}

/**
 * e.g. `[voice] latency slice: speech 410ms + endpoint 352ms + queue 0ms + stt 388ms + dispatch 9ms = 1159ms (onset→dispatched)`
 */
export function formatLatencyLine(phrase: string, timing: UtteranceTiming): string {
  const b = latencyBreakdown(timing);
  const extras: string[] = [];
  if (timing.sttBackend) extras.push(timing.sttBackend);
  if (timing.gazeMs !== undefined) extras.push(`gaze ${ms(timing.gazeMs)}ms`);
  extras.push(`silence ${timing.silenceMs}ms`);
  extras.push(`audio ${timing.audioMs}ms`);
  return (
    `[voice] latency ${phrase}: speech ${b.speechMs}ms + endpoint ${b.endpointMs}ms + queue ${b.queueMs}ms + ` +
    `stt ${b.sttMs}ms + dispatch ${b.dispatchMs}ms = ${b.totalMs}ms (onset→dispatched)` +
    (extras.length ? ` [${extras.join(", ")}]` : "")
  );
}

export interface LatencyRecord {
  time: string;
  utteranceId: string;
  phrase: string;
  source: string;
  text?: string;
  timing: UtteranceTiming;
  breakdown: LatencyBreakdown;
}

export function buildLatencyRecord(params: {
  utteranceId: string;
  phrase: string;
  source: string;
  text?: string;
  timing: UtteranceTiming;
}): LatencyRecord {
  return {
    time: new Date(params.timing.dispatchedAt ?? Date.now()).toISOString(),
    utteranceId: params.utteranceId,
    phrase: params.phrase,
    source: params.source,
    ...(params.text !== undefined ? { text: params.text } : {}),
    timing: params.timing,
    breakdown: latencyBreakdown(params.timing),
  };
}

/** Append one JSON line; never throws. */
export async function appendLatencyRecord(record: LatencyRecord, file = DEFAULT_LATENCY_LOG): Promise<void> {
  try {
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // diagnostics only
  }
}
