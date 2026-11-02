const mockClient: any = {
  listOrgWorkers: jest.fn(),
  listCloudWorkers: jest.fn(),
  getSandbox: jest.fn(),
  listSandboxSnapshots: jest.fn(),
  listOrgSnapshots: jest.fn(),
  listSandboxes: jest.fn(),
  startCloudWorkerRaw: jest.fn(),
  stopCloudWorkerRaw: jest.fn(),
  forkSandboxFromSnapshot: jest.fn(),
  destroySandbox: jest.fn(),
  deleteCloudWorkerRaw: jest.fn(),
};

jest.mock("../../src/services/KnowhowClient", () => ({
  KnowhowSimpleClient: class {
    constructor() {
      return mockClient;
    }
  },
}));

import {
  buildSnapshotChoices,
  lineageSnapshots,
  pickDefaultSnapshot,
  buildLaunchTargets,
  matchCloudWorker,
  findConnectedWorker,
  startBody,
  listSnapshotsForCloudWorker,
  startCloudWorker,
  stopCloudWorker,
  destroyForkedSandbox,
  forkFromSnapshot,
} from "../../src/services/WorkerLauncher";
import {
  buildPickerOptions,
  parsePickerAnswer,
  startChoiceToSnapshotId,
  parseAttachArgs,
  choiceFromFlags,
  matchLaunchTarget,
  pickSnapshot,
  ensureCloudWorkerStarted,
  formatBytes,
} from "../../src/services/WorkerPicker";

const snap = (id: string, createdAt: string, extra: any = {}) => ({
  id,
  sandboxId: "sb1",
  status: "ready",
  createdAt,
  ...extra,
});

const ow = (o: any) => ({
  id: "w",
  orgId: "o",
  userId: "u",
  socketId: "s",
  userAgent: "knowhow-worker/1.0/host (linux; x64)",
  fsRoot: "/x",
  connected: true,
  lastConnected: "2026-01-01T00:00:00Z",
  shared: false,
  cloudWorkerId: null,
  ...o,
});

describe("snapshot choices", () => {
  it("keeps only ready snapshots, newest first, and marks the default", () => {
    const choices = buildSnapshotChoices(
      [
        snap("a", "2026-01-01T00:00:00Z"),
        snap("b", "2026-03-01T00:00:00Z", { label: "latest" }),
        snap("c", "2026-02-01T00:00:00Z", { status: "pending" }),
        snap("d", "2026-02-15T00:00:00Z", { sizeBytes: 5 }),
      ] as any,
      "a"
    );
    expect(choices.map((c) => c.id)).toEqual(["b", "d", "a"]);
    expect(choices[0].name).toBe("latest");
    expect(choices[1].sizeBytes).toBe(5);
    expect(pickDefaultSnapshot(choices)?.id).toBe("a");
  });

  it("has no default when lastSnapshotId is unknown / not ready", () => {
    const choices = buildSnapshotChoices([snap("a", "2026-01-01T00:00:00Z")] as any, "zzz");
    expect(pickDefaultSnapshot(choices)).toBeUndefined();
    expect(choices.every((c) => !c.isDefault)).toBe(true);
  });
});

describe("lineage snapshots", () => {
  it("includes earlier sandboxes with the same name and dedupes", () => {
    const out = lineageSnapshots(
      [snap("cur", "2026-03-01T00:00:00Z", { sandboxId: "sbNew" })] as any,
      [
        snap("old", "2026-01-01T00:00:00Z", { sandboxId: "sbOld" }),
        snap("cur", "2026-03-01T00:00:00Z", { sandboxId: "sbNew" }),
        snap("other", "2026-01-01T00:00:00Z", { sandboxId: "sbOther" }),
      ] as any,
      [
        { id: "sbOld", name: "Knowhow-web", status: "destroyed" },
        { id: "sbNew", name: "Knowhow-web", status: "running" },
        { id: "sbOther", name: "Other", status: "running" },
      ] as any,
      "knowhow-web"
    );
    expect(out.map((s) => s.id).sort()).toEqual(["cur", "old"]);
  });
});

describe("launch targets", () => {
  it("online first, cloud workers (stopped) next, excludes ephemeral runners", () => {
    const targets = buildLaunchTargets(
      [
        ow({ id: "w1", userAgent: "knowhow-worker/1/zeta (linux; x64)" }),
        ow({ id: "w2", userAgent: "knowhow-worker/1/alpha (linux; x64)" }),
        ow({ id: "w3", ephemeral: true }),
        ow({ id: "w4", connected: false }),
        ow({ id: "w5", cloudWorkerId: "cw1", userAgent: "knowhow-worker/1/Knowhow-cli (linux; x64)" }),
        ow({ id: "w6", cloudWorkerId: "cw2", connected: false }),
      ] as any,
      [
        { id: "cw1", name: "Knowhow-cli", status: "RUNNING", sandboxId: "s1" },
        { id: "cw2", name: "Knowhow-web", status: "STOPPED", sandboxId: "s2" },
        { id: "cw3", name: "runner-123", status: "STOPPED", isEphemeral: true },
      ] as any,
      { s2: { id: "s2", status: "destroyed", lastSnapshotId: "snapX" } }
    );
    expect(targets.map((t) => `${t.kind}:${t.name}:${t.status}`)).toEqual([
      "online:alpha:online",
      "online:Knowhow-cli:online",
      "online:zeta:online",
      "cloudworker:Knowhow-web:stopped",
    ]);
    const web = targets.find((t) => t.name === "Knowhow-web")!;
    expect(web.lastSnapshotId).toBe("snapX");
    expect(web.cloudWorkerId).toBe("cw2");
    // connected cloud worker keeps its cloudWorkerId / sandbox
    const cli = targets.find((t) => t.name === "Knowhow-cli")!;
    expect(cli).toMatchObject({ cloudWorkerId: "cw1", sandboxId: "s1", workerId: "w5" });
  });

  it("a stale connected worker row of a STOPPED cloud worker is not shown as online", () => {
    const targets = buildLaunchTargets(
      [ow({ id: "w1", cloudWorkerId: "cw1", userAgent: "knowhow-worker/1/Knowhow-web (linux; x64)" })] as any,
      [{ id: "cw1", name: "Knowhow-web", status: "STOPPED", sandboxId: "s1" }] as any,
      {}
    );
    expect(targets.map((t) => `${t.kind}:${t.name}:${t.status}`)).toEqual([
      "cloudworker:Knowhow-web:stopped",
    ]);
  });

  it("includeOffline adds offline plain workers last", () => {
    const targets = buildLaunchTargets(
      [ow({ id: "w1" }), ow({ id: "w4", connected: false, userAgent: "knowhow-worker/1/off (linux; x64)" })] as any,
      [],
      {},
      { includeOffline: true }
    );
    expect(targets.map((t) => t.status)).toEqual(["online", "offline"]);
  });
});

describe("matching helpers", () => {
  const cws: any[] = [
    { id: "aaaa1111", name: "Knowhow-web", status: "STOPPED" },
    { id: "bbbb2222", name: "Knowhow-cli", status: "STOPPED" },
  ];
  it("matches by id, prefix, name, substring and reports ambiguity", () => {
    expect(matchCloudWorker(cws, "aaaa1111").name).toBe("Knowhow-web");
    expect(matchCloudWorker(cws, "bbbb").name).toBe("Knowhow-cli");
    expect(matchCloudWorker(cws, "knowhow-web").id).toBe("aaaa1111");
    expect(() => matchCloudWorker(cws, "knowhow")).toThrow(/ambiguous/);
    expect(() => matchCloudWorker(cws, "nope")).toThrow(/No cloud worker/);
  });
  it("findConnectedWorker picks the newest connected linked worker", () => {
    const w = findConnectedWorker(
      [
        ow({ id: "old", cloudWorkerId: "cw", lastConnected: "2026-01-01T00:00:00Z" }),
        ow({ id: "new", cloudWorkerId: "cw", lastConnected: "2026-02-01T00:00:00Z" }),
        ow({ id: "off", cloudWorkerId: "cw", connected: false, lastConnected: "2026-03-01T00:00:00Z" }),
      ] as any,
      "cw"
    );
    expect(w?.id).toBe("new");
  });
  it("startBody maps snapshot choices to the API body", () => {
    expect(startBody()).toEqual({});
    expect(startBody(false)).toEqual({ snapshotId: false });
    expect(startBody("s")).toEqual({ snapshotId: "s" });
  });
  it("matchLaunchTarget by number / name", () => {
    const t: any[] = [
      { kind: "online", name: "alpha", workerId: "w1abcdef", status: "online" },
      { kind: "cloudworker", name: "Knowhow-web", cloudWorkerId: "cw1abcdef", status: "stopped" },
    ];
    expect(matchLaunchTarget(t, "2")?.name).toBe("Knowhow-web");
    expect(matchLaunchTarget(t, "alpha")?.name).toBe("alpha");
    expect(matchLaunchTarget(t, "know")?.name).toBe("Knowhow-web");
    expect(matchLaunchTarget(t, "9")).toBeUndefined();
  });
});

describe("snapshot picker", () => {
  const snaps = buildSnapshotChoices(
    [snap("snap-aaaa-1", "2026-01-01T00:00:00Z"), snap("snap-bbbb-2", "2026-02-01T00:00:00Z")] as any,
    "snap-aaaa-1"
  );

  it("Enter selects the default snapshot", () => {
    const options = buildPickerOptions(snaps, { allowFork: true });
    const picked = parsePickerAnswer("", options, snaps, { allowFork: true });
    expect(picked?.choice).toEqual({ mode: "snapshot", snapshotId: "snap-aaaa-1" });
    expect(options.find((o) => o.isDefault)?.label).toMatch(/default — resume/);
  });

  it("without a default snapshot Enter = default (backend decides)", () => {
    const noDef = buildSnapshotChoices([snap("x", "2026-01-01T00:00:00Z")] as any, null);
    const options = buildPickerOptions(noDef);
    expect(parsePickerAnswer("", options, noDef)?.choice).toEqual({ mode: "default" });
  });

  it("parses number, fresh, fork and rejects fork when not allowed", () => {
    const options = buildPickerOptions(snaps, { allowFork: true });
    expect(parsePickerAnswer("1", options, snaps)?.choice).toEqual({ mode: "snapshot", snapshotId: "snap-bbbb-2" });
    expect(parsePickerAnswer("fresh", options, snaps)?.choice).toEqual({ mode: "fresh" });
    expect(parsePickerAnswer("fork 2", options, snaps, { allowFork: true })?.choice).toEqual({
      mode: "fork",
      snapshotId: "snap-aaaa-1",
    });
    expect(parsePickerAnswer("fork", options, snaps, { allowFork: true })?.choice).toEqual({
      mode: "fork",
      snapshotId: "snap-aaaa-1",
    });
    expect(parsePickerAnswer("fork 1", options, snaps, { allowFork: false })).toBeUndefined();
    expect(parsePickerAnswer("snap-bbbb", options, snaps)?.choice).toEqual({ mode: "snapshot", snapshotId: "snap-bbbb-2" });
    expect(parsePickerAnswer("zzz", options, snaps)).toBeUndefined();
  });

  it("maps choices to startCloudWorker snapshotId", () => {
    expect(startChoiceToSnapshotId({ mode: "fresh" })).toBe(false);
    expect(startChoiceToSnapshotId({ mode: "default" })).toBeUndefined();
    expect(startChoiceToSnapshotId({ mode: "snapshot", snapshotId: "s" })).toBe("s");
  });

  it("pickSnapshot skips the prompt when there are no snapshots and supports cancel", async () => {
    const ask = jest.fn();
    expect(await pickSnapshot("w", [], ask, { log: () => {} })).toEqual({ mode: "default" });
    expect(ask).not.toHaveBeenCalled();
    expect(await pickSnapshot("w", snaps, async () => "q", { log: () => {} })).toBeUndefined();
    expect(await pickSnapshot("w", snaps, async () => "", { log: () => {} })).toEqual({
      mode: "snapshot",
      snapshotId: "snap-aaaa-1",
    });
  });

  it("parseAttachArgs / choiceFromFlags", () => {
    expect(parseAttachArgs(["Knowhow-web", "--snapshot", "s1", "--task", "t1"])).toEqual({
      worker: "Knowhow-web",
      snapshot: "s1",
      task: "t1",
    });
    expect(parseAttachArgs(["--fresh", "w", "--prompt", "do", "the", "thing"])).toEqual({
      worker: "w",
      fresh: true,
      prompt: "do the thing",
    });
    expect(choiceFromFlags({ fork: "f" })).toEqual({ mode: "fork", snapshotId: "f" });
    expect(choiceFromFlags({ fresh: true })).toEqual({ mode: "fresh" });
    expect(choiceFromFlags({})).toBeUndefined();
  });

  it("formatBytes", () => {
    expect(formatBytes(1114680320)).toBe("1.0 GB");
    expect(formatBytes(undefined)).toBe("?");
  });
});

describe("API-backed launcher functions", () => {
  beforeEach(() => jest.resetAllMocks());

  it("listSnapshotsForCloudWorker uses the sandbox's lastSnapshotId as default", async () => {
    mockClient.listCloudWorkers.mockResolvedValue({
      data: [{ id: "cw1", name: "Knowhow-web", status: "STOPPED", sandboxId: "sb1" }],
    });
    mockClient.getSandbox.mockResolvedValue({ data: { id: "sb1", lastSnapshotId: "b" } });
    mockClient.listSandboxSnapshots.mockResolvedValue({
      data: [snap("a", "2026-01-01T00:00:00Z"), snap("b", "2026-02-01T00:00:00Z")],
    });
    mockClient.listOrgSnapshots.mockResolvedValue({
      data: [snap("z", "2026-03-01T00:00:00Z", { sandboxId: "sbPrev" })],
    });
    mockClient.listSandboxes.mockResolvedValue({
      data: [{ id: "sbPrev", name: "Knowhow-web", status: "destroyed" }],
    });
    const out = await listSnapshotsForCloudWorker("knowhow-web");
    expect(out.map((o) => [o.id, o.isDefault])).toEqual([
      ["z", false], // earlier sandbox of the same cloud worker
      ["b", true],
      ["a", false],
    ]);
  });

  it("startCloudWorker is a no-op when already running+connected", async () => {
    mockClient.listCloudWorkers.mockResolvedValue({
      data: [{ id: "cw1", name: "W", status: "RUNNING", sandboxId: "sb1" }],
    });
    mockClient.listOrgWorkers.mockResolvedValue({ data: [ow({ id: "w9", cloudWorkerId: "cw1" })] });
    const r = await startCloudWorker("W", {});
    expect(r).toEqual({ cloudWorkerId: "cw1", workerId: "w9", name: "W" });
    expect(mockClient.startCloudWorkerRaw).not.toHaveBeenCalled();
  });

  it("startCloudWorker posts the snapshot body and waits for connect", async () => {
    mockClient.listCloudWorkers.mockResolvedValue({
      data: [{ id: "cw1", name: "W", status: "STOPPED", sandboxId: "sb1" }],
    });
    mockClient.listOrgWorkers
      .mockResolvedValueOnce({ data: [] }) // initial no-op check
      .mockResolvedValue({ data: [ow({ id: "w9", cloudWorkerId: "cw1" })] });
    mockClient.startCloudWorkerRaw.mockResolvedValue({ data: {} });
    const progress: string[] = [];
    const r = await startCloudWorker("W", { snapshotId: false, onProgress: (m) => progress.push(m) });
    expect(mockClient.startCloudWorkerRaw).toHaveBeenCalledWith("cw1", { snapshotId: false });
    expect(r.workerId).toBe("w9");
    expect(progress.join("\n")).toMatch(/fresh cold start/);
  });

  it("forkFromSnapshot finds the worker through the cloud worker linked to the new sandbox", async () => {
    mockClient.forkSandboxFromSnapshot.mockResolvedValue({ data: { id: "sbNew", name: "fork1" } });
    mockClient.listCloudWorkers.mockResolvedValue({
      data: [{ id: "cwFork", name: "fork1", status: "RUNNING", sandboxId: "sbNew" }],
    });
    mockClient.listOrgWorkers.mockResolvedValue({ data: [ow({ id: "wF", cloudWorkerId: "cwFork" })] });
    const r = await forkFromSnapshot({ snapshotId: "snap1", name: "fork1" });
    expect(mockClient.forkSandboxFromSnapshot).toHaveBeenCalledWith({ snapshotId: "snap1", name: "fork1" });
    expect(r).toEqual({ sandboxId: "sbNew", cloudWorkerId: "cwFork", workerId: "wF", name: "fork1" });
  });

  it("stopCloudWorker / destroyForkedSandbox call the API", async () => {
    mockClient.listCloudWorkers.mockResolvedValue({
      data: [{ id: "cw1", name: "W", status: "RUNNING" }],
    });
    mockClient.stopCloudWorkerRaw.mockResolvedValue({ data: {} });
    mockClient.destroySandbox.mockResolvedValue({ data: {} });
    await stopCloudWorker("W");
    expect(mockClient.stopCloudWorkerRaw).toHaveBeenCalledWith("cw1", { snapshot: false });
    await stopCloudWorker("W", { snapshot: true });
    expect(mockClient.stopCloudWorkerRaw).toHaveBeenLastCalledWith("cw1", { snapshot: true });
    mockClient.getSandbox.mockResolvedValue({ data: { id: "sbX", baseSnapshotId: null } });
    await destroyForkedSandbox("sbX");
    expect(mockClient.destroySandbox).toHaveBeenCalledWith("sbX");
    expect(mockClient.deleteCloudWorkerRaw).not.toHaveBeenCalled();

    // a real fork also loses its leftover cloud worker record
    mockClient.getSandbox.mockResolvedValue({ data: { id: "sbF", baseSnapshotId: "snap1" } });
    mockClient.listCloudWorkers.mockResolvedValue({
      data: [{ id: "cwF", name: "fork1", status: "RUNNING", sandboxId: "sbF" }],
    });
    mockClient.deleteCloudWorkerRaw.mockResolvedValue({ data: {} });
    await destroyForkedSandbox("sbF");
    expect(mockClient.destroySandbox).toHaveBeenLastCalledWith("sbF");
    expect(mockClient.deleteCloudWorkerRaw).toHaveBeenCalledWith("cwF");
  });

  it("ensureCloudWorkerStarted: running worker is untouched; stopped uses --snapshot flag", async () => {
    const ask = jest.fn();
    expect(
      await ensureCloudWorkerStarted({ id: "cw1", name: "W", status: "RUNNING" }, {}, ask, () => {})
    ).toBe(true);
    expect(mockClient.startCloudWorkerRaw).not.toHaveBeenCalled();

    mockClient.listCloudWorkers.mockResolvedValue({
      data: [{ id: "cw1", name: "W", status: "STOPPED", sandboxId: "sb1" }],
    });
    mockClient.listOrgWorkers
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValue({ data: [ow({ id: "w9", cloudWorkerId: "cw1" })] });
    mockClient.startCloudWorkerRaw.mockResolvedValue({ data: {} });
    expect(
      await ensureCloudWorkerStarted(
        { id: "cw1", name: "W", status: "STOPPED" },
        { snapshot: "snapZ" },
        ask,
        () => {}
      )
    ).toBe(true);
    expect(mockClient.startCloudWorkerRaw).toHaveBeenCalledWith("cw1", { snapshotId: "snapZ" });
    expect(ask).not.toHaveBeenCalled();
  });
});
