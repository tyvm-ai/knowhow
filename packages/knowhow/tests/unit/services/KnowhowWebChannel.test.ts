import { AgentSession, KnowhowWebChannel } from "../../../src/services/stateful";
import { FakeAgent, waitFor } from "../stateful/agent/fakeAgent";

const resp = (over: any = {}) => ({
  data: {
    id: "remote-1",
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
const httpError = (status: number, body: any = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { status, body });

function mockClient(over: any = {}) {
  return {
    createChatTask: jest.fn().mockResolvedValue({ data: { id: "remote-1" } }),
    appendTaskThread: jest.fn().mockImplementation(async () => resp()),
    replaceTaskThread: jest.fn().mockImplementation(async () => resp({ applied: "replaced" })),
    updateChatTask: jest.fn().mockResolvedValue({ data: {} }),
    markMessagesAsProcessed: jest.fn().mockResolvedValue({ data: {} }),
    getTaskDetails: jest.fn().mockResolvedValue({ data: { status: "running", threads: [] } }),
    getPendingMessages: jest.fn().mockResolvedValue({ data: [] }),
    ...over,
  } as any;
}

async function make(client: any, channelOpts: any = { messageId: "msg-1" }, opts: { pollMs?: number } = {}) {
  const agent = new FakeAgent();
  const channel = new KnowhowWebChannel({ ...channelOpts, client, pollMs: opts.pollMs ?? 5000, policy: { minIntervalMs: 0 } });
  const session = await AgentSession.create({
    agent: agent as any,
    taskId: "local-1",
    prompt: "do it",
    channels: [channel],
  });
  return { agent, session, channel };
}

describe("KnowhowWebChannel", () => {
  it("creates the task from the messageId, records the remote link, then appends only new messages per thread", async () => {
    const client = mockClient();
    const { agent, session } = await make(client);
    expect(client.createChatTask).toHaveBeenCalledWith({ messageId: "msg-1", prompt: "do it" });
    expect(session.meta.links?.remoteTaskId).toBe("remote-1");
    expect(session.meta.links?.remoteMessageId).toBe("msg-1");

    const run = session.start();
    await waitFor(() => client.appendTaskThread.mock.calls.some((c: any[]) => c[2].messages.length > 0));
    // first publish: a new thread is created by an append at index == threadCount
    const first = client.appendTaskThread.mock.calls.find((c: any[]) => c[2].messages.length > 0);
    expect([first[0], first[1]]).toEqual(["remote-1", 0]);
    expect(first[2].length).toBe(1);
    expect(first[2].messages.map((m: any) => m.content)).toEqual(["do it"]);

    agent.release();
    await run;
    await session.flush();
    // growth is O(new messages): append with the length AFTER the append, never a replace
    const appends = client.appendTaskThread.mock.calls.filter((c: any[]) => c[2].messages.length > 0);
    const sent = appends.flatMap((c: any[]) => c[2].messages.map((m: any) => m.content));
    expect(sent).toEqual(["do it", "ok"]);
    expect(appends[appends.length - 1][2].length).toBe(2);
    expect(client.replaceTaskThread).not.toHaveBeenCalled();
    // the terminal write carries the status fields
    const terminal = client.appendTaskThread.mock.calls.map((c: any[]) => c[2]).find((b: any) => b.inProgress === false);
    expect(terminal).toMatchObject({ inProgress: false, result: "ok", totalUsdCost: 0.5 });
    await session.close();
  });

  it("attaches to an existing remote task without creating one", async () => {
    const client = mockClient();
    const { agent, session } = await make(client, { remoteTaskId: "existing-1" });
    expect(client.createChatTask).not.toHaveBeenCalled();
    expect(session.meta.links?.remoteTaskId).toBe("existing-1");
    agent.release();
    await session.start();
    await session.close();
    expect(client.appendTaskThread.mock.calls[0][0]).toBe("existing-1");
  });

  it("409 on an append resets that thread and replaces it with the whole thread", async () => {
    let first = true;
    const client = mockClient({
      appendTaskThread: jest.fn().mockImplementation(async () => {
        if (first) {
          first = false;
          throw httpError(409, { reason: "length_mismatch", lengths: [3] });
        }
        return resp();
      }),
    });
    const { agent, session } = await make(client);
    const run = session.start();
    await waitFor(() => client.replaceTaskThread.mock.calls.length >= 1);
    const [id, index, body] = client.replaceTaskThread.mock.calls[0];
    expect([id, index]).toEqual(["remote-1", 0]);
    // the very first publish (empty thread list) hit the 409: the thread is replaced from scratch
    expect(body.messages).toEqual([]);
    agent.release();
    await run;
    await session.flush();
    // after the replace the cursor is back in sync: the rest is appended
    const sent = client.appendTaskThread.mock.calls
      .filter((c: any[]) => c[2].messages.length > 0)
      .flatMap((c: any[]) => c[2].messages.map((m: any) => m.content));
    expect(sent).toEqual(["do it", "ok"]);
    await session.close();
  });

  it("falls back to full PUTs against an old server (404)", async () => {
    const client = mockClient({
      replaceTaskThread: jest.fn().mockRejectedValue(httpError(404)),
      appendTaskThread: jest.fn().mockRejectedValue(httpError(404)),
    });
    const { agent, session } = await make(client);
    const run = session.start();
    await waitFor(() => client.updateChatTask.mock.calls.length >= 1);
    expect(client.updateChatTask.mock.calls[0][1].threads).toEqual([]);
    agent.release();
    await run;
    await session.flush();
    const last = client.updateChatTask.mock.calls[client.updateChatTask.mock.calls.length - 1][1];
    expect(last).toMatchObject({ inProgress: false, result: "ok" });
    expect(last.threads[0].map((m: any) => m.content)).toEqual(["do it", "ok"]);
    // after the first 404 the thread endpoints are not tried again
    expect(client.appendTaskThread).toHaveBeenCalledTimes(1);
    await session.close();
  });

  it("delivers pendingMessages from write responses and marks them processed after consumption", async () => {
    const client = mockClient({
      appendTaskThread: jest.fn().mockImplementation(async () =>
        resp({
          pendingMessages: [{ id: "m1", message: "hi from web", role: "user", createdAt: new Date().toISOString() }],
        })
      ),
    });
    const { agent, session } = await make(client);
    const run = session.start();
    await waitFor(() => agent.pendingUser.length === 1);
    expect(agent.pendingUser[0].content).toBe("hi from web");
    await waitFor(() => client.markMessagesAsProcessed.mock.calls.length >= 1);
    expect(client.markMessagesAsProcessed).toHaveBeenCalledWith("remote-1", ["m1"]);
    // the same pending row in later responses is not delivered twice
    agent.release();
    await run;
    await session.flush();
    expect(agent.pendingUser.length === 0 || agent.pendingUser.length === 1).toBe(true);
    expect(session.getState().inputCursors.web).toBe("m1");
    await session.close();
  });

  it("maps a paused task status (edge-triggered; the first observation is the baseline)", async () => {
    let n = 0;
    const client = mockClient({
      appendTaskThread: jest.fn().mockImplementation(async () => {
        n++;
        return resp({ status: n === 2 ? "paused" : "running" });
      }),
    });
    const { agent, session } = await make(client, { messageId: "msg-1" }, { pollMs: 30 });
    const run = session.start();
    // idle polls are cheap no-op writes whose response carries the task status
    await waitFor(() => agent.paused);
    expect(session.getLifecycle().status).toBe("paused");
    await waitFor(() => !agent.paused); // the next observation is "running" again
    agent.release();
    await run;
    await session.close();
  });

  it("prefers desiredStatus over status (new servers: owner writes status, controllers write desiredStatus)", async () => {
    let n = 0;
    const client = mockClient({
      appendTaskThread: jest.fn().mockImplementation(async () => {
        n++;
        // status stays "running" (owner-written); only the control changes
        return resp({ status: "running", desiredStatus: n === 2 ? "paused" : n === 3 ? "running" : null, controlVersion: n });
      }),
    });
    const { agent, session } = await make(client, { messageId: "msg-1" }, { pollMs: 30 });
    const run = session.start();
    await waitFor(() => agent.paused);
    expect(session.getLifecycle().status).toBe("paused");
    await waitFor(() => !agent.paused);
    agent.release();
    await run;
    await session.close();
  });

  it("stays quiet and keeps the session working when the task cannot be created", async () => {
    const client = mockClient({ createChatTask: jest.fn().mockRejectedValue(new Error("offline")) });
    const { agent, session } = await make(client);
    expect(session.meta.links?.remoteTaskId).toBeUndefined();
    agent.release();
    await expect(session.start()).resolves.toBe("ok");
    expect(client.appendTaskThread).not.toHaveBeenCalled();
    expect(client.createChatTask).toHaveBeenCalledTimes(1);
    await session.close();
  });
});
