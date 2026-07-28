/**
 * Unit tests for the sandbox CLI command.
 *
 * Focus: `regenerate-snapshot` and `snapshot-status` commands use the backend
 * `/regenerate` endpoint (fire-and-forget) + polling rather than a single
 * long synchronous exec request.
 */

// ─── Mock http util ───────────────────────────────────────────────────────────
// jest.mock is hoisted so we must declare the fns inside the factory,
// then retrieve them via require after the fact.
jest.mock("../../../src/utils/http", () => {
  const get = jest.fn();
  const post = jest.fn();
  const del = jest.fn();
  const mock = { get, post, delete: del };
  return { default: mock, __esModule: true };
});

// Pull the mock fns after the module is mocked
// eslint-disable-next-line @typescript-eslint/no-var-requires
const httpMock = (require("../../../src/utils/http") as { default: { get: jest.Mock; post: jest.Mock; delete: jest.Mock } }).default;
const mockGet = httpMock.get;
const mockPost = httpMock.post;
const mockDelete = httpMock.delete;

// ─── Mock KnowhowClient ───────────────────────────────────────────────────────
jest.mock("../../../src/services/KnowhowClient", () => ({
  KNOWHOW_API_URL: "https://api.example.com",
  loadKnowhowJwt: jest.fn().mockReturnValue("test-jwt-token"),
}));

import { Command } from "commander";
import { addSandboxCommand } from "../../../src/commands/sandbox";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  addSandboxCommand(program);
  return program;
}

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "snap123456789012",
    sandboxId: "sb123456789012",
    label: "tests-ready",
    description: "CI snapshot",
    status: "ready",
    errorMsg: null,
    statusMessage: null,
    regenerationSandboxId: null,
    snapshotContent: "disk_only",
    setupScript: "npm install && npm run build",
    ...overrides,
  };
}

function makeSandbox(overrides: Record<string, unknown> = {}) {
  return {
    id: "sb123456789012",
    name: "knowhow-web",
    status: "running",
    vmStatus: "running",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("sandbox regenerate-snapshot", () => {
  let program: Command;
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    program = makeProgram();
    consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("calls POST /regenerate and returns immediately when --no-wait is set", async () => {
    const snap = makeSnapshot();
    // GET snapshot
    mockGet.mockResolvedValueOnce({ data: snap });
    // POST regenerate — returns immediately with regenerationSandboxId set
    mockPost.mockResolvedValueOnce({
      data: makeSnapshot({ regenerationSandboxId: "eph123456789012" }),
    });

    await program.parseAsync([
      "node", "knowhow", "sandbox", "regenerate-snapshot",
      "--sandbox-id", "sb123456789012",
      "--snapshot-id", "snap123456789012",
      "--no-wait",
    ]);

    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith(
      expect.stringContaining("/sandboxes/sb123456789012/snapshots/snap123456789012/regenerate"),
      undefined,
      expect.any(Object)
    );
    // Should NOT poll further (no additional GET calls after initial snapshot fetch)
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("polls snapshot status until regenerationSandboxId clears and status is ready", async () => {
    const snap = makeSnapshot();
    // Initial GET for resolving snapshot
    mockGet.mockResolvedValueOnce({ data: snap });
    // POST /regenerate returns immediately
    mockPost.mockResolvedValueOnce({
      data: makeSnapshot({ regenerationSandboxId: "eph123456789012" }),
    });
    // First poll: still regenerating
    mockGet.mockResolvedValueOnce({
      data: makeSnapshot({
        regenerationSandboxId: "eph123456789012",
        statusMessage: "Running setupScript...",
      }),
    });
    // Second poll: done
    mockGet.mockResolvedValueOnce({
      data: makeSnapshot({ regenerationSandboxId: null, status: "ready" }),
    });

    // Run the command but don't await yet — it will pause at the first setTimeout
    const parsePromise = program.parseAsync([
      "node", "knowhow", "sandbox", "regenerate-snapshot",
      "--sandbox-id", "sb123456789012",
      "--snapshot-id", "snap123456789012",
      // --wait is the default (no --no-wait)
    ]);

    // Let pending promises resolve (GET + POST), then advance past each 5s poll delay
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.runAllTimers();
    await Promise.resolve();
    await Promise.resolve();
    jest.runAllTimers();
    await Promise.resolve();
    await Promise.resolve();
    jest.runAllTimers();

    await parsePromise;

    // POST /regenerate called once
    expect(mockPost).toHaveBeenCalledTimes(1);
    // Initial GET + 2 polling GETs
    expect(mockGet).toHaveBeenCalledTimes(3);

    const logOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logOutput).toContain("✅ Snapshot regeneration complete!");
  });

  it("does NOT fork a sandbox or exec a script directly (old behavior)", async () => {
    const snap = makeSnapshot();
    mockGet.mockResolvedValueOnce({ data: snap });
    mockPost.mockResolvedValueOnce({
      data: makeSnapshot({ regenerationSandboxId: "eph123456789012" }),
    });
    // done immediately
    mockGet.mockResolvedValueOnce({
      data: makeSnapshot({ regenerationSandboxId: null, status: "ready" }),
    });

    const parsePromise = program.parseAsync([
      "node", "knowhow", "sandbox", "regenerate-snapshot",
      "--sandbox-id", "sb123456789012",
      "--snapshot-id", "snap123456789012",
    ]);

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.runAllTimers();
    await Promise.resolve();
    await Promise.resolve();

    await parsePromise;

    // Should only call POST /regenerate — not POST /fork or POST /exec
    const postCalls = mockPost.mock.calls.map((c) => c[0] as string);
    expect(postCalls.every((url) => url.includes("/regenerate"))).toBe(true);
    expect(postCalls.some((url) => url.includes("/fork"))).toBe(false);
    expect(postCalls.some((url) => url.includes("/exec"))).toBe(false);
  });

  it("shows statusMessage updates during polling", async () => {
    const snap = makeSnapshot();
    mockGet.mockResolvedValueOnce({ data: snap });
    mockPost.mockResolvedValueOnce({
      data: makeSnapshot({ regenerationSandboxId: "eph123456789012" }),
    });
    mockGet.mockResolvedValueOnce({
      data: makeSnapshot({
        regenerationSandboxId: "eph123456789012",
        statusMessage: "Uploading 500 MB / 1.0 GB (50%)",
      }),
    });
    mockGet.mockResolvedValueOnce({
      data: makeSnapshot({ regenerationSandboxId: null, status: "ready" }),
    });

    const parsePromise = program.parseAsync([
      "node", "knowhow", "sandbox", "regenerate-snapshot",
      "--sandbox-id", "sb123456789012",
      "--snapshot-id", "snap123456789012",
    ]);

    // Flush microtasks then advance timers repeatedly until done
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      jest.runAllTimers();
    }

    await parsePromise;

    const logOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logOutput).toContain("Uploading 500 MB / 1.0 GB (50%)");
  }, 15000);

  it("requires --sandbox-id or --sandbox-name", async () => {
    await expect(
      program.parseAsync([
        "node", "knowhow", "sandbox", "regenerate-snapshot",
        "--snapshot-id", "snap123456789012",
      ])
    ).rejects.toThrow(/sandbox-id|sandbox-name/i);
  });

  it("requires --snapshot-id or --snapshot-name", async () => {
    // Use --sandbox-id directly (avoids name resolution GET) to keep test isolated
    await expect(
      program.parseAsync([
        "node", "knowhow", "sandbox", "regenerate-snapshot",
        "--sandbox-id", "sb123456789012",
      ])
    ).rejects.toThrow(/snapshot-id|snapshot-name/i);
  });
});

describe("sandbox snapshot-status", () => {
  let program: Command;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    program = makeProgram();
    consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    consoleSpy.mockRestore();
  });

  it("prints snapshot status without waiting when --wait not set", async () => {
    const snap = makeSnapshot({ regenerationSandboxId: "eph123456789012", status: "ready" });
    mockGet.mockResolvedValueOnce({ data: snap });

    await program.parseAsync([
      "node", "knowhow", "sandbox", "snapshot-status",
      "--sandbox-id", "sb123456789012",
      "--snapshot-id", "snap123456789012",
    ]);

    const logOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logOutput).toContain("regenerating");
    expect(logOutput).toContain("eph123456789012");
    // Should not poll further
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("shows ready status when not regenerating", async () => {
    const snap = makeSnapshot({ id: "snap123456789012", status: "ready" });
    mockGet.mockResolvedValueOnce({ data: snap });

    await program.parseAsync([
      "node", "knowhow", "sandbox", "snapshot-status",
      "--sandbox-id", "sb123456789012",
      "--snapshot-id", "snap123456789012",
    ]);

    const logOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logOutput).toContain("ready");
  });

  it("polls when --wait is set and regeneration is in progress", async () => {
    const snapInProgress = makeSnapshot({ regenerationSandboxId: "eph123456789012" });
    const snapDone = makeSnapshot({ regenerationSandboxId: null, status: "ready" });

    // First GET: initial fetch (for snapshot-status command)
    mockGet.mockResolvedValueOnce({ data: snapInProgress });
    // Second GET: first poll iteration - still in progress
    mockGet.mockResolvedValueOnce({ data: snapInProgress });
    // Third GET: done
    mockGet.mockResolvedValueOnce({ data: snapDone });

    const parsePromise = program.parseAsync([
      "node", "knowhow", "sandbox", "snapshot-status",
      "--sandbox-id", "sb123456789012",
      "--snapshot-id", "snap123456789012",
      "--wait",
    ]);

    // Flush microtasks then advance timers
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      jest.runAllTimers();
    }

    await parsePromise;

    const logOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logOutput).toContain("Done");
    expect(mockGet).toHaveBeenCalledTimes(3);
  }, 15000);

  it("outputs raw JSON with --json flag", async () => {
    const snap = makeSnapshot();
    mockGet.mockResolvedValueOnce({ data: snap });

    await program.parseAsync([
      "node", "knowhow", "sandbox", "snapshot-status",
      "--sandbox-id", "sb123456789012",
      "--snapshot-id", "snap123456789012",
      "--json",
    ]);

    const logOutput = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    const parsed = JSON.parse(logOutput);
    expect(parsed.id).toBe("snap123456789012");
    expect(parsed.status).toBe("ready");
  });
});
