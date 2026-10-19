/**
 * WorkerModule - `/worker` chat command.
 * While a remote worker is selected, every non-command chat input is delegated
 * to a remote agent task on that worker (started via the worker's
 * startAgentTask tool) and followed through the existing /attach flow.
 */
import { BaseChatModule } from "./BaseChatModule";
import { ChatCommand, ChatContext } from "../types";
import { AgentModule } from "./AgentModule";
import { getConfig } from "../../config";

export interface ActiveWorker {
  id: string;
  name: string;
  os: string;
  root?: string;
  taskId?: string;
}

/** Prefix for the chat prompt when a worker is selected. */
export function workerPromptPrefix(ctx?: ChatContext): string {
  const w = ctx?.activeWorker as ActiveWorker | undefined;
  return w ? `[worker: ${w.name}] ` : "";
}

export class WorkerModule extends BaseChatModule {
  name = "worker";
  description = "Run agent turns on a remote worker (/worker)";

  constructor(private agentModule?: AgentModule) {
    super();
  }

  getCommands(): ChatCommand[] {
    return [
      {
        name: "worker",
        description:
          "Select a remote worker for agent turns: /worker [list|<id|name>|off|new|status]",
        handler: this.handleWorkerCommand.bind(this),
      },
    ];
  }

  private get ctx(): ChatContext {
    return this.chatService.getContext();
  }

  private async printList(): Promise<void> {
    const { listRemoteWorkers, formatWorkerTable } = await import(
      "../../services/RemoteWorkers"
    );
    const workers = await listRemoteWorkers();
    if (!workers.length) {
      console.log(
        "No connected workers. Start one with: knowhow worker [--share]"
      );
      return;
    }
    console.log(formatWorkerTable(workers));
  }

  async handleWorkerCommand(args: string[] = []): Promise<void> {
    const sub = (args[0] || "").trim();
    const ctx = this.ctx;
    try {
      if (!sub || sub === "status") {
        const w = ctx.activeWorker as ActiveWorker | undefined;
        if (w) {
          console.log(
            `🛰️ Worker: ${w.name} (${w.id.slice(0, 8)}) os=${w.os}${
              w.root ? ` root=${w.root}` : ""
            }`
          );
          console.log(
            w.taskId
              ? `   Remote task: ${w.taskId} (next message resumes it; /worker new to start fresh)`
              : "   No remote task yet (next message starts a new one)"
          );
        } else {
          console.log(
            "No worker selected. Usage: /worker list | /worker <id|name> | /worker off | /worker new"
          );
          await this.printList();
        }
        return;
      }

      if (sub === "list" || sub === "ls") {
        await this.printList();
        return;
      }

      if (sub === "off" || sub === "local") {
        if (ctx.activeWorker) {
          console.log(
            `🏠 Agent turns run locally again (was: ${ctx.activeWorker.name}).`
          );
        } else {
          console.log("No worker was selected; already running locally.");
        }
        ctx.activeWorker = undefined;
        return;
      }

      if (sub === "new") {
        const w = ctx.activeWorker as ActiveWorker | undefined;
        if (!w) {
          console.log("No worker selected. Use /worker <id|name> first.");
          return;
        }
        w.taskId = undefined;
        console.log(`🆕 Next message starts a fresh task on ${w.name}.`);
        return;
      }

      const { resolveWorker } = await import("../../services/RemoteWorkers");
      const w = await resolveWorker(args.join(" ").trim());
      ctx.activeWorker = {
        id: w.id,
        name: w.name,
        os: w.os,
        root: w.fsRoot,
        taskId: undefined,
      } as ActiveWorker;
      console.log(
        `🛰️ Agent turns now run on ${w.name}. Use /worker off to return to local.`
      );
    } catch (e: any) {
      console.error(`❌ ${e?.message ?? String(e)}`);
    }
  }

  async handleInput(input: string, context: ChatContext): Promise<boolean> {
    const w = context.activeWorker as ActiveWorker | undefined;
    if (!w || !input || !input.trim()) return false;
    if (input.trim().startsWith("/")) return false;

    try {
      const { startRemoteAgentTask } = await import(
        "../../services/RemoteWorkers"
      );
      let agentName: string | undefined;
      if (context.agentMode && context.currentAgent) {
        agentName = context.currentAgent;
      }
      if (!agentName) {
        try {
          const cfg: any = await getConfig();
          agentName = cfg?.chat?.defaultAgent ?? undefined;
        } catch (_) {}
      }

      let taskId: string | undefined;
      let resumedTask = false;
      if (w.taskId) {
        try {
          const r = await startRemoteAgentTask({
            worker: w.id,
            prompt: input,
            agentName,
            resumeTaskId: w.taskId,
          });
          taskId = r.taskId;
          resumedTask = true;
        } catch (e: any) {
          console.warn(
            `⚠️ could not resume remote task (${
              e?.message ?? String(e)
            }); starting a new one`
          );
        }
      }
      if (!taskId) {
        const r = await startRemoteAgentTask({
          worker: w.id,
          prompt: input,
          agentName,
        });
        taskId = r.taskId;
      }
      w.taskId = taskId;

      console.log(`🛰️ ${w.name}: task ${taskId}`);
      context.chatHistory?.push({ input, output: "", taskId } as any);
      if (resumedTask) {
        // The backend still shows the previous (completed) state until the
        // resumed agent syncs; wait for it so /attach follows the new turn.
        const { waitForRemoteTaskRunning } = await import(
          "../../services/RemoteWorkers"
        );
        const running = await waitForRemoteTaskRunning(taskId);
        if (!running) {
          console.warn(
            "⚠️ remote task did not report running yet; attaching anyway (use /attach " +
              taskId +
              " again if it shows completed)"
          );
        }
      }
      await this.chatService.processInput(`/attach ${taskId}`);
    } catch (e: any) {
      console.error(`❌ Remote worker error: ${e?.message ?? String(e)}`);
    }
    return true;
  }
}
