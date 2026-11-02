import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgentFsChannel, AgentSession, appendInput } from "../../../../src/services/stateful";
import { FakeAgent, waitFor } from "./fakeAgent";

const mockCreateRemote = jest.fn();
jest.mock("../../../../src/services/RemoteTaskLink", () => ({
  ...jest.requireActual("../../../../src/services/RemoteTaskLink"),
  createRemoteTaskForAgent: (...a: any[]) => mockCreateRemote(...a),
}));

const UUID = "11111111-2222-4333-8444-555555555555";
const resp = (over: any = {}) => ({
  data: {
    id: UUID,
    applied: "appended",
    revision: 1,
    lengths: [1],
    inProgress: true,
    status: "running",
    totalUsdCost: 0,
    updatedAt: new Date().toISOString(),
    pendingMessages: [],
    ...over,
  },
});

function mockClient() {
  return {
    appendTaskThread: jest.fn().mockImplementation(async () => resp()),
    replaceTaskThread: jest.fn().mockImplementation(async () => resp({ applied: "replaced" })),
    updateChatTask: jest.fn().mockResolvedValue({ data: {} }),
    markMessagesAsProcessed: jest.fn().mockResolvedValue({ data: {} }),
    getTaskDetails: jest.fn().mockResolvedValue({ data: { status: "running", threads: [] } }),
    getPendingMessages: jest.fn().mockResolvedValue({ data: [] }),
  } as any;
}

describe("AgentSession /sync:remote input command", () => {
  let dir: string;
  let taskDir: string;
  beforeEach(() => {
    mockCreateRemote.mockReset().mockResolvedValue({ sessionId: "s1", messageId: "m1", taskId: UUID });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-session-sync-"));
    taskDir = path.join(dir, "t1");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const meta = () => JSON.parse(fs.readFileSync(path.join(taskDir, "metadata.json"), "utf8"));

  async function make(client: any) {
    const agent = new FakeAgent();
    const session = await AgentSession.create({
      agent: agent as any,
      taskId: "t1",
      prompt: "build the thing",
      channels: [new AgentFsChannel({ taskId: "t1", baseDir: dir, pollMs: 20, input: { partialSettleMs: 50 } })],
      webClient: client,
    });
    return { agent, session };
  }
  const input = () => path.join(taskDir, "input.txt");

  it("creates a remote task, attaches the web channel, pushes history and persists the link", async () => {
    const client = mockClient();
    const { agent, session } = await make(client);
    const run = session.start();
    await waitFor(() => agent.threads.length > 0);

    appendInput(input(), { text: "/sync:remote" });
    await waitFor(() => session.channels().some((c) => c.id === "web"));

    expect(mockCreateRemote).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "build the thing", agentName: "Fake", client })
    );
    // full thread history is published on attach
    await waitFor(() => client.appendTaskThread.mock.calls.some((c: any[]) => c[2].messages.length > 0));
    const first = client.appendTaskThread.mock.calls.find((c: any[]) => c[2].messages.length > 0);
    expect(first[0]).toBe(UUID);
    expect(first[2].messages[0].content).toBe("build the thing");
    expect(session.meta.links?.remoteTaskId).toBe(UUID);
    expect(session.meta.links?.remoteMessageId).toBe("m1");
    await waitFor(() => meta().remoteTaskId === UUID);
    expect(meta().knowhowTaskId).toBe(UUID);
    // the command is not forwarded to the agent as a user message
    expect(agent.pendingUser.map((m) => m.content)).not.toContain("/sync:remote");

    agent.release();
    await run;
    await session.close();
  });

  it("attaches to a given remote uuid without creating a remote task", async () => {
    const client = mockClient();
    const { agent, session } = await make(client);
    const run = session.start();
    appendInput(input(), { text: `/sync:remote ${UUID}` });
    await waitFor(() => session.channels().some((c) => c.id === "web"));
    expect(mockCreateRemote).not.toHaveBeenCalled();
    expect(session.meta.links?.remoteTaskId).toBe(UUID);
    agent.release();
    await run;
    await session.close();
  });

  it("is a no-op when already linked", async () => {
    const client = mockClient();
    const { agent, session } = await make(client);
    const run = session.start();
    appendInput(input(), { text: "/sync:remote" });
    await waitFor(() => session.channels().some((c) => c.id === "web"));
    appendInput(input(), { text: "/sync:remote" });
    await new Promise((r) => setTimeout(r, 200));
    expect(mockCreateRemote).toHaveBeenCalledTimes(1);
    expect(session.channels().filter((c) => c.id === "web")).toHaveLength(1);
    agent.release();
    await run;
    await session.close();
  });

  it("does not attach (and does not throw) when creating the remote task fails", async () => {
    mockCreateRemote.mockRejectedValue(new Error("backend down"));
    const { agent, session } = await make(mockClient());
    const run = session.start();
    appendInput(input(), { text: "/sync:remote" });
    await new Promise((r) => setTimeout(r, 300));
    expect(session.channels().some((c) => c.id === "web")).toBe(false);
    expect(mockCreateRemote).toHaveBeenCalledTimes(1);
    agent.release();
    await run;
    await session.close();
  });

  it("/sync:remote:off detaches the web channel", async () => {
    const client = mockClient();
    const { agent, session } = await make(client);
    const run = session.start();
    appendInput(input(), { text: "/sync:remote" });
    await waitFor(() => session.channels().some((c) => c.id === "web"));
    appendInput(input(), { text: "/sync:remote:off" });
    await waitFor(() => !session.channels().some((c) => c.id === "web"));
    agent.release();
    await run;
    await session.close();
  });

  it("after attaching, backend pendingMessages (e.g. replyToParent from a remote child) arrive as agent input", async () => {
    const client = mockClient();
    let delivered = false;
    client.appendTaskThread.mockImplementation(async () => {
      const pending = delivered
        ? []
        : [{ id: "pm1", message: "[from:child/Patcher] all done", role: "user", createdAt: Date.now() }];
      delivered = true;
      return resp({ pendingMessages: pending });
    });
    const { agent, session } = await make(client);
    const run = session.start();
    appendInput(input(), { text: `/sync:remote ${UUID}` });
    await waitFor(() => agent.pendingUser.some((m) => m.content === "[from:child/Patcher] all done"));
    await waitFor(() => client.markMessagesAsProcessed.mock.calls.length > 0);
    expect(client.markMessagesAsProcessed).toHaveBeenCalledWith(UUID, ["pm1"]);
    agent.release();
    await run;
    await session.close();
  });
});
