/**
 * The one learned store: things the user confirmed ("yes") for any recoverer,
 * persisted as `{ [recovererName]: string[] }` in ~/.knowhow/voice/learned.json.
 *
 * Migrates the two older files on first load (when learned.json doesn't exist):
 *   ~/.knowhow/voice-learned-intents.json   { tmuxPrefixes: [...] }  → "tmux"
 *   ~/.knowhow/voice-app-aliases.json       { spoken: app }          → "app-name" ("spoken=>app")
 * The old files are left in place.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";

export const LEARNED_FILE =
  process.env.KNOWHOW_VOICE_LEARNED_FILE ?? join(homedir(), ".knowhow", "voice", "learned.json");
export const LEGACY_INTENTS_FILE =
  process.env.KNOWHOW_VOICE_LEARNED_INTENTS_FILE ?? join(homedir(), ".knowhow", "voice-learned-intents.json");
export const LEGACY_APP_ALIASES_FILE =
  process.env.KNOWHOW_VOICE_APP_ALIASES_FILE ?? join(homedir(), ".knowhow", "voice-app-aliases.json");

export type LearnedData = Record<string, string[]>;

export interface LearnedStoreOptions {
  /** Store file (default ~/.knowhow/voice/learned.json). */
  file?: string;
  /** Old `{tmuxPrefixes}` file to migrate (default: the real one only when `file` is the default). */
  legacyIntentsFile?: string | null;
  /** Old `{spoken: app}` file to migrate (same default rule). */
  legacyAppAliasesFile?: string | null;
  /** Write to disk on add/migrate (tests turn this off). */
  persist?: boolean;
}

export class LearnedStore {
  readonly file: string;
  private readonly legacyIntents?: string;
  private readonly legacyAliases?: string;
  private readonly persist: boolean;
  private data: Map<string, Set<string>> | undefined;

  constructor(opts: LearnedStoreOptions = {}) {
    const isDefault = opts.file === undefined;
    this.file = opts.file ?? LEARNED_FILE;
    this.legacyIntents = opts.legacyIntentsFile === undefined ? (isDefault ? LEGACY_INTENTS_FILE : undefined) : opts.legacyIntentsFile ?? undefined;
    this.legacyAliases = opts.legacyAppAliasesFile === undefined ? (isDefault ? LEGACY_APP_ALIASES_FILE : undefined) : opts.legacyAppAliasesFile ?? undefined;
    this.persist = opts.persist ?? true;
  }

  private load(): Map<string, Set<string>> {
    if (this.data) return this.data;
    const data = (this.data = new Map<string, Set<string>>());
    const put = (name: string, key: string) => {
      if (!key) return;
      if (!data.has(name)) data.set(name, new Set());
      data.get(name)!.add(key);
    };
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
        for (const [name, keys] of Object.entries(parsed)) {
          if (Array.isArray(keys)) for (const k of keys) if (typeof k === "string") put(name, k);
        }
        return data;
      }
    } catch { /* corrupt file: start fresh */ }
    let migrated = false;
    try {
      if (this.legacyIntents && existsSync(this.legacyIntents)) {
        const old = JSON.parse(readFileSync(this.legacyIntents, "utf8")) as { tmuxPrefixes?: string[] };
        for (const p of old.tmuxPrefixes ?? []) { put("tmux", String(p).toLowerCase()); migrated = true; }
      }
    } catch { /* ignore */ }
    try {
      if (this.legacyAliases && existsSync(this.legacyAliases)) {
        const old = JSON.parse(readFileSync(this.legacyAliases, "utf8")) as Record<string, unknown>;
        for (const [spoken, app] of Object.entries(old)) {
          if (typeof app === "string" && spoken) { put("app-name", `${spoken}=>${app}`); migrated = true; }
        }
      }
    } catch { /* ignore */ }
    if (migrated && this.persist) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, this.serialise(), "utf8");
      } catch { /* best effort */ }
    }
    return data;
  }

  private serialise(): string {
    const out: LearnedData = {};
    for (const [name, set] of this.load()) out[name] = [...set].sort();
    return JSON.stringify(out, null, 2) + "\n";
  }

  has(recoverer: string, key: string): boolean {
    return this.load().get(recoverer)?.has(key) ?? false;
  }

  list(recoverer: string): string[] {
    return [...(this.load().get(recoverer) ?? [])];
  }

  /** Everything, `{ [recovererName]: string[] }`. */
  all(): LearnedData {
    const out: LearnedData = {};
    for (const [name, set] of this.load()) out[name] = [...set].sort();
    return out;
  }

  /** Remember `key` for `recoverer` (after the user said "yes"). */
  async add(recoverer: string, key: string): Promise<void> {
    const k = key.trim();
    if (!k) return;
    const data = this.load();
    if (!data.has(recoverer)) data.set(recoverer, new Set());
    const set = data.get(recoverer)!;
    if (set.has(k)) return;
    set.add(k);
    if (!this.persist) return;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, this.serialise(), "utf8");
    } catch { /* best effort */ }
  }

  /** Replace the in-memory contents (tests); nothing is written. */
  reset(seed: LearnedData = {}): void {
    this.data = new Map(Object.entries(seed).map(([name, keys]) => [name, new Set(keys)]));
  }
}
