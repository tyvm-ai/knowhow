import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { waitForAgentCompleted } from "../../../src/agents/tools/waitForAgentCompleted";

describe("waitForAgentCompleted", () => {
  let tmpCwd: string;
  let originalCwd: string;
  let agentsDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "wait-agent-"));
    process.chdir(tmpCwd);
    agentsDir = path.join(tmpCwd, ".knowhow", "processes", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  function makeTask(taskId: string, meta: Record<string, any> = {}, status?: string) {
    const dir = path.join(agentsDir, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "metadata.json"),
      JSON.stringify({ taskId, ...meta }, null, 2),
      "utf8"
    );
    if (status !== undefined) {
      fs.writeFileSync(path.join(dir, "status.txt"), status, "utf8");
    }
    return dir;
  }

  it("returns error when taskId missing", async () => {
    const res = JSON.parse(await waitForAgentCompleted({ taskId: "" }));
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/taskId is required/);
  });

  it("returns error when task directory does not exist", async () => {
    const res = JSON.parse(await waitForAgentCompleted({ taskId: "nope" }));
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/No agent task directory/);
  });

  it("returns immediately with structured result for a completed task", async () => {
    makeTask("done-1", {
      status: "completed",
      totalCostUsd: 1.23,
      result: "the final answer",
      artifacts: ["a.txt"],
    });

    const res = JSON.parse(await waitForAgentCompleted({ taskId: "done-1" }));
    expect(res.status).toBe("completed");
    expect(res.costUsd).toBe(1.23);
    expect(res.finalAnswer).toBe("the final answer");
    expect(res.artifacts).toEqual(["a.txt"]);
  });

  it("falls back to last assistant message when no result field", async () => {
    makeTask("done-2", {
      status: "completed",
      totalCostUsd: 0.5,
      threads: [
        [
          { role: "user", content: "do it" },
          { role: "assistant", content: "I did it" },
        ],
      ],
    });

    const res = JSON.parse(await waitForAgentCompleted({ taskId: "done-2" }));
    expect(res.finalAnswer).toBe("I did it");
  });

  it("treats inProgress:false with no status as completed", async () => {
    makeTask("done-3", { inProgress: false, totalCostUsd: 0.1, result: "ok" });
    const res = JSON.parse(await waitForAgentCompleted({ taskId: "done-3" }));
    expect(res.status).toBe("completed");
  });

  it("times out on a still-running task", async () => {
    makeTask("running-1", { status: "running", totalCostUsd: 0.2 });
    const res = JSON.parse(
      await waitForAgentCompleted({
        taskId: "running-1",
        timeoutMs: 300,
        pollIntervalMs: 100,
      })
    );
    expect(res.timedOut).toBe(true);
    expect(res.status).toBe("running");
    expect(res.costUsd).toBe(0.2);
  });

  it("resolves when a running task transitions to completed mid-poll", async () => {
    const dir = makeTask("running-2", { status: "running", totalCostUsd: 0 });

    // Flip to completed shortly after we start waiting.
    setTimeout(() => {
      fs.writeFileSync(
        path.join(dir, "metadata.json"),
        JSON.stringify(
          {
            taskId: "running-2",
            status: "completed",
            totalCostUsd: 2.0,
            result: "eventually done",
          },
          null,
          2
        ),
        "utf8"
      );
    }, 150);

    const res = JSON.parse(
      await waitForAgentCompleted({
        taskId: "running-2",
        timeoutMs: 3000,
        pollIntervalMs: 100,
      })
    );
    expect(res.status).toBe("completed");
    expect(res.finalAnswer).toBe("eventually done");
    expect(res.costUsd).toBe(2.0);
  });

  it("fails a task whose pid is dead without a terminal status", async () => {
    // Use a pid that is virtually guaranteed not to exist.
    makeTask("crashed-1", { status: "running", totalCostUsd: 0.3, pid: 999999 });
    const res = JSON.parse(
      await waitForAgentCompleted({
        taskId: "crashed-1",
        timeoutMs: 5000,
        pollIntervalMs: 100,
      })
    );
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/exited without writing a terminal status/);
  });
});
