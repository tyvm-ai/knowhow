import { EventService } from "../../../../src/services/EventService";

const eventTypes = {
  threadUpdate: "thread_update",
  toolCall: "tool:pre_call",
  toolUsed: "tool:post_call",
  agentSay: "agent:say",
  tokenUsage: "agent:tokenUsage",
  done: "done",
  pause: "pause",
  unpause: "unpause",
  kill: "kill",
};

/** Minimal BaseAgent stand-in: one long "tool call" the test can hold open. */
export class FakeAgent {
  name = "Fake";
  agentEvents = new EventService();
  eventTypes = eventTypes;
  threads: any[][] = [];
  pendingUser: any[] = [];
  paused = false;
  killed = false;
  interrupts: Array<string | undefined> = [];
  maxSpend: number | null = null;
  maxRunTime: number | null = null;
  compactRequested = false;
  release!: () => void;
  gate = new Promise<void>((r) => (this.release = r));
  sawMessages?: any[];

  getModel() { return "m"; }
  getProvider() { return "p"; }
  getReasoningEffort() { return undefined; }
  getSummarizeReasoning() { return undefined; }
  getEnabledToolNames() { return ["a"]; }
  getThreads() { return this.threads; }
  getTotalCostUsd() { return 0.5; }
  getTokenUsage() {
    return { totalInputTokens: 1, totalOutputTokens: 2, totalCacheReadTokens: 0, totalCacheWriteTokens: 0 };
  }
  getPendingUserMessageCount() { return this.pendingUser.length; }
  addPendingUserMessage(m: any) { this.pendingUser.push(m); }
  setMaxSpend(v: number | null) { this.maxSpend = v; }
  setMaxRunTime(v: number | null) { this.maxRunTime = v; }
  setMaxTurns() {}
  setParentTaskId() {}
  newTask() {}
  restoreEnabledTools() {}
  requestCompact() { this.compactRequested = true; }
  pause() { this.paused = true; this.agentEvents.emit("pause", this); }
  unpause() { this.paused = false; this.agentEvents.emit("unpause", this); }
  async kill() { this.killed = true; this.agentEvents.emit("kill", this); }
  interrupt(m?: string) {
    this.interrupts.push(m);
    if (m) this.addPendingUserMessage({ role: "user", content: m });
  }
  private update(thread: any[]) {
    this.threads[0] = thread;
    this.agentEvents.emit("thread_update", thread);
  }
  async call(prompt: any, messages?: any[]) {
    this.sawMessages = messages;
    const thread = messages ? [...messages] : [{ role: "user", content: prompt }];
    this.update(thread);
    await this.gate; // the long tool call
    while (this.paused) {
      await new Promise((r) => this.agentEvents.once("unpause", r));
    }
    thread.push(...this.pendingUser.splice(0));
    this.update(thread);
    thread.push({ role: "assistant", content: "ok" });
    this.update(thread);
    this.agentEvents.emit("done", "ok");
    return "ok";
  }
}

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 4000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

