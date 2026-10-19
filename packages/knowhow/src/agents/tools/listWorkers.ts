import { Tool } from "../../clients/types";
import { KnowhowSimpleClient } from "../../services/KnowhowClient";
import {
  listRemoteWorkers,
  summarizeWorker,
} from "../../services/RemoteWorkers";

export interface ListWorkersParams {
  /** default true */
  onlyConnected?: boolean;
  includeClients?: boolean;
  os?: "windows" | "posix";
  nameContains?: string;
}

/** Returns JSON.stringify(WorkerSummary[]) or {"error": "..."} on failure. */
export async function listWorkers(
  params: ListWorkersParams = {}
): Promise<string> {
  try {
    const workers = await listRemoteWorkers(new KnowhowSimpleClient(), {
      all: params.onlyConnected === false,
      includeClients: params.includeClients,
    });
    const needle = params.nameContains?.toLowerCase();
    const filtered = workers
      .filter((w) => !params.os || w.os === params.os)
      .filter((w) => !needle || w.name.toLowerCase().includes(needle))
      .map(summarizeWorker);
    return JSON.stringify(filtered);
  } catch (e: any) {
    return JSON.stringify({ error: e?.message ?? String(e) });
  }
}

export const listWorkersDefinition: Tool = {
  type: "function",
  function: {
    name: "listWorkers",
    description:
      "List knowhow workers (other machines/sandboxes running `knowhow worker`) connected to your org: id, name (hostname), os (heuristic), root dir, online/offline, shared, owner. Use the id or name with startAgentTask {worker}, workerExec, etc.",
    parameters: {
      type: "object",
      positional: false,
      properties: {
        onlyConnected: {
          type: "boolean",
          description: "Only list online workers. Default: true.",
        },
        includeClients: {
          type: "boolean",
          description:
            "Include browser/extension/desktop client workers. Default: false.",
        },
        os: {
          type: "string",
          enum: ["windows", "posix"],
          description:
            "Filter by OS (heuristic, derived from the worker's root directory).",
        },
        nameContains: {
          type: "string",
          description: "Filter by hostname substring (case-insensitive).",
        },
      },
      required: [],
    },
  },
};
