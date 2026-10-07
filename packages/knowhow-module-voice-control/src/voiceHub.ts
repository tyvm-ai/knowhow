/**
 * Voice + Gaze Hub — shared types and a client for the eye-tracking server's
 * cross-process voice/gaze hub (Contract 2).
 *
 * The hub lives on the eye-tracking server (127.0.0.1:7465).  Automations and
 * the voice session communicate through it so they can live in different
 * processes.
 */

import { GazeSample } from "./eyeTracking";
import type { UtteranceTiming } from "./types";

// ─── Shared data types ───────────────────────────────────────────────────────

export interface VoiceCommandSpec {
  phrase: string;
  aliases?: string[];
  description?: string;
}

export interface VoiceCommandEvent {
  type: "voice.command";
  /** Utterance id — matches the TranscriptEvent utteranceId. */
  id: string;
  /** Canonical matched phrase, e.g. "slice". */
  phrase: string;
  /** Full recognized text. */
  text: string;
  /** Epoch ms of SPEECH ONSET (VAD) — the moment to read gaze at. */
  spokenAt: number;
  /** Epoch ms STT finished. */
  recognizedAt: number;
  /**
   * Gaze sample nearest spokenAt. Filled by the hub from its own gaze history
   * when the voice-agent posts without one (avoids an extra round-trip).
   */
  gaze?: GazeSample;
  /** Latency breakdown (speech onset → endpoint → STT → dispatch). */
  timing?: UtteranceTiming;
}

export interface VoiceModeChangedEvent {
  type: "voice.mode";
  mode: "command" | "agent";
  timestamp: number;
}

export type VoiceHubEvent = VoiceCommandEvent | VoiceModeChangedEvent;

// ─── Hub client ─────────────────────────────────────────────────────────────

const DEFAULT_HUB_URL = "http://127.0.0.1:7465";

export function resolveHubUrl(): string {
  return (process.env.KNOWHOW_EYE_URL || DEFAULT_HUB_URL).replace(/\/$/, "");
}

/** Post a VoiceCommandEvent to the hub (fire and forget — never throws). */
export async function postVoiceCommand(event: VoiceCommandEvent, hubUrl = resolveHubUrl()): Promise<void> {
  try {
    await fetch(`${hubUrl}/api/voice/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Best-effort — hub may not be running.
  }
}

/** Fetch currently registered command specs from the hub. Returns [] on error. */
export async function fetchRegisteredCommands(hubUrl = resolveHubUrl()): Promise<VoiceCommandSpec[]> {
  try {
    const res = await fetch(`${hubUrl}/api/voice/commands`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    const data = await res.json() as { specs: VoiceCommandSpec[] };
    return Array.isArray(data.specs) ? data.specs : [];
  } catch {
    return [];
  }
}

/** Register phrases as belonging to `owner` (heartbeat every ttlMs/2). Returns a dispose fn. */
export function registerPhrases(
  specs: VoiceCommandSpec[],
  owner: string,
  hubUrl = resolveHubUrl(),
  ttlMs = 10_000,
): () => void {
  const doRegister = () => {
    fetch(`${hubUrl}/api/voice/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phrases: specs, owner, ttlMs }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  };
  doRegister();
  const interval = setInterval(doRegister, Math.max(1000, ttlMs / 2));
  interval.unref?.();
  return () => {
    clearInterval(interval);
    fetch(`${hubUrl}/api/voice/unregister`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner }),
      signal: AbortSignal.timeout(1000),
    }).catch(() => {});
  };
}

/** Subscribe to hub SSE events. Returns dispose fn; handler called for each event. */
export function subscribeHubEvents(
  handler: (event: VoiceHubEvent) => void,
  signal: AbortSignal,
  hubUrl = resolveHubUrl(),
): () => void {
  let cancelled = false;
  const abort = new AbortController();
  const unsubscribe = () => {
    cancelled = true;
    abort.abort();
  };
  signal.addEventListener("abort", unsubscribe, { once: true });

  (async () => {
    while (!cancelled) {
      try {
        const res = await fetch(`${hubUrl}/api/voice/events`, {
          signal: abort.signal,
          headers: { accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            try {
              const ev = JSON.parse(dataLine.slice(5).trim()) as VoiceHubEvent;
              handler(ev);
            } catch {
              // malformed SSE
            }
          }
        }
      } catch {
        if (cancelled) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();

  return unsubscribe;
}
