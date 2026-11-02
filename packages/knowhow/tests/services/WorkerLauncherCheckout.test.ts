const mockClient: any = {
  listOrgWorkers: jest.fn(),
  listCloudWorkers: jest.fn(),
  forkSandboxFromSnapshot: jest.fn(),
  createSandboxCheckout: jest.fn(),
  getSandboxCheckout: jest.fn(),
};

jest.mock("../../src/services/KnowhowClient", () => ({
  KnowhowSimpleClient: class {
    constructor() {
      return mockClient;
    }
  },
}));

const mockTransport = {
  resolveRepoContext: jest.fn(),
  ensureBaseBundles: jest.fn(),
  resolveLocalTask: jest.fn(),
  pushTask: jest.fn(),
};
jest.mock("../../src/services/TaskTransport", () => mockTransport);

import {
  forkBody,
  validateCheckoutBody,
  checkoutWireBody,
  resolveCheckoutSpec,
  checkoutInSandbox,
  forkFromSnapshot,
} from "../../src/services/WorkerLauncher";

const SHA = "a".repeat(40);
const UUID = "11111111-2222-3333-4444-555555555555";
const ow = (o: any) => ({
  id: "w",
  orgId: "o",
  userId: "u",
  socketId: "s",
  connected: true,
  userAgent: "knowhow-cli/1 (host)",
  fsRoot: "/",
  lastConnected: new Date().toISOString(),
  ...o,
});

describe("forkBody", () => {
  it("maps resources and drops undefined", () => {
    expect(forkBody({ snapshotId: "s", memoryMb: 4096, cpuCount: 2 })).toEqual({
      snapshotId: "s",
      memoryMb: 4096,
      cpuCount: 2,
    });
    expect(Object.keys(forkBody({ snapshotId: "s", name: undefined }))).toEqual(["snapshotId"]);
    expect(forkBody({ snapshotId: "s", diskGb: 20, name: "n" })).toEqual({
      snapshotId: "s",
      name: "n",
      diskGb: 20,
    });
  });
  it("rejects invalid values", () => {
    expect(() => forkBody({ snapshotId: "s", cpuCount: 0 })).toThrow(/cpuCount/);
    expect(() => forkBody({ snapshotId: "s", memoryMb: 128 })).toThrow(/memoryMb/);
    expect(() => forkBody({ snapshotId: "s", diskGb: 1.5 })).toThrow(/diskGb/);
  });
});

describe("checkout spec helpers", () => {
  it("validateCheckoutBody enforces exactly one mode", () => {
    expect(() => validateCheckoutBody({})).toThrow(/exactly one/);
    expect(() => validateCheckoutBody({ taskId: UUID, repositoryId: "r" })).toThrow(/exactly one/);
    expect(() => validateCheckoutBody({ repositoryId: "r" })).toThrow(/commitSha or branch/);
    expect(() => validateCheckoutBody({ taskId: UUID, branch: "x" })).toThrow(/cannot be combined/);
    expect(() => validateCheckoutBody({ repositoryId: "r", commitSha: "abc" })).toThrow(/full/);
    expect(() => validateCheckoutBody({ repositoryId: "r", commitSha: SHA })).not.toThrow();
    expect(() => validateCheckoutBody({ taskId: UUID })).not.toThrow();
  });

  it("checkoutWireBody strips client-only + empty fields", () => {
    expect(
      checkoutWireBody({ taskId: UUID, pushSnapshot: true, newBranch: "", installDeps: false })
    ).toEqual({ taskId: UUID, installDeps: false });
  });
});

describe("resolveCheckoutSpec", () => {
  beforeEach(() => jest.resetAllMocks());

  it("resolves the repository from the local repo + uploads base bundles for commit/branch", async () => {
    const repo = { id: "repo1", bundles: [] };
    mockTransport.resolveRepoContext.mockResolvedValue({ repo, info: { gitRoot: "/g" }, cwd: "/g" });
    mockTransport.ensureBaseBundles.mockResolvedValue({ uploaded: true });
    const out = await resolveCheckoutSpec({ branch: "main" }, { cwd: "/g" });
    expect(out).toEqual({ repositoryId: "repo1", branch: "main" });
    expect(mockTransport.resolveRepoContext).toHaveBeenCalledWith(mockClient, "/g");
    expect(mockTransport.ensureBaseBundles).toHaveBeenCalled();
  });

  it("errors when nothing identifies what to check out", async () => {
    await expect(resolveCheckoutSpec({ installDeps: true })).rejects.toThrow(/provide taskId/);
  });

  it("resolves taskId 'current' to the backend UUID and can push a fresh snapshot", async () => {
    mockTransport.resolveLocalTask.mockReturnValue({ localId: "l", remoteId: UUID, metadata: { model: "m" } });
    mockTransport.pushTask.mockResolvedValue({ created: { id: "snapX" } });
    const out = await resolveCheckoutSpec({ taskId: "current", pushSnapshot: true });
    expect(mockTransport.resolveLocalTask).toHaveBeenCalledWith(undefined);
    expect(mockTransport.pushTask).toHaveBeenCalledWith(
      mockClient,
      UUID,
      expect.objectContaining({ metadata: { model: "m" } })
    );
    expect(out).toEqual({ taskId: UUID, workspaceSnapshotId: "snapX" });
  });

  it("passes backend UUIDs through untouched and errors for unsynced local tasks", async () => {
    expect(await resolveCheckoutSpec({ taskId: UUID })).toEqual({ taskId: UUID });
    expect(mockTransport.resolveLocalTask).not.toHaveBeenCalled();
    mockTransport.resolveLocalTask.mockReturnValue({ localId: "slug" });
    await expect(resolveCheckoutSpec({ taskId: "slug" })).rejects.toThrow(/not synced/);
  });
});

describe("checkoutInSandbox", () => {
  beforeEach(() => jest.resetAllMocks());

  it("creates then polls until succeeded", async () => {
    mockClient.createSandboxCheckout.mockResolvedValue({ data: { id: "c1", sandboxId: "sb", status: "running" } });
    mockClient.getSandboxCheckout
      .mockResolvedValueOnce({ data: { id: "c1", status: "running" } })
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({
        data: { id: "c1", status: "succeeded", repoDir: "/r", cwd: "/r/p", commitSha: SHA, branch: "b", verified: true },
      });
    const r = await checkoutInSandbox("sb", { taskId: UUID }, { pollMs: 1 });
    expect(mockClient.createSandboxCheckout).toHaveBeenCalledWith("sb", { taskId: UUID });
    expect(r).toEqual({
      checkoutId: "c1",
      sandboxId: "sb",
      repoDir: "/r",
      cwd: "/r/p",
      commitSha: SHA,
      branch: "b",
      verified: true,
    });
  });

  it("throws with error and log tail on failure", async () => {
    mockClient.createSandboxCheckout.mockResolvedValue({ data: { id: "c1" } });
    mockClient.getSandboxCheckout.mockResolvedValue({
      data: { id: "c1", status: "failed", error: "bad ref", logTail: "line1\nline2" },
    });
    await expect(checkoutInSandbox("sb", { taskId: UUID }, { pollMs: 1 })).rejects.toThrow(
      /bad ref[\s\S]*line2/
    );
  });

  it("times out and validates the spec before calling the API", async () => {
    mockClient.createSandboxCheckout.mockResolvedValue({ data: { id: "c1" } });
    mockClient.getSandboxCheckout.mockResolvedValue({ data: { id: "c1", status: "running" } });
    await expect(checkoutInSandbox("sb", { taskId: UUID }, { pollMs: 1, timeoutMs: 20 })).rejects.toThrow(/Timed out/);
    mockClient.createSandboxCheckout.mockClear();
    await expect(checkoutInSandbox("sb", {})).rejects.toThrow(/exactly one/);
    expect(mockClient.createSandboxCheckout).not.toHaveBeenCalled();
  });
});

describe("forkFromSnapshot with resources + checkout", () => {
  beforeEach(() => jest.resetAllMocks());

  const wire = () => {
    // The fork response is the sandbox record at the top level.
    mockClient.forkSandboxFromSnapshot.mockResolvedValue({
      data: { id: "sbNew", name: "fork1", cpuCount: 2, memoryMb: 4096 },
    });
    mockClient.listCloudWorkers.mockResolvedValue({
      data: [{ id: "cwFork", name: "fork1", status: "RUNNING", sandboxId: "sbNew" }],
    });
    mockClient.listOrgWorkers.mockResolvedValue({ data: [ow({ id: "wF", cloudWorkerId: "cwFork" })] });
  };

  it("sends cpuCount/memoryMb and returns the sizes", async () => {
    wire();
    const r = await forkFromSnapshot({ snapshotId: "s", memoryMb: 4096, cpuCount: 2 });
    expect(mockClient.forkSandboxFromSnapshot).toHaveBeenCalledWith({
      snapshotId: "s",
      memoryMb: 4096,
      cpuCount: 2,
    });
    expect(r).toEqual({
      sandboxId: "sbNew",
      cloudWorkerId: "cwFork",
      workerId: "wF",
      name: "fork1",
      cpuCount: 2,
      memoryMb: 4096,
    });
  });

  it("runs the checkout after connect and returns it", async () => {
    wire();
    mockClient.createSandboxCheckout.mockResolvedValue({ data: { id: "c1" } });
    mockClient.getSandboxCheckout.mockResolvedValue({
      data: { id: "c1", status: "succeeded", cwd: "/work/repo", commitSha: SHA },
    });
    const r = await forkFromSnapshot({ snapshotId: "s", checkout: { taskId: UUID } });
    expect(mockClient.createSandboxCheckout).toHaveBeenCalledWith("sbNew", { taskId: UUID });
    expect(r.checkout?.cwd).toBe("/work/repo");
  });

  it("names the sandbox when the checkout fails; rejects checkout without waitForConnect", async () => {
    wire();
    mockClient.createSandboxCheckout.mockResolvedValue({ data: { id: "c1" } });
    mockClient.getSandboxCheckout.mockResolvedValue({ data: { id: "c1", status: "failed", error: "nope" } });
    await expect(forkFromSnapshot({ snapshotId: "s", checkout: { taskId: UUID } })).rejects.toThrow(
      /nope[\s\S]*sandbox sbNew is still running/
    );
    await expect(
      forkFromSnapshot({ snapshotId: "s", waitForConnect: false, checkout: { taskId: UUID } })
    ).rejects.toThrow(/waitForConnect/);
  });
});
