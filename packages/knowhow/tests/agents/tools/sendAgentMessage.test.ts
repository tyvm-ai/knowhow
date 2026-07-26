import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sendAgentMessage } from "../../../src/agents/tools/sendAgentMessage";

describe("sendAgentMessage", () => {
  let tmpCwd: string;
  let originalCwd: string;
  let agentsDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "send-msg-"));
    process.chdir(tmpCwd);
    agentsDir = path.join(tmpCwd, ".knowhow", "processes", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  function makeTask(taskId: string): string {
    const dir = path.join(agentsDir, taskId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("requires taskId and message", async () => {
    expect(await sendAgentMessage({ taskId: "", message: "hi" })).toMatch(
      /taskId is required/
    );
    expect(await sendAgentMessage({ taskId: "x", message: "" })).toMatch(
      /message is required/
    );
  });

  it("errors when the target task dir doesn't exist", async () => {
    const res = await sendAgentMessage({ taskId: "nope", message: "hi" });
    expect(res).toMatch(/target task directory not found/);
  });

  it("appends an envelope with sender identity from _ctx", async () => {
    makeTask("child-1");
    const res = await sendAgentMessage({
      taskId: "child-1",
      message: "do the thing",
      _ctx: { taskId: "parent-1", caller: { name: "Developer" } },
    });
    expect(res).toMatch(/Sent message to task child-1/);
    const input = fs.readFileSync(
      path.join(agentsDir, "child-1", "input.txt"),
      "utf8"
    );
    expect(input).toContain("[from:parent-1/Developer] do the thing");
  });

  it("uses explicit from when provided", async () => {
    makeTask("child-2");
    await sendAgentMessage({
      taskId: "child-2",
      message: "msg",
      from: "orchestrator",
    });
    const input = fs.readFileSync(
      path.join(agentsDir, "child-2", "input.txt"),
      "utf8"
    );
    expect(input).toContain("[from:orchestrator] msg");
  });

  it("delivers as /poke when poke:true (interrupts recipient)", async () => {
    makeTask("child-3");
    await sendAgentMessage({
      taskId: "child-3",
      message: "stop and reconsider",
      from: "boss",
      poke: true,
    });
    const input = fs.readFileSync(
      path.join(agentsDir, "child-3", "input.txt"),
      "utf8"
    );
    expect(input).toMatch(/^\/poke \[from:boss\] stop and reconsider/);
  });

  it("appends without clobbering existing pending messages", async () => {
    const dir = makeTask("child-4");
    fs.writeFileSync(path.join(dir, "input.txt"), "existing line\n", "utf8");
    await sendAgentMessage({
      taskId: "child-4",
      message: "second",
      from: "a",
    });
    const input = fs.readFileSync(path.join(dir, "input.txt"), "utf8");
    expect(input).toBe("existing line\n[from:a] second\n");
  });
});
