import * as fs from "fs";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

const sleepSync = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** O_EXCL lock file holding the owner pid; stale when the pid is dead or the file is old. */
export function tryLock(file: string, waitMs = 0, staleMs = 10 * 60_000): boolean {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e: any) {
      if (e?.code !== "EEXIST") return false;
      try {
        const pid = Number(fs.readFileSync(file, "utf8").trim());
        const age = Date.now() - fs.statSync(file).mtimeMs;
        if ((pid && !pidAlive(pid)) || age > staleMs) {
          fs.rmSync(file, { force: true });
          continue;
        }
      } catch {
        continue; // vanished meanwhile
      }
      if (Date.now() >= deadline) return false;
      sleepSync(25);
    }
  }
}

export function unlock(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}

export function withLock<T>(file: string, waitMs: number, fn: () => T): T | undefined {
  if (!tryLock(file, waitMs)) return undefined;
  try {
    return fn();
  } finally {
    unlock(file);
  }
}
