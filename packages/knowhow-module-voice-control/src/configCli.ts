/**
 * `knowhow voice-control config [--json]` — the effective value of every pack / service setting and where it
 * came from (env var, knowhow.json path, or the default).
 */

import { createConfigResolver, formatConfigReport } from "./config";
import type { ConfigReportRow, ConfigResolver } from "./config";
import { allPacks } from "./packs/index";
import type { AnyVoicePack } from "./packs/define";

/** A resolver that knows every service's settings and every pack's `config` schema. */
export function resolverWithPacks(packs: readonly AnyVoicePack[] = allPacks(), base: ConfigResolver = createConfigResolver()): ConfigResolver {
  for (const pack of packs) {
    if (pack.config && Object.keys(pack.config).length) base.register({ kind: "packs", name: pack.name }, pack.config);
  }
  return base;
}

export function configReport(resolver: ConfigResolver = resolverWithPacks()): ConfigReportRow[] {
  return resolver.report();
}

export async function runConfigCli(
  opts: { json?: boolean; resolver?: ConfigResolver; write?: (text: string) => void } = {},
): Promise<void> {
  const write = opts.write ?? ((text: string) => void process.stdout.write(text));
  const rows = configReport(opts.resolver ?? resolverWithPacks());
  if (opts.json) {
    write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }
  write(formatConfigReport(rows));
  write("\nPrecedence: env var > knowhow.json (voiceControl.packs.<pack>.<key> / voiceControl.services.<service>.<key>) > default.\n");
}
