import { Command } from "commander";
import * as crypto from "crypto";
import * as fs from "fs";
import { execSync } from "child_process";
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
      "Save the current hash. In standalone mode, records the hash immediately (no command run). " +
        "In --run mode, records the hash only if the command succeeds. " +
        "Without --save in --run mode, the hash is never recorded — useful when --run is a " +
        "side-effect trigger rather than the step that produces the tracked artifacts."
    )
    .option(
      "--run <command>",
      "Self-contained mode: if inputs are unchanged, skip and exit 0. " +
        "If changed (or first run), run this shell command and — only if it " +
        "succeeds — save the new hash. Replaces the '(hash) || (build && hash --save)' pattern."
    )
    .option("--verbose", "Print what files were found and the computed hash")
    .action(
      async (opts: {
        name: string;
        input: string;
        output?: string;
        save?: boolean;
        run?: string;
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

        // Standalone --save mode (no --run): record hash immediately and exit.
        // When --run is also present, --save is handled inside the --run branch below.
        if (opts.save && !opts.run) {
          if (!hashes[opts.name]) hashes[opts.name] = {};
          hashes[opts.name][opts.input] = currentHash;
          await saveHashes(hashes);
          if (opts.verbose) {
            console.error(`[knowhow hash] saved hash ${currentHash} for "${opts.name}"`);
          }
          process.exit(0);
        }

        // Determine whether inputs (or missing outputs) indicate a rebuild is needed.
        let changed = false;

        // If any output file is missing, always report changed
        for (const outPath of outputPaths) {
          if (!fs.existsSync(outPath)) {
            if (opts.verbose) {
              console.error(`[knowhow hash] output file missing: ${outPath} → changed`);
            }
            changed = true;
          }
        }

        const storedHash: string | undefined = hashes[opts.name]?.[opts.input];

        if (opts.verbose) {
          console.error(
            `[knowhow hash] stored=${storedHash ?? "(none)"}  current=${currentHash}`
          );
        }

        if (!(storedHash && storedHash === currentHash)) {
          changed = true;
        }

        // --run mode: self-contained. Skip when unchanged; otherwise run the
        // command and only save the new hash if it succeeds.
        if (opts.run) {
          if (!changed) {
            if (opts.verbose) {
              console.error(`[knowhow hash] ✓ unchanged — skipping "${opts.run}"`);
            }
            process.exit(0);
          }

          if (opts.verbose) {
            console.error(`[knowhow hash] ✗ changed — running "${opts.run}"`);
          }
          try {
            execSync(opts.run, { stdio: "inherit", shell: "/bin/sh" });
          } catch (err: any) {
            // Command failed — do NOT save the hash so it retries next time.
            process.exit(typeof err?.status === "number" ? err.status : 1);
          }

          // Command succeeded — only save the hash if --save was also passed.
          // Without --save, the hash is NOT recorded so the command will re-run next time.
          // Use --save when --run produces the artifacts that the hash tracks.
          // Omit --save when --run is a side-effect trigger (e.g. snapshot regeneration).
          if (opts.save) {
            if (!hashes[opts.name]) hashes[opts.name] = {};
            hashes[opts.name][opts.input] = currentHash;
            await saveHashes(hashes);
            if (opts.verbose) {
              console.error(`[knowhow hash] saved hash ${currentHash} for "${opts.name}"`);
            }
          }
          process.exit(0);
        }

        // Legacy check mode: exit 0 (unchanged) or 1 (changed).
        if (!changed) {
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
