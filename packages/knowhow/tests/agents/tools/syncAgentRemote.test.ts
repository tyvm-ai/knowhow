import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  syncAgentRemote,
  syncLocalAgentRemote,
} from "../../../src/agents/tools/syncAgentRemote";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("syncAgentRemote (local path)", () => {
  let tmpCwd: string;
  let originalCwd: string;
  let agentsDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "sync-remote-"));
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
    fs.writeFileSync(path.join(dir, "input.txt"), "");
    fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ taskId, ...meta }));
    return dir;
  }

  /** Stand-in for the running agent's session: link when it sees /sync:remote. */
  function fakeAgentLinks(dir: string, taskId: string, remote = UUID) {
    return setInterval(() => {
      const input = fs.readFileSync(path.join(dir, "input.txt"), "utf8");
      if (input.includes("/sync:remote")) {
        fs.writeFileSync(
          path.join(dir, "metadata.json"),
          JSON.stringify({ taskId, remoteTaskId: remote })
        );
      }
    }, 20);
  }

  it("is a no-op when already linked", async () => {
    const dir = makeTask("t1", { remoteTaskId: UUID });
    const r = await syncAgentRemote({ taskId: "t1" });
    expect(r).toEqual({ success: true, taskId: "t1", remoteTaskId: UUID, alreadyLinked: true });
    expect(fs.readFileSync(path.join(dir, "input.txt"), "utf8")).toBe("");
  });

  it("appends /sync:remote to input.txt and returns the link once metadata has it", async () => {
    const dir = makeTask("t2");
    const timer = fakeAgentLinks(dir, "t2");
    try {
      const r = await syncAgentRemote({ taskId: "t2" });
      expect(r).toEqual({ success: true, taskId: "t2", remoteTaskId: UUID });
    } finally {
      clearInterval(timer);
    }
    const input = fs.readFileSync(path.join(dir, "input.txt"), "utf8");
    expect(input).toContain('"text":"/sync:remote"');
  });

  it("passes an explicit remoteTaskId (stripping remote:) in the command", async () => {
    const dir = makeTask("t3");
    const timer = fakeAgentLinks(dir, "t3");
    try {
      const r = await syncAgentRemote({ taskId: "t3", remoteTaskId: `remote:${UUID}` });
      expect(r.remoteTaskId).toBe(UUID);
    } finally {
      clearInterval(timer);
    }
    expect(fs.readFileSync(path.join(dir, "input.txt"), "utf8")).toContain(`/sync:remote ${UUID}`);
  });

  it("defaults taskId to the caller's own task (_ctx)", async () => {
    makeTask("self-1", { remoteTaskId: UUID });
    const r = await syncAgentRemote({ _ctx: { taskId: "self-1" } });
    expect(r).toMatchObject({ success: true, taskId: "self-1", remoteTaskId: UUID });
  });

  it("fails without a task id, for a missing dir, and on timeout", async () => {
    expect(await syncAgentRemote({})).toMatchObject({ success: false });
    expect(await syncAgentRemote({ taskId: "ghost" })).toMatchObject({
      success: false,
      error: expect.stringMatching(/not found/),
    });
    makeTask("stuck");
    const r = await syncLocalAgentRemote("stuck", undefined, { timeoutMs: 100, pollMs: 20 });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/timed out/);
  });
});
