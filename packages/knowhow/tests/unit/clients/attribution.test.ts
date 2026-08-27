const post = jest.fn();

jest.mock("../../../src/utils/http", () => ({
  __esModule: true,
  default: { post },
  HTTP_UNAUTHORIZED_HANDLER: Symbol("refresh"),
  HttpError: class HttpError extends Error {
    constructor(
      public status: number,
      public response: Response,
      message: string
    ) {
      super(message);
    }
  },
}));

import packageJson from "../../../package.json";
import { HttpClient } from "../../../src/clients/http";
import { GenericOpenRouterClient } from "../../../src/clients/openrouter";
import {
  KNOWHOW_ATTRIBUTION_HEADERS,
  withKnowhowAttribution,
} from "../../../src/clients/attribution";

describe("OpenRouter attribution", () => {
  beforeEach(() => post.mockReset());
  afterEach(() => jest.restoreAllMocks());

  it("uses the Knowhow application identity and current package version", () => {
    expect(KNOWHOW_ATTRIBUTION_HEADERS).toEqual({
      "HTTP-Referer": "https://knowhow.tyvm.ai",
      "X-Title": "Knowhow",
      "X-OpenRouter-Title": "Knowhow",
      "User-Agent": `knowhow/${packageJson.version}`,
    });
  });

  it("applies caller overrides case-insensitively without duplicates", () => {
    const headers = withKnowhowAttribution({
      "user-agent": "custom-agent",
      "HTTP-referer": "https://caller.example",
      "x-title": "Caller",
      "x-openrouter-title": "Caller",
      "X-Custom": "preserved",
    });

    expect(headers).toEqual({
      "User-Agent": "custom-agent",
      "HTTP-Referer": "https://caller.example",
      "X-Title": "Caller",
      "X-OpenRouter-Title": "Caller",
      "X-Custom": "preserved",
    });
    for (const name of ["user-agent", "http-referer", "x-title", "x-openrouter-title"]) {
      expect(
        Object.keys(headers).filter((key) => key.toLowerCase() === name)
      ).toHaveLength(1);
    }
  });

  it("sends attribution only as OpenRouter request headers", async () => {
    post.mockResolvedValueOnce({
      status: 200,
      headers: new Headers(),
      data: {
        choices: [{ message: { role: "assistant", content: "ok" } }],
        model: "test",
      },
    });
    const client = new GenericOpenRouterClient("test-key");
    client.setOptions({
      headers: {
        "user-agent": "caller-agent",
        "http-referer": "https://caller.example",
      },
    });

    await client.createChatCompletion({
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    });

    const body = post.mock.calls[0][1];
    const headers = post.mock.calls[0][2].headers;
    expect(headers).toMatchObject({
      "HTTP-Referer": "https://caller.example",
      "X-Title": "Knowhow",
      "X-OpenRouter-Title": "Knowhow",
      "User-Agent": "caller-agent",
      Authorization: "Bearer test-key",
    });
    expect(
      Object.keys(headers).filter(
        (name) => name.toLowerCase() === "http-referer"
      )
    ).toHaveLength(1);
    expect(
      Object.keys(headers).filter((name) => name.toLowerCase() === "x-title")
    ).toHaveLength(1);
    const serializedBody = JSON.stringify(body);
    expect(serializedBody).not.toContain("HTTP-Referer");
    expect(serializedBody).not.toContain("X-OpenRouter-Title");
    expect(serializedBody).not.toContain("caller-agent");
  });

  it("does not add OpenRouter attribution to generic provider traffic", async () => {
    post.mockResolvedValueOnce({
      status: 200,
      headers: new Headers(),
      data: {
        choices: [{ message: { role: "assistant", content: "ok" } }],
        model: "test",
      },
    });
    const client = new HttpClient("https://provider.example");

    await client.createChatCompletion({
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(post.mock.calls[0][2].headers).toEqual({});
  });

  it("sends attribution on OpenRouter embedding requests", async () => {
    post.mockResolvedValueOnce({
      status: 200,
      headers: new Headers(),
      data: { data: [{ embedding: [1] }], usage: {} },
    });
    const client = new GenericOpenRouterClient("initial-key", {
      headers: { "x-openrouter-title": "Embedding caller" },
    });
    client.setKey("replacement-key");

    await client.createEmbedding({ model: "embedding-test", input: "hello" });

    expect(post.mock.calls[0][2].headers).toMatchObject({
      "HTTP-Referer": "https://knowhow.tyvm.ai",
      "X-OpenRouter-Title": "Embedding caller",
      // X-Title was not overridden, so it keeps the default "Knowhow"
      "X-Title": "Knowhow",
      "User-Agent": `knowhow/${packageJson.version}`,
      Authorization: "Bearer replacement-key",
    });
  });

  it("sends attribution on OpenRouter streaming requests", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
          "data: [DONE]\n\n",
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }
      )
    );
    const client = new GenericOpenRouterClient("test-key", {
      headers: { "HTTP-referer": "https://stream.example" },
    });

    const chunks = [];
    for await (const chunk of client.createChatCompletionStream({
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    })) {
      chunks.push(chunk);
    }

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;
    expect(headers).toMatchObject({
      "HTTP-Referer": "https://stream.example",
      "X-OpenRouter-Title": "Knowhow",
      "X-Title": "Knowhow",
      "User-Agent": `knowhow/${packageJson.version}`,
      Authorization: "Bearer test-key",
    });
    expect(chunks.length).toBeGreaterThan(0);
  });
});
