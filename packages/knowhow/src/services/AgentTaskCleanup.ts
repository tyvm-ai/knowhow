/**
 * Periodic cleanup of old agent task directories (.knowhow/processes/agents/*)
 * and old execCommand logs / managed-process dirs (.knowhow/processes/*).
 * Previously a side effect of constructing AgentSyncFs.
 */
import { promises as fs } from "fs";
import * as path from "path";
import { getConfigSync } from "../config";

const AGENTS_PATH = ".knowhow/processes/agents";
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Parse a duration like "3d", "12h", "90m", "30s", "2w" (a bare number is
 * milliseconds). Returns undefined when unparseable.
 */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value === "number") return value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "ms").toLowerCase();
  const mult: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return n * mult[unit];
}

/** Task retention from knowhow.json `retention.tasks` (default 3 days). */
export function getTaskRetentionMs(): number {
  try {
    return parseDuration(getConfigSync()?.retention?.tasks) ?? THREE_DAYS_MS;
  } catch {
    return THREE_DAYS_MS;
  }
}

let interval: NodeJS.Timeout | null = null;
let started = false;

/**
 * Remove .knowhow/processes/<id>/ directories created by spawnManaged /
 * execCommand (identified by a status.json) older than maxAgeMs.
 */
export async function cleanupOldManagedProcessDirs(maxAgeMs: number): Promise<void> {
  try {
    const processesPath = path.dirname(AGENTS_PATH);
    try {
      await fs.access(processesPath);
    } catch {
      return;
    }
    const entries = await fs.readdir(processesPath, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(processesPath, entry.name);
      try {
        await fs.access(path.join(dirPath, "status.json"));
        const stats = await fs.stat(dirPath);
        if (now - stats.mtimeMs > maxAgeMs) {
          console.log(`🧹 Cleaning up old process directory: ${entry.name}`);
          await fs.rm(dirPath, { recursive: true, force: true });
        }
      } catch {
        // No status.json or can't stat — skip (e.g. the agents/ subdir)
      }
    }
  } catch (error) {
    console.error(`❌ Error during managed process dir cleanup:`, error);
  }
}

/** Remove execCommand background log files (.knowhow/processes/*.txt) older than maxAgeMs. */
export async function cleanupOldProcessLogs(maxAgeMs: number): Promise<void> {
  try {
    const processesPath = path.dirname(AGENTS_PATH);
    try {
      await fs.access(processesPath);
    } catch {
      return;
    }
    const entries = await fs.readdir(processesPath, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".txt")) continue;
      const logPath = path.join(processesPath, entry.name);
      try {
        const stats = await fs.stat(logPath);
        if (now - stats.mtimeMs > maxAgeMs) {
          console.log(`🧹 Cleaning up old process log file: ${entry.name}`);
          await fs.rm(logPath, { force: true });
        }
      } catch (error) {
        console.error(`❌ Error cleaning up log ${entry.name}:`, error);
      }
    }
  } catch (error) {
    console.error(`❌ Error during process log cleanup:`, error);
  }
}

/** Remove agent task directories older than `retention.tasks` (default 3 days), then the other process leftovers. */
export async function cleanupOldTasks(): Promise<void> {
  const maxAgeMs = getTaskRetentionMs();
  try {
    try {
      await fs.access(AGENTS_PATH);
    } catch {
      return;
    }
    const entries = await fs.readdir(AGENTS_PATH, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskPath = path.join(AGENTS_PATH, entry.name);
      try {
        const stats = await fs.stat(taskPath);
        if (now - stats.mtimeMs > maxAgeMs) {
          console.log(`🧹 Cleaning up old task directory: ${entry.name}`);
          await fs.rm(taskPath, { recursive: true, force: true });
        }
      } catch (error) {
        console.error(`❌ Error cleaning up ${entry.name}:`, error);
      }
    }
    await cleanupOldProcessLogs(maxAgeMs);
    await cleanupOldManagedProcessDirs(maxAgeMs);
  } catch (error) {
    console.error(`❌ Error during cleanup:`, error);
  }
}

/** Start hourly cleanup (once per process; the timer never keeps the process alive). */
export function startAgentTaskCleanup(): void {
  if (started) return;
  started = true;
  interval = setInterval(() => void cleanupOldTasks(), 60 * 60 * 1000);
  interval.unref?.();
  void cleanupOldTasks();
}

export function stopAgentTaskCleanup(): void {
  if (interval) clearInterval(interval);
  interval = null;
  started = false;
}
