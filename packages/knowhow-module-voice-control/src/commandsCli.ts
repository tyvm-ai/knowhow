/**
 * `knowhow voice-control commands` — list every voice command the voice-agent
 * would recognise: built-ins, module extensions, knowhow.json, and live
 * automation phrases registered with the eye-tracking hub.
 */

import { homedir } from "os";
import { join, resolve as resolvePath } from "path";
import type { VoiceCommandSpec } from "./voiceHub";
import { resolveHubUrl } from "./voiceHub";
import {
  ExtensionsLike,
  VOICE_COMMAND_EXTENSION,
  collectVoiceCommands,
  commandRows,
  formatVoiceCommandsTable,
  readKnowhowConfig,
  RegisteredVoiceCommand,
} from "./voiceCommands";

/** Live hub phrases, or undefined when the hub is unreachable. */
export async function fetchLiveHubCommands(
  hubUrl = resolveHubUrl(),
  timeoutMs = 800,
): Promise<VoiceCommandSpec[] | undefined> {
  try {
    const res = await fetch(`${hubUrl}/api/voice/commands`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const data = await res.json() as { specs?: VoiceCommandSpec[] };
    return Array.isArray(data.specs) ? data.specs : [];
  } catch {
    return undefined;
  }
}

function tryCoreExtensions(): ExtensionsLike | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require("@tyvm/knowhow/ts_build/src/services");
    const ext = core.services?.().Extensions;
    return ext && typeof ext.list === "function" ? ext : undefined;
  } catch {
    return undefined;
  }
}

async function configuredModulePaths(config: any): Promise<string[]> {
  const local: string[] = Array.isArray(config?.modules) ? config.modules : [];
  let global: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getGlobalConfig } = require("@tyvm/knowhow/ts_build/src/config");
    const g = await getGlobalConfig();
    global = Array.isArray(g?.modules) ? g.modules : [];
  } catch {
    // no global config
  }
  return [...new Set([...global, ...local])];
}

/**
 * Read `extensions` straight off each configured module's export WITHOUT
 * running register()/init() — cheap and side-effect free for a listing.
 */
export async function readModuleVoiceExtensions(
  modulePaths: string[],
  load: (path: string) => any = (p) => require(p),
): Promise<Array<{ owner: string; extension: unknown }>> {
  const out: Array<{ owner: string; extension: unknown }> = [];
  const searchPaths = [
    join(process.cwd(), ".knowhow", "node_modules"),
    join(homedir(), ".knowhow", "node_modules"),
    join(process.cwd(), "node_modules"),
  ];
  for (const modulePath of modulePaths) {
    let mod: any;
    try {
      if (modulePath.startsWith(".")) {
        mod = load(resolvePath(process.cwd(), modulePath));
      } else {
        let resolved: string | undefined;
        for (const p of searchPaths) {
          try { resolved = require.resolve(modulePath, { paths: [p] }); break; } catch { /* next */ }
        }
        mod = load(resolved ?? modulePath);
      }
    } catch {
      continue;
    }
    const extensions = (mod?.default ?? mod)?.extensions;
    if (!Array.isArray(extensions)) continue;
    for (const extension of extensions) {
      if (extension?.type === VOICE_COMMAND_EXTENSION) out.push({ owner: modulePath, extension });
    }
  }
  return out;
}

export interface VoiceCommandsCliOptions {
  json?: boolean;
}

export interface VoiceCommandsCliDeps {
  config?: unknown;
  extensions?: ExtensionsLike | null;
  moduleExtensions?: Array<{ owner: string; extension: unknown }>;
  live?: VoiceCommandSpec[] | undefined | null;
  write?: (text: string) => void;
}

export async function runVoiceCommandsList(
  options: VoiceCommandsCliOptions = {},
  deps: VoiceCommandsCliDeps = {},
): Promise<{ registered: RegisteredVoiceCommand[]; live?: VoiceCommandSpec[] }> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const config = deps.config ?? readKnowhowConfig();
  const warnings: string[] = [];
  const moduleExtensions = deps.moduleExtensions ??
    await readModuleVoiceExtensions(await configuredModulePaths(config));
  const registered = collectVoiceCommands({
    config,
    extensions: deps.extensions === undefined ? tryCoreExtensions() : deps.extensions,
    moduleExtensions,
    warn: (msg) => warnings.push(msg),
  });
  const live = deps.live === undefined ? await fetchLiveHubCommands() : (deps.live ?? undefined);
  const rows = commandRows(registered, live ?? []);

  if (options.json) {
    write(`${JSON.stringify({ commands: rows, hub: live ? "up" : "down", warnings }, null, 2)}\n`);
  } else {
    write(formatVoiceCommandsTable(rows));
    if (!live) {
      write(`\nNote: eye-tracking hub not reachable at ${resolveHubUrl()} — live automation phrases not shown (start it with \`knowhow eye-tracking\`).\n`);
    }
    for (const w of warnings) write(`warning: ${w}\n`);
  }
  return { registered, live };
}
