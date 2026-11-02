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
import { InputQueueManager } from "../../utils/InputQueueManager";
import { RemoteTaskWatcher } from "../../services/RemoteTaskWatcher";
import { WatcherBackedAgent } from "../../services/SyncedAgentWatcher";
import {
  parseAttachArgs,
  prepareWorkerForAttach,
} from "../../services/WorkerPicker";
import { destroyForkedSandbox } from "../../services/WorkerLauncher";

export interface ActiveWorker {
  id: string;
  name: string;
  os: string;
  root?: string;
  taskId?: string;
  /** set for sandbox cloud workers (incl. forks) */
  cloudWorkerId?: string;
  /** sandbox forked for this attach — destroy on /worker off (after asking) */
  forkedSandboxId?: string;
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
      {
        name: "workers",
        description:
          "Pick a worker (starting a stopped cloud worker from a snapshot if needed) and attach: /workers [worker] [--snapshot <id>|--fresh|--fork <snapshotId>] [--prompt <text>] [--task <remoteTaskId>]",
        handler: this.handleWorkersCommand.bind(this),
      },
      {
        name: "status",
        description: "Show the attached remote worker task status",
        modes: ["agent:attached"],
        handler: async () => {
          const w = this.remoteWatcher();
          if (!w) {
            console.log("Not attached to a remote worker task.");
            return;
          }
          await w.poll().catch(() => undefined);
          console.log(w.statusLine());
        },
      },
    ];
  }

  /** The RemoteTaskWatcher behind the currently attached agent, if any. */
  private remoteWatcher(): RemoteTaskWatcher | undefined {
    const a = this.agentModule?.getAttachedAgent() as WatcherBackedAgent | undefined;
    const w = (a as any)?.watcher;
    return w?.isRemoteWorkerWatcher ? (w as RemoteTaskWatcher) : undefined;
  }

  private lastCtrlC = 0;

  async initialize(service: any): Promise<void> {
    await super.initialize(service);
    // Ctrl-C while attached to a remote worker task detaches (never kills it).
    InputQueueManager.ctrlCInterceptor = () => {
      const now = Date.now();
      // readline emits SIGINT *and* a raw keypress for the same Ctrl-C
      if (now - this.lastCtrlC < 400) return true;
      if (!this.remoteWatcher()) return false;
      this.lastCtrlC = now;
      void this.chatService.processInput("/detach");
      return true;
    };
    this.agentModule?.onUserDetach((agent, reason) => {
      const w = (agent as any)?.watcher;
      if (!w?.isRemoteWorkerWatcher) return;
      const watcher = w as RemoteTaskWatcher;
      const ctx = this.ctx;
      if (reason === "kill") {
        console.log(`🛑 Killed remote task ${watcher.taskId}.`);
      } else {
        console.log(watcher.detachMessage());
      }
      const forked = (ctx.activeWorker as ActiveWorker | undefined)?.forkedSandboxId;
      if (forked) {
        console.log(
          `   ⚠️ Forked sandbox ${forked} is still running (billed). Destroy it when done: /worker off  or  knowhow sandbox delete ${forked}`
        );
        return; // keep activeWorker so /worker off can still clean the fork up
      }
      if (ctx.activeWorker?.id === watcher.workerId) ctx.activeWorker = undefined;
    });
  }

  /** Mirror a remote task into the chat and route typed messages to it. */
  async attachRemote(
    w: ActiveWorker,
    taskId: string,
    opts: {
      replayLast?: number;
      sentTexts?: string[];
      awaitRunning?: boolean;
      logPath?: string;
    } = {}
  ): Promise<void> {
    const watcher = new RemoteTaskWatcher({
      workerId: w.id,
      workerName: w.name,
      replayLast: opts.replayLast,
      sentTexts: opts.sentTexts,
      awaitRunning: opts.awaitRunning,
      logPath: opts.logPath,
    });
    const existing = this.agentModule.getActiveSyncedWatcher();
    if (existing) existing.stopWatching();
    await watcher.startWatching(taskId);
    this.agentModule.setActiveSyncedWatcher(watcher);
    const ctx = this.ctx;
    ctx.activeAgentTaskId = taskId;
    w.taskId = taskId;
    await this.agentModule.attachedAgentChatLoop(
      taskId,
      new WatcherBackedAgent(watcher)
    );
    watcher.flushReplay();
  }

  /** /workers: choose a worker (launching it if stopped), then attach. */
  async handleWorkersCommand(args: string[] = []): Promise<void> {
    try {
      const parsed = parseAttachArgs(args);
      const ask = async (p: string) => this.chatService.getInput(p);
      const prepared = await prepareWorkerForAttach(parsed, ask);
      if (!prepared) return;
      const w: ActiveWorker = {
        id: prepared.id,
        name: prepared.name,
        os: prepared.os ?? "unknown",
        root: prepared.root,
        taskId: undefined,
        cloudWorkerId: prepared.cloudWorkerId,
        forkedSandboxId: prepared.forkedSandboxId,
      };
      this.ctx.activeWorker = w;
      console.log(`🛰️ Attached to ${w.name}. /detach to leave the remote agent running.`);
      if (prepared.forkedSandboxId) {
        console.log(
          `   ⚠️ Forked sandbox ${prepared.forkedSandboxId} is billed until destroyed: /worker off (or knowhow sandbox delete) when done.`
        );
      }
      if (parsed.task) {
        await this.attachRemote(w, parsed.task, { replayLast: 6 });
      } else if (parsed.prompt) {
        await this.startAndAttach(w, parsed.prompt);
      } else {
        console.log("   Type your first message to start a remote agent on it.");
      }
    } catch (e: any) {
      console.error(`❌ ${e?.message ?? String(e)}`);
    }
  }

  /** Start (or resume) a remote task with `prompt`, then mirror it. */
  private async startAndAttach(w: ActiveWorker, prompt: string): Promise<void> {
    const context = this.ctx;
    const { startRemoteAgentTask, waitForRemoteTaskRunning } = await import(
      "../../services/RemoteWorkers"
    );
    let agentName: string | undefined;
    if (context.agentMode && context.currentAgent) agentName = context.currentAgent;
    if (!agentName) {
      try {
        const cfg: any = await getConfig();
        agentName = cfg?.chat?.defaultAgent ?? undefined;
      } catch (_) {}
    }
    // Sandbox cloud workers (esp. fresh forks) may have no provider mapping in
    // their config; they always have the Knowhow provider via their JWT.
    const provider = w.cloudWorkerId ? "knowhow" : undefined;
    let taskId: string | undefined;
    let resumed = false;
    let logPath: string | undefined;
    if (w.taskId) {
      try {
        const r = await startRemoteAgentTask({
          worker: w.id,
          prompt,
          agentName,
          provider,
          resumeTaskId: w.taskId,
        });
        taskId = r.taskId;
        logPath = r.startResult?.logPath;
        resumed = true;
      } catch (e: any) {
        console.warn(
          `⚠️ could not resume remote task (${e?.message ?? String(e)}); starting a new one`
        );
      }
    }
    if (!taskId) {
      const r = await startRemoteAgentTask({
        worker: w.id,
        prompt,
        agentName,
        provider,
      });
      taskId = r.taskId;
      logPath = r.startResult?.logPath;
    }
    console.log(`🛰️ ${w.name}: task ${taskId}`);
    context.chatHistory?.push({ input: prompt, output: "", taskId } as any);
    if (resumed) {
      const running = await waitForRemoteTaskRunning(taskId);
      if (!running) {
        console.warn("⚠️ remote task did not report running yet; attaching anyway");
      }
    }
    await this.attachRemote(w, taskId, {
      sentTexts: [prompt],
      awaitRunning: resumed,
      logPath,
    });
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
        const forked = (ctx.activeWorker as ActiveWorker | undefined)?.forkedSandboxId;
        if (forked) {
          const ans = (
            (await this.chatService.getInput(
              `Destroy the forked sandbox ${forked}? [Y/n]: `
            )) || ""
          ).trim();
          if (!/^n/i.test(ans)) {
            await destroyForkedSandbox(forked);
            console.log(`🗑️ Destroyed forked sandbox ${forked}.`);
          } else {
            console.log(`Left forked sandbox ${forked} running.`);
          }
        }
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
    // Already mirroring a remote task: AgentModule forwards the message to it.
    if (this.remoteWatcher()) return false;

    try {
      await this.startAndAttach(w, input);
    } catch (e: any) {
      console.error(`❌ Remote worker error: ${e?.message ?? String(e)}`);
    }
    return true;
  }
}
