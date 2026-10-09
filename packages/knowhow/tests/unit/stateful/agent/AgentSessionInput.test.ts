import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AgentFsChannel,
  AgentSession,
  appendInput,
  loadAgentRestoreState,
} from "../../../../src/services/stateful";
import { FakeAgent, waitFor } from "./fakeAgent";

describe("AgentSession input.txt (cursor protocol)", () => {
  let dir: string;
  let taskDir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-input-"));
    taskDir = path.join(dir, "t1");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const meta = () => JSON.parse(fs.readFileSync(path.join(taskDir, "metadata.json"), "utf8"));
  const channel = (trim = true) =>
    new AgentFsChannel({ taskId: "t1", baseDir: dir, pollMs: 20, input: { partialSettleMs: 50, trim } });

  async function make(trim = true, restore?: any) {
    const agent = new FakeAgent();
    const session = await AgentSession.create({
      agent: agent as any,
      taskId: "t1",
      prompt: "p",
      channels: [channel(trim)],
      restore,
    });
    return { agent, session };
  }

  it("does not truncate existing input; reads each record as one message; /poke only for its own record", async () => {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "input.txt"), "left over\n");
    const { agent, session } = await make();
    const input = path.join(taskDir, "input.txt");
    appendInput(input, { text: "m1" });
    appendInput(input, { text: "/poke now" });
    appendInput(input, { text: "m2" });
    await waitFor(() => agent.pendingUser.length === 4);
    expect(agent.pendingUser.map((m) => m.content)).toEqual(["left over", "m1", "now", "m2"]);
    expect(agent.interrupts).toEqual(["now"]);
    agent.release();
    await session.start();
    await session.close();
  });

  it("trims by rename+delete once persisted and keeps reading the fresh file", async () => {
    const { agent, session } = await make();
    const input = path.join(taskDir, "input.txt");
    appendInput(input, { text: "one" });
    await waitFor(() => agent.pendingUser.length === 1);
    await waitFor(() => !fs.existsSync(input));
    expect(fs.existsSync(input + ".consuming")).toBe(false);
    await waitFor(() => meta().inputCursor?.offset === 0);
    appendInput(input, { text: "two" }); // fresh file after rotation
    await waitFor(() => agent.pendingUser.length === 2);
    expect(agent.pendingUser.map((m) => m.content)).toEqual(["one", "two"]);
    agent.release();
    await session.start();
    await session.close();
  });

  it("restart resumes from the persisted cursor and re-adds unplaced messages (no loss, no replay)", async () => {
    const first = await make(false); // no trim: a crash right after the metadata write
    const input = path.join(taskDir, "input.txt");
    appendInput(input, { text: "a" });
    appendInput(input, { text: "b" });
    await waitFor(() => first.agent.pendingUser.length === 2);
    await waitFor(() => meta().pendingUserMessages?.length === 2 && meta().inputCursor?.offset > 0);
    await first.session.flush();
    appendInput(input, { text: "c" }); // arrives while nobody owns the task
    // "crash": the first session is abandoned (its pollers die with the channel)
    await first.session.detach("fs");

    const restore = await loadAgentRestoreState("t1", dir);
    expect(restore?.pendingUserMessages?.map((m: any) => m.content)).toEqual(["a", "b"]);
    const second = await make(true, restore);
    await waitFor(() => second.agent.pendingUser.length === 3);
    expect(second.agent.pendingUser.map((m) => m.content)).toEqual(["a", "b", "c"]);
    second.agent.release();
    await second.session.start();
    await second.session.close();
  });
});
