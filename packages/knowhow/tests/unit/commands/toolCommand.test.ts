const mockCall = jest.fn();
const mockList = jest.fn();
jest.mock("../../../src/services/ClientWorkerTools", () => ({
  ...jest.requireActual("../../../src/services/ClientWorkerTools"),
  callClientTool: (...a: any[]) => mockCall(...a),
  listClientWorkers: (...a: any[]) => mockList(...a),
}));
jest.mock("../../../src/services/KnowhowClient", () => ({
  KnowhowSimpleClient: jest.fn().mockImplementation(() => ({})),
}));

import { Command } from "commander";
import { addToolCommand } from "../../../src/commands/tool";

function prog() {
  const p = new Command();
  p.exitOverride();
  addToolCommand(p);
  return p;
}

let out: string[];
let err: string[];
let exit: jest.SpyInstance;
beforeEach(() => {
  jest.resetAllMocks();
  out = [];
  err = [];
  jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  jest.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  exit = jest.spyOn(process, "exit").mockImplementation(((c?: number) => {
    throw new Error(`exit:${c}`);
  }) as any);
});
afterEach(() => jest.restoreAllMocks());

const run = (...a: string[]) => prog().parseAsync(["node", "knowhow", "tool", ...a]);

describe("knowhow tool call", () => {
  it("passes tool, parsed args and options and prints the raw text", async () => {
    mockCall.mockResolvedValue({
      workerId: "w1",
      clientKind: "mobile",
      result: { status: "ok", rawText: '{"tabs":[]}' },
    });
    await run("call", "browser_list_tabs", '{"x":1}', "--worker", "mobile", "--timeout", "5000");
    expect(mockCall.mock.calls[0][1]).toMatchObject({
      tool: "browser_list_tabs",
      args: { x: 1 },
      worker: "mobile",
      timeoutMs: 5000,
      waitApproval: false,
    });
    expect(out).toEqual(['{"tabs":[]}']);
    expect(err.join("\n")).toContain("worker=w1 kind=mobile status=ok");
    expect(exit).not.toHaveBeenCalled();
  });

  it("--json prints the full result", async () => {
    mockCall.mockResolvedValue({
      workerId: "w1",
      clientKind: "mobile",
      result: { status: "ok", rawText: "hi", tier: "read" },
    });
    await run("call", "t", "--json");
    expect(JSON.parse(out.join("\n"))).toMatchObject({ status: "ok", rawText: "hi", workerId: "w1" });
  });

  it("exits 2 and prints the approval id when still pending", async () => {
    mockCall.mockResolvedValue({
      workerId: "w1",
      clientKind: "mobile",
      result: { status: "approval_pending", approval: { approvalId: "ap1", toolName: "browser_click" } },
    });
    await expect(run("call", "browser_click", "{}")).rejects.toThrow("exit:2");
    expect(JSON.parse(out.join("\n"))).toEqual({
      status: "approval_pending",
      approval: { approvalId: "ap1", toolName: "browser_click" },
    });
  });

  it("forwards --approval-id and --wait-approval", async () => {
    mockCall.mockResolvedValue({ workerId: "w", clientKind: "k", result: { status: "ok", rawText: "" } });
    await run("call", "t", "--approval-id", "ap1", "--wait-approval", "--approval-timeout", "5000");
    expect(mockCall.mock.calls[0][1]).toMatchObject({
      approvalId: "ap1",
      waitApproval: true,
      approvalTimeoutMs: 5000,
    });
  });

  it("exits 1 on a worker error status", async () => {
    mockCall.mockResolvedValue({
      workerId: "w",
      clientKind: "k",
      result: { status: "error", workerError: "locked", rawText: '{"error":"locked"}' },
    });
    await expect(run("call", "t")).rejects.toThrow("exit:1");
    expect(out.join("\n")).toContain("locked");
  });

  it("exits 1 on invalid JSON args without calling the backend", async () => {
    await expect(run("call", "t", "{nope")).rejects.toThrow("exit:1");
    expect(mockCall).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("JSON object");
  });
});

describe("knowhow tool list", () => {
  it("prints tools for the connected client workers", async () => {
    mockList.mockResolvedValue([
      { id: "w1", clientKind: "mobile", connected: true, lastConnected: "", tools: [{ name: "a", tier: "read" }] },
    ]);
    await run("list", "--kind", "mobile");
    expect(mockList.mock.calls[0][1]).toMatchObject({ includeTools: true, kind: "mobile" });
    expect(out.join("\n")).toContain("a [read]");
  });
});
