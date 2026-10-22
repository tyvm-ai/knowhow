import * as fs from "fs";
import { homeDir } from "./homeDir";
import * as path from "path";

/**
 * Per-automation JSON key/value persistence for `sdk.store`.
 *
 * Files live at `~/.knowhow/automations-data/<automationName>/<name>.json`.
 * Names are sanitized so a script can never escape its data directory. Writes
 * are atomic (tmp file + rename) and serialized; the initial load is synchronous
 * so `store.get()` is usable immediately.
 */
export interface Store<T> {
  get(): T;
  set(value: T): Promise<void>;
  update(fn: (current: T) => T | void): Promise<void>;
}

export function sanitizeStoreName(name: string): string {
  const safe = String(name ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "_");
  return safe || "_";
}

export function automationDataDir(automationName: string): string {
  return path.join(
    homeDir(),
    ".knowhow",
    "automations-data",
    sanitizeStoreName(automationName)
  );
}

const clone = <V>(v: V): V =>
  v === undefined ? v : (JSON.parse(JSON.stringify(v)) as V);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function createStore<T>(
  automationName: string,
  name: string,
  defaults: T,
  opts: { persist?: () => boolean } = {}
): Store<T> {
  const dir = automationDataDir(automationName);
  const file = path.join(dir, `${sanitizeStoreName(name)}.json`);

  let value: T = clone(defaults);
  try {
    if (fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, "utf8"));
      value =
        isPlainObject(defaults) && isPlainObject(loaded)
          ? ({ ...clone(defaults), ...loaded } as T)
          : (loaded as T);
    }
  } catch {
    // Corrupt file: fall back to defaults (the next set() rewrites it).
    value = clone(defaults);
  }

  let queue: Promise<void> = Promise.resolve();
  let seq = 0;

  const write = (snapshot: string): Promise<void> => {
    const task = queue.then(() => {
      if (opts.persist && !opts.persist()) return;
      // Owner-only: the data dir is 0700 and the file 0600 from creation
      // (mode on write + explicit chmod, so umask/pre-existing files can't loosen it).
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        /* best effort on filesystems without POSIX modes (Windows) */
      }
      const tmp = `${file}.${process.pid}.${Date.now()}.${seq++}.tmp`;
      try {
        fs.writeFileSync(tmp, snapshot, { encoding: "utf8", mode: 0o600 });
        try {
          fs.chmodSync(tmp, 0o600);
        } catch {
          /* best effort on Windows */
        }
        fs.renameSync(tmp, file);
      } catch (e) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        throw e;
      }
    });
    // Keep the chain alive even if one write fails.
    queue = task.catch(() => {});
    return task;
  };

  return {
    get: () => clone(value),
    set: (v: T) => {
      value = clone(v);
      return write(JSON.stringify(value, null, 2));
    },
    update: (fn) => {
      const draft = clone(value);
      const result = fn(draft);
      value = clone(result === undefined ? draft : (result as T));
      return write(JSON.stringify(value, null, 2));
    },
  };
}
