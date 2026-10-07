/**
 * VoiceStore — the ONE API for runtime state that lives under `~/.knowhow/voice/` (config `store.dir`):
 * learned intents / app aliases (`learned.json`), anything else a pack wants to remember.
 *
 *   store.file("learned.json")            absolute path inside the store directory
 *   store.readJson<T>("x.json", fallback) / store.writeJson("x.json", data)   (sync-safe, never throws on read)
 *   store.memory<T>("map-by-app")         in-process per-session memory (a named Map) — e.g. per-app map memory
 *
 * `memory()` is deliberately not persisted: it is state that must not outlive the session (stale hint numbering).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, isAbsolute, join } from "path";
import type { ConfigResolver } from "../config";
import { STORE_SERVICE_CONFIG } from "../config/services";

export class VoiceStore {
  private readonly memories = new Map<string, Map<string, unknown>>();

  /** `dir` is a fixed directory, or a function (so a config change applies on the next access). */
  constructor(private readonly dir: string | (() => string)) {}

  static fromConfig(config: ConfigResolver): VoiceStore {
    return new VoiceStore(() => config.get({ kind: "services", name: "store" }, "dir", STORE_SERVICE_CONFIG.dir));
  }

  get directory(): string {
    return typeof this.dir === "function" ? this.dir() : this.dir;
  }

  /** Absolute path of a file in the store (absolute names are returned as is). */
  file(name: string): string {
    return isAbsolute(name) ? name : join(this.directory, name);
  }

  readJson<T>(name: string, fallback: T): T {
    const path = this.file(name);
    try {
      if (!existsSync(path)) return fallback;
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  writeJson(name: string, data: unknown): void {
    const path = this.file(name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  }

  async writeJsonAsync(name: string, data: unknown): Promise<void> {
    const path = this.file(name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data, null, 2) + "\n");
  }

  /** A named in-process map (per store instance = per session). */
  memory<T>(name: string): Map<string, T> {
    let m = this.memories.get(name);
    if (!m) {
      m = new Map();
      this.memories.set(name, m);
    }
    return m as Map<string, T>;
  }
}
