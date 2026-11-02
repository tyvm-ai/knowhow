import {
  resolveSnapshotOption,
  listCloudWorkerSnapshots,
  startCloudWorker,
  forkCloudWorker,
  stopCloudWorker,
  destroyForkedSandbox,
  checkoutCloudWorker,
  forkCloudWorkerDefinition,
  checkoutCloudWorkerDefinition,
  startCloudWorkerDefinition,
} from "../../../../src/agents/tools/cloudWorkers";
import { includedTools } from "../../../../src/agents/tools/list";
import * as launcher from "../../../../src/services/WorkerLauncher";

jest.mock("../../../../src/services/WorkerLauncher", () => ({
  listSnapshotsForCloudWorker: jest.fn(),
  startCloudWorker: jest.fn(),
  forkFromSnapshot: jest.fn(),
  stopCloudWorker: jest.fn(),
  destroyForkedSandbox: jest.fn(),
  checkoutResolved: jest.fn(),
  sandboxIdForCloudWorker: jest.fn(),
}));

const m = launcher as jest.Mocked<typeof launcher>;

describe("cloudWorkers tools", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("resolveSnapshotOption", () => {
    it("fresh => false", () => {
      expect(resolveSnapshotOption({ fresh: true })).toBe(false);
    });
    it("snapshotId => that id", () => {
      expect(resolveSnapshotOption({ snapshotId: "s1" })).toBe("s1");
    });
    it("neither => undefined (auto-resume)", () => {
      expect(resolveSnapshotOption({})).toBeUndefined();
      expect(resolveSnapshotOption({ snapshotId: "" })).toBeUndefined();
    });
    it("both => throws", () => {
      expect(() => resolveSnapshotOption({ fresh: true, snapshotId: "s" })).toThrow();
    });
  });

  it("registers all five definitions", () => {
    const names = includedTools.map((t: any) => t.function.name);
    for (const n of [
      "listCloudWorkerSnapshots",
      "startCloudWorker",
      "forkCloudWorker",
      "stopCloudWorker",
      "destroyForkedSandbox",
    ]) {
      expect(names).toContain(n);
    }
    expect(startCloudWorkerDefinition.function.description).toMatch(/COST/);
  });

  it("listCloudWorkerSnapshots returns JSON", async () => {
    m.listSnapshotsForCloudWorker.mockResolvedValue([{ id: "a", isDefault: true }] as any);
    const r = JSON.parse(await listCloudWorkerSnapshots({ cloudWorker: "kw" }));
    expect(r).toEqual([{ id: "a", isDefault: true }]);
    expect(m.listSnapshotsForCloudWorker).toHaveBeenCalledWith("kw");
  });

  it("startCloudWorker passes snapshot/fresh/waitForConnect (default true)", async () => {
    m.startCloudWorker.mockResolvedValue({ cloudWorkerId: "c", workerId: "w", name: "n" });
    await startCloudWorker({ cloudWorker: "kw", fresh: true });
    expect(m.startCloudWorker).toHaveBeenCalledWith("kw", {
      snapshotId: false,
      waitForConnect: true,
      timeoutMs: undefined,
    });
    await startCloudWorker({ cloudWorker: "kw", snapshotId: "s", waitForConnect: false });
    expect(m.startCloudWorker).toHaveBeenLastCalledWith("kw", {
      snapshotId: "s",
      waitForConnect: false,
      timeoutMs: undefined,
    });
  });

  it("forkCloudWorker returns sandboxId + workerId", async () => {
    m.forkFromSnapshot.mockResolvedValue({ sandboxId: "sb", workerId: "w", name: "fork" } as any);
    const r = JSON.parse(await forkCloudWorker({ snapshotId: "s", name: "fork" }));
    expect(r.sandboxId).toBe("sb");
    expect(r.workerId).toBe("w");
    expect(m.forkFromSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: "s", name: "fork", waitForConnect: true })
    );
  });

  it("stop/destroy report success and errors are returned as {error}", async () => {
    m.stopCloudWorker.mockResolvedValue(undefined);
    expect(JSON.parse(await stopCloudWorker({ cloudWorker: "kw" })).stopped).toBe(true);
    m.destroyForkedSandbox.mockRejectedValue(new Error("boom"));
    expect(JSON.parse(await destroyForkedSandbox({ sandboxId: "sb" }))).toEqual({ error: "boom" });
    expect(JSON.parse(await destroyForkedSandbox({ sandboxId: "" })).error).toMatch(/required/);
  });

  it("forkCloudWorker maps cpuCount/memoryMb/diskGb/checkout through", async () => {
    m.forkFromSnapshot.mockResolvedValue({ sandboxId: "sb", name: "f", checkout: { cwd: "/w" } } as any);
    const r = JSON.parse(
      await forkCloudWorker({
        snapshotId: "s",
        cpuCount: 2,
        memoryMb: 4096,
        diskGb: 20,
        checkout: { taskId: "current" },
      })
    );
    expect(r.checkout.cwd).toBe("/w");
    expect(m.forkFromSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotId: "s",
        cpuCount: 2,
        memoryMb: 4096,
        diskGb: 20,
        checkout: { taskId: "current" },
      })
    );
  });

  it("startCloudWorker forwards checkout", async () => {
    m.startCloudWorker.mockResolvedValue({ cloudWorkerId: "c", name: "n" } as any);
    await startCloudWorker({ cloudWorker: "kw", checkout: { branch: "main" } });
    expect(m.startCloudWorker).toHaveBeenCalledWith(
      "kw",
      expect.objectContaining({ checkout: { branch: "main" } })
    );
  });

  it("descriptions: resize only for disk checkpoints; checkout tool registered", () => {
    const d = forkCloudWorkerDefinition.function.description;
    expect(d).toMatch(/ONLY works when forking a DISK checkpoint/);
    const props = (forkCloudWorkerDefinition.function.parameters as any).properties;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["cpuCount", "memoryMb", "diskGb", "checkout"])
    );
    expect(props.memoryMb.description).toMatch(/disk checkpoints/);
    expect(includedTools.map((t: any) => t.function.name)).toContain("checkoutCloudWorker");
    expect(checkoutCloudWorkerDefinition.function.name).toBe("checkoutCloudWorker");
  });

  it("checkoutCloudWorker resolves a cloud worker to its sandbox, or uses sandboxId directly", async () => {
    m.sandboxIdForCloudWorker.mockResolvedValue("sbFromCw");
    m.checkoutResolved.mockResolvedValue({ checkoutId: "c", sandboxId: "sbFromCw", cwd: "/w" } as any);
    const r = JSON.parse(
      await checkoutCloudWorker({ cloudWorker: "kw", branch: "main", timeoutMs: 5 })
    );
    expect(r.cwd).toBe("/w");
    expect(m.checkoutResolved).toHaveBeenCalledWith("sbFromCw", { branch: "main" }, { timeoutMs: 5 });

    await checkoutCloudWorker({ sandboxId: "sb2", taskId: "current", pushSnapshot: true });
    expect(m.checkoutResolved).toHaveBeenLastCalledWith(
      "sb2",
      { taskId: "current", pushSnapshot: true },
      { timeoutMs: undefined }
    );
  });

  it("checkoutCloudWorker validates the target and returns errors as {error}", async () => {
    expect(JSON.parse(await checkoutCloudWorker({ branch: "x" })).error).toMatch(/cloudWorker.*sandboxId/);
    expect(
      JSON.parse(await checkoutCloudWorker({ sandboxId: "a", cloudWorker: "b", branch: "x" })).error
    ).toMatch(/not both/);
    m.checkoutResolved.mockRejectedValue(new Error("Checkout failed: boom"));
    expect(JSON.parse(await checkoutCloudWorker({ sandboxId: "a", branch: "x" }))).toEqual({
      error: "Checkout failed: boom",
    });
  });
});
