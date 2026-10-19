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
  const workersCmd = program
    .command("workers")
    .description(
      "Manage workers: `workers list|exec|tools` act on connected remote workers; `--list` shows locally registered worker paths; with no args starts all registered workers"
    )
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

  addRemoteWorkerSubcommands(workersCmd);
}

function fail(error: any): never {
  console.error("Error: " + (error?.message ?? String(error)));
  process.exit(1);
}

export function addRemoteWorkerSubcommands(workersCmd: Command): void {
  workersCmd
    .command("list")
    .description(
      "List workers connected to your org (remote), with OS, host, status"
    )
    .option("--all", "Include offline workers")
    .option(
      "--include-clients",
      "Include browser/extension/desktop client workers"
    )
    .option(
      "--probe",
      "Probe each online worker for its real OS/arch (runs a tiny command; slower)"
    )
    .option("--json", "Output JSON")
    .action(async (options) => {
      try {
        const {
          listRemoteWorkers,
          summarizeWorker,
          probeWorkerOs,
          formatWorkerTable,
        } = await import("../services/RemoteWorkers");
        const { KnowhowSimpleClient } = await import(
          "../services/KnowhowClient"
        );
        const client = new KnowhowSimpleClient();
        const workers = await listRemoteWorkers(client, {
          all: options.all,
          includeClients: options.includeClients,
        });
        const probes: Record<string, any> = {};
        if (options.probe) {
          await Promise.all(
            workers
              .filter((w) => w.connected)
              .map(async (w) => {
                probes[w.id] = await probeWorkerOs(client, w);
              })
          );
        }
        if (options.json) {
          console.log(
            JSON.stringify(
              workers.map((w) => ({
                ...summarizeWorker(w),
                ...(probes[w.id] ? { probe: probes[w.id] } : {}),
              })),
              null,
              2
            )
          );
          return;
        }
        if (workers.length === 0) {
          console.log(
            "No connected workers. Start one with: knowhow worker [--share]  (add --all to see offline workers)"
          );
          const local = await listWorkerPaths().catch(() => []);
          if (local.length) {
            console.log(
              `(${local.length} local worker path(s) registered; see: knowhow workers --list)`
            );
          }
          return;
        }
        console.log(formatWorkerTable(workers, probes));
      } catch (error) {
        fail(error);
      }
    });

  workersCmd
    .command("exec <worker> <command...>")
    .description(
      "Run a shell command on a connected worker (uses the worker's execCommand tool; runs via the worker's default shell: sh or cmd.exe). Use `--` before the command if it has flags."
    )
    .option(
      "--timeout <ms>",
      "Command timeout (default 25000; worker RPC limit ~30s)",
      "25000"
    )
    .option(
      "--background",
      "Start in background on the worker (execCommand continueInBackground) and print the log name"
    )
    .option("--json", "Output JSON {stdout,stderr,exitCode}")
    .action(async (workerRef: string, commandParts: string[], options) => {
      try {
        const { resolveWorker, execOnWorker } = await import(
          "../services/RemoteWorkers"
        );
        const { KnowhowSimpleClient } = await import(
          "../services/KnowhowClient"
        );
        const client = new KnowhowSimpleClient();
        const w = await resolveWorker(workerRef, client);
        const timeoutMs = parseInt(options.timeout, 10) || 25000;
        if (timeoutMs > 25000 && !options.background) {
          console.error(
            "Warning: the worker RPC times out at ~30s; use --background for long commands."
          );
        }
        const extra: any = {};
        if (options.background) {
          extra.continueInBackground = true;
          extra.logFileName = `workers-exec-${Date.now()}`;
        }
        const r = await execOnWorker(
          client,
          w,
          commandParts.join(" "),
          timeoutMs,
          extra
        );
        if (options.json) {
          console.log(
            JSON.stringify(
              { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode },
              null,
              2
            )
          );
        } else {
          if (r.stdout) {
            process.stdout.write(
              r.stdout.endsWith("\n") ? r.stdout : r.stdout + "\n"
            );
          }
          if (r.stderr) process.stderr.write(r.stderr);
        }
        if (typeof r.exitCode === "number" && r.exitCode !== 0) {
          process.exit(r.exitCode);
        }
      } catch (error) {
        fail(error);
      }
    });

  workersCmd
    .command("tools <worker>")
    .description("List tools exposed by a worker")
    .option("--json", "Output JSON")
    .action(async (workerRef: string, options) => {
      try {
        const { resolveWorker } = await import("../services/RemoteWorkers");
        const { KnowhowSimpleClient } = await import(
          "../services/KnowhowClient"
        );
        const client = new KnowhowSimpleClient();
        const w = await resolveWorker(workerRef, client);
        const res = await client.listWorkerTools(w.id);
        const tools = (Array.isArray(res.data) ? res.data : []).map((t) => ({
          name: t.function.name.replace(/^worker_0_/, ""),
          description: t.function.description || "",
        }));
        if (options.json) {
          console.log(JSON.stringify(tools, null, 2));
          return;
        }
        for (const t of tools) {
          const first = t.description.split("\n")[0];
          console.log(first ? `${t.name}  — ${first}` : t.name);
        }
      } catch (error) {
        fail(error);
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
    .option(
      "-p, --port <ports...>",
      "Allow these local ports on the tunnel (e.g. --port 3000 8080, or 5432:tcp). " +
      "Missing ports are added to worker.tunnel.allowedPorts in knowhow.json before starting."
    )
    .action(async (options) => {
      if (options.port?.length) {
        const { ensureTunnelPorts } = await import("../tunnel");
        const added = await ensureTunnelPorts(options.port);
        console.log(
          added.length
            ? `➕ Added tunnel port(s) ${added.join(", ")} to knowhow.json`
            : `✅ Tunnel port(s) ${options.port.join(", ")} already allowed`
        );
      }
      console.log("🌐 Starting tunnel (minimal worker) mode...");
      console.log(`   Tools: ${TUNNEL_MINIMAL_TOOLS.join(", ")}`);
      await worker({
        share: options.share,
        unshare: options.unshare,
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
      "--init",
      "Initialize config.files entries based on what exists in .knowhow/ (run once before --push)"
    )
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
        const { cloudWorker, pullCloudWorkerConfig, initCloudWorker } = await import(
          "../cloudWorker"
        );
        if (options.init) {
          await initCloudWorker({ dryRun: options.dryRun });
          return;
        }
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
