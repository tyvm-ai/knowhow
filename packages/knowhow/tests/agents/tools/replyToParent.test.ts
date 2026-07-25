import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { replyToParent } from "../../../src/agents/tools/replyToParent";

/**
 * These tests exercise the `_ctx`-based self-referential mechanism:
 * replyToParent discovers who is calling (and which parent spawned them)
 * purely from the per-call context object threaded in as the last positional
 * argument by ToolsService.callTool.
 */
describe("replyToParent (_ctx self-referential tool)", () => {
  let tmpCwd: string;
  let originalCwd: string;
  let agentsDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "reply-parent-"));
    process.chdir(tmpCwd);
    agentsDir = path.join(tmpCwd, ".knowhow", "processes", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  function makeTask(taskId: string, meta: Record<string, any> = {}) {
    const dir = path.join(agentsDir, taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "input.txt"), "", "utf8");
    fs.writeFileSync(
      path.join(dir, "metadata.json"),
      JSON.stringify({ taskId, ...meta }, null, 2),
      "utf8"
    );
    return dir;
  }

  it("returns a helpful message when there is no parent", async () => {
    makeTask("child-1"); // no parentTaskId
    const result = await replyToParent("hi", { taskId: "child-1" });
    expect(result).toMatch(/No parent task found/);
  });

  it("uses parentTaskId directly from _ctx when provided", async () => {
    const parentDir = makeTask("parent-1");
    makeTask("child-2", { parentTaskId: "parent-1" });

    const result = await replyToParent("progress update", {
      taskId: "child-2",
      parentTaskId: "parent-1",
    });

    expect(result).toMatch(/Sent message to parent task parent-1/);
    const parentInput = fs.readFileSync(
      path.join(parentDir, "input.txt"),
      "utf8"
    );
    expect(parentInput).toContain("progress update");
    expect(parentInput).toContain("[from:child-2]");
  });

  it("falls back to reading parentTaskId from the caller's metadata.json", async () => {
    const parentDir = makeTask("parent-2");
    makeTask("child-3", { parentTaskId: "parent-2" });

    // No parentTaskId in _ctx — must be discovered from child-3's metadata.
    const result = await replyToParent("need help", { taskId: "child-3" });

    expect(result).toMatch(/Sent message to parent task parent-2/);
    const parentInput = fs.readFileSync(
      path.join(parentDir, "input.txt"),
      "utf8"
    );
    expect(parentInput).toContain("need help");
  });

  it("reads taskId/name off _ctx.caller when taskId not set directly", async () => {
    const parentDir = makeTask("parent-3");
    makeTask("child-4", { parentTaskId: "parent-3" });

    const fakeAgent = { currentTaskId: "child-4", name: "Researcher" };
    const result = await replyToParent("done researching", {
      caller: fakeAgent,
    });

    expect(result).toMatch(/Sent message to parent task parent-3/);
    const parentInput = fs.readFileSync(
      path.join(parentDir, "input.txt"),
      "utf8"
    );
    expect(parentInput).toContain("[agent:Researcher]");
    expect(parentInput).toContain("done researching");
  });

  it("appends rather than clobbers existing parent input", async () => {
    const parentDir = makeTask("parent-4");
    fs.writeFileSync(
      path.join(parentDir, "input.txt"),
      "existing message\n",
      "utf8"
    );
    makeTask("child-5", { parentTaskId: "parent-4" });

    await replyToParent("second message", {
      taskId: "child-5",
      parentTaskId: "parent-4",
    });

    const parentInput = fs.readFileSync(
      path.join(parentDir, "input.txt"),
      "utf8"
    );
    expect(parentInput).toContain("existing message");
    expect(parentInput).toContain("second message");
  });

  it("returns error for empty message", async () => {
    const result = await replyToParent("   ", { taskId: "whatever" });
    expect(result).toMatch(/No message provided/);
  });
});
