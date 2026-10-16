/**
 * "Did you mean Ghostty?" — the `app-name` recoverer.
 *
 * When a matched command's {app} slot doesn't name a running app but sounds
 * like one ("maximize ghosting"), the recoverer proposes the rewritten command
 * ("maximize ghostty"). The RecoveryEngine asks "yes"/"no" (never auto-runs a
 * guess), runs it on "yes" and remembers the mishearing in the shared learned
 * store (`app-name`: "ghosting=>ghostty"), after which "ghosting" maps straight
 * to Ghostty through the grammar's APP_ALIASES.
 */

import { readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawnOsa } from "./actions/osa";
import { APP_ALIASES, addLearnedAppAlias } from "./grammar/slots";
import type { IntentRecoverer, RecoveryResult } from "./recovery/types";

/** Similarity needed before we suggest anything (0..1). */
export const APP_SUGGEST_MIN_SCORE = 0.55;
/** A pending suggestion is dropped after this long. */
export const APP_SUGGEST_TTL_MS = 20_000;

// ─── Per-session state ──────────────────────────────────────────────────────

/**
 * Per-session app-suggest state: whether the learned aliases are loaded and
 * the installed-apps cache (`services.appSuggest`).
 */
export class AppSuggestState {
  installed: { at: number; names: Set<string> } | undefined;
  /** Desktop notification when a suggestion is asked (tests inject a no-op). */
  readonly notify: (title: string, message: string) => void;

  constructor(opts: { notify?: (title: string, message: string) => void } = {}) {
    this.notify = opts.notify ?? notifyMac;
  }

  /** Case-insensitive check against /Applications and /System/Applications (cached 60 s). */
  isInstalledApp(name: string, now = Date.now()): boolean {
    if (process.platform !== "darwin") return false;
    if (!this.installed || now - this.installed.at > 60_000) {
      const names = new Set<string>();
      for (const dir of ["/Applications", "/System/Applications", "/System/Applications/Utilities", join(homedir(), "Applications")]) {
        try {
          for (const f of readdirSync(dir)) {
            if (f.endsWith(".app")) names.add(normaliseName(f.slice(0, -4)));
          }
        } catch { /* missing dir */ }
      }
      this.installed = { at: now, names };
    }
    const want = normaliseName(name);
    if (this.installed.names.has(want)) return true;
    for (const n of this.installed.names) if (n.split(" ").includes(want)) return true;
    return false;
  }
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

// ─── The recoverer ──────────────────────────────────────────────────────────

export const APP_NAME_RECOVERER = "app-name";

/** Learned-store key for "spoken" meaning "app". */
export function appAliasKey(spoken: string, app: string): string {
  return `${normaliseName(spoken)}=>${app}`;
}

/** Commands whose app may be installed-but-not-running (they launch it). */
const LAUNCHING_COMMAND = /focus|open|switch|launch/;

export const appNameRecoverer: IntentRecoverer = {
  name: APP_NAME_RECOVERER,
  stage: "matched",
  onLearned(key) {
    const [spoken, app] = key.split("=>");
    if (spoken && app) addLearnedAppAlias(spoken, app);
  },
  async recover({ text, match }, { services }): Promise<RecoveryResult | undefined> {
    const spoken = typeof match?.slots.app === "string" ? match.slots.app.trim() : "";
    const listRunningApps = services.platform?.listRunningApps;
    if (!match || !spoken || !listRunningApps) return undefined;
    let running: string[] = [];
    try {
      running = await listRunningApps.call(services.platform);
    } catch {
      return undefined;
    }
    if (!running.length || namesRunningApp(spoken, running)) return undefined;
    // Installed but not running ("open spotify") — let the command launch it.
    if (LAUNCHING_COMMAND.test(match.command) && services.appSuggest.isInstalledApp(spoken, services.clock.now())) return undefined;

    const suggestion = suggestApp(spoken, running);
    if (!suggestion || normaliseName(suggestion.app) === normaliseName(spoken)) return undefined;
    const corrected = replaceWord(text, spoken, suggestion.app);
    if (!corrected) return undefined;
    return {
      kind: "rewrite",
      text: corrected,
      confidence: "low",
      learnKey: appAliasKey(spoken, suggestion.app),
      prompt: `No running app called "${spoken}". Did you mean ${suggestion.app}? Say "yes" to run "${corrected}", or "no".`,
      describe: `${corrected} (heard "${spoken}")`,
      onAsk: () => services.appSuggest.notify("Voice: did you mean…?", `${corrected} — say "yes" or "no"`),
    };
  },
};

/** `text` with `word` replaced by `replacement`; undefined when `word` isn't in the text. */
function replaceWord(text: string, word: string, replacement: string): string | undefined {
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const cleaned = text.replace(/[.!?]+$/, "");
  return re.test(cleaned) ? cleaned.replace(re, replacement) : undefined;
}

/** Non-blocking macOS notification (no shell; text passed as an argument). */
export function notifyMac(title: string, message: string): void {
  if (process.platform !== "darwin") return;
  const script = `on run argv
display notification (item 2 of argv) with title (item 1 of argv)
end run`;
  try {
    const child = spawnOsa("applescript", script, { args: [title, message] });
    child.unref?.();
  } catch { /* ignore */ }
}
