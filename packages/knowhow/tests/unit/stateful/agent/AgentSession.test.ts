import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AgentFsChannel,
  AgentSession,
  appendInput,
  buildResumeMessages,
} from "../../../../src/services/stateful";
import { FakeAgent, waitFor } from "./fakeAgent";

describe("AgentSession (fs channel)", () => {
  let dir: string;
  let agentDir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-"));
    agentDir = path.join(dir, "t1");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const meta = () => JSON.parse(fs.readFileSync(path.join(agentDir, "metadata.json"), "utf8"));
  const status = () => fs.readFileSync(path.join(agentDir, "status.txt"), "utf8");

  async function make(extra: Partial<Parameters<typeof AgentSession.create>[0]> = {}) {
    const agent = new FakeAgent();
    const session = await AgentSession.create({
      agent: agent as any,
      taskId: "t1",
      parentTaskId: "parent-1",
      prompt: "do it",
      channels: [new AgentFsChannel({ taskId: "t1", baseDir: dir, pollMs: 20, input: { partialSettleMs: 50 } })],
      ...extra,
    });
    return { agent, session };
  }

  it("writes the legacy metadata.json / status.txt shape", async () => {
    const { agent, session } = await make();
    expect(meta()).toMatchObject({ taskId: "t1", agentName: "Fake", prompt: "do it", status: "running", parentTaskId: "parent-1" });
    expect(status()).toBe("running");
    agent.release();
    await session.start();
    await session.flush();
    const m = meta();
    expect(m).toMatchObject({
      taskId: "t1",
      pid: process.pid,
      agentName: "Fake",
      model: "m",
      provider: "p",
      enabledTools: ["a"],
      inProgress: false,
      status: "completed",
      result: "ok",
      totalCostUsd: 0.5,
    });
    expect(m.threads[0].map((x: any) => x.content)).toEqual(["do it", "ok"]);
    expect(typeof m.lastUpdate).toBe("string");
    expect(typeof m.startTime).toBe("string");
    expect(m.tokenUsage.totalOutputTokens).toBe(2);
    expect(status()).toBe("completed");
    await session.close();
  });

  it("delivers input.txt as a thread message with its cursor saved in the same write", async () => {
    const { agent, session } = await make();
    const run = session.start();
    await waitFor(() => session.getLifecycle().status === "running");
    appendInput(path.join(agentDir, "input.txt"), { text: "hello there" });
    appendInput(path.join(agentDir, "input.txt"), { text: "/poke wake up" });
    await waitFor(() => agent.pendingUser.length === 2);
    expect(agent.pendingUser.map((m) => m.content)).toEqual(["hello there", "wake up"]);
    expect(agent.interrupts).toEqual(["wake up"]);
    // message + cursor are persisted together, before the agent put it in the thread
    await waitFor(() => meta().pendingUserMessages?.length === 2 && !!meta().inputCursor);
    // once persisted, input.txt is trimmed (renamed away, never truncated) and the cursor reset
    await waitFor(() => !fs.existsSync(path.join(agentDir, "input.txt")));
    await waitFor(() => meta().inputCursor?.offset === 0);
    expect(meta().pendingUserMessages).toHaveLength(2); // still not in the thread: kept for crash recovery
    agent.release();
    await run;
    await session.flush();
    expect(meta().threads[0].map((x: any) => x.content)).toEqual(["do it", "hello there", "wake up", "ok"]);
    expect(meta().pendingUserMessages).toEqual([]);
    await session.close();
  });

  it("pauses and resumes via status.txt during a long tool call", async () => {
    const { agent, session } = await make();
    const run = session.start();
    await waitFor(() => session.getLifecycle().status === "running");
    fs.writeFileSync(path.join(agentDir, "status.txt"), "paused");
    await waitFor(() => session.getLifecycle().status === "paused");
    expect(agent.paused).toBe(true);
    await waitFor(() => status() === "paused");
    await waitFor(() => meta().status === "running"); // legacy: metadata never says paused
    await session.flush(); // the owner has published "paused" (a human sees it before resuming)
    fs.writeFileSync(path.join(agentDir, "status.txt"), "running");
    await waitFor(() => !agent.paused);
    await waitFor(() => session.getLifecycle().status === "running");
    agent.release();
    await run;
    await session.close();
  });

  it("maps status.txt killed to cancel and records a killed task", async () => {
    const { agent, session } = await make();
    const run = session.start();
    await waitFor(() => session.getLifecycle().status === "running");
    fs.writeFileSync(path.join(agentDir, "status.txt"), "killed");
    await waitFor(() => agent.killed);
    agent.release();
    await run;
    await session.flush();
    expect(session.getLifecycle().status).toBe("cancelled");
    expect(meta().status).toBe("killed");
    await session.close();
  });

  it("ignores unknown status.txt values", async () => {
    const { agent, session } = await make();
    const run = session.start();
    await waitFor(() => session.getLifecycle().status === "running");
    fs.writeFileSync(path.join(agentDir, "status.txt"), "banana");
    await new Promise((r) => setTimeout(r, 120));
    expect(session.getControl().desired).toBeUndefined();
    agent.release();
    await run;
    await session.close();
  });

  it("applies the spend / time limits and a remote spend control", async () => {
    const { agent, session } = await make({ limits: { maxSpendUsd: 2, maxRunTimeMs: 1000 } });
    expect(agent.maxSpend).toBe(2);
    expect(agent.maxRunTime).toBe(1000);
    session.applyControl({ maxSpendLimit: 5 });
    await session.flush();
    expect(agent.maxSpend).toBe(5);
    agent.release();
    await session.start();
    await session.close();
  });

  it("builds resume/fork messages with rollback and uses them as the request context", async () => {
    const threads = [
      [
        { role: "user", content: "task" },
        { role: "assistant", content: "a1" },
      ],
    ] as any;
    const msgs = buildResumeMessages(threads, 0, "continue please");
    expect(msgs[0].content).toContain("task");
    expect(msgs[0].content).toContain("[RESUME CONTEXT]: continue please");
    const { agent, session } = await make({
      prompt: "continue please",
      history: { mode: "resume", threads },
    });
    agent.release();
    await session.start();
    expect(agent.sawMessages?.[0].content).toContain("[RESUME CONTEXT]");
    await session.close();
  });
});
