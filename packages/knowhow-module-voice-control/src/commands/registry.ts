/**
 * Command registry validation (pure — no I/O).
 *
 *  - `applyOverrides`: drop commands that another command declares it
 *    replaces via `overrides: "<name>"`.
 *  - `analyzeCommands`: report duplicate names, phrases/patterns claimed by
 *    more than one command, and slot types the grammar doesn't know.
 *
 * Reports are data, not exceptions: a conflicting registry still runs (first
 * command wins ties), `voice-control commands --conflicts` shows the report.
 */

import type { VoiceCommandExtension } from "../voiceCommands";
import { expandPhraseSynonyms } from "../grammar/compile";
import { compilePattern } from "../grammar/compile";
import type { PatternToken } from "../grammar/compile";
import { getSlotMatcher } from "../grammar/slots";
import { literalPatterns } from "./define";

export type CommandConflictKind = "duplicate-name" | "phrase" | "pattern" | "unknown-slot-type";

export interface CommandConflict {
  kind: CommandConflictKind;
  /** The shared phrase / pattern / slot type (or name for duplicate-name). */
  key: string;
  /** Names of the commands involved, in priority order. */
  commands: string[];
  message: string;
}

/** Lower-case, strip punctuation, collapse whitespace ("Double-click." → "double click"). */
export function normaliseSpoken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Remove commands that another command `overrides`. */
export function applyOverrides<T extends VoiceCommandExtension>(commands: readonly T[]): { commands: T[]; overridden: string[] } {
  const overridden = new Set<string>();
  for (const c of commands) {
    if (typeof c.overrides === "string" && c.overrides && c.overrides !== c.name) overridden.add(c.overrides);
  }
  return {
    commands: commands.filter((c) => !overridden.has(c.name)),
    overridden: [...overridden],
  };
}

/** Every plain spoken form a command answers to (phrase, aliases, literal patterns, + synonym variants). */
export function spokenForms(command: VoiceCommandExtension): string[] {
  const forms = new Set<string>();
  const base = [command.phrase, ...(command.aliases ?? []), ...literalPatterns(command.patterns), ...literalPatterns(command.pattern ? [command.pattern] : [])];
  for (const phrase of base) {
    if (typeof phrase !== "string" || !phrase.trim()) continue;
    for (const variant of expandPhraseSynonyms(normaliseSpoken(phrase), command.synonyms)) forms.add(variant);
  }
  return [...forms];
}

function slotPatterns(command: VoiceCommandExtension): string[] {
  const all = [...(command.patterns ?? []), ...(typeof command.pattern === "string" ? [command.pattern] : [])];
  return all.filter((p) => p.trim() && !literalPatterns([p]).length);
}

function appContexts(command: VoiceCommandExtension): string[] | undefined {
  const app = command.context?.app;
  if (!app) return undefined;
  return (Array.isArray(app) ? app : [app]).map((a) => a.toLowerCase()).sort();
}

/** Two commands can only conflict if they can be active at once. */
function coexist(a: VoiceCommandExtension, b: VoiceCommandExtension): boolean {
  if (a.platforms?.length && b.platforms?.length && !a.platforms.some((p) => b.platforms!.includes(p))) return false;
  const ca = appContexts(a);
  const cb = appContexts(b);
  // An app-scoped command intentionally wins over a global one in that app.
  if (!!ca !== !!cb) return false;
  if (ca && cb && !ca.some((x) => cb.includes(x))) return false;
  return true;
}

function slotTypesOf(tokens: PatternToken[], out: Set<string>): void {
  for (const t of tokens) {
    if (t.kind === "slot") out.add(t.type);
    else if (t.kind === "optional") t.tokens.forEach((seq) => slotTypesOf(seq, out));
    else if (t.kind === "alt") t.alternatives.forEach((seq) => slotTypesOf(seq, out));
  }
}

/**
 * Find registry problems among `commands` (already de-duplicated by name and
 * with overrides applied — pass `duplicateNames` from the collector).
 */
export function analyzeCommands(
  commands: readonly VoiceCommandExtension[],
  duplicateNames: readonly string[] = [],
): CommandConflict[] {
  const conflicts: CommandConflict[] = [];

  for (const name of duplicateNames) {
    conflicts.push({
      kind: "duplicate-name",
      key: name,
      commands: [name, name],
      message: `command name "${name}" is registered more than once (first wins); set \`overrides\` to make it intentional`,
    });
  }

  // phrase / pattern ownership
  const phraseOwners = new Map<string, VoiceCommandExtension[]>();
  const patternOwners = new Map<string, VoiceCommandExtension[]>();
  for (const c of commands) {
    for (const form of spokenForms(c)) {
      const owners = phraseOwners.get(form) ?? [];
      owners.push(c);
      phraseOwners.set(form, owners);
    }
    for (const p of slotPatterns(c)) {
      const key = p.trim().toLowerCase().replace(/\s+/g, " ");
      const owners = patternOwners.get(key) ?? [];
      owners.push(c);
      patternOwners.set(key, owners);
    }
  }
  const report = (kind: "phrase" | "pattern", map: Map<string, VoiceCommandExtension[]>) => {
    for (const [key, owners] of map) {
      const distinct = owners.filter((c, i) => owners.findIndex((o) => o.name === c.name) === i);
      if (distinct.length < 2) continue;
      const clashing = distinct.filter((c, i) => distinct.some((o, j) => j !== i && coexist(c, o)));
      if (clashing.length < 2) continue;
      conflicts.push({
        kind,
        key,
        commands: clashing.map((c) => c.name),
        message: `${kind} "${key}" is claimed by ${clashing.map((c) => c.name).join(", ")}; set \`overrides\` on the one that should win`,
      });
    }
  };
  report("phrase", phraseOwners);
  report("pattern", patternOwners);

  // unknown slot types
  for (const c of commands) {
    const types = new Set<string>();
    for (const p of slotPatterns(c)) {
      try {
        slotTypesOf(compilePattern(p), types);
      } catch (e) {
        conflicts.push({ kind: "unknown-slot-type", key: p, commands: [c.name], message: `pattern "${p}" in ${c.name} does not compile: ${e}` });
      }
    }
    for (const type of types) {
      if (!getSlotMatcher(type)) {
        conflicts.push({
          kind: "unknown-slot-type",
          key: type,
          commands: [c.name],
          message: `${c.name} uses slot type "${type}" which is not registered`,
        });
      }
    }
  }
  return conflicts;
}

/** Human-readable report. */
export function formatConflicts(conflicts: readonly CommandConflict[]): string {
  if (!conflicts.length) return "No voice command conflicts.\n";
  return `${conflicts.length} voice command conflict(s):\n${conflicts.map((c) => `  [${c.kind}] ${c.message}`).join("\n")}\n`;
}
