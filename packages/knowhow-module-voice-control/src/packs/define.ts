/**
 * `defineVoicePack` — a pack is a named bundle of voice commands with its own
 * per-session state, slot types, synonyms and lifecycle hooks.
 *
 *   interface TextState { lastTyped?: string }
 *
 *   export const TEXT_PACK = defineVoicePack<TextState>({
 *     name: "text",
 *     prefix: "voice-control.text.",
 *     createState: () => ({}),
 *     commands: ({ command }) => [
 *       command({
 *         name: "type",
 *         patterns: ["type {text:text}"],
 *         description: "Type spoken text",
 *         run: async (ctx) => {
 *           ctx.state.lastTyped = ctx.slots.text as string; // pack state
 *           await ctx.services.platform.typeText(ctx.state.lastTyped);
 *         },
 *       }),
 *     ],
 *     onSessionStop: ({ state }) => { state.lastTyped = undefined; },
 *   });
 *
 * - `createState(services)` runs lazily, once per session (`services.packs`).
 * - Every command's `ctx` gains `ctx.services` (the VoiceServices container)
 *   and `ctx.state` (this pack's state).
 * - `onSessionStart` / `onSessionStop` start/stop timers and watchers via
 *   `services.clock`; `VoiceSession` calls them (see `PackRuntime`).
 * - `commands` may be a plain array of command definitions (names are
 *   prefixed and `defaults` applied) or a function receiving `{ command }`.
 */

import { defineCommand } from "../commands/define";
import type { CommandDefinition } from "../commands/define";
import { registerSlotType } from "../grammar/slots";
import { getDefaultServices } from "../services";
import type { VoiceServices } from "../services";
import type { VoiceCommandContext, VoiceCommandExtension } from "../voiceCommands";

/** The context a pack command's `run` receives: the base ctx plus services + the pack's state. */
export type PackCommandContext<S = void> = VoiceCommandContext & {
  services: VoiceServices;
  state: S;
};

export type VoiceCommandDefinition<S = void> = CommandDefinition<PackCommandContext<S>>;

export interface PackApi<S = void> {
  /** Define a command in this pack (prefix + defaults + state binding applied). */
  command(def: VoiceCommandDefinition<S>): VoiceCommandExtension;
}

export interface PackLifecycleContext<S = void> {
  services: VoiceServices;
  state: S;
  log: VoiceServices["log"];
}

/** A slot type contributed by a pack (registered with the grammar engine). */
export interface SlotTypeDef {
  name: string;
  matcher: Parameters<typeof registerSlotType>[1];
}

export interface VoicePackDefinition<S = void> {
  /** Unique pack name (also the key of its state in `services.packs`). */
  name: string;
  description?: string;
  /** Prepended to every command name, e.g. "voice-control.text.". */
  prefix?: string;
  /** Applied to every command unless it sets the same field. */
  defaults?: Partial<Omit<VoiceCommandDefinition<S>, "name" | "description" | "run">>;
  /** Per-session state; replaces module-level `let` variables. */
  createState?(services: VoiceServices): S;
  commands: VoiceCommandDefinition<S>[] | ((api: PackApi<S>) => VoiceCommandExtension[]);
  /** Slot types to register (instead of a registerXSlot() side effect). */
  slots?: SlotTypeDef[];
  /** Vocabulary synonyms applied to every command of the pack. */
  synonyms?: Record<string, string[]>;
  onSessionStart?(ctx: PackLifecycleContext<S>): void | Promise<void>;
  onSessionStop?(ctx: PackLifecycleContext<S>): void | Promise<void>;
}

/** A defined pack: the definition plus the ready-to-register command extensions. */
export interface VoicePack<S = void> extends VoicePackDefinition<S> {
  /** The command extensions (what `ExtensionsService` registers). */
  readonly extensions: VoiceCommandExtension[];
}

export function defineVoicePack<S = void>(def: VoicePackDefinition<S>): VoicePack<S> {
  const stateful = { name: def.name, createState: def.createState };

  const bind = (command: VoiceCommandDefinition<S>): VoiceCommandExtension => {
    const run = command.run;
    const merged = {
      ...(def.synonyms ? { synonyms: def.synonyms } : {}),
      ...(def.defaults ?? {}),
      ...command,
      name: `${def.prefix ?? ""}${command.name}`,
      pack: def.name,
      run: (ctx: VoiceCommandContext) => {
        const services = ctx.services ?? getDefaultServices();
        return run({ ...ctx, services, state: services.packs.get(stateful) } as PackCommandContext<S>);
      },
    } as CommandDefinition;
    return defineCommand(merged);
  };

  const api: PackApi<S> = { command: bind };
  const extensions = Array.isArray(def.commands) ? def.commands.map(bind) : def.commands(api);
  return { ...def, extensions };
}

/** Anything that looks like a pack (so third-party packs can be run by `PackRuntime` too). */
export type AnyVoicePack = VoicePack<any>;

/** Register every pack's slot types with the grammar engine (idempotent). */
export function registerPackSlots(packs: readonly AnyVoicePack[]): void {
  for (const pack of packs) for (const slot of pack.slots ?? []) registerSlotType(slot.name, slot.matcher);
}

/**
 * Runs pack lifecycle hooks for one session. `start()` calls `onSessionStart`
 * in order; `stop()` calls `onSessionStop` in reverse order and never throws
 * (errors are logged) so one pack can't leave the others' timers running.
 */
export class PackRuntime {
  private started = false;

  constructor(
    private readonly services: VoiceServices,
    private readonly packs: readonly AnyVoicePack[],
  ) {}

  private ctxFor(pack: AnyVoicePack): PackLifecycleContext<any> {
    return {
      services: this.services,
      state: this.services.packs.get(pack),
      log: this.services.log.child(pack.name),
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const pack of this.packs) {
      if (!pack.onSessionStart) continue;
      try {
        await pack.onSessionStart(this.ctxFor(pack));
      } catch (err) {
        this.services.log.warn(`pack "${pack.name}" onSessionStart failed: ${errorMessage(err)}`);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const pack of [...this.packs].reverse()) {
      if (!pack.onSessionStop) continue;
      try {
        await pack.onSessionStop(this.ctxFor(pack));
      } catch (err) {
        this.services.log.warn(`pack "${pack.name}" onSessionStop failed: ${errorMessage(err)}`);
      }
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
