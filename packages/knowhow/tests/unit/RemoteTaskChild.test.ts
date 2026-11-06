import { createRemoteTaskForAgent } from "../../src/services/RemoteTaskLink";

const PARENT = "8ee8aa2d-a2fe-4468-ba74-36770af3be0a";

function mockClient(over: any = {}) {
  return {
    createChatTask: jest.fn(),
    createSessionPlaceholder: jest.fn().mockResolvedValue({ sessionId: "new-session", orgId: "o" }),
    createMessagePlaceholder: jest.fn().mockResolvedValue({ messageId: "new-msg", taskId: "new-task" }),
    ...over,
  } as any;
}

describe("createRemoteTaskForAgent child tasks", () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errSpy.mockRestore());

  it("top-level (no parent): creates its own session + message placeholder", async () => {
    const client = mockClient();
    const link = await createRemoteTaskForAgent({ prompt: "hello", client });
    expect(client.createChatTask).not.toHaveBeenCalled();
    expect(client.createSessionPlaceholder).toHaveBeenCalledTimes(1);
    expect(link).toEqual({ sessionId: "new-session", messageId: "new-msg", taskId: "new-task" });
  });

  it("with a parent: attaches a child task to the parent's message/session (no new session)", async () => {
    const client = mockClient({
      createChatTask: jest.fn().mockResolvedValue({
        data: { id: "child-task", messageId: "parent-msg", sessionId: "parent-session", parentTaskId: PARENT },
      }),
    });
    const link = await createRemoteTaskForAgent({
      prompt: "do the sub task",
      parentRemoteTaskId: `remote:${PARENT}`,
      client,
    });
    expect(client.createChatTask).toHaveBeenCalledWith({
      parentTaskId: PARENT,
      prompt: "do the sub task",
    });
    expect(client.createSessionPlaceholder).not.toHaveBeenCalled();
    expect(client.createMessagePlaceholder).not.toHaveBeenCalled();
    expect(link).toEqual({ sessionId: "parent-session", messageId: "parent-msg", taskId: "child-task" });
  });

  it("falls back to a new session when the backend can't link the child (error)", async () => {
    const client = mockClient({
      createChatTask: jest.fn().mockRejectedValue(new Error("Parent task not found")),
    });
    const link = await createRemoteTaskForAgent({ prompt: "x", parentRemoteTaskId: PARENT, client });
    expect(client.createSessionPlaceholder).toHaveBeenCalledTimes(1);
    expect(link.sessionId).toBe("new-session");
  });

  it("falls back when an older backend ignores parentTaskId (no parent link in the response)", async () => {
    const client = mockClient({
      createChatTask: jest.fn().mockResolvedValue({ data: { id: "orphan" } }),
    });
    const link = await createRemoteTaskForAgent({ prompt: "x", parentRemoteTaskId: PARENT, client });
    expect(client.createSessionPlaceholder).toHaveBeenCalledTimes(1);
    expect(link.taskId).toBe("new-task");
  });

  it("an explicit sessionId wins over the parent", async () => {
    const client = mockClient();
    const link = await createRemoteTaskForAgent({
      prompt: "x",
      sessionId: "given-session",
      parentRemoteTaskId: PARENT,
      client,
    });
    expect(client.createChatTask).not.toHaveBeenCalled();
    expect(client.createSessionPlaceholder).not.toHaveBeenCalled();
    expect(link.sessionId).toBe("given-session");
  });
});
