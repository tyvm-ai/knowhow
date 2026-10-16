/**
 * Periodic cleanup of old agent task directories (.knowhow/processes/agents/*)
 * and old execCommand logs / managed-process dirs (.knowhow/processes/*).
 * Previously a side effect of constructing AgentSyncFs.
 */
import { promises as fs } from "fs";
import * as path from "path";

const AGENTS_PATH = ".knowhow/processes/agents";
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

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

/** Remove agent task directories older than 3 days, then the other process leftovers. */
export async function cleanupOldTasks(): Promise<void> {
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
        if (now - stats.mtimeMs > THREE_DAYS_MS) {
          console.log(`🧹 Cleaning up old task directory: ${entry.name}`);
          await fs.rm(taskPath, { recursive: true, force: true });
        }
      } catch (error) {
        console.error(`❌ Error cleaning up ${entry.name}:`, error);
      }
    }
    await cleanupOldProcessLogs(THREE_DAYS_MS);
    await cleanupOldManagedProcessDirs(THREE_DAYS_MS);
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
