import http from "../../src/utils/http";
import { GenericFireworksClient } from "../../src/clients/fireworks";
import { FireworksModels } from "../../src/clients/pricing/fireworks";

jest.mock("../../src/utils/http", () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

const post = http.post as jest.MockedFunction<typeof http.post>;

describe("GenericFireworksClient", () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({
      data: {
        choices: [{ message: { role: "assistant", content: "ok" } }],
        model: FireworksModels.DeepseekV4Flash,
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      },
    } as any);
  });

  it("removes non-Fireworks options and tool return metadata", async () => {
    const client = new GenericFireworksClient("test-key");

    await client.createChatCompletion({
      model: FireworksModels.DeepseekV4Flash,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 100,
      reasoning_summary: true,
      long_ttl_cache: true,
      tools: [{
        type: "function",
        function: {
          name: "lookup",
          description: "Look something up",
          parameters: { type: "object", properties: {} },
          returns: { type: "string" },
        } as any,
      }],
    });

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, requestOptions] = post.mock.calls[0];
    expect(url).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
    expect(requestOptions).toMatchObject({
      headers: { Authorization: "Bearer test-key" },
    });
    expect(body).toMatchObject({
      model: FireworksModels.DeepseekV4Flash,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 100,
      tool_choice: "auto",
    });
    const serializedBody = JSON.parse(JSON.stringify(body));
    expect(serializedBody).not.toHaveProperty("reasoning_summary");
    expect(serializedBody).not.toHaveProperty("long_ttl_cache");
    expect(serializedBody.tools[0].function).toEqual({
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: {} },
    });
  });
});
