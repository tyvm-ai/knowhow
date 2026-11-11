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
    const res = JSON.parse(
      await waitForAgentCompleted({ taskId: "nope", dirGraceMs: 0 })
    );
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/No agent task directory/);
  });

  it("waits for a just-spawned task's directory to appear (startAgentTask race)", async () => {
    setTimeout(
      () => makeTask("late-1", { status: "completed", result: "ok" }),
      700
    );
    const res = JSON.parse(
      await waitForAgentCompleted({ taskId: "late-1", dirGraceMs: 5000 })
    );
    expect(res.status).toBe("completed");
    expect(res.finalAnswer).toBe("ok");
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

  describe("interruptible wait", () => {
    const fastOpts = { timeoutMs: 5000, pollIntervalMs: 250 };

    it("tags a normal completion with reason 'completed'", async () => {
      makeTask("c-1", { status: "completed", result: "x" });
      const res = JSON.parse(await waitForAgentCompleted({ taskId: "c-1" }));
      expect(res.reason).toBe("completed");
      expect(res.interrupted).toBeUndefined();
    });

    it("tags a timeout with reason 'timeout'", async () => {
      makeTask("t-1", { status: "running" });
      const res = JSON.parse(
        await waitForAgentCompleted({
          taskId: "t-1",
          timeoutMs: 300,
          pollIntervalMs: 250,
        })
      );
      expect(res.timedOut).toBe(true);
      expect(res.reason).toBe("timeout");
    });

    it("returns pending_message early when the caller agent has a pending message (not consumed)", async () => {
      makeTask("child-1", { status: "running", totalCostUsd: 0.4 });
      let pending = false;
      const caller = { hasPendingMessages: jest.fn(() => pending) };
      setTimeout(() => (pending = true), 300);

      const started = Date.now();
      const res = JSON.parse(
        await waitForAgentCompleted({
          taskId: "child-1",
          ...fastOpts,
          pollIntervalMs: 2000, // slow status poll: message must still be noticed fast
          _ctx: { caller },
        })
      );
      expect(Date.now() - started).toBeLessThan(2000);
      expect(res.interrupted).toBe(true);
      expect(res.reason).toBe("pending_message");
      expect(res.status).toBe("running");
      expect(res.taskId).toBe("child-1");
      expect(res.hint).toMatch(/again/);
      // peeking only: the flag is untouched
      expect(pending).toBe(true);
    });

    it("returns pending_message immediately when a message is already pending", async () => {
      makeTask("child-2", { status: "running" });
      const res = JSON.parse(
        await waitForAgentCompleted({
          taskId: "child-2",
          ...fastOpts,
          _ctx: { caller: { hasPendingMessages: () => true } },
        })
      );
      expect(res.reason).toBe("pending_message");
    });

    it("ignores pending messages when interruptOnMessages is false", async () => {
      makeTask("child-3", { status: "running" });
      const res = JSON.parse(
        await waitForAgentCompleted({
          taskId: "child-3",
          timeoutMs: 400,
          pollIntervalMs: 250,
          interruptOnMessages: false,
          _ctx: { caller: { hasPendingMessages: () => true } },
        })
      );
      expect(res.timedOut).toBe(true);
      expect(res.interrupted).toBeUndefined();
    });

    it("completion wins over a pending message when both are true", async () => {
      makeTask("child-4", { status: "completed", result: "done" });
      const res = JSON.parse(
        await waitForAgentCompleted({
          taskId: "child-4",
          _ctx: { caller: { hasPendingMessages: () => true } },
        })
      );
      expect(res.reason).toBe("completed");
      expect(res.finalAnswer).toBe("done");
    });

    it("falls back to the caller's input.txt when there is no live caller", async () => {
      makeTask("child-5", { status: "running" });
      const callerDir = makeTask("caller-5", { status: "running" });
      const inputPath = path.join(callerDir, "input.txt");
      fs.writeFileSync(inputPath, "");
      setTimeout(
        () =>
          fs.appendFileSync(
            inputPath,
            JSON.stringify({ kind: "message", text: "hi parent", from: "child-5" }) + "\n"
          ),
        200
      );
      const res = JSON.parse(
        await waitForAgentCompleted({
          taskId: "child-5",
          ...fastOpts,
          _ctx: { taskId: "caller-5" },
        })
      );
      expect(res.reason).toBe("pending_message");
      // not consumed
      expect(fs.readFileSync(inputPath, "utf8")).toContain("hi parent");
    });

    it("does not interrupt for an empty caller input.txt", async () => {
      makeTask("child-6", { status: "running" });
      const callerDir = makeTask("caller-6", { status: "running" });
      fs.writeFileSync(path.join(callerDir, "input.txt"), "");
      const res = JSON.parse(
        await waitForAgentCompleted({
          taskId: "child-6",
          timeoutMs: 400,
          pollIntervalMs: 250,
          _ctx: { taskId: "caller-6" },
        })
      );
      expect(res.timedOut).toBe(true);
    });

    it("returns child_status when a child transitions to waiting", async () => {
      const dir = makeTask("child-7", { status: "running" });
      setTimeout(
        () =>
          fs.writeFileSync(
            path.join(dir, "metadata.json"),
            JSON.stringify({ taskId: "child-7", status: "waiting" })
          ),
        200
      );
      const res = JSON.parse(
        await waitForAgentCompleted({ taskId: "child-7", ...fastOpts })
      );
      expect(res.interrupted).toBe(true);
      expect(res.reason).toBe("child_status");
      expect(res.status).toBe("waiting");
    });

    it("can wait through a waiting child with interruptOnChildStatus:false", async () => {
      makeTask("child-8", { status: "paused" });
      const res = JSON.parse(
        await waitForAgentCompleted({
          taskId: "child-8",
          timeoutMs: 400,
          pollIntervalMs: 250,
          interruptOnChildStatus: false,
        })
      );
      expect(res.timedOut).toBe(true);
    });

    it("taskIds returns the first child that completes", async () => {
      makeTask("m-a", { status: "running" });
      const b = makeTask("m-b", { status: "running" });
      makeTask("m-c", { status: "running" });
      setTimeout(
        () =>
          fs.writeFileSync(
            path.join(b, "metadata.json"),
            JSON.stringify({ taskId: "m-b", status: "completed", result: "b done" })
          ),
        200
      );
      const res = JSON.parse(
        await waitForAgentCompleted({
          taskIds: ["m-a", "m-b", "m-c"],
          ...fastOpts,
        })
      );
      expect(res.reason).toBe("completed");
      expect(res.taskId).toBe("m-b");
      expect(res.finalAnswer).toBe("b done");
      expect(res.taskIds).toEqual(["m-a", "m-b", "m-c"]);
    });

    it("taskIds errors when one directory is missing", async () => {
      makeTask("m-x", { status: "running" });
      const res = JSON.parse(
        await waitForAgentCompleted({ taskIds: ["m-x", "ghost"], dirGraceMs: 0 })
      );
      expect(res.status).toBe("error");
      expect(res.error).toMatch(/ghost/);
    });

    it("returns user_interrupt cleanly when the call's abort signal fires", async () => {
      makeTask("child-9", { status: "running" });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200);
      const started = Date.now();
      const res = JSON.parse(
        await waitForAgentCompleted({
          taskId: "child-9",
          timeoutMs: 10000,
          pollIntervalMs: 2000,
          _ctx: { signal: ac.signal },
        })
      );
      expect(Date.now() - started).toBeLessThan(1500);
      expect(res.interrupted).toBe(true);
      expect(res.reason).toBe("user_interrupt");
    });

    it("description tells agents to call it again after handling the message", () => {
      const {
        waitForAgentCompletedDefinition,
      } = require("../../../src/agents/tools/waitForAgentCompleted");
      const d = waitForAgentCompletedDefinition.function.description;
      expect(d).toMatch(/CALL waitForAgentCompleted AGAIN/);
      expect(waitForAgentCompletedDefinition.function.parameters.properties).toHaveProperty("taskIds");
      expect(waitForAgentCompletedDefinition.function.parameters.properties).toHaveProperty("interruptOnMessages");
    });
  });
});
