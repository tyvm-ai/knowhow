import {
  resolveSnapshotOption,
  listCloudWorkerSnapshots,
  startCloudWorker,
  forkCloudWorker,
  stopCloudWorker,
  destroyForkedSandbox,
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
});
