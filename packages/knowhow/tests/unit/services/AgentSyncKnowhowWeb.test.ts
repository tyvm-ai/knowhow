import { AgentSyncKnowhowWeb } from "../../../src/services/AgentSyncKnowhowWeb";

describe("AgentSyncKnowhowWeb sync error reporting", () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("reports only the first remote failure for a task", async () => {
    const sync = new AgentSyncKnowhowWeb();
    (sync as any).client = {
      createChatTask: jest.fn().mockRejectedValue(new Error("offline")),
    };

    await sync.createChatTask({ messageId: "message-1", prompt: "test" });
    await sync.createChatTask({ messageId: "message-1", prompt: "test" });

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("allows the next task to report its first failure after reset", async () => {
    const sync = new AgentSyncKnowhowWeb();
    (sync as any).client = {
      createChatTask: jest.fn().mockRejectedValue(new Error("offline")),
    };

    await sync.createChatTask({ messageId: "message-1", prompt: "test" });
    sync.reset();
    await sync.createChatTask({ messageId: "message-2", prompt: "test" });

    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});
