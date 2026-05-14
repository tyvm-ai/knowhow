import { Command } from "commander";
import { worker } from "../worker";
import { TUNNEL_MINIMAL_TOOLS } from "../tunnel";
import { fileSync } from "../fileSync";
import {
  startAllWorkers,
  listWorkerPaths,
  unregisterWorkerPath,
  clearWorkerRegistry,
} from "../workerRegistry";

export function addWorkerCommand(program: Command): void {
  program
    .command("worker")
    .description(
      "Start worker process and optionally register current directory"
    )
    .option("--register", "Register current directory as a worker path")
    .option(
      "--share",
      "Share this worker with your organization (allows other users to use it)"
    )
    .option("--unshare", "Make this worker private (only you can use it)")
    .option("--sandbox", "Run worker in a Docker container for isolation")
    .option(
      "--no-sandbox",
      "Run worker directly on host (disable sandbox mode)"
    )
    .option("--passkey", "Set up passkey authentication for this worker")
    .option("--passkey-reset", "Remove passkey authentication requirement")
    .action(async (options) => {
      const { setupServices } = await import("./services");
      await setupServices();
      await worker(options);
    });
}

export function addWorkersCommand(program: Command): void {
  program
    .command("workers")
    .description("Manage and start all registered workers")
    .option("--list", "List all registered worker paths")
    .option("--unregister <path>", "Unregister a worker path")
    .option("--clear", "Clear all registered worker paths")
    .action(async (options) => {
      try {
        if (options.list) {
          const workers = await listWorkerPaths();
          if (workers.length === 0) {
            console.log("No workers registered.");
            console.log(
              "\nTo register a worker, run 'knowhow worker --register' from the worker directory."
            );
          } else {
            console.log(`Registered workers (${workers.length}):`);
            workers.forEach((workerPath, index) => {
              console.log(`  ${index + 1}. ${workerPath}`);
            });
          }
          return;
        }

        if (options.unregister) {
          await unregisterWorkerPath(options.unregister);
          return;
        }

        if (options.clear) {
          await clearWorkerRegistry();
          return;
        }

        // Default action: start all workers
        const { setupServices } = await import("./services");
        await setupServices();
        await startAllWorkers();
      } catch (error) {
        console.error("Error managing workers:", error);
        process.exit(1);
      }
    });
}

export function addTunnelCommand(program: Command): void {
  program
    .command("tunnel")
    .description(
      "Start a minimal worker with tunnel enabled: exposes local ports to the cloud. " +
      "Registers essential tools (unlock, lock, listAllowedPorts) so the backend is aware of the worker and ports. " +
      "If passkey auth is configured, the tunnel is locked until unlocked via tool call or WebSocket auth protocol."
    )
    .option(
      "--share",
      "Share this tunnel with your organization (allows other users to use it)"
    )
    .option("--unshare", "Make this tunnel private (only you can use it)")
    .action(async (options) => {
      console.log("🌐 Starting tunnel (minimal worker) mode...");
      console.log(`   Tools: ${TUNNEL_MINIMAL_TOOLS.join(", ")}`);
      await worker({
        ...options,
        allowedTools: TUNNEL_MINIMAL_TOOLS,
      });
    });
}

export function addFilesCommand(program: Command): void {
  program
    .command("files")
    .description(
      "Sync files between local filesystem and Knowhow FS (uses fileMounts config)"
    )
    .option("--upload", "Force upload direction for all mounts")
    .option("--download", "Force download direction for all mounts")
    .option("--config <path>", "Path to knowhow.json", "./knowhow.json")
    .option("--dry-run", "Print what would be synced without doing it")
    .action(async (options) => {
      try {
        await fileSync(options);
      } catch (error) {
        console.error("Error syncing files:", error);
        process.exit(1);
      }
    });
}

export function addCloudWorkerCommand(program: Command): void {
  program
    .command("cloudworker")
    .description("Create or sync a cloud worker with your local knowhow config")
    .option(
      "--create",
      "Create a new cloud worker with synced config and files"
    )
    .option(
      "--push <uid>",
      "Push/sync local config and files to an existing cloud worker"
    )
    .option(
      "--pull <id>",
      "Pull the latest workerConfigJson from a cloud worker and update local config"
    )
    .option("--name <name>", "Name for the cloud worker (used with --create)")
    .option("--dry-run", "Print what would be synced without doing it")
    .action(async (options) => {
      try {
        const { cloudWorker, pullCloudWorkerConfig } = await import(
          "../cloudWorker"
        );
        if (options.pull) {
          await pullCloudWorkerConfig({ id: options.pull });
        } else {
          await cloudWorker(options);
        }
      } catch (error) {
        console.error("Error running cloudworker:", error);
        process.exit(1);
      }
    });
}
