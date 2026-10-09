import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AgentFsChannel,
  AgentSession,
  MirrorAgentWatcher,
  ProcessMirror,
  ThreadDiffer,
  agentProjection,
} from "../../../src/services/stateful";
import { EventService } from "../../../src/services/EventService";
import { FakeAgent, waitFor } from "../stateful/agent/fakeAgent";

const retained = { role: "assistant", content: "before compaction" };
const oldThread = [
  { role: "system", content: "instructions" },
  { role: "user", content: "task" },
  retained,
];
const compactedThread = [
  { role: "system", content: "instructions" },
  { role: "user", content: "compressed summary" },
  retained,
  { role: "assistant", content: "after compaction" },
];

// The thread diff that FsSyncer and RemoteSyncer each duplicated is now ThreadDiffer.
describe("ThreadDiffer thread rollover", () => {
  it("continues after compaction (a new thread that retains the last message)", () => {
    const d = new ThreadDiffer([oldThread]);
    const fresh = d.next([oldThread, compactedThread]);
    expect(fresh.map((m) => m.content)).toEqual(["after compaction"]);
    expect(d.state.index).toBe(1);
    expect(d.state.length).toBe(compactedThread.length);
  });

  it("resets a cursor when a thread shrinks without changing index", () => {
    const d = new ThreadDiffer([[...oldThread, ...oldThread, ...oldThread, ...oldThread]]);
    const fresh = d.next([compactedThread]);
    expect(fresh.map((m) => m.content)).toEqual(["after compaction"]);
    expect(d.state.length).toBe(compactedThread.length);
  });

  it("only returns the growth of the last thread", () => {
    const d = new ThreadDiffer([oldThread]);
    expect(d.next([[...oldThread, { role: "assistant", content: "more" }]]).map((m) => m.content)).toEqual(["more"]);
    expect(d.next([[...oldThread, { role: "assistant", content: "more" }]])).toEqual([]);
  });
});

describe("agentProjection over a mirror", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-mirror-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("attaches mid-run to an fs task, renders only new messages, sends control + input, sees done", async () => {
    const agent = new FakeAgent();
    const session = await AgentSession.create({
      agent: agent as any,
      taskId: "t1",
      prompt: "do it",
      channels: [new AgentFsChannel({ taskId: "t1", baseDir: dir, pollMs: 20 })],
    });
    const run = session.start();
    await waitFor(() => session.getState().threads.length === 1);
    await session.flush();

    // another "process" attaches mid-run
    const source = new AgentFsChannel({ taskId: "t1", baseDir: dir, pollMs: 20 });
    const mirror = await ProcessMirror.open(source as any);
    expect(mirror.getState().threads[0].map((m: any) => m.content)).toEqual(["do it"]);

    const events = new EventService();
    const said: string[] = [];
    let done: unknown;
    events.on("agent:say", (d: any) => said.push(d.message));
    events.on("done", (r: unknown) => (done = r));
    agentProjection(mirror as any, events);

    // control through the mirror reaches the running agent via status.txt
    await mirror.pause();
    await waitFor(() => agent.paused);
    await session.flush(); // "pausing…" is over: the owner published "paused"
    await mirror.resume();
    await waitFor(() => !agent.paused);
    // input through the mirror is an input.txt record
    await mirror.send("message", { text: "from mirror" });
    await waitFor(() => agent.pendingUser.length === 1);
    expect(agent.pendingUser[0].content).toBe("from mirror");

    agent.release();
    await run;
    await session.flush();
    await waitFor(() => done !== undefined, 5000);
    expect(done).toBe("ok");
    expect(said).toEqual(["from mirror", "ok"]); // only what happened after the attach
    mirror.close();
    await session.close();
  });

  it("MirrorAgentWatcher is a SyncedAgentWatcher over any mirror", async () => {
    const agent = new FakeAgent();
    const session = await AgentSession.create({
      agent: agent as any,
      taskId: "t2",
      prompt: "go",
      channels: [new AgentFsChannel({ taskId: "t2", baseDir: dir, pollMs: 20 })],
    });
    const run = session.start();
    await waitFor(() => session.getState().threads.length === 1);
    await session.flush();
    const watcher = new MirrorAgentWatcher((id) => new AgentFsChannel({ taskId: id, baseDir: dir, pollMs: 20 }));
    const log = console.log;
    console.log = () => {};
    try {
      await watcher.startWatching("t2");
      expect((await watcher.getThreads())[0].map((m: any) => m.content)).toEqual(["go"]);
      await watcher.interrupt("poke!");
      await waitFor(() => agent.interrupts.includes("poke!"));
      agent.release();
      await run;
      await session.close();
    } finally {
      console.log = log;
      watcher.stopWatching();
    }
  });
});
