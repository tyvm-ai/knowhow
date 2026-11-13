import { GenericGeminiClient } from "../../src/clients/gemini";

const KEY = "AIzaSyTESTKEY1234567890abcdefghijklmn";
const JOB = "interactions/v1_abc123";

const interaction = (video: Record<string, unknown>[], status = "completed") => ({
  id: "v1_abc123",
  status,
  steps: [{ type: "model_output", content: video.map((v) => ({ type: "video", ...v })) }],
});

const json = (body: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    statusText: status === 404 ? "Not Found" : "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const bytes = (buf: Buffer, status = 200) =>
  ({
    ok: status < 400,
    status,
    statusText: status === 404 ? "Not Found" : "OK",
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  }) as unknown as Response;

describe("GenericGeminiClient Omni (interactions/<id>) downloads", () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let client: GenericGeminiClient;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    client = new GenericGeminiClient(KEY);
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it("returns the inline base64 video of the interaction without touching the Files API", async () => {
    const mp4 = Buffer.from("fake-mp4-bytes");
    fetchMock.mockResolvedValueOnce(
      json(interaction([{ data: mp4.toString("base64"), mime_type: "video/mp4" }]))
    );
    const res = await client.downloadFile({ fileId: JOB });
    expect(res.data.equals(mp4)).toBe(true);
    expect(res.mimeType).toBe("video/mp4");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions/v1_abc123"
    );
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  it("downloadVideo takes the same path and uses the LAST video block", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        interaction([
          { data: Buffer.from("first").toString("base64") },
          { data: Buffer.from("second").toString("base64"), mime_type: "video/webm" },
        ])
      )
    );
    const res = await client.downloadVideo({ fileId: JOB });
    expect(res.data.toString()).toBe("second");
    expect(res.mimeType).toBe("video/webm");
  });

  it("fetches a Google uri with the key appended and following redirects", async () => {
    const uri = "https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media";
    const mp4 = Buffer.from("from-uri");
    fetchMock
      .mockResolvedValueOnce(json(interaction([{ uri }])))
      .mockResolvedValueOnce(bytes(mp4));
    const res = await client.downloadFile({ fileId: JOB });
    expect(res.data.equals(mp4)).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe(`${uri}&key=${KEY}`);
    expect(fetchMock.mock.calls[1][1]).toEqual({ redirect: "follow" });
  });

  it("does not send the API key to non-Google uris", async () => {
    const uri = "https://cdn.example.com/video.mp4?sig=1";
    fetchMock
      .mockResolvedValueOnce(json(interaction([{ uri }])))
      .mockResolvedValueOnce(bytes(Buffer.from("x")));
    await client.downloadFile({ fileId: JOB });
    expect(fetchMock.mock.calls[1][0]).toBe(uri);
  });

  it("throws a clear error when the interaction has no video", async () => {
    fetchMock.mockResolvedValueOnce(json(interaction([])));
    await expect(client.downloadFile({ fileId: JOB })).rejects.toThrow(/completed without a video/);
  });

  it("throws a clear error when the interaction is not completed", async () => {
    fetchMock.mockResolvedValueOnce(json(interaction([], "in_progress")));
    await expect(client.downloadFile({ fileId: JOB })).rejects.toThrow(/not completed/);
  });

  it("never puts the API key in a thrown or logged download error", async () => {
    const uri = "https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media";
    fetchMock
      .mockResolvedValueOnce(json(interaction([{ uri }])))
      .mockResolvedValueOnce(bytes(Buffer.alloc(0), 404));
    const err = await client.downloadFile({ fileId: JOB }).catch((e) => e);
    expect(err.message).toMatch(/HTTP 404 Not Found/);
    expect(err.message).toContain("key=[REDACTED]");
    expect(err.message).not.toContain(KEY);
    const logged = JSON.stringify((console.error as jest.Mock).mock.calls.map((c) => String(c[1]?.message ?? c[1])));
    expect(logged).not.toContain(KEY);
  });

  it("still downloads regular Files API ids and redacts the key on failure", async () => {
    fetchMock.mockResolvedValueOnce(bytes(Buffer.from("file")));
    const ok = await client.downloadFile({ fileId: "files/xyz" });
    expect(ok.data.toString()).toBe("file");
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://generativelanguage.googleapis.com/v1beta/files/xyz:download?alt=media&key=${KEY}`
    );

    fetchMock.mockResolvedValueOnce(bytes(Buffer.alloc(0), 404));
    const err = await client.downloadFile({ fileId: "files/xyz" }).catch((e) => e);
    expect(err.message).not.toContain(KEY);
  });

  it("redactApiKeys strips key= params and raw AIza keys", () => {
    expect(GenericGeminiClient.redactApiKeys("https://x/y?alt=media&key=SECRET&b=1")).toBe(
      "https://x/y?alt=media&key=[REDACTED]&b=1"
    );
    expect(GenericGeminiClient.redactApiKeys(`oops ${KEY} oops`)).toBe("oops [REDACTED] oops");
  });
});
