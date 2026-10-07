/**
 * F6: Per-command decision log to ~/.cache/knowhow/voice/commands.jsonl.
 *
 * Every command-mode decision (accepted/rejected, with voicedMs, audioMs,
 * no_speech_prob, text) is appended here for offline analysis.
 */

import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface CommandDecisionRecord {
  ts: number;
  utteranceId: string;
  text: string;
  decision: "accepted" | "rejected";
  rejectedReason?: string;
  phrase?: string;
  source?: string;
  voicedMs?: number;
  audioMs?: number;
  no_speech_prob?: number;
  avg_logprob?: number;
}

const LOG_DIR = join(homedir(), ".cache", "knowhow", "voice");
const LOG_FILE = join(LOG_DIR, "commands.jsonl");

let logDirEnsured = false;

async function ensureLogDir(): Promise<void> {
  if (logDirEnsured) return;
  await fs.mkdir(LOG_DIR, { recursive: true });
  logDirEnsured = true;
}

export async function appendCommandDecision(record: CommandDecisionRecord): Promise<void> {
  try {
    await ensureLogDir();
    await fs.appendFile(LOG_FILE, JSON.stringify(record) + "\n");
  } catch {
    // never crash the voice session over logging
  }
}
