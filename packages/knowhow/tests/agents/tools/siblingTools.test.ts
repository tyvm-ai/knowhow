import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { waitForAgentMessage } from "../../../src/agents/tools/waitForAgentMessage";
import { listAgents } from "../../../src/agents/tools/listAgents";
import { LazyToolsService } from "../../../src/services/LazyToolsService";

function fakeCaller(initial: any[] = []) {
  const pending = [...initial];
  return {
    pending,
    peekPendingMessages: () => [...pending],
  };
}

describe("waitForAgentMessage", () => {
  it("returns timeout when nothing arrives", async () => {
    const caller = fakeCaller();
    const res = JSON.parse(
      await waitForAgentMessage({
        timeoutMs: 300,
        pollIntervalMs: 100,
        _ctx: { caller },
      })
    );
    expect(res.status).toBe("timeout");
    expect(res.timedOut).toBe(true);
  });

  it("wakes when a message from the awaited sibling arrives (and ignores others)", async () => {
    const caller = fakeCaller();
    setTimeout(
      () => caller.pending.push({ role: "user", content: "[from:other-1] hi" }),
      100
    );
    setTimeout(
      () =>
        caller.pending.push({
          role: "user",
          content: "[from:builder-7/Patcher] build is green",
        }),
      500
    );
    const res = JSON.parse(
      await waitForAgentMessage({
        fromTaskId: "builder-7",
        timeoutMs: 5000,
        pollIntervalMs: 100,
        _ctx: { caller },
      })
    );
    expect(res.status).toBe("message");
    expect(res.elapsedMs).toBeGreaterThanOrEqual(400);
    expect(res.preview).toContain("build is green");
    // never consumed
    expect(caller.pending).toHaveLength(2);
  });

  it("wakes on any message when no fromTaskId", async () => {
    const caller = fakeCaller([{ role: "user", content: "[from:x] ping" }]);
    const res = JSON.parse(
      await waitForAgentMessage({ timeoutMs: 1000, _ctx: { caller } })
    );
    expect(res.reason).toBe("message");
  });

  it("errors without an agent caller", async () => {
    const res = JSON.parse(await waitForAgentMessage({ timeoutMs: 100 }));
    expect(res.status).toBe("error");
  });
});

describe("listAgents", () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "listagents-"));
    process.chdir(dir);
    const mk = (id: string, meta: any) => {
      const d = path.join(dir, ".knowhow", "processes", "agents", id);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(
        path.join(d, "metadata.json"),
        JSON.stringify({ taskId: id, startTime: new Date().toISOString(), lastUpdate: new Date().toISOString(), ...meta })
      );
    };
    mk("parent", { agentName: "Developer", status: "running", pid: process.pid });
    mk("a", {
      agentName: "Patcher",
      status: "running",
      pid: process.pid,
      parentTaskId: "parent",
      totalCostUsd: 0.5,
      threads: [[{ role: "assistant", content: "Working on it.\nSee .knowhow/tasks/x/a-report.md" }]],
    });
    mk("b", { agentName: "Researcher", status: "completed", parentTaskId: "parent" });
    mk("c", { agentName: "Other", status: "running", pid: process.pid, parentTaskId: "elsewhere" });
  });
  afterEach(() => {
    process.chdir(cwd);
  });

  it("lists siblings of the caller with last message + report path", async () => {
    const res = JSON.parse(
      await listAgents({ siblings: true, _ctx: { taskId: "a", parentTaskId: "parent" } })
    );
    expect(res.you).toBe("a");
    expect(res.agents.map((x: any) => x.taskId)).toEqual(["b"]);
  });

  it("lists children of self, with lastMessage/reportPath/parent", async () => {
    const res = JSON.parse(
      await listAgents({ parentTaskId: "self", _ctx: { taskId: "parent" } })
    );
    const a = res.agents.find((x: any) => x.taskId === "a");
    expect(a.parentTaskId).toBe("parent");
    expect(a.lastMessage).toContain("Working on it.");
    expect(a.reportPath).toBe(".knowhow/tasks/x/a-report.md");
    expect(a.costUsd).toBe(0.5);
  });
});

describe("LazyToolsService coordination auto-enable", () => {
  it("enabling startAgentTask also enables the coordination tools", () => {
    const tools = new LazyToolsService();
    const mk = (name: string) => ({
      type: "function" as const,
      function: { name, description: name, parameters: { type: "object", properties: {}, required: [] } },
    });
    tools.addTools(
      ["startAgentTask", "sendAgentMessage", "waitForAgentCompleted", "waitForAgentMessage", "listAgents", "replyToParent"].map(mk)
    );
    expect(tools.getTools().map((t) => t.function.name)).not.toContain("listAgents");
    tools.enableTools(["startAgentTask"]);
    const names = tools.getTools().map((t) => t.function.name);
    for (const n of ["sendAgentMessage", "waitForAgentCompleted", "waitForAgentMessage", "listAgents", "replyToParent"]) {
      expect(names).toContain(n);
    }
  });
});
