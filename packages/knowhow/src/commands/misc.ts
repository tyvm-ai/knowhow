import { Command } from "commander";
import { execSync } from "child_process";
import { version } from "../../package.json";
import { logger } from "../logger";
import { embed, upload, download, purge } from "../index";
import { generate, buildWaves, normalizeInputPattern, GenerateOptions } from "../generate";
import { init } from "../config";
import { login } from "../login";
import { KnowhowSimpleClient } from "../services/KnowhowClient";
import { startChat } from "../chat";

export function addInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize knowhow configuration")
    .action(async () => {
      await init();
    });
}

export function addLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Login to knowhow")
    .option("--jwt", "Use manual JWT input instead of browser login")
    .action(async (opts) => {
      await login(opts.jwt);
    });
}

export function addUpdateCommand(program: Command): void {
  program
    .command("update")
    .description("Update knowhow to the latest version from npm")
    .action(async () => {
      try {
        console.log("🔄 Checking for knowhow updates...");
        console.log(`Current version: ${version}`);
        console.log("📦 Installing latest version from npm...");
        execSync("npm install -g @tyvm/knowhow@latest", {
          stdio: "inherit",
          encoding: "utf-8",
        });
        console.log("✓ knowhow has been updated successfully!");
        console.log("Run 'knowhow --version' to see the new version.");
      } catch (error) {
        console.error("Error updating knowhow:", error.message);
        process.exit(1);
      }
    });
}

export function addGenerateCommand(program: Command): void {
  program
    .command("generate")
    .description("Generate documentation")
    .option(
      "--name <name>",
      "Only run the generation source with this exact `name`"
    )
    .option(
      "--filter <substring>",
      "Only run generation sources whose name/input/output contains this substring"
    )
    .option(
      "--sync-fs",
      "Enable filesystem sync for agent-driven sources (creates .knowhow/processes/agents/<taskId>/ so tasks appear in `knowhow agents list`)"
    )
    .option(
      "--force",
      "Skip hash checks and regenerate all matching sources regardless of whether inputs/outputs have changed"
    )
    .option(
      "--concurrency <n>",
      "Maximum number of sources to run in parallel within a dependency wave (default: 3)",
      (v) => parseInt(v, 10)
    )
    .option(
      "--plan",
      "Show the execution plan (dependency waves, skip/run status) without actually generating anything"
    )
    .action(async (options: {
      name?: string;
      filter?: string;
      syncFs?: boolean;
      force?: boolean;
      concurrency?: number;
      plan?: boolean;
    }) => {
      const { setupServices } = await import("./services");
      await setupServices();

      if (options.plan) {
        await showGeneratePlan(options);
        return;
      }

      await generate({
        name: options.name,
        filter: options.filter,
        syncFs: options.syncFs,
        force: options.force,
        concurrency: options.concurrency,
      });
    });
}

async function showGeneratePlan(options: {
  name?: string;
  filter?: string;
  force?: boolean;
  concurrency?: number;
}): Promise<void> {
  const { getConfig } = await import("../config");
  const { getHashes, checkNoFilesChanged } = await import("../hashes");
  const { globSync } = await import("glob");
  const crypto = await import("crypto");
  const { loadPrompt } = await import("../config");

  const config = await getConfig();
  const allSources = config.sources ?? [];

  // Filter sources
  const sources = allSources.filter((s) => {
    if (options.name) return s.name === options.name;
    if (options.filter) {
      const needle = options.filter.toLowerCase();
      return [s.name, s.input, s.output].filter(Boolean).some((v) => v!.toLowerCase().includes(needle));
    }
    return true;
  });

  if (sources.length === 0) {
    console.warn("No generation sources matched the filter.");
    return;
  }

  const concurrency = options.concurrency ?? 3;
  const waves = buildWaves(sources);
  const hashes = await getHashes();

  console.log(`\n📋 Generation Plan  (concurrency: ${concurrency})\n`);
  console.log(`   Total sources : ${sources.length}`);
  console.log(`   Waves         : ${waves.length}`);
  console.log("");

  for (let wi = 0; wi < waves.length; wi++) {
    const wave = waves[wi];
    console.log(`┌─ Wave ${wi + 1}/${waves.length}  (${wave.length} source${wave.length !== 1 ? "s" : ""} in parallel)`);

    for (const source of wave) {
      // Determine skip/run status via hash check
      let status = "▶  run ";
      let reason = "";

      if (!options.force) {
        try {
          const prompt = await loadPrompt(source.prompt);
          const promptHash = crypto.createHash("md5").update(prompt || "").digest("hex");
          let filesToCheck: string[];

          if (source.output.endsWith("/")) {
            // For multi-output we check the input files individually;
            // just check one representative glob match to indicate staleness
            const files = globSync(normalizeInputPattern(source.input || ""));
            filesToCheck = files.length > 0 ? [files[0], source.output] : [source.output];
          } else {
            const files = globSync(normalizeInputPattern(source.input || ""));
            filesToCheck = [source.output, ...files];
          }

          const noChanges = await checkNoFilesChanged(filesToCheck, promptHash, hashes);
          if (noChanges) {
            status = "⏭  skip";
            reason = " (no changes)";
          }
        } catch {
          // If hash check fails just mark as run
        }
      } else {
        reason = " (--force)";
      }

      const deps = source.dependsOn?.length ? `  [depends: ${source.dependsOn.join(", ")}]` : "";
      const name = source.name ? `${source.name}` : "(unnamed)";
      const arrow = `${source.input || "?"} → ${source.output || "?"}`;
      console.log(`│  ${status}  ${name.padEnd(30)} ${arrow}${reason}${deps}`);
    }
    console.log("└" + "─".repeat(60));
    console.log("");
  }

  const runCount = (await Promise.all(
    waves.flat().map(async (source) => {
      if (options.force) return true;
      try {
        const prompt = await loadPrompt(source.prompt);
        const promptHash = crypto.createHash("md5").update(prompt || "").digest("hex");
        const files = globSync(normalizeInputPattern(source.input || ""));
        const filesToCheck = source.output.endsWith("/")
          ? (files.length > 0 ? [files[0], source.output] : [source.output])
          : [source.output, ...files];
        const noChanges = await checkNoFilesChanged(filesToCheck, promptHash, hashes);
        return !noChanges;
      } catch {
        return true;
      }
    })
  )).filter(Boolean).length;

  console.log(`   Would run  : ${runCount} source${runCount !== 1 ? "s" : ""}`);
  console.log(`   Would skip : ${sources.length - runCount} source${sources.length - runCount !== 1 ? "s" : ""}`);
  console.log("");
  console.log("Run `knowhow generate` to execute, or add --force to skip hash checks.\n");
}

export function addEmbedCommands(program: Command): void {
  program
    .command("embed")
    .description("Create embeddings")
    .action(async () => {
      const { setupServices } = await import("./services");
      await setupServices();
      await embed();
    });

  program
    .command("embed:purge")
    .description("Purge embeddings matching a glob pattern")
    .argument("<pattern>", "Glob pattern to match files for purging")
    .action(async (pattern) => {
      await purge(pattern);
    });
}

export function addUploadCommand(program: Command): void {
  program
    .command("upload")
    .description("Upload data")
    .action(async () => {
      await upload();
    });
}

export function addDownloadCommand(program: Command): void {
  program
    .command("download")
    .description("Download data")
    .action(async () => {
      await download();
    });
}

export function addChatCommand(program: Command): void {
  program
    .command("chat")
    .description("Start new chat interface")
    .action(async () => {
      const { setupServices } = await import("./services");
      await setupServices();
      await startChat();
    });
}

export function addGithubCredentialsCommand(program: Command): void {
  program
    .command("github-credentials [action]")
    .description(
      "Git credential helper for GitHub. Use as: git config credential.helper 'knowhow github-credentials'"
    )
    .option(
      "--repo <repo>",
      "Repository in owner/repo format (e.g. myorg/myrepo)"
    )
    .action(async (action: string | undefined, options: { repo?: string }) => {
      // Silence ALL output immediately — git credential helpers must produce
      // only the protocol=.../host=.../username=.../password=... lines on stdout.
      logger.silence();

      const client = new KnowhowSimpleClient();

      let repo = options.repo;

      if (action === "get") {
        const lines: string[] = [];
        const readline = await import("readline");
        const rl = readline.createInterface({
          input: process.stdin,
          terminal: false,
        });
        await new Promise<void>((resolve) => {
          rl.on("line", (line) => {
            if (line.trim()) lines.push(line.trim());
          });
          rl.on("close", resolve);
        });
      } else if (action === "store" || action === "erase") {
        process.exit(0);
      }

      if (!repo) {
        try {
          const remoteUrl = execSync("git remote get-url origin", {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }).trim();
          const match =
            remoteUrl.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/) ||
            remoteUrl.match(/github\.com\/([^/]+\/[^/]+)/);
          if (match) {
            repo = match[1];
          }
        } catch {
          // Not in a git repo or no remote — proceed without repo
        }
      }

      try {
        const credential = await client.getGitCredential(repo || "");
        process.stdout.write(
          `protocol=${credential.protocol}\nhost=${credential.host}\nusername=${credential.username}\npassword=${credential.password}\n`
        );
      } catch (error) {
        console.error("Failed to get git credentials:", error.message);
        process.exit(1);
      }
    });
}
