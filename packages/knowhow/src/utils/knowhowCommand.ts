import * as fs from "fs";
import * as path from "path";
import type { SpawnOptions } from "child_process";

/**
 * Resolve how to launch the knowhow CLI as a child process.
 *
 * Spawning the bare "knowhow" command breaks on Windows: npm installs the global
 * bin as `knowhow.cmd`, and child_process.spawn without a shell only resolves
 * real executables, so it fails with `spawn knowhow ENOENT`.
 *
 * Instead we run this package's own bin script with the current node binary.
 * That works on every platform, needs no shell, and guarantees the child is the
 * same knowhow version as the parent.
 */
export function getKnowhowSpawn(args: string[]): {
  command: string;
  args: string[];
  options: SpawnOptions;
} {
  // __dirname is src/utils (ts-node) or ts_build/src/utils (compiled)
  const candidates = [
    path.resolve(__dirname, "../../bin/knowhow.js"),
    path.resolve(__dirname, "../../../bin/knowhow.js"),
  ];
  const binPath = candidates.find((p) => fs.existsSync(p));

  if (binPath) {
    return { command: process.execPath, args: [binPath, ...args], options: {} };
  }

  // Fallback: rely on PATH. On Windows a shell is needed to resolve knowhow.cmd.
  return {
    command: "knowhow",
    args,
    options: process.platform === "win32" ? { shell: true } : {},
  };
}
