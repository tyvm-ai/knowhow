import { ToolCommandModule } from "../../../src/chat/modules/ToolCommandModule";
import { LazyToolsService } from "../../../src/services/LazyToolsService";
import { ChatService } from "../../../src/chat/types";

function makeHarness() {
  const tools = new LazyToolsService();
  tools.addTools([{
    type: "function",
    function: {
      name: "hiddenEcho",
      description: "echo",
      parameters: { type: "object", properties: { value: { type: "string" } } },
    },
  }]);
  tools.setFunction("hiddenEcho", ({ value }: { value: string }) => ({ value }));

  const context: any = { plugins: [], chatHistory: [], activeAgentTaskId: "task-1" };
  const service = {
    getTools: () => tools,
    getContext: () => context,
    registerCommand: jest.fn(),
    registerMode: jest.fn(),
  } as unknown as ChatService;
  const module = new ToolCommandModule();
  return module.initialize(service).then(() => ({
    command: module.getCommands()[0],
    tools,
  }));
}

describe("ToolCommandModule", () => {
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(console, "log").mockImplementation();
    error = jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  test("executes compact JSON against a hidden lazy tool", async () => {
    const { command, tools } = await makeHarness();
    expect(tools.getToolNames()).not.toContain("hiddenEcho");

    await command.handler(['{"name":"hiddenEcho","arguments":{"value":"hello world"}}']);

    expect(log).toHaveBeenCalledWith('{\n  "value": "hello world"\n}');
    expect(error).not.toHaveBeenCalled();
  });

  test("accepts an OpenAI-style tool call", async () => {
    const { command } = await makeHarness();
    await command.handler([
      '{"id":"call-1","function":{"name":"hiddenEcho","arguments":{"value":"ok"}}}',
    ]);
    expect(log).toHaveBeenCalledWith('{\n  "value": "ok"\n}');
  });

  test("prints usage and actionable errors", async () => {
    const { command } = await makeHarness();
    await command.handler([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Usage: /tool"));

    await command.handler(["not-json"]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Invalid tool call JSON"));

    await command.handler(['{"name":"missing","arguments":{}}']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Tool execution failed"));
  });
});
