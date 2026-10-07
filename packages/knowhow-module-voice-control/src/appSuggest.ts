/**
 * "Did you mean Ghostty?" — suggest a correction when a command's {app}
 * slot doesn't name a running app but sounds like one ("maximize ghosting").
 *
 * Flow:
 *   1. checkAppSlot() resolves the spoken name against running apps and the
 *      alias table. A clean match → run the command as usual.
 *   2. A near miss → the command is held as a pending action and the user is
 *      asked to say "yes"/"confirm" (or "no"/"cancel").
 *   3. Accepting runs the command with the corrected app and remembers the
 *      mishearing (~/.knowhow/voice-app-aliases.json), so next time
 *      "ghosting" maps straight to Ghostty.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";
import { spawnOsa } from "./actions/osa";
import { APP_ALIASES } from "./grammar/slots";
import { setPending, peekPending, clearPending, PendingAction } from "./pendingAction";

export const LEARNED_APP_ALIASES_FILE =
  process.env.KNOWHOW_VOICE_APP_ALIASES_FILE ?? join(homedir(), ".knowhow", "voice-app-aliases.json");

/** Similarity needed before we suggest anything (0..1). */
export const APP_SUGGEST_MIN_SCORE = 0.55;
/** A pending suggestion is dropped after this long. */
export const APP_SUGGEST_TTL_MS = 20_000;

// ─── Learned aliases ────────────────────────────────────────────────────────

let _learnedLoaded = false;

/** Load learned mishearings into APP_ALIASES (idempotent). */
export function loadLearnedAppAliases(file = LEARNED_APP_ALIASES_FILE): Record<string, string> {
  if (_learnedLoaded && file === LEARNED_APP_ALIASES_FILE) return {};
  if (file === LEARNED_APP_ALIASES_FILE) _learnedLoaded = true;
  try {
    if (!existsSync(file)) return {};
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    for (const [spoken, app] of Object.entries(data)) {
      if (typeof app === "string" && spoken && !(spoken in APP_ALIASES)) APP_ALIASES[spoken] = app;
    }
    return data;
  } catch {
    return {};
  }
}

export async function learnAppAlias(spoken: string, app: string, file = LEARNED_APP_ALIASES_FILE): Promise<void> {
  const key = normaliseName(spoken);
  if (!key || normaliseName(app) === key) return;
  APP_ALIASES[key] = app;
  if (process.env.NODE_ENV === "test" && file === LEARNED_APP_ALIASES_FILE) return;
  let data: Record<string, string> = {};
  try {
    if (existsSync(file)) data = JSON.parse(readFileSync(file, "utf8"));
  } catch { /* start fresh */ }
  data[key] = app;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch { /* best effort */ }
}

// ─── Fuzzy matching ─────────────────────────────────────────────────────────

function normaliseName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Rough "sounds like" squash: drop vowels after the first letter, collapse repeats. */
function skeleton(s: string): string {
  const x = s.replace(/\s+/g, "").replace(/ph/g, "f").replace(/ck/g, "k").replace(/[yw]/g, "i");
  return (x[0] ?? "") + x.slice(1).replace(/[aeiou]/g, "").replace(/(.)\1+/g, "$1");
}

/** 0..1 similarity between a spoken name and a candidate app name. */
export function appNameSimilarity(spoken: string, candidate: string): number {
  const a = normaliseName(spoken).replace(/\s+/g, "");
  const b = normaliseName(candidate).replace(/\s+/g, "");
  if (!a || !b) return 0;
  if (a === b) return 1;
  const edit = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  const prefixScore = prefix >= 3 ? (prefix / Math.min(a.length, b.length)) * 0.9 : 0;
  const sa = skeleton(a), sb = skeleton(b);
  const sound = sa.length >= 2 && sb.length >= 2 ? (1 - levenshtein(sa, sb) / Math.max(sa.length, sb.length)) * 0.9 : 0;
  return Math.max(edit, prefixScore, sound);
}

export interface AppSuggestion {
  app: string;
  score: number;
  /** What it was compared against (an alias like "ghosty", or the app name). */
  via: string;
}

/**
 * Best app for a spoken name among running apps and known aliases. Multi-word
 * app names are also compared word by word ("chrom" ≈ "Google Chrome").
 */
export function suggestApp(spoken: string, runningApps: string[], aliases: Record<string, string> = APP_ALIASES): AppSuggestion | undefined {
  const running = new Set(runningApps.map((n) => n.toLowerCase()));
  const pool: Array<{ name: string; app: string }> = [];
  for (const app of runningApps) {
    pool.push({ name: app, app });
    const words = normaliseName(app).split(" ");
    if (words.length > 1) for (const w of words) if (w.length >= 4) pool.push({ name: w, app });
  }
  for (const [alias, app] of Object.entries(aliases)) {
    // Prefer aliases that point at something running (or when we can't tell).
    const runningName = runningApps.find((n) => n.toLowerCase() === app.toLowerCase())
      ?? runningApps.find((n) => n.toLowerCase().startsWith(app.toLowerCase()) || app.toLowerCase().startsWith(n.toLowerCase()));
    if (runningApps.length && !runningName) continue;
    pool.push({ name: alias, app: runningName ?? app });
  }
  let best: AppSuggestion | undefined;
  for (const { name, app } of pool) {
    const score = appNameSimilarity(spoken, name) + (running.has(app.toLowerCase()) ? 0.001 : 0);
    if (!best || score > best.score) best = { app, score, via: name };
  }
  return best && best.score >= APP_SUGGEST_MIN_SCORE ? best : undefined;
}

/** True when `spoken` already names a running app (exact, prefix, or word match). */
export function namesRunningApp(spoken: string, runningApps: string[]): boolean {
  const want = normaliseName(spoken);
  if (!want) return false;
  return runningApps.some((n) => {
    const l = normaliseName(n);
    return l === want || l.startsWith(want) || l.split(" ").includes(want) || (want.length >= 4 && l.includes(want));
  });
}

// ─── Command gate ───────────────────────────────────────────────────────────

export interface AppSlotCheck {
  /** "ok": run as-is. "suggested": held for confirmation. */
  status: "ok" | "suggested";
  suggestion?: AppSuggestion;
}

export interface AppSlotCheckOptions {
  spoken: string;
  /** Text of the command for the prompt, e.g. "maximize ghosting". */
  commandText: string;
  listRunningApps?: () => Promise<string[]>;
  /** Re-run the command with the corrected app. */
  rerun: (app: string) => Promise<void>;
  log: (msg: string) => void;
  notify?: (title: string, message: string) => void;
  /** Accept names of installed (not running) apps, for commands that launch. */
  allowInstalled?: boolean;
}

let _installed: { at: number; names: Set<string> } | undefined;

/** Case-insensitive check against /Applications and /System/Applications (cached 60 s). */
export function isInstalledApp(name: string): boolean {
  if (process.platform !== "darwin") return false;
  if (!_installed || Date.now() - _installed.at > 60_000) {
    const names = new Set<string>();
    for (const dir of ["/Applications", "/System/Applications", "/System/Applications/Utilities", join(homedir(), "Applications")]) {
      try {
        for (const f of readdirSync(dir)) {
          if (f.endsWith(".app")) names.add(normaliseName(f.slice(0, -4)));
        }
      } catch { /* missing dir */ }
    }
    _installed = { at: Date.now(), names };
  }
  const want = normaliseName(name);
  if (_installed.names.has(want)) return true;
  for (const n of _installed.names) if (n.split(" ").includes(want)) return true;
  return false;
}

/**
 * Check a command's {app} slot. Returns "suggested" (and registers a pending
 * confirm) when the name isn't a running app but closely resembles one.
 */
export async function checkAppSlot(opts: AppSlotCheckOptions): Promise<AppSlotCheck> {
  loadLearnedAppAliases();
  const spoken = opts.spoken.trim();
  if (!spoken || !opts.listRunningApps) return { status: "ok" };
  let running: string[] = [];
  try {
    running = await opts.listRunningApps();
  } catch {
    return { status: "ok" };
  }
  if (!running.length || namesRunningApp(spoken, running)) return { status: "ok" };
  // Installed but not running ("open spotify") — let the command launch it.
  if (opts.allowInstalled && isInstalledApp(spoken)) return { status: "ok" };

  const suggestion = suggestApp(spoken, running);
  if (!suggestion || normaliseName(suggestion.app) === normaliseName(spoken)) return { status: "ok" };

  const corrected = replaceWord(opts.commandText, spoken, suggestion.app);
  const describe = `${corrected} (heard "${spoken}")`;
  const pending: PendingAction = {
    describe,
    accept: async () => {
      opts.log(`[voice] using ${suggestion.app} for "${spoken}" (remembered for next time)`);
      await learnAppAlias(spoken, suggestion.app);
      await opts.rerun(suggestion.app);
    },
    reject: () => {
      opts.log(`[voice] ok, not running "${corrected}"`);
    },
  };
  setPending(pending);
  const timer = setTimeout(() => {
    if (peekPending() === pending) clearPending();
  }, APP_SUGGEST_TTL_MS);
  timer.unref?.();

  const prompt = `No running app called "${spoken}". Did you mean ${suggestion.app}? Say "yes" to run "${corrected}", or "no".`;
  opts.log(`[voice] ${prompt}`);
  (opts.notify ?? notifyMac)("Voice: did you mean…?", `${corrected} — say "yes" or "no"`);
  return { status: "suggested", suggestion };
}

function replaceWord(text: string, word: string, replacement: string): string {
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const cleaned = text.replace(/[.!?]+$/, "");
  return re.test(cleaned) ? cleaned.replace(re, replacement) : `${cleaned} → ${replacement}`;
}

/** Non-blocking macOS notification (no shell; text passed as an argument). */
export function notifyMac(title: string, message: string): void {
  if (process.platform !== "darwin" || process.env.NODE_ENV === "test") return;
  const script = `on run argv
display notification (item 2 of argv) with title (item 1 of argv)
end run`;
  try {
    const child = spawnOsa("applescript", script, { args: [title, message] });
    child.unref?.();
  } catch { /* ignore */ }
}
