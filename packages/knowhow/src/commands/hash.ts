import { Command } from "commander";
import * as crypto from "crypto";
import * as fs from "fs";
import { globSync } from "glob";
import { getHashes, saveHashes } from "../hashes";

/**
 * Compute an MD5 hash over the sorted contents of all matched files.
 * Uses file content only (not mtime) for stability across CI clones.
 */
function hashFiles(files: string[]): string {
  const hash = crypto.createHash("md5");
  const sorted = [...files].sort();
  for (const f of sorted) {
    if (!fs.existsSync(f)) continue;
    const content = fs.readFileSync(f);
    hash.update(f);
    hash.update(content);
  }
  return hash.digest("hex");
}

export function addHashCommand(program: Command): void {
  program
    .command("hash")
    .description(
      "Check whether a named set of input files has changed since last saved. " +
        "Exits 0 (unchanged) or 1 (changed / first run). " +
        "Use with shell short-circuit: (knowhow hash ... || run-build-step)"
    )
    .requiredOption(
      "--name <name>",
      "Unique name for this hash slot (e.g. 'build', 'generate-api'). Becomes the top-level key in .hashes.json."
    )
    .requiredOption(
      "--input <glob>",
      "Glob pattern(s) of input files to hash. Separate multiple globs with commas."
    )
    .option(
      "--output <paths>",
      "Optional output file(s) — if any are missing the check always returns changed (comma-separated)."
    )
    .option(
      "--save",
      "Save the current hash after a successful build step."
    )
    .option("--verbose", "Print what files were found and the computed hash")
    .action(
      async (opts: {
        name: string;
        input: string;
        output?: string;
        save?: boolean;
        verbose?: boolean;
      }) => {
        const hashes = await getHashes();

        const inputGlobs = opts.input.split(",").map((g) => g.trim());
        const outputPaths = opts.output
          ? opts.output.split(",").map((p) => p.trim())
          : [];

        // Expand input globs
        const inputFiles: string[] = [];
        for (const pattern of inputGlobs) {
          const matches = globSync(pattern, { nodir: true });
          inputFiles.push(...matches);
        }

        if (opts.verbose) {
          console.error(`[knowhow hash] name=${opts.name}`);
          console.error(
            `[knowhow hash] input files (${inputFiles.length}): ${inputFiles.slice(0, 10).join(", ")}${inputFiles.length > 10 ? "…" : ""}`
          );
          if (outputPaths.length) {
            console.error(`[knowhow hash] output files: ${outputPaths.join(", ")}`);
          }
        }

        const currentHash = hashFiles(inputFiles);

        // --save mode: record into .hashes.json under hashes[name][inputGlob] = hash
        if (opts.save) {
          if (!hashes[opts.name]) hashes[opts.name] = {};
          hashes[opts.name][opts.input] = currentHash;
          await saveHashes(hashes);
          if (opts.verbose) {
            console.error(`[knowhow hash] saved hash ${currentHash} for "${opts.name}"`);
          }
          process.exit(0);
        }

        // Check mode: if any output file is missing, always report changed
        for (const outPath of outputPaths) {
          if (!fs.existsSync(outPath)) {
            if (opts.verbose) {
              console.error(`[knowhow hash] output file missing: ${outPath} → changed`);
            }
            process.exit(1);
          }
        }

        const storedHash: string | undefined = hashes[opts.name]?.[opts.input];

        if (opts.verbose) {
          console.error(
            `[knowhow hash] stored=${storedHash ?? "(none)"}  current=${currentHash}`
          );
        }

        if (storedHash && storedHash === currentHash) {
          if (opts.verbose) {
            console.error(`[knowhow hash] ✓ unchanged — skipping`);
          }
          process.exit(0);
        }

        if (opts.verbose) {
          console.error(`[knowhow hash] ✗ changed — rebuild needed`);
        }
        process.exit(1);
      }
    );
}
