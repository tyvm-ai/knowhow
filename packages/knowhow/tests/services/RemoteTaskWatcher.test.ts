const mockClient: any = {
  getTaskDetails: jest.fn(),
  sendMessageToAgent: jest.fn(),
  killAgent: jest.fn(),
  pauseAgent: jest.fn(),
  resumeAgent: jest.fn(),
  createSessionPlaceholder: jest.fn(),
  createMessagePlaceholder: jest.fn(),
  callWorkerToolRaw: jest.fn(),
  listOrgWorkers: jest.fn(),
};

jest.mock("../../src/services/KnowhowClient", () => ({
  KnowhowSimpleClient: class {
    constructor() {
      return mockClient;
    }
  },
}));

import {
  RemoteThreadCursor,
  RemoteTaskWatcher,
  nextPollInterval,
  taskSignature,
  isTerminalTask,
} from "../../src/services/RemoteTaskWatcher";

const user = (t: string) => ({ role: "user", content: t });
const asst = (t: string, tool_calls?: any[]) => ({ role: "assistant", content: t, tool_calls });
const tc = (id: string, name: string, args = "{}") => ({ id, function: { name, arguments: args } });
const tool = (name: string, content: string) => ({ role: "tool", name, content, tool_call_id: "x" });

describe("RemoteThreadCursor", () => {
  it("emits each new message exactly once", () => {
    const c = new RemoteThreadCursor("t1");
    c.seed([[user("hi")]]);
    expect(c.next([[user("hi")]])).toEqual([]);

    const t2 = [[user("hi"), asst("thinking", [tc("1", "readFile", '{"p":"a"}')])]];
    const e2 = c.next(t2);
    expect(e2.map((e) => e.type)).toEqual(["agentSay", "toolCall"]);

    // same threads again → nothing new
    expect(c.next(t2)).toEqual([]);

    const t3 = [[...t2[0], tool("readFile", "contents"), asst("done")]];
    const e3 = c.next(t3);
    expect(e3.map((e) => e.type)).toEqual(["toolUsed", "agentSay"]);
    expect((e3[1] as any).payload.message).toBe("done");
  });

  it("skips user messages we sent ourselves but shows others", () => {
    const c = new RemoteThreadCursor("t1");
    c.seed([[]]);
    const sent = new Set(["do it"]);
    const ev = c.next([[user("do it"), user("someone else")]], sent);
    expect(ev).toHaveLength(1);
    expect((ev[0] as any).payload.message).toBe("🧑 someone else");
  });

  it("handles a new thread (compaction) by diffing the last thread", () => {
    const c = new RemoteThreadCursor("t1");
    c.seed([[user("a"), asst("b")]]);
    const ev = c.next([[user("a"), asst("b")], [asst("summary"), asst("next")]]);
    expect(ev.map((e) => (e as any).payload.message)).toEqual(["summary", "next"]);
  });

  it("replayLast replays only the tail of existing history on attach", () => {
    const c = new RemoteThreadCursor("t1");
    const threads = [[user("1"), asst("2"), asst("3"), asst("4")]];
    c.seed(threads, 2);
    const ev = c.next(threads);
    expect(ev.map((e) => (e as any).payload.message)).toEqual(["3", "4"]);
    expect(c.next(threads)).toEqual([]);
  });
});

describe("poll helpers", () => {
  it("backs off when idle and resets on activity", () => {
    expect(nextPollInterval(1500, false)).toBe(2250);
    expect(nextPollInterval(2250, false)).toBe(3375);
    expect(nextPollInterval(5000, false)).toBe(6000);
    expect(nextPollInterval(6000, false)).toBe(6000);
    expect(nextPollInterval(6000, true)).toBe(1500);
  });
  it("terminal detection + signature", () => {
    expect(isTerminalTask({ status: "completed" })).toBe(true);
    expect(isTerminalTask({ status: "running" })).toBe(false);
    expect(isTerminalTask({ inProgress: false })).toBe(true);
    expect(taskSignature({ status: "running", updatedAt: "a", totalUsdCost: 1 })).not.toBe(
      taskSignature({ status: "running", updatedAt: "b", totalUsdCost: 1 })
    );
  });
});

describe("RemoteTaskWatcher polling", () => {
  beforeEach(() => jest.resetAllMocks());

  it("fetches threads only when the status changed and emits done on completion", async () => {
    const base = { taskId: "t1", inProgress: true, status: "running", totalUsdCost: 0, updatedAt: "u1" };
    const calls: boolean[] = [];
    let phase = 0;
    mockClient.getTaskDetails.mockImplementation(async (_id: string, includeThreads: boolean) => {
      calls.push(includeThreads);
      if (phase === 0) return { data: { ...base, threads: [[user("hi")]] } };
      if (phase === 1) return { data: { ...base, threads: includeThreads ? [[user("hi")]] : undefined } };
      if (phase === 2)
        return {
          data: {
            ...base,
            updatedAt: "u2",
            threads: includeThreads ? [[user("hi"), asst("working")]] : undefined,
          },
        };
      return {
        data: {
          ...base,
          updatedAt: "u3",
          status: "completed",
          inProgress: false,
          result: "FINAL",
          threads: includeThreads ? [[user("hi"), asst("working"), asst("FINAL")]] : undefined,
        },
      };
    });

    const w = new RemoteTaskWatcher({ workerId: "w1", workerName: "wk", client: mockClient, pollMinMs: 10, pollMaxMs: 20 });
    const said: string[] = [];
    let done: any;
    w.agentEvents.on(w.eventTypes.agentSay, (p: any) => said.push(p.message));
    w.agentEvents.on(w.eventTypes.done, (r: any) => (done = r));
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    await w.startWatching("t1"); // baseline fetch (with threads)
    log.mockRestore();
    expect(w.threadFetches).toBe(1);
    w.stopWatching();

    // phase 1: unchanged → status-only poll, no thread fetch
    (w as any).stopped = false;
    phase = 1;
    calls.length = 0;
    await w.poll();
    expect(calls).toEqual([false]);
    expect(w.threadFetches).toBe(1);

    // phase 2: updatedAt changed → fetch threads, emit only the new message
    phase = 2;
    calls.length = 0;
    await w.poll();
    expect(calls).toEqual([false, true]);
    expect(said).toEqual(["working"]);

    // phase 3: completed → final message once + done
    phase = 3;
    const terminal = await w.poll();
    expect(terminal).toBe(true);
    expect(said).toEqual(["working", "FINAL"]);
    expect(done).toBe("FINAL");
    w.stopWatching();
  });

  it("awaitRunning ignores a stale completed status until the task shows activity", async () => {
    const stale = { taskId: "t1", inProgress: false, status: "completed", totalUsdCost: 0, updatedAt: "u1" };
    let phase = 0;
    mockClient.getTaskDetails.mockImplementation(async (_id: string, inc: boolean) => {
      if (phase === 0) return { data: { ...stale, threads: [[user("old"), asst("old answer")]] } };
      if (phase === 1) return { data: { ...stale, threads: inc ? [[user("old"), asst("old answer")]] : undefined } };
      return {
        data: { ...stale, updatedAt: "u2", threads: inc ? [[user("old"), asst("old answer"), asst("new answer")]] : undefined },
      };
    });
    const w = new RemoteTaskWatcher({ workerId: "w", workerName: "wk", client: mockClient, awaitRunning: true, pollMinMs: 10 });
    let done: any;
    w.agentEvents.on(w.eventTypes.done, (r: any) => (done = r));
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    await w.startWatching("t1");
    log.mockRestore();
    w.stopWatching();
    (w as any).stopped = false;
    phase = 1;
    expect(await w.poll()).toBe(false); // stale completed → not terminal
    expect(done).toBeUndefined();
    phase = 2;
    expect(await w.poll()).toBe(true); // updatedAt changed → real completion
    expect(done).toBeDefined();
    w.stopWatching();
  });

  it("sendMessage resumes a finished task on the worker, otherwise just sends", async () => {
    const w = new RemoteTaskWatcher({ workerId: "w1", workerName: "wk", client: mockClient });
    w.taskId = "11111111-1111-4111-8111-111111111111";

    mockClient.getTaskDetails.mockResolvedValue({ data: { status: "running", inProgress: true } });
    await w.sendMessage("hello");
    expect(mockClient.sendMessageToAgent).toHaveBeenCalledWith(w.taskId, "hello");
    w.stopWatching();
  });

  it("detach message tells how to re-attach", () => {
    const w = new RemoteTaskWatcher({ workerId: "w1", workerName: "Knowhow-web", client: mockClient });
    w.taskId = "tid";
    expect(w.detachMessage()).toMatch(/knowhow workers attach Knowhow-web --task tid/);
    expect(w.statusLine()).toMatch(/Knowhow-web/);
  });
});
