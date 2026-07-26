import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  connectAgent,
  stopConnections,
} from "../../../src/agents/tools/connectAgent";

describe("connectAgent / stopConnections", () => {
  let tmpCwd: string;
  let originalCwd: string;
  let agentsDir: string;

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "connect-agent-"));
    process.chdir(tmpCwd);
    agentsDir = path.join(tmpCwd, ".knowhow", "processes", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(async () => {
    await stopConnections({});
    process.chdir(originalCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  function makeTask(taskId: string, threads: any[] = []): string {
    const dir = path.join(agentsDir, taskId);
    fs.mkdirSync(dir, { recursive: true });
    writeThreads(taskId, threads);
    return dir;
  }

  function writeThreads(taskId: string, threads: any[], extra: any = {}) {
    fs.writeFileSync(
      path.join(agentsDir, taskId, "metadata.json"),
      JSON.stringify({ taskId, threads, ...extra }, null, 2),
      "utf8"
    );
  }

  function readInput(taskId: string): string {
    const p = path.join(agentsDir, taskId, "input.txt");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  }

  it("rejects empty connections array", async () => {
    const res = await connectAgent({ connections: [] });
    expect(res).toMatch(/non-empty array/);
  });

  it("reports missing task dirs but still wires valid ones", async () => {
    makeTask("a");
    const res = await connectAgent({
      connections: [
        { listener: "a", speaker: "missing" },
        { listener: "a", speaker: "a" }, // self connection skipped
      ],
    });
    expect(res).toMatch(/speaker task dir not found: missing/);
    expect(res).toMatch(/self-connection for a/);
  });

  it("relays only NEW assistant messages from speaker to listener", async () => {
    // Speaker starts with one existing assistant message (should NOT be relayed)
    makeTask("listener", []);
    makeTask("speaker", [
      { role: "assistant", content: "old message" },
    ]);

    await connectAgent({
      connections: [{ listener: "listener", speaker: "speaker" }],
      intervalMs: 1000,
    });

    // Now the speaker produces a new assistant message
    writeThreads("speaker", [
      { role: "assistant", content: "old message" },
      { role: "assistant", content: "new insight" },
    ]);

    // Wait for a couple of poll cycles
    await delay(1300);

    const input = readInput("listener");
    expect(input).toContain("[from:speaker] new insight");
    expect(input).not.toContain("old message");
  });

  it("supports bidirectional in a single call (array of connections)", async () => {
    makeTask("a", []);
    makeTask("b", []);

    await connectAgent({
      connections: [
        { listener: "a", speaker: "b" },
        { listener: "b", speaker: "a" },
      ],
      intervalMs: 1000,
    });

    writeThreads("a", [{ role: "assistant", content: "from A" }]);
    writeThreads("b", [{ role: "assistant", content: "from B" }]);

    await delay(1300);

    // A hears B, B hears A
    expect(readInput("a")).toContain("[from:b] from B");
    expect(readInput("b")).toContain("[from:a] from A");
  });

  it("stops a specific connection by id", async () => {
    makeTask("l", []);
    makeTask("s", []);
    const res = await connectAgent({
      connections: [{ listener: "l", speaker: "s" }],
      intervalMs: 1000,
    });
    const idMatch = res.match(/conn_[A-Za-z0-9_]+/);
    expect(idMatch).toBeTruthy();
    const stopRes = await stopConnections({ id: idMatch![0] });
    expect(stopRes).toMatch(/Stopped connection/);
  });

  it("stopConnections() with no id stops all", async () => {
    makeTask("l2", []);
    makeTask("s2", []);
    await connectAgent({
      connections: [{ listener: "l2", speaker: "s2" }],
      intervalMs: 1000,
    });
    const res = await stopConnections({});
    expect(res).toMatch(/Stopped 1 active connection/);
  });
});
