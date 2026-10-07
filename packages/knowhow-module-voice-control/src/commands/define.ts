/**
 * `defineCommand` — the ONE factory for voice commands.
 *
 *   const hintsOff = defineCommand({
 *     name: "hints.hide",
 *     patterns: ["hide hints", "clear hints", "hints off"],
 *     description: "Remove the hint labels",
 *     run: async (ctx) => { … },
 *   });
 *
 * - `phrase` defaults to the first pattern (the canonical spoken form).
 * - `aliases` is DERIVED: every literal pattern (no `{slot}`/`[opt]`/`(a|b)`)
 *   other than the phrase becomes an alias, so phrases are written once.
 *   Pass `aliases` only for phrases that aren't patterns.
 * - `pack(prefix, defaults)` binds a namespace + shared defaults for a pack.
 */

import type { VoiceCommandContext, VoiceCommandExtension, VoiceCommandMode } from "../voiceCommands";
import { expandPhraseSynonyms } from "../grammar/compile";

/** Extension type tag (re-exported from voiceCommands.ts; lives here to avoid an import cycle). */
export const VOICE_COMMAND_EXTENSION = "voice-control.command" as const;
/** Extension type under which a module contributes a whole `VoicePack` (commands, slots, normalisers, recoverers, lifecycle). */
export const VOICE_PACK_EXTENSION = "voice-control.pack" as const;

export interface CommandDefinition<Ctx = VoiceCommandContext> {
  /** Unique id. With `pack(prefix)` the prefix is prepended. */
  name: string;
  /** Shown in `knowhow voice-control commands`. */
  description: string;
  run(ctx: Ctx): void | Promise<void>;
  /** Canonical phrase. Defaults to the first pattern. */
  phrase?: string;
  /** Grammar patterns (literals, `[optional]`, `(a|b)`, `{slot:type}`). */
  patterns?: string[];
  /** Single-pattern shorthand. */
  pattern?: string;
  /** Extra literal phrases that are not in `patterns`. */
  aliases?: string[];
  /** Vocabulary synonyms expanded when patterns are compiled. */
  synonyms?: Record<string, string[]>;
  /** Name of the command this one intentionally replaces. */
  overrides?: string;
  /** Only wins over global commands when the frontmost app matches. */
  context?: { app?: string | string[] };
  /** Default ["command"]. */
  modes?: VoiceCommandMode[];
  repeatable?: boolean;
  risk?: "low" | "confirm";
  minVoicedMs?: number;
  maxAudioMs?: number;
  platforms?: NodeJS.Platform[];
  /** Pack-specific fields (kept as-is on the extension). */
  [key: string]: unknown;
}

const NON_LITERAL = /[{}()[\]|]/;

/** Patterns that are plain phrases (no slots, optionals or alternatives). */
export function literalPatterns(patterns: readonly string[] | undefined): string[] {
  return (patterns ?? []).filter((p) => p.trim() && !NON_LITERAL.test(p));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * `phrase` + `aliases` with every synonym variant added ("show hints" →
 * "show map"), minus the phrase itself. Keeps help output, the STT prompt and
 * the plain-phrase matcher in step with the compiled patterns.
 */
export function aliasesWithSynonyms(
  phrase: string,
  aliases: readonly string[],
  synonyms: Record<string, string[]> | undefined,
): string[] {
  if (!synonyms || !Object.keys(synonyms).length) return unique([...aliases]).filter((a) => a !== phrase);
  const out = [...aliases];
  for (const base of [phrase, ...aliases]) out.push(...expandPhraseSynonyms(base, synonyms));
  return unique(out).filter((a) => a !== phrase);
}

export function defineCommand<Ctx = VoiceCommandContext>(def: CommandDefinition<Ctx>): VoiceCommandExtension {
  const { name, description, run, pattern, patterns: rawPatterns, aliases, phrase: rawPhrase, modes, ...rest } = def;
  const patterns = rawPatterns ?? (pattern !== undefined ? [pattern] : undefined);
  const phrase = rawPhrase ?? patterns?.[0];
  if (!name) throw new Error("defineCommand: `name` is required");
  if (!phrase || !phrase.trim()) throw new Error(`defineCommand(${name}): needs a \`phrase\` or at least one pattern`);

  const derived = literalPatterns(patterns).filter((p) => p !== phrase);
  const allAliases = aliasesWithSynonyms(phrase, [...(aliases ?? []), ...derived], rest.synonyms);

  const ext: VoiceCommandExtension = {
    type: VOICE_COMMAND_EXTENSION,
    ...rest,
    name,
    phrase,
    description,
    run: run as VoiceCommandExtension["run"],
    modes: modes ?? ["command"],
  };
  if (patterns) ext.patterns = patterns;
  ext.aliases = allAliases;
  return ext;
}

export interface PackDefaults {
  /** Prepended to every `name` (e.g. "voice-control.keys."). */
  prefix?: string;
  /** Applied to every command unless it sets the same field. */
  defaults?: Partial<Omit<CommandDefinition, "name" | "description" | "run">>;
}

/** Bind a name prefix and shared defaults; returns that pack's `defineCommand`. */
export function pack<Ctx = VoiceCommandContext>(options: PackDefaults = {}) {
  const prefix = options.prefix ?? "";
  return (def: CommandDefinition<Ctx>): VoiceCommandExtension =>
    defineCommand<Ctx>({ ...(options.defaults ?? {}), ...def, name: `${prefix}${def.name}` } as CommandDefinition<Ctx>);
}
