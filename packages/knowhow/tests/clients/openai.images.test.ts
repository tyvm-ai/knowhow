import { GenericOpenAiClient } from "../../src/clients/openai";
import { Message } from "../../src/clients/types";

describe("GenericOpenAiClient image message conversion", () => {
  const imageUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
  let client: GenericOpenAiClient;

  beforeEach(() => {
    client = new GenericOpenAiClient("test-key");
  });

  it("moves tool image output to a user message for Chat Completions", () => {
    const messages: Message[] = [{
      role: "tool",
      tool_call_id: "call_1",
      name: "loadImageAsBase64",
      content: [{
        type: "image_url",
        image_url: { url: imageUrl, detail: "high" },
      }],
    }];

    const converted = client.toChatCompletionMessages(messages);

    expect(converted).toEqual([
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [{
          type: "text",
          text: "Image output attached in the following user message.",
        }],
      },
      {
        role: "user",
        content: [{
          type: "image_url",
          image_url: { url: imageUrl, detail: "high" },
        }],
      },
    ]);
  });

  it("uses input_image parts for the Responses API", () => {
    const converted = client.toResponseContent([
      { type: "text", text: "Screenshot" },
      { type: "image_url", image_url: { url: imageUrl, detail: "low" } },
    ]);

    expect(converted).toEqual([
      { type: "input_text", text: "Screenshot" },
      { type: "input_image", image_url: imageUrl, detail: "low" },
    ]);
  });

  it.each([
    { type: "audio_url", audio_url: { url: "data:audio/wav;base64,UklGRg==" } },
    { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAAIGZ0eXA=" } },
  ] as const)("rejects unsupported $type Responses API content instead of dropping it", (part) => {
    expect(() => client.toResponseContent([
      { type: "text", text: "Media" },
      part,
    ])).toThrow(
      `OpenAI Responses API conversion does not support ${part.type} content.`
    );
  });

  it("attaches a tool image as input_image in a Responses API request", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "resp_1",
      output: [],
      usage: undefined,
    });
    (client as any).client = { responses: { create } };

    await client.createChatResponse({
      model: "gpt-5.4",
      reasoning_effort: "none",
      messages: [{
        role: "tool",
        tool_call_id: "call_1",
        content: [{
          type: "image_url",
          image_url: { url: imageUrl, detail: "auto" },
        }],
      }],
    });

    expect(create.mock.calls[0][0].input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "Image output attached in the following user message.",
      },
      {
        role: "user",
        content: [{
          type: "input_image",
          image_url: imageUrl,
          detail: "auto",
        }],
      },
    ]);
  });
});
