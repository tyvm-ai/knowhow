/**
 * Third-party contributions: modules extend voice-control through the core
 * extension registry (`services().Extensions`), with two typed extension points:
 *
 *   "voice-control.app-adapter"  an `AppAdapter` (name + app regex required, unique name)
 *   "voice-control.pack"         a whole `VoicePack` (`packExtension(defineVoicePack({...}))`)
 *
 * (plus the long-standing "voice-control.command" for a single command).
 *
 * `defineVoiceExtensionPoints(Extensions)` declares both with validators so a
 * bad contribution is rejected at registration. Because a third-party module can
 * load *before* voice-control declares the points, `readContributions` validates
 * again when a session starts (invalid ones are skipped with a warning).
 * `VoiceSession` calls `readContributions` + `applyContributions`.
 */

import type { ExtensionPoint, ExtensionsService } from "@tyvm/knowhow/sdk";
import { VOICE_PACK_EXTENSION } from "./commands/define";
import { registerPackNormalisers, registerPackSlots } from "./packs/define";
import type { AnyVoicePack } from "./packs/define";
import type { VoiceServices } from "./services";
import type { ExtensionsLike } from "./voiceCommands";
import { APP_ADAPTER_EXTENSION } from "./targeting/adapter";
import type { AppAdapter } from "./targeting/adapter";

export { APP_ADAPTER_EXTENSION };

export type AppAdapterExtension = AppAdapter & { type: typeof APP_ADAPTER_EXTENSION; [key: string]: unknown };
export type VoicePackExtension = AnyVoicePack & { type: typeof VOICE_PACK_EXTENSION; [key: string]: unknown };

/** Wrap a defined pack so a module can list it in `extensions`. */
export function packExtension(pack: AnyVoicePack): VoicePackExtension {
  return { ...pack, type: VOICE_PACK_EXTENSION };
}

/** Wrap an adapter so a module can list it in `extensions`. */
export function adapterExtension(adapter: AppAdapter): AppAdapterExtension {
  return { ...adapter, type: APP_ADAPTER_EXTENSION };
}

/** Problem string, or undefined when `ext` is a valid app-adapter contribution. */
export function validateAppAdapter(ext: unknown, existing: readonly unknown[] = []): string | undefined {
  const a = ext as Partial<AppAdapter> | undefined;
  if (!a || typeof a !== "object") return "not an object";
  if (typeof a.name !== "string" || !a.name.trim()) return "missing name";
  if (!(a.app instanceof RegExp)) return `adapter "${a.name}": app must be a RegExp matching the front app name`;
  if (existing.some((e) => (e as AppAdapter)?.name === a.name)) return `duplicate adapter name "${a.name}"`;
  return undefined;
}

/** Problem string, or undefined when `ext` is a valid pack contribution. */
export function validatePack(ext: unknown, existing: readonly unknown[] = [], reserved: ReadonlySet<string> = new Set()): string | undefined {
  const p = ext as Partial<AnyVoicePack> | undefined;
  if (!p || typeof p !== "object") return "not an object";
  if (typeof p.name !== "string" || !p.name.trim()) return "missing name";
  if (!Array.isArray(p.extensions)) return `pack "${p.name}": missing extensions (build it with defineVoicePack)`;
  if (reserved.has(p.name)) return `pack name "${p.name}" is already used by a shipped pack`;
  if (existing.some((e) => (e as AnyVoicePack)?.name === p.name)) return `duplicate pack name "${p.name}"`;
  return undefined;
}

let shippedPackNames: ReadonlySet<string> | undefined;
function reservedPackNames(): ReadonlySet<string> {
  if (!shippedPackNames) {
    // required lazily: packs/index pulls every shipped pack
    shippedPackNames = new Set((require("./packs/index") as typeof import("./packs/index")).allPacks().map((p) => p.name));
  }
  return shippedPackNames;
}

/** The typed extension points (declared on core's registry so bad contributions are rejected up front). */
export interface VoiceExtensionPoints {
  adapters: ExtensionPoint<AppAdapterExtension>;
  packs: ExtensionPoint<VoicePackExtension>;
}

export function defineVoiceExtensionPoints(extensions: Pick<ExtensionsService, "defineExtensionPoint">): VoiceExtensionPoints {
  return {
    adapters: extensions.defineExtensionPoint<AppAdapterExtension>(APP_ADAPTER_EXTENSION, {
      validate: (ext, existing) => validateAppAdapter(ext, existing),
    }),
    packs: extensions.defineExtensionPoint<VoicePackExtension>(VOICE_PACK_EXTENSION, {
      validate: (ext, existing) => validatePack(ext, existing),
    }),
  };
}

export interface Contributions {
  adapters: AppAdapter[];
  packs: AnyVoicePack[];
  /** One line per skipped contribution. */
  problems: string[];
}

/** Read + validate every adapter and pack contributed through `extensions`. */
export function readContributions(extensions: ExtensionsLike | null | undefined): Contributions {
  const out: Contributions = { adapters: [], packs: [], problems: [] };
  if (!extensions) return out;
  for (const item of extensions.list(APP_ADAPTER_EXTENSION)) {
    if ((item as { type?: string })?.type !== APP_ADAPTER_EXTENSION) continue;
    const problem = validateAppAdapter(item, out.adapters);
    if (problem) out.problems.push(`ignoring ${APP_ADAPTER_EXTENSION} extension${ownerOf(item)}: ${problem}`);
    else out.adapters.push(item as AppAdapter);
  }
  const reserved = reservedPackNames();
  for (const item of extensions.list(VOICE_PACK_EXTENSION)) {
    if ((item as { type?: string })?.type !== VOICE_PACK_EXTENSION) continue;
    const problem = validatePack(item, out.packs, reserved);
    if (problem) out.problems.push(`ignoring ${VOICE_PACK_EXTENSION} extension${ownerOf(item)}: ${problem}`);
    else out.packs.push(item as AnyVoicePack);
  }
  return out;
}

function ownerOf(item: unknown): string {
  const owner = (item as { owner?: unknown })?.owner;
  return typeof owner === "string" && owner ? ` from ${owner}` : "";
}

/**
 * Hook the contributions into one session: adapters → `services.adapters`,
 * pack slot types + normaliser rules → the grammar. (Commands are collected by
 * `collectVoiceCommands`, lifecycle by `PackRuntime`, recoverers by the engine.)
 */
export function applyContributions(services: Pick<VoiceServices, "adapters" | "log">, contributions: Contributions): void {
  for (const problem of contributions.problems) services.log.warn(problem);
  for (const adapter of contributions.adapters) services.adapters.register(adapter);
  registerPackSlots(contributions.packs);
  registerPackNormalisers(contributions.packs);
}
