import { ComputerService } from "../ComputerService";
import { RustCoreDriver } from "../drivers/RustCoreDriver";
import { AutomationRunner, loadAutomation, setKillSwitchArmed } from "../automation";
import { setHotkeyProvider } from "../hotkeys";
import { HostClient } from "./HostClient";
import { HostHotkeyProvider } from "./HostHotkeyProvider";

export interface WorkerArgs {
  name: string;
  cwd?: string;
  params?: Record<string, unknown>;
  maxDurationMs?: number;
  dryRun?: boolean;
}

export function parseWorkerArgs(argv: string[]): WorkerArgs {
  const out: Partial<WorkerArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--name") out.name = next();
    else if (a === "--cwd") out.cwd = next();
    else if (a === "--params") {
      const p = JSON.parse(next());
      if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("--params must be a JSON object");
      out.params = p;
    } else if (a === "--max-duration") out.maxDurationMs = Number(next());
    else if (a === "--dry-run") out.dryRun = true;
  }
  if (!out.name) throw new Error("worker requires --name <automation>");
  return out as WorkerArgs;
}

/** Run one automation as a host-managed worker. Returns the process exit code. */
export async function runWorker(
  args: WorkerArgs,
  env: NodeJS.ProcessEnv = process.env,
  svcFactory: () => ComputerService = defaultService
): Promise<number> {
  if (args.cwd) process.chdir(args.cwd);
  const workerId = env.KNOWHOW_HOST_WORKER_ID || "";
  const client = await HostClient.connect("worker", {
    workerId,
    name: env.KNOWHOW_HOST_NAME || args.name,
    endpoint: env.KNOWHOW_HOST_ENDPOINT,
    // Per-worker secret the host put in our env; the host rejects workers without it.
    token: env.KNOWHOW_CU_WORKER_TOKEN ?? "",
  });
  const provider = new HostHotkeyProvider(client, (m) => console.error(`[host] ${m}`));
  try {
    // Arming: the host's hello reply reports whether its keyboard hook (kill switch) is live.
    const armed = !!client.helloResult?.killSwitchArmed;
    setKillSwitchArmed(armed);
    setHotkeyProvider(provider);

    const spec = loadAutomation(args.name);
    const runner = new AutomationRunner(spec, svcFactory(), {
      maxDurationMs: args.maxDurationMs,
      params: args.params,
      dryRun: !!args.dryRun,
      hotkeyProvider: provider,
      onHeldKeysChange: provider.heldKeysReporter(),
      tray: provider.trayBridge(),
      gui: provider.gui(),
      onLog: (e) => console.log(`t+${e.t}ms ${JSON.stringify(e.data)}`),
    });
    provider.bindRunner(runner);
    // Losing the host means losing the kill switch + hotkeys: stop.
    client.on("close", () => runner.ctl.stop());
    const onTerm = () => runner.ctl.stop();
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onTerm);
    console.log(`worker ${workerId} running automation "${args.name}" (killSwitchArmed=${armed})`);
    const result = await runner.run();
    console.log(
      `worker done: ${JSON.stringify({ stopped: result.stopped, error: result.error, elapsedMs: result.elapsedMs })}`
    );
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onTerm);
    return result.error ? 1 : 0;
  } catch (e: any) {
    console.error(`worker error: ${e?.message ?? e}`);
    return 1;
  } finally {
    setHotkeyProvider(null);
    provider.dispose();
    client.close();
  }
}

function defaultService(): ComputerService {
  const svc = new ComputerService({});
  const rust = RustCoreDriver.tryLoad();
  if (rust) svc.registerDriver(rust);
  return svc;
}

if (require.main === module) {
  let args: WorkerArgs;
  try {
    args = parseWorkerArgs(process.argv.slice(2));
  } catch (e: any) {
    console.error(`worker: ${e?.message ?? e}`);
    process.exit(1);
  }
  runWorker(args).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e);
      process.exit(1);
    }
  );
}
