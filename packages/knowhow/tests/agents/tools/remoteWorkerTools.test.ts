import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mockClient: any = {
  listOrgWorkers: jest.fn(),
  callWorkerToolRaw: jest.fn(),
  listWorkerTools: jest.fn(),
  createSessionPlaceholder: jest.fn(),
  createMessagePlaceholder: jest.fn(),
  getTaskDetails: jest.fn(),
  sendMessageToAgent: jest.fn(),
};

jest.mock("../../../src/services/KnowhowClient", () => ({
  KnowhowSimpleClient: class {
    constructor() {
      return mockClient;
    }
  },
}));

const mockSpawn = jest.fn();
jest.mock("child_process", () => ({
  ...jest.requireActual("child_process"),
  spawn: (...a: any[]) => mockSpawn(...a),
}));

import { startAgentTask } from "../../../src/agents/tools/startAgentTask";
import { waitForAgentCompleted } from "../../../src/agents/tools/waitForAgentCompleted";
import { sendAgentMessage } from "../../../src/agents/tools/sendAgentMessage";
import { listWorkers } from "../../../src/agents/tools/listWorkers";

const UUID = "e8dd1d92-2f9e-4eab-91e9-d2b701746427";
const WIN = "4054aa1d-aaaa-4bbb-8ccc-111111111111";
const MAC = "470a479c-aaaa-4bbb-8ccc-222222222222";

const workers = [
  {
    id: WIN,
    userAgent: "knowhow-worker/1/DESKTOP-QRLHKTL",
    fsRoot: "C:\\Users\\Micah\\dev\\poecraft",
    connected: true,
    lastConnected: "2026-01-02T00:00:00Z",
    shared: false,
    cloudWorkerId: null,
    user: { id: "u", email: "a@b.c", name: "Micah" },
  },
  {
    id: MAC,
    userAgent: "knowhow-worker/1/Mac.lan",
    fsRoot: "/Users/m/dev",
    connected: true,
    lastConnected: "2026-01-01T00:00:00Z",
    shared: true,
    cloudWorkerId: null,
  },
];

let tmpCwd: string;
let originalCwd: string;

beforeEach(() => {
  jest.resetAllMocks();
  originalCwd = process.cwd();
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "remote-tools-"));
  process.chdir(tmpCwd);
  mockClient.listOrgWorkers.mockResolvedValue({ data: workers });
  mockClient.createSessionPlaceholder.mockResolvedValue({ sessionId: "s1" });
  mockClient.createMessagePlaceholder.mockResolvedValue({ messageId: "m1", taskId: UUID });
  mockClient.callWorkerToolRaw.mockResolvedValue({
    data: { functionResp: { success: true, status: "started" } },
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

describe("startAgentTask {worker}", () => {
  it("starts remotely, returns remote:true, and never spawns locally", async () => {
    const r = await startAgentTask({ prompt: "hi", worker: "DESKTOP" });
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      success: true,
      status: "started",
      remote: true,
      taskId: UUID,
      remoteTaskId: UUID,
      workerId: WIN,
      workerName: "DESKTOP-QRLHKTL",
      sessionId: "s1",
    });
    expect(mockClient.callWorkerToolRaw.mock.calls[0][1]).toBe("worker_0_startAgentTask");
  });

  it("does not forward parentTaskId to the worker", async () => {
    await startAgentTask({ prompt: "hi", worker: WIN, parentTaskId: "parent-1" });
    expect(mockClient.callWorkerToolRaw.mock.calls[0][2]).not.toHaveProperty("parentTaskId");
  });

  it("waitForCompletion waits on the backend and returns the final answer", async () => {
    mockClient.getTaskDetails.mockResolvedValue({
      data: { status: "completed", inProgress: false, totalUsdCost: 1, threads: [], result: "ANSWER" },
    });
    const r: any = await startAgentTask({ prompt: "hi", worker: WIN, waitForCompletion: true });
    expect(r.status).toBe("completed");
    expect(r.finalAnswer).toBe("ANSWER");
  });

  it("rejects forkTaskId with worker", async () => {
    await expect(
      startAgentTask({ prompt: "hi", worker: WIN, forkTaskId: "x" })
    ).rejects.toThrow(/forkTaskId/);
  });

  it("errors for an unknown worker without spawning", async () => {
    await expect(startAgentTask({ prompt: "hi", worker: "nope" })).rejects.toThrow(/No worker matches/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe("waitForAgentCompleted remote fallback", () => {
  it("polls the backend for a UUID with no local dir", async () => {
    mockClient.getTaskDetails.mockResolvedValue({
      data: { status: "completed", inProgress: false, totalUsdCost: 0.25, threads: [], result: "yes" },
    });
    const r = JSON.parse(await waitForAgentCompleted({ taskId: UUID }));
    expect(r).toMatchObject({ status: "completed", costUsd: 0.25, finalAnswer: "yes", remote: true });
  });

  it("prefers the local dir when it exists", async () => {
    const dir = path.join(tmpCwd, ".knowhow", "processes", "agents", UUID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "metadata.json"),
      JSON.stringify({ status: "completed", result: "local answer", totalCostUsd: 0.1 })
    );
    const r = JSON.parse(await waitForAgentCompleted({ taskId: UUID }));
    expect(r.finalAnswer).toBe("local answer");
    expect(r.remote).toBeUndefined();
    expect(mockClient.getTaskDetails).not.toHaveBeenCalled();
  });

  it("non-UUID missing ids keep the local error", async () => {
    const r = JSON.parse(await waitForAgentCompleted({ taskId: "nope" }));
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/No agent task directory/);
  });
});

describe("sendAgentMessage remote fallback", () => {
  it("sends through the backend for UUIDs without a local dir", async () => {
    mockClient.sendMessageToAgent.mockResolvedValue({ data: {} });
    const res = await sendAgentMessage({ taskId: UUID, message: "hello", from: "p1" });
    expect(res).toMatch(/queued for remote task/);
    expect(mockClient.sendMessageToAgent).toHaveBeenCalledWith(UUID, "[from:p1] hello", "user");
  });

  it("poke is delivered as /poke text", async () => {
    mockClient.sendMessageToAgent.mockResolvedValue({ data: {} });
    const res = await sendAgentMessage({ taskId: "remote:" + UUID, message: "now", poke: true });
    expect(res).toMatch(/poke/);
    expect(mockClient.sendMessageToAgent).toHaveBeenCalledWith(UUID, "/poke now", "user");
  });

  it("uses the local input file when the dir exists", async () => {
    const dir = path.join(tmpCwd, ".knowhow", "processes", "agents", UUID);
    fs.mkdirSync(dir, { recursive: true });
    const res = await sendAgentMessage({ taskId: UUID, message: "local", from: "p" });
    expect(res).toMatch(/Sent message to task/);
    expect(mockClient.sendMessageToAgent).not.toHaveBeenCalled();
  });
});

describe("listWorkers tool", () => {
  it("returns summaries as JSON", async () => {
    const out = JSON.parse(await listWorkers());
    expect(out.map((w: any) => w.name)).toEqual(["DESKTOP-QRLHKTL", "Mac.lan"]);
    expect(out[0]).toMatchObject({ id: WIN, os: "windows", status: "online", owner: "Micah" });
    expect(out[1]).toMatchObject({ os: "posix", shared: true });
  });

  it("filters by os and name", async () => {
    expect(JSON.parse(await listWorkers({ os: "posix" })).map((w: any) => w.name)).toEqual(["Mac.lan"]);
    expect(JSON.parse(await listWorkers({ nameContains: "desk" })).length).toBe(1);
  });

  it("returns {error} instead of throwing", async () => {
    mockClient.listOrgWorkers.mockRejectedValue(new Error("auth failed"));
    expect(JSON.parse(await listWorkers())).toEqual({ error: "auth failed" });
  });
});
