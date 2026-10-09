import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  controlProcess,
  listAllProcesses,
  resolveProcessEntry,
  sendToProcess,
} from "../../../src/processes/registry";
import { parseTunnelPortSpec } from "../../../src/tunnel";

function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

describe("process registry", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kh-registry-"));
    // exec'd command
    write(path.join(root, "1-ls-abc", "status.json"), {
      id: "1-ls-abc", pid: process.pid, shimPid: null, state: "running", command: "ls",
      args: ["-la"], cwd: "/", parentProcessId: null, parentPid: null, background: false,
      startedAt: "2026-01-01T00:00:01Z", endedAt: null, exitCode: null, signal: null,
    });
    // agent task (live pid)
    write(path.join(root, "agents", "task-1", "metadata.json"), {
      agentName: "Patcher", pid: process.pid, startTime: "2026-01-01T00:00:02Z",
      threads: [[{ role: "user", content: "<X>ctx</X><CurrentTask>fix the bug</CurrentTask>" }]],
    });
    write(path.join(root, "agents", "task-1", "status.txt"), "running");
    // stateful script runs: one live, one orphaned, one finished
    const doc = (id: string, status: string, pid?: number) => ({
      meta: { id, kind: "script", name: `${id}.ts`, createdAt: "2026-01-01T00:00:03Z", schemaVersion: 1 },
      state: { status }, control: {},
      lifecycle: {
        status, updatedAt: "2026-01-01T00:00:04Z", startedAt: "2026-01-01T00:00:03Z", resumable: "checkpoint",
        ...(pid ? { executor: { host: "h", pid, heartbeatAt: "" } } : {}),
      },
      version: 3, controlVersion: 0, observedControlVersion: 0,
    });
    write(path.join(root, "scripts", "run-live", "state.json"), doc("run-live", "running", process.pid));
    write(path.join(root, "scripts", "run-dead", "state.json"), doc("run-dead", "running", 999999));
    write(path.join(root, "scripts", "run-done", "state.json"), doc("run-done", "completed"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("lists exec, agent and stateful processes; finished/orphaned only with all", () => {
    const active = listAllProcesses({ root });
    expect(active.map((e) => `${e.kind}:${e.id}:${e.status}`).sort()).toEqual([
      "agent:task-1:running",
      "exec:1-ls-abc:running",
      "script:run-live:running",
    ]);
    expect(active.find((e) => e.kind === "agent")!.summary).toBe("Patcher: fix the bug");

    const all = listAllProcesses({ root, all: true, kinds: ["script"] });
    expect(Object.fromEntries(all.map((e) => [e.id, e.status]))).toEqual({
      "run-live": "running",
      "run-dead": "orphaned",
      "run-done": "completed",
    });
  });

  it("resolves by unique substring and routes control/input to the right medium", async () => {
    expect(() => resolveProcessEntry("run-", { root })).toThrow(/Ambiguous/);
    const script = resolveProcessEntry("live", { root });
    await controlProcess(script, "paused");
    expect(JSON.parse(fs.readFileSync(path.join(script.dir, "control.json"), "utf8"))).toEqual({
      desired: "paused",
    });
    await sendToProcess(script, "hello");
    expect(fs.readFileSync(path.join(script.dir, "input.txt"), "utf8")).toContain("hello");

    const agent = resolveProcessEntry("task-1", { root });
    await controlProcess(agent, "cancelled");
    expect(fs.readFileSync(path.join(agent.dir, "status.txt"), "utf8")).toBe("killed");

    await expect(
      controlProcess(resolveProcessEntry("run-done", { root }), "paused")
    ).rejects.toThrow(/completed/);
  });
});

describe("parseTunnelPortSpec", () => {
  it("parses ports and transports", () => {
    expect(parseTunnelPortSpec("3000")).toBe(3000);
    expect(parseTunnelPortSpec("8080:http")).toBe(8080);
    expect(parseTunnelPortSpec("5432:tcp")).toEqual({ port: 5432, transport: "tcp" });
    expect(() => parseTunnelPortSpec("abc")).toThrow(/Invalid tunnel port/);
    expect(() => parseTunnelPortSpec("70000")).toThrow(/Invalid tunnel port/);
    expect(() => parseTunnelPortSpec("22:ssh")).toThrow(/transport/);
  });
});
