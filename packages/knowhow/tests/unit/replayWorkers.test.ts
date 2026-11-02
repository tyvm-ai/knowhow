import {
  extractWorkersFromThreads,
  isMetaTool,
  parseWorkerToolName,
  parseWorkersOption,
  resolveWorkers,
} from "../../src/commands/replayWorkers";

const sys = (workers: Array<Record<string, unknown>>) => ({
  role: "system",
  content:
    "You are an agent." +
    workers
      .map(
        (w, i) =>
          `\n        \nYou may leverage tools from this worker:\n\n        worker_${i}:\n        ${JSON.stringify(w)}\n        Tools from worker_${i}_* run inside ...`
      )
      .join(""),
});

describe("replayWorkers", () => {
  it("extracts recorded workers from the system prompt", () => {
    const threads = [
      [
        sys([
          { id: "w-ext", clientKind: "extension", userId: "u1", ephemeral: true },
          { id: "w-cli", clientKind: null, userId: "u1" },
        ]),
        { role: "user", content: "worker_9: {\"id\":\"not-system\"}" },
      ],
    ];
    const workers = extractWorkersFromThreads(threads);
    expect(workers.map((w) => [w.index, w.id, w.clientKind])).toEqual([
      [0, "w-ext", "extension"],
      [1, "w-cli", null],
    ]);
  });

  it("parses worker tool names and meta tools", () => {
    expect(parseWorkerToolName("worker_0_canvas_get")).toEqual({ index: 0, tool: "canvas_get" });
    expect(parseWorkerToolName("worker_12_page_read")).toEqual({ index: 12, tool: "page_read" });
    expect(parseWorkerToolName("readFile")).toBeNull();
    expect(isMetaTool("enableTools")).toBe(true);
    expect(isMetaTool("writeFile")).toBe(false);
  });

  it("parses --workers positional and explicit forms", () => {
    expect([...parseWorkersOption("a,b")]).toEqual([[0, "a"], [1, "b"]]);
    expect([...parseWorkersOption("1=b,0=a")]).toEqual([[1, "b"], [0, "a"]]);
    expect(parseWorkersOption(undefined).size).toBe(0);
  });

  it("resolves: override > connected recorded > same-kind fallback > recorded", () => {
    const recorded = [
      { index: 0, id: "old-ext", clientKind: "extension", userId: "u1" },
      { index: 1, id: "cli", clientKind: null, userId: "u1" },
      { index: 2, id: "gone", clientKind: null, userId: "u1" },
    ];
    const connected = [
      { id: "cli", connected: true, userId: "u1" },
      { id: "new-ext-older", connected: true, clientKind: "extension", userId: "u1", lastConnected: "2026-01-01" },
      { id: "new-ext", connected: true, clientKind: "extension", userId: "u1", lastConnected: "2026-02-01" },
      { id: "other-users-ext", connected: true, clientKind: "extension", userId: "u2", lastConnected: "2026-03-01" },
    ];
    const r = resolveWorkers(recorded, new Map(), connected);
    expect(r.map((w) => w.id)).toEqual(["new-ext", "cli", "gone"]);
    expect(r[2].note).toContain("NOT connected");

    const o = resolveWorkers(recorded, new Map([[0, "cli"]]), connected);
    expect(o[0]).toMatchObject({ id: "cli", note: "from --workers" });

    // A pinned-but-gone client worker still falls back to the live one
    const pinned = resolveWorkers(recorded, new Map([[0, "old-ext"]]), connected);
    expect(pinned[0].id).toBe("new-ext");
    // A pinned-but-gone non-client worker is kept (and reported)
    const pinnedCli = resolveWorkers(recorded, new Map([[2, "gone"]]), connected);
    expect(pinnedCli[2]).toMatchObject({ id: "gone", note: "from --workers, NOT connected" });
  });
});
