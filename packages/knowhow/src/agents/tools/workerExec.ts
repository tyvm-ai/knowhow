import { Tool } from "../../clients/types";
import { KnowhowSimpleClient } from "../../services/KnowhowClient";
import { execOnWorker, resolveWorker } from "../../services/RemoteWorkers";

export interface WorkerExecParams {
  worker: string;
  command: string;
  /** default 25000; the worker RPC limit is ~30s */
  timeoutMs?: number;
}

/** Run a shell command on a connected remote worker. Returns JSON {stdout,stderr,exitCode} or {error}. */
export async function workerExec(params: WorkerExecParams): Promise<string> {
  try {
    if (!params.worker) throw new Error("worker is required");
    if (!params.command) throw new Error("command is required");
    const client = new KnowhowSimpleClient();
    const w = await resolveWorker(params.worker, client);
    const r = await execOnWorker(
      client,
      w,
      params.command,
      params.timeoutMs ?? 25000
    );
    return JSON.stringify({
      worker: w.name,
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
    });
  } catch (e: any) {
    return JSON.stringify({ error: e?.message ?? String(e) });
  }
}

export const workerExecDefinition: Tool = {
  type: "function",
  function: {
    name: "workerExec",
    description:
      "Run a shell command on a connected remote worker (see listWorkers) via its execCommand tool. Short commands only (~25s limit). For long tasks use startAgentTask {worker}.",
    parameters: {
      type: "object",
      positional: false,
      properties: {
        worker: {
          type: "string",
          description: "Worker id, id-prefix, hostname or host:folder.",
        },
        command: {
          type: "string",
          description:
            "Shell command to run (executed by the worker's default shell).",
        },
        timeoutMs: {
          type: "number",
          description: "Command timeout in ms. Default 25000.",
        },
      },
      required: ["worker", "command"],
    },
  },
};
