import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgentSyncFs } from "../../../src/services/AgentSyncFs";
import { appendInput } from "../../../src/services/stateful";

function fakeAgent() {
  const pending: any[] = [];
  const interrupts: Array<string | undefined> = [];
  const threads: any[][] = [[]];
  return {
    pending,
    interrupts,
    name: "fake",
    addPendingUserMessage: (m: any) => pending.push(m),
    interrupt: (m?: string) => interrupts.push(m),
    getPendingUserMessageCount: () => pending.length,
    /** the agent's next turn moves pending messages into the thread */
    flushPendingIntoThread: () => threads[0].push(...pending.splice(0)),
    getThreads: () => threads,
    getTotalCostUsd: () => 0,
    getTokenUsage: () => ({}),
    getModel: () => "m",
    getProvider: () => "p",
    getEnabledToolNames: () => [],
  } as any;
}

describe("AgentSyncFs input.txt (cursor protocol)", () => {
  let cwd: string;
  let prevCwd: string;
  let taskDir: string;
  const log = console.log;
  beforeEach(() => {
    prevCwd = process.cwd();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agentsyncfs-"));
    process.chdir(cwd);
    console.log = () => {};
  });
  afterAll(() => {
    // the shared cleanup interval would keep jest alive
    new AgentSyncFs().stopCleanup();
  });
  afterEach(() => {
    console.log = log;
    process.chdir(prevCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  async function setup(taskId = "t1") {
    const sync = new AgentSyncFs();
    await sync.createTask({ taskId, prompt: "p" });
    taskDir = path.join(".knowhow/processes/agents", taskId);
    return sync as any;
  }

  it("does not truncate existing input on createTask; reads each record as one message", async () => {
    fs.mkdirSync(".knowhow/processes/agents/t1", { recursive: true });
    fs.writeFileSync(".knowhow/processes/agents/t1/input.txt", "left over\n");
    const sync = await setup();
    const agent = fakeAgent();
    appendInput(path.join(taskDir, "input.txt"), { text: "m1" });
    appendInput(path.join(taskDir, "input.txt"), { text: "/poke now" });
    appendInput(path.join(taskDir, "input.txt"), { text: "m2" });
    await sync.checkForChanges(agent);
    expect(agent.pending.map((m: any) => m.content)).toEqual(["left over", "m1", "m2"]);
    expect(agent.interrupts).toEqual(["now"]); // /poke is a command only for its own record
  });

  it("commits the cursor with the thread, trims by rename+delete, loses nothing", async () => {
    const sync = await setup();
    const agent = fakeAgent();
    const input = path.join(taskDir, "input.txt");
    appendInput(input, { text: "one" });
    await sync.checkForChanges(agent);
    expect(agent.pending).toHaveLength(1);

    // metadata written while the message is still pending: cursor NOT committed
    await sync.updateMetadata(agent, true);
    expect(JSON.parse(fs.readFileSync(path.join(taskDir, "metadata.json"), "utf8")).inputCursor).toBeUndefined();
    expect(fs.readFileSync(input, "utf8")).toContain("one"); // not trimmed yet

    // the message moved into the thread: next write commits message + cursor together
    agent.flushPendingIntoThread();
    await sync.updateMetadata(agent, true);
    const meta = JSON.parse(fs.readFileSync(path.join(taskDir, "metadata.json"), "utf8"));
    expect(meta.threads[0]).toHaveLength(1);
    // trimmed afterwards: file rotated away and cursor reset
    expect(fs.existsSync(input)).toBe(false);
    expect(fs.existsSync(input + ".consuming")).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(taskDir, "metadata.json"), "utf8")).inputCursor).toEqual({ inode: 0, offset: 0 });

    appendInput(input, { text: "two" }); // fresh file after rotation
    await sync.checkForChanges(agent);
    expect(agent.pending.map((m: any) => m.content)).toEqual(["two"]);
  });

  it("restart resumes from the committed cursor (no replay)", async () => {
    const sync = await setup();
    const agent = fakeAgent();
    const input = path.join(taskDir, "input.txt");
    appendInput(input, { text: "a" });
    appendInput(input, { text: "b" });
    await sync.checkForChanges(agent);
    agent.flushPendingIntoThread();
    // commit without trimming: simulate crash right after the metadata write
    (sync as any).trimInput = async () => {};
    await sync.updateMetadata(agent, true);
    appendInput(input, { text: "c" });

    const sync2 = new AgentSyncFs() as any;
    const agent2 = fakeAgent();
    // what setupAgentSync does on (re)start, minus the event/watch wiring
    sync2.taskId = "t1";
    sync2.taskPath = path.join(".knowhow/processes/agents", "t1");
    await sync2.loadInputCursor();
    await sync2.checkForChanges(agent2);
    expect(agent2.pending.map((m: any) => m.content)).toEqual(["c"]);
  });
});
