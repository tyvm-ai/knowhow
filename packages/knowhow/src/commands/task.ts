import { Command } from "commander";
import * as readline from "readline/promises";
import { KnowhowSimpleClient, KNOWHOW_API_URL } from "../services/KnowhowClient";
import { getConfig } from "../config";
import { getRealRepoInfo } from "../services/RealRepo";
import { ensureCloudWorkerStarted } from "../services/WorkerPicker";
import {
  CloudWorkerSummary,
  describeCloudWorker,
  findCloudWorker,
  offload,
  pushTask,
  rankCloudWorkers,
  resolveLocalTask,
} from "../services/TaskTransport";

function requireRemoteId(task: { localId: string; remoteId?: string }) {
  if (!task.remoteId) {
    throw new Error(
      `Task ${task.localId} is not synced to the Knowhow backend yet. ` +
        `Run /sync:remote in the chat (or start it with remote sync enabled) first.`
    );
  }
  return task.remoteId;
}

/** Print where to watch the offloaded task. */
export function printTaskHint(remoteTaskId: string) {
  const u = new URL(KNOWHOW_API_URL);
  u.hostname = u.hostname.replace(/^api\./, "");
  u.pathname = u.pathname.replace(/\/api\/?$/, "").replace(/\/$/, "");
  console.log(`🌐 Watch it: ${u.toString().replace(/\/$/, "")}/dashboard/agents`);
  console.log(`   or: knowhow agents attach ${remoteTaskId}`);
}

export async function chooseCloudWorker(
  client: KnowhowSimpleClient,
  spec: string | undefined,
  ask: (prompt: string) => Promise<string | undefined>
): Promise<CloudWorkerSummary | undefined> {
  const localUrl = getRealRepoInfo(process.cwd())?.remoteUrl;
  const res = await client.listCloudWorkers();
  const workers = rankCloudWorkers(res.data as CloudWorkerSummary[], localUrl);
  if (!workers.length) {
    console.log("No cloud workers found. Create one in the Knowhow app first.");
    return undefined;
  }
  if (spec) {
    const w = findCloudWorker(workers, spec);
    if (!w) console.log(`No cloud worker matching "${spec}".`);
    return w;
  }
  console.log("\nCloud workers:");
  workers.forEach((w, i) => console.log(`  ${i + 1}. ${describeCloudWorker(w, localUrl)}`));
  const answer = (await ask("Offload to which worker? (number, blank to cancel): "))?.trim();
  if (!answer) return undefined;
  const idx = parseInt(answer, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= workers.length) return workers[idx - 1];
  return findCloudWorker(workers, answer);
}

async function readlineAsk(prompt: string) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export function addTaskCommand(program: Command): void {
  const task = program
    .command("task")
    .description("Move a local agent task's working tree to another machine (cloud worker)");

  task
    .command("push")
    .description("Snapshot this task's working tree (incl. uncommitted changes) and upload it")
    .option("--id <taskId>", "Local or remote task id (default: most recent local task)")
    .action(async (opts: { id?: string }) => {
      const client = new KnowhowSimpleClient(KNOWHOW_API_URL);
      const t = resolveLocalTask(opts.id);
      const remoteId = requireRemoteId(t);
      const config = await getConfig();
      await pushTask(client, remoteId, {
        metadata: t.metadata,
        maxFileMb: config.gitPlugin?.maxFileMb,
        configFiles: config.files,
      });
    });

  task
    .command("offload")
    .description("Push the task and resume it on a cloud worker sandbox")
    .option("--id <taskId>", "Local or remote task id (default: most recent local task)")
    .option("--worker <idOrName>", "Cloud worker id or name")
    .option("--prompt <text>", "Prompt to resume the task with on the worker")
    .option("--snapshot <id>", "If the cloud worker is stopped, start it from this snapshot")
    .option("--fresh", "If the cloud worker is stopped, start it with a clean cold start")
    .action(async (opts: { id?: string; worker?: string; prompt?: string; snapshot?: string; fresh?: boolean }) => {
      const client = new KnowhowSimpleClient(KNOWHOW_API_URL);
      const t = resolveLocalTask(opts.id);
      const remoteId = requireRemoteId(t);
      const worker = await chooseCloudWorker(client, opts.worker, readlineAsk);
      if (!worker) return;
      if (
        !(await ensureCloudWorkerStarted(
          worker,
          { snapshot: opts.snapshot, fresh: opts.fresh },
          async (p) => readlineAsk(p)
        ))
      ) {
        console.log("Offload cancelled.");
        return;
      }
      const config = await getConfig();
      await offload(client, remoteId, worker.id, {
        prompt: opts.prompt,
        metadata: t.metadata,
        maxFileMb: config.gitPlugin?.maxFileMb,
        configFiles: config.files,
      });
      printTaskHint(remoteId);
    });

  task
    .command("status")
    .description("Show the task workspace (latest snapshot, holder, recent offloads)")
    .option("--id <taskId>", "Local or remote task id (default: most recent local task)")
    .action(async (opts: { id?: string }) => {
      const client = new KnowhowSimpleClient(KNOWHOW_API_URL);
      const t = resolveLocalTask(opts.id);
      const remoteId = requireRemoteId(t);
      const ws = await client.getTaskWorkspace(remoteId);
      console.log(JSON.stringify(ws, null, 2));
    });
}
