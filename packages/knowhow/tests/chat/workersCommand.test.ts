const mockList = jest.fn();
const mockResolve = jest.fn();
const mockExec = jest.fn();
jest.mock("../../src/services/RemoteWorkers", () => ({
  listRemoteWorkers: (...a: any[]) => mockList(...a),
  summarizeWorker: (w: any) => ({ id: w.id, name: w.name }),
  probeWorkerOs: jest.fn(),
  formatWorkerTable: (ws: any[]) => ws.map((w) => `ROW ${w.name}`).join("\n"),
  resolveWorker: (...a: any[]) => mockResolve(...a),
  execOnWorker: (...a: any[]) => mockExec(...a),
}));
jest.mock("../../src/services/KnowhowClient", () => ({
  KnowhowSimpleClient: jest.fn().mockImplementation(() => ({ listWorkerTools: jest.fn() })),
}));
const mockListPaths = jest.fn();
jest.mock("../../src/workerRegistry", () => ({
  startAllWorkers: jest.fn(),
  listWorkerPaths: (...a: any[]) => mockListPaths(...a),
  unregisterWorkerPath: jest.fn(),
  clearWorkerRegistry: jest.fn(),
}));
jest.mock("../../src/worker", () => ({ worker: jest.fn() }));
jest.mock("../../src/tunnel", () => ({ TUNNEL_MINIMAL_TOOLS: [], ensureTunnelPorts: jest.fn() }));
jest.mock("../../src/fileSync", () => ({ fileSync: jest.fn() }));

import { Command } from "commander";
import { addWorkersCommand } from "../../src/commands/workers";

function prog() {
  const p = new Command();
  p.exitOverride();
  addWorkersCommand(p);
  return p;
}

let out: string[];
beforeEach(() => {
  jest.resetAllMocks();
  out = [];
  jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("knowhow workers", () => {
  it("`workers list` dispatches to the remote list", async () => {
    mockList.mockResolvedValue([{ id: "a", name: "WIN", connected: true }]);
    await prog().parseAsync(["node", "knowhow", "workers", "list"]);
    expect(mockList).toHaveBeenCalled();
    expect(out.join("\n")).toContain("ROW WIN");
  });

  it("`workers list --json` prints JSON", async () => {
    mockList.mockResolvedValue([{ id: "a", name: "WIN", connected: true }]);
    await prog().parseAsync(["node", "knowhow", "workers", "list", "--json", "--all"]);
    expect(mockList.mock.calls[0][1]).toMatchObject({ all: true });
    expect(JSON.parse(out.join("\n"))).toEqual([{ id: "a", name: "WIN" }]);
  });

  it("`workers --list` still shows locally registered paths", async () => {
    mockListPaths.mockResolvedValue(["/a/b"]);
    await prog().parseAsync(["node", "knowhow", "workers", "--list"]);
    expect(mockList).not.toHaveBeenCalled();
    expect(out.join("\n")).toContain("/a/b");
  });

  it("`workers exec <w> -- cmd` joins the command and prints stdout", async () => {
    mockResolve.mockResolvedValue({ id: "wid", name: "WIN" });
    mockExec.mockResolvedValue({ stdout: "Windows 10", raw: "Windows 10" });
    const write = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    await prog().parseAsync(["node", "knowhow", "workers", "exec", "WIN", "--", "git", "status", "--short"]);
    expect(mockExec.mock.calls[0][2]).toBe("git status --short");
    expect(write).toHaveBeenCalledWith("Windows 10\n");
    write.mockRestore();
  });
});
