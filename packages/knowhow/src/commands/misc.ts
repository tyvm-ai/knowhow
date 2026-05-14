import { Command } from "commander";
import { execSync } from "child_process";
import { version } from "../../package.json";
import { generate, embed, upload, download, purge } from "../index";
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
    .action(async () => {
      const { setupServices } = await import("./services");
      await setupServices();
      await generate();
    });
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
