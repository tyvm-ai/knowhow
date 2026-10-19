const mockClient: any = {
  listOrgWorkers: jest.fn(),
  callWorkerToolRaw: jest.fn(),
  listWorkerTools: jest.fn(),
  createSessionPlaceholder: jest.fn(),
  createMessagePlaceholder: jest.fn(),
  getTaskDetails: jest.fn(),
  sendMessageToAgent: jest.fn(),
  killAgent: jest.fn(),
};

jest.mock("../../src/services/KnowhowClient", () => ({
  KnowhowSimpleClient: class {
    constructor() {
      return mockClient;
    }
  },
}));

import {
  parseWorkerUserAgent,
  inferWorkerOs,
  listRemoteWorkers,
  resolveWorker,
  callWorkerTool,
  unwrapToolResponse,
  startRemoteAgentTask,
  waitForRemoteTask,
  isRemoteTaskId,
  stripRemotePrefix,
  execOnWorker,
  extractRemoteFinalAnswer,
  formatWorkerTable,
  _clearToolNameCache,
  waitForRemoteTaskRunning,
} from "../../src/services/RemoteWorkers";

const ID_WIN = "4054aa1d-aaaa-4bbb-8ccc-111111111111";
const ID_MAC = "470a479c-aaaa-4bbb-8ccc-222222222222";
const ID_MAC2 = "470b0000-aaaa-4bbb-8ccc-333333333333";
const ID_OFF = "d59c4317-aaaa-4bbb-8ccc-444444444444";
const UUID = "e8dd1d92-2f9e-4eab-91e9-d2b701746427";

function info(over: any) {
  return {
    id: "x",
    orgId: "o",
    userId: "u",
    socketId: "s",
    userAgent: "knowhow-worker/1.1.1/HOST",
    fsRoot: "~",
    connected: true,
    lastConnected: "2026-01-01T00:00:00Z",
    shared: false,
    cloudWorkerId: null,
    ...over,
  };
}

const WORKERS = [
  info({
    id: ID_WIN,
    userAgent: "knowhow-worker/1.1.1/DESKTOP-QRLHKTL",
    fsRoot: "~\\dev\\poecraft",
    lastConnected: "2026-01-02T00:00:00Z",
  }),
  info({
    id: ID_MAC,
    userAgent: "knowhow-worker/1.1.1/Mac.lan",
    fsRoot: "~/dev/poeflip",
  }),
  info({
    id: ID_OFF,
    userAgent: "knowhow-worker/1.1.1/old-box",
    fsRoot: "/home/x/proj",
    connected: false,
  }),
  info({
    id: "ffffffff-aaaa-4bbb-8ccc-555555555555",
    userAgent: "browser/1.0/browserhost",
    clientKind: "browser",
    ephemeral: true,
  }),
];

beforeEach(() => {
  jest.resetAllMocks();
  _clearToolNameCache();
  mockClient.listOrgWorkers.mockResolvedValue({ data: WORKERS });
});

describe("parseWorkerUserAgent / inferWorkerOs", () => {
  it("parses ua", () => {
    expect(parseWorkerUserAgent("knowhow-worker/1.1.1/Micahs-MacBook-Pro.local")).toEqual({
      client: "knowhow-worker",
      version: "1.1.1",
      hostname: "Micahs-MacBook-Pro.local",
    });
    expect(parseWorkerUserAgent("knowhow-worker/host")).toEqual({
      client: "knowhow-worker",
      hostname: "host",
    });
    expect(parseWorkerUserAgent("")).toEqual({ client: "" });
  });
  it("infers os", () => {
    expect(inferWorkerOs("C:\\Users\\a\\proj")).toBe("windows");
    expect(inferWorkerOs("C:/Users/a/proj")).toBe("windows");
    expect(inferWorkerOs("~\\dev")).toBe("windows");
    expect(inferWorkerOs("/home/a/proj")).toBe("posix");
    expect(inferWorkerOs("~")).toBe("posix");
    expect(inferWorkerOs("weird")).toBe("unknown");
  });
});

describe("listRemoteWorkers", () => {
  it("filters offline + clients by default, sorts online first", async () => {
    const ws = await listRemoteWorkers(mockClient);
    expect(ws.map((w) => w.id)).toEqual([ID_WIN, ID_MAC]);
    expect(ws[0].name).toBe("DESKTOP-QRLHKTL");
    expect(ws[0].os).toBe("windows");
    expect(ws[0].folder).toBe("poecraft");
  });
  it("--all includes offline but still no clients", async () => {
    const ws = await listRemoteWorkers(mockClient, { all: true });
    expect(ws.map((w) => w.id)).toEqual([ID_WIN, ID_MAC, ID_OFF]);
    expect(ws[2].connected).toBe(false);
  });
  it("formats a table", async () => {
    const ws = await listRemoteWorkers(mockClient, { all: true });
    const t = formatWorkerTable(ws);
    expect(t).toMatch(/ID\s+NAME\s+OS\s+STATUS/);
    expect(t).toMatch(/4054aa1d\s+DESKTOP-QRLHKTL\s+win\s+online/);
    expect(t).toMatch(/offline/);
  });
});

describe("resolveWorker", () => {
  it("exact id", async () => {
    expect((await resolveWorker(ID_WIN, mockClient)).id).toBe(ID_WIN);
  });
  it("id prefix", async () => {
    expect((await resolveWorker("4054", mockClient)).id).toBe(ID_WIN);
  });
  it("exact name case-insensitive", async () => {
    expect((await resolveWorker("mac.lan", mockClient)).id).toBe(ID_MAC);
  });
  it("substring of name", async () => {
    expect((await resolveWorker("DESKTOP", mockClient)).id).toBe(ID_WIN);
  });
  it("name:folder when several share a host", async () => {
    mockClient.listOrgWorkers.mockResolvedValue({
      data: [
        info({ id: ID_MAC, userAgent: "knowhow-worker/1/Mac.lan", fsRoot: "~/a" }),
        info({ id: ID_MAC2, userAgent: "knowhow-worker/1/Mac.lan", fsRoot: "~/b" }),
      ],
    });
    expect((await resolveWorker("Mac.lan:b", mockClient)).id).toBe(ID_MAC2);
    await expect(resolveWorker("Mac.lan", mockClient)).rejects.toThrow(
      /ambiguous[\s\S]*470a479c[\s\S]*470b0000/
    );
  });
  it("prefers the online worker among name matches", async () => {
    mockClient.listOrgWorkers.mockResolvedValue({
      data: [
        info({ id: ID_MAC, userAgent: "knowhow-worker/1/Mac.lan", connected: false }),
        info({ id: ID_MAC2, userAgent: "knowhow-worker/1/Mac.lan" }),
      ],
    });
    expect((await resolveWorker("Mac.lan", mockClient)).id).toBe(ID_MAC2);
  });
  it("offline worker errors unless allowOffline", async () => {
    await expect(resolveWorker("old-box", mockClient)).rejects.toThrow(/offline/);
    expect(
      (await resolveWorker("old-box", mockClient, { allowOffline: true })).id
    ).toBe(ID_OFF);
  });
  it("no match errors with hint", async () => {
    await expect(resolveWorker("nothing", mockClient)).rejects.toThrow(
      /No worker matches 'nothing'.*workers list --all/
    );
  });
});

describe("unwrapToolResponse / callWorkerTool", () => {
  it("unwraps functionResp strings (JSON) and objects", () => {
    expect(unwrapToolResponse({ functionResp: '{"a":1}' })).toEqual({ a: 1 });
    expect(unwrapToolResponse({ functionResp: "plain text" })).toBe("plain text");
    expect(unwrapToolResponse({ functionResp: { b: 2 } })).toEqual({ b: 2 });
  });
  it("maps WORKER_LOCKED", () => {
    expect(() =>
      unwrapToolResponse({ functionResp: { error: "WORKER_LOCKED" } })
    ).toThrow(/locked/i);
  });
  it("uses worker_0_ prefix first", async () => {
    mockClient.callWorkerToolRaw.mockResolvedValue({
      data: { functionResp: "ok" },
    });
    const r = await callWorkerTool(mockClient, ID_WIN, "execCommand", { command: "ver" });
    expect(r).toBe("ok");
    expect(mockClient.callWorkerToolRaw).toHaveBeenCalledWith(
      ID_WIN,
      "worker_0_execCommand",
      { command: "ver" }
    );
    expect(mockClient.listWorkerTools).not.toHaveBeenCalled();
  });
  it("falls back to listWorkerTools suffix match on not-found", async () => {
    mockClient.callWorkerToolRaw
      .mockRejectedValueOnce(
        Object.assign(new Error("HTTP 400"), {
          status: 400,
          body: { message: "Tool worker_0_execCommand not found" },
        })
      )
      .mockResolvedValueOnce({ data: { functionResp: "second" } });
    mockClient.listWorkerTools.mockResolvedValue({
      data: [{ type: "function", function: { name: "worker_1_execCommand" } }],
    });
    const r = await callWorkerTool(mockClient, ID_WIN, "execCommand", {});
    expect(r).toBe("second");
    expect(mockClient.callWorkerToolRaw).toHaveBeenLastCalledWith(
      ID_WIN,
      "worker_1_execCommand",
      {}
    );
    // cached on the next call
    mockClient.callWorkerToolRaw.mockResolvedValueOnce({ data: { functionResp: "third" } });
    await callWorkerTool(mockClient, ID_WIN, "execCommand", {});
    expect(mockClient.callWorkerToolRaw).toHaveBeenLastCalledWith(
      ID_WIN,
      "worker_1_execCommand",
      {}
    );
  });
  it("throws a helpful error when the tool is absent", async () => {
    mockClient.callWorkerToolRaw.mockRejectedValue(
      Object.assign(new Error("HTTP 400"), {
        status: 400,
        body: { message: "tool not found" },
      })
    );
    mockClient.listWorkerTools.mockResolvedValue({ data: [] });
    await expect(
      callWorkerTool(mockClient, ID_WIN, "startAgentTask", {})
    ).rejects.toThrow(/not exposed by this worker.*allowedTools/);
  });
  it("does not retry on other errors", async () => {
    mockClient.callWorkerToolRaw.mockRejectedValue(new Error("boom"));
    await expect(callWorkerTool(mockClient, ID_WIN, "x", {})).rejects.toThrow(/boom/);
    expect(mockClient.listWorkerTools).not.toHaveBeenCalled();
  });
});

describe("execOnWorker", () => {
  it("handles string and object responses", async () => {
    mockClient.callWorkerToolRaw.mockResolvedValueOnce({ data: { functionResp: "hello" } });
    expect((await execOnWorker(mockClient, ID_WIN, "echo hello")).stdout).toBe("hello");
    mockClient.callWorkerToolRaw.mockResolvedValueOnce({
      data: { functionResp: { stdout: "o", stderr: "e", exitCode: 3 } },
    });
    const r = await execOnWorker(mockClient, ID_WIN, "x");
    expect(r).toMatchObject({ stdout: "o", stderr: "e", exitCode: 3 });
  });
});

describe("startRemoteAgentTask", () => {
  beforeEach(() => {
    mockClient.createSessionPlaceholder.mockResolvedValue({ sessionId: "sess-1" });
    mockClient.createMessagePlaceholder.mockResolvedValue({ messageId: "msg-1", taskId: UUID });
    mockClient.callWorkerToolRaw.mockResolvedValue({
      data: { functionResp: { success: true, status: "started", taskId: UUID } },
    });
  });

  it("creates placeholders then calls startAgentTask with the placeholder task id", async () => {
    const order: string[] = [];
    mockClient.createSessionPlaceholder.mockImplementation(async () => {
      order.push("session");
      return { sessionId: "sess-1" };
    });
    mockClient.createMessagePlaceholder.mockImplementation(async () => {
      order.push("message");
      return { messageId: "msg-1", taskId: UUID };
    });
    mockClient.callWorkerToolRaw.mockImplementation(async () => {
      order.push("tool");
      return { data: { functionResp: { success: true } } };
    });
    const r = await startRemoteAgentTask(
      { worker: "DESKTOP", prompt: "do it", agentName: "Patcher", maxTimeLimit: 5 },
      mockClient
    );
    expect(order).toEqual(["session", "message", "tool"]);
    expect(r).toMatchObject({
      taskId: UUID,
      workerId: ID_WIN,
      workerName: "DESKTOP-QRLHKTL",
      sessionId: "sess-1",
      resumed: false,
    });
    expect(mockClient.createSessionPlaceholder).toHaveBeenCalledWith(
      expect.objectContaining({ workerId: ID_WIN, title: "do it" })
    );
    expect(mockClient.callWorkerToolRaw).toHaveBeenCalledWith(
      ID_WIN,
      "worker_0_startAgentTask",
      {
        prompt: "do it",
        taskId: UUID,
        syncRemote: true,
        syncFs: true,
        agentName: "Patcher",
        maxTimeLimit: 5,
      }
    );
  });

  it("resume skips placeholders and passes resume:true", async () => {
    const r = await startRemoteAgentTask(
      { worker: ID_WIN, prompt: "more", resumeTaskId: "remote:" + UUID },
      mockClient
    );
    expect(r.resumed).toBe(true);
    expect(r.taskId).toBe(UUID);
    expect(mockClient.createSessionPlaceholder).not.toHaveBeenCalled();
    expect(mockClient.createMessagePlaceholder).not.toHaveBeenCalled();
    expect(mockClient.callWorkerToolRaw.mock.calls[0][2]).toMatchObject({
      taskId: UUID,
      resume: true,
    });
  });

  it("throws when the backend returns no taskId", async () => {
    mockClient.createMessagePlaceholder.mockResolvedValue({ messageId: "m" });
    await expect(
      startRemoteAgentTask({ worker: ID_WIN, prompt: "x" }, mockClient)
    ).rejects.toThrow(/taskId/);
    expect(mockClient.callWorkerToolRaw).not.toHaveBeenCalled();
  });

  it("surfaces success:false errors with the worker log path", async () => {
    mockClient.callWorkerToolRaw.mockResolvedValue({
      data: { functionResp: { success: false, error: "spawn failed", logPath: "C:\\x\\log.txt" } },
    });
    await expect(
      startRemoteAgentTask({ worker: ID_WIN, prompt: "x" }, mockClient)
    ).rejects.toThrow(/spawn failed[\s\S]*C:\\x\\log\.txt/);
  });
});

describe("waitForRemoteTask", () => {
  const det = (over: any) => ({
    data: { taskId: UUID, status: "running", inProgress: true, totalUsdCost: 0.5, threads: [], ...over },
  });

  it("polls running -> completed and returns finalAnswer from result", async () => {
    mockClient.getTaskDetails
      .mockResolvedValueOnce(det({}))
      .mockResolvedValueOnce(det({ status: "completed", inProgress: false }))
      .mockResolvedValueOnce(det({ status: "completed", inProgress: false, result: "DONE" }));
    const r = await waitForRemoteTask(UUID, { client: mockClient, pollIntervalMs: 1 });
    expect(r).toMatchObject({ status: "completed", finalAnswer: "DONE", costUsd: 0.5 });
    expect(mockClient.getTaskDetails).toHaveBeenNthCalledWith(1, UUID, false);
    expect(mockClient.getTaskDetails).toHaveBeenNthCalledWith(3, UUID, true);
  }, 15000);

  it("returns killed status", async () => {
    mockClient.getTaskDetails.mockResolvedValue(det({ status: "killed", inProgress: false }));
    const r = await waitForRemoteTask(UUID, { client: mockClient });
    expect(r.status).toBe("killed");
  });

  it("falls back to finalAnswer tool message and then assistant text", () => {
    expect(
      extractRemoteFinalAnswer([
        [
          { role: "assistant", content: "thinking" },
          { role: "tool", name: "finalAnswer", content: "the answer" },
        ],
      ])
    ).toBe("the answer");
    expect(
      extractRemoteFinalAnswer([[{ role: "assistant", content: "last words" }]])
    ).toBe("last words");
    expect(
      extractRemoteFinalAnswer([
        [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { name: "finalAnswer", arguments: '{"answer":"from args"}' } },
            ],
          },
        ],
      ])
    ).toBe("from args");
  });

  it("fails when the agent never reports progress (startup timeout)", async () => {
    mockClient.getTaskDetails.mockResolvedValue(det({}));
    const r = await waitForRemoteTask(UUID, {
      client: mockClient,
      startupTimeoutMs: 1,
      pollIntervalMs: 1,
    });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/never reported progress/);
  }, 15000);

  it("times out with timedOut:true", async () => {
    mockClient.getTaskDetails.mockResolvedValue(
      det({ threads: [[{ role: "user", content: "x" }]] })
    );
    const r = await waitForRemoteTask(UUID, {
      client: mockClient,
      timeoutMs: 50,
      pollIntervalMs: 1,
    });
    expect(r.timedOut).toBe(true);
    expect(r.status).toBe("running");
  }, 15000);
});

describe("remote task id helpers", () => {
  it("detects UUIDs", () => {
    expect(isRemoteTaskId(UUID)).toBe(true);
    expect(isRemoteTaskId("remote:" + UUID)).toBe(true);
    expect(isRemoteTaskId("1792378634-some-local-task")).toBe(false);
    expect(stripRemotePrefix("remote:" + UUID)).toBe(UUID);
  });
});

describe("waitForRemoteTaskRunning", () => {
  it("returns true once the task is running again", async () => {
    mockClient.getTaskDetails
      .mockResolvedValueOnce({ data: { status: "completed", inProgress: false } })
      .mockResolvedValueOnce({ data: { status: "running", inProgress: true } });
    expect(
      await waitForRemoteTaskRunning(UUID, { client: mockClient, pollIntervalMs: 1 })
    ).toBe(true);
  }, 15000);
  it("returns false on timeout", async () => {
    mockClient.getTaskDetails.mockResolvedValue({ data: { status: "completed", inProgress: false } });
    expect(
      await waitForRemoteTaskRunning(UUID, { client: mockClient, timeoutMs: 30, pollIntervalMs: 1 })
    ).toBe(false);
  }, 15000);
});
