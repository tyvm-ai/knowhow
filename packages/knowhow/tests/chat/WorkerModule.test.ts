const mockStart = jest.fn();
const mockResolve = jest.fn();
jest.mock("../../src/services/RemoteWorkers", () => ({
  startRemoteAgentTask: (...a: any[]) => mockStart(...a),
  resolveWorker: (...a: any[]) => mockResolve(...a),
  waitForRemoteTaskRunning: jest.fn().mockResolvedValue(true),
  listRemoteWorkers: jest.fn().mockResolvedValue([]),
  formatWorkerTable: jest.fn().mockReturnValue(""),
}));
jest.mock("../../src/config", () => ({
  getConfig: jest.fn().mockResolvedValue({ chat: { defaultAgent: "Patcher" } }),
}));

import { WorkerModule, workerPromptPrefix } from "../../src/chat/modules/WorkerModule";

const TASK1 = "11111111-1111-4111-8111-111111111111";
const TASK2 = "22222222-2222-4222-8222-222222222222";

function setup() {
  const context: any = { chatHistory: [], agentMode: true, currentAgent: "Developer" };
  const chatService: any = {
    getContext: () => context,
    registerCommand: jest.fn(),
    processInput: jest.fn().mockResolvedValue(true),
  };
  const mod = new WorkerModule();
  (mod as any).chatService = chatService;
  return { mod, context, chatService };
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockResolve.mockResolvedValue({ id: "wid-1234567", name: "WIN", os: "windows", fsRoot: "C:\\x" });
});

describe("WorkerModule", () => {
  it("registers /worker", () => {
    expect(setup().mod.getCommands().map((c) => c.name)).toEqual(["worker"]);
  });

  it("handleInput returns false without an active worker", async () => {
    const { mod, context } = setup();
    expect(await mod.handleInput("hello", context)).toBe(false);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("/worker <ref> selects a worker and sets the prompt prefix; off clears", async () => {
    const { mod, context } = setup();
    await mod.handleWorkerCommand(["WIN"]);
    expect(context.activeWorker).toMatchObject({ id: "wid-1234567", name: "WIN" });
    expect(workerPromptPrefix(context)).toBe("[worker: WIN] ");
    await mod.handleWorkerCommand(["off"]);
    expect(context.activeWorker).toBeUndefined();
    expect(workerPromptPrefix(context)).toBe("");
  });

  it("failed resolution leaves the context untouched", async () => {
    const { mod, context } = setup();
    mockResolve.mockRejectedValue(new Error("No worker matches 'zzz'"));
    await mod.handleWorkerCommand(["zzz"]);
    expect(context.activeWorker).toBeUndefined();
  });

  it("delegates a turn: starts a remote task then /attach, and resumes on the next turn", async () => {
    const { mod, context, chatService } = setup();
    await mod.handleWorkerCommand(["WIN"]);
    mockStart.mockResolvedValueOnce({ taskId: TASK1 });
    expect(await mod.handleInput("first", context)).toBe(true);
    expect(mockStart).toHaveBeenLastCalledWith({
      worker: "wid-1234567",
      prompt: "first",
      agentName: "Developer",
    });
    expect(chatService.processInput).toHaveBeenLastCalledWith(`/attach ${TASK1}`);
    expect(context.activeWorker.taskId).toBe(TASK1);
    expect(context.chatHistory[0]).toMatchObject({ input: "first", taskId: TASK1 });

    mockStart.mockResolvedValueOnce({ taskId: TASK1, resumed: true });
    await mod.handleInput("second", context);
    expect(mockStart).toHaveBeenLastCalledWith({
      worker: "wid-1234567",
      prompt: "second",
      agentName: "Developer",
      resumeTaskId: TASK1,
    });
  });

  it("falls back to a new task when resume fails", async () => {
    const { mod, context, chatService } = setup();
    await mod.handleWorkerCommand(["WIN"]);
    context.activeWorker.taskId = TASK1;
    mockStart.mockRejectedValueOnce(new Error("cannot resume")).mockResolvedValueOnce({ taskId: TASK2 });
    await mod.handleInput("again", context);
    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(mockStart.mock.calls[1][0]).not.toHaveProperty("resumeTaskId");
    expect(context.activeWorker.taskId).toBe(TASK2);
    expect(chatService.processInput).toHaveBeenLastCalledWith(`/attach ${TASK2}`);
  });

  it("/worker new clears the task id; errors don't forward to the local agent", async () => {
    const { mod, context, chatService } = setup();
    await mod.handleWorkerCommand(["WIN"]);
    context.activeWorker.taskId = TASK1;
    await mod.handleWorkerCommand(["new"]);
    expect(context.activeWorker.taskId).toBeUndefined();

    mockStart.mockRejectedValue(new Error("worker offline"));
    expect(await mod.handleInput("x", context)).toBe(true);
    expect(chatService.processInput).not.toHaveBeenCalled();
  });

  it("does not intercept slash commands", async () => {
    const { mod, context } = setup();
    await mod.handleWorkerCommand(["WIN"]);
    expect(await mod.handleInput("/help", context)).toBe(false);
  });
});
