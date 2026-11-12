import http from "http";
import { AddressInfo } from "net";
import { AIClient } from "../../src/clients";
import { ToolsService } from "../../src/services/Tools";
import {
  createAudioGeneration,
  createImageGeneration,
  createVideoGeneration,
  getVideoStatus,
  downloadVideo,
  listVoicesForProvider,
} from "../../src/agents/tools/aiClient";
import {
  packArtifact,
  unpackArtifact,
  setArtifactUploader,
  ArtifactUploader,
} from "../../src/agents/tools/mediaArtifacts";
import { KnowhowMcpClient } from "../../src/clients/knowhowMcp";
import { withMediaTools, WORKER_MEDIA_TOOLS } from "../../src/worker";
import { startFakeMediaServer, FakeMediaServer, PNG_B64 } from "../helpers/fakeMediaServer";

jest.spyOn(AIClient.prototype as any, "_initDefaultProviders").mockResolvedValue(undefined);

/** A fake "org files": the uploader stores bytes, a local http server serves them like a presigned URL. */
async function startFakeFiles() {
  const files = new Map<string, Buffer>();
  const removed: string[] = [];
  const server = http.createServer((req, res) => {
    const id = (req.url || "").slice(1);
    const buf = files.get(id);
    if (!buf) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(buf);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const uploader: ArtifactUploader = {
    async upload(data, meta) {
      const fileId = `f${files.size + 1}`;
      files.set(fileId, data);
      expect(meta.folderPath).toBe("/ai-generated/worker-tmp/");
      return { fileId, downloadUrl: `${base}/${fileId}` };
    },
    async remove(id) {
      removed.push(id);
    },
  };
  return {
    files,
    removed,
    uploader,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("packArtifact / unpackArtifact", () => {
  let fake: Awaited<ReturnType<typeof startFakeFiles>>;
  beforeEach(async () => {
    fake = await startFakeFiles();
    setArtifactUploader(fake.uploader);
  });
  afterEach(async () => {
    setArtifactUploader(undefined);
    await fake.close();
  });

  test("small results stay inline as base64", async () => {
    const packed = await packArtifact(Buffer.from("hello"), { fileName: "a.wav", maxInlineBytes: 100 });
    expect(packed).toEqual({ base64: Buffer.from("hello").toString("base64"), sizeBytes: 5 });
    expect(fake.files.size).toBe(0);
    expect((await unpackArtifact(packed)).toString()).toBe("hello");
  });

  test("results over the limit are uploaded and only a presigned ref goes over the socket", async () => {
    const big = Buffer.alloc(5000, 3);
    const packed = await packArtifact(big, { fileName: "v.mp4", mimeType: "video/mp4", maxInlineBytes: 1000 });
    expect("ref" in packed).toBe(true);
    expect(JSON.stringify(packed).length).toBeLessThan(400); // no payload bytes in the message
    expect(fake.files.size).toBe(1);
    const back = await unpackArtifact(packed);
    expect(back.equals(big)).toBe(true);
  });

  test("malformed artifacts are rejected", async () => {
    await expect(unpackArtifact({} as any)).rejects.toThrow(/Malformed/);
  });
});

describe("worker media MCP tools (against a fake media server)", () => {
  let server: FakeMediaServer;
  let fake: Awaited<ReturnType<typeof startFakeFiles>>;
  let ctx: ToolsService;

  beforeAll(async () => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    server = await startFakeMediaServer({ videoPolls: 0, videoBytes: 4096, voices: false });
    const ai = new AIClient();
    await ai.registerModelProviders([
      {
        provider: "tpl-media",
        url: server.url,
        modelsByModality: { audio: ["qwen3-tts"], image: ["flux"], video: ["wan"] },
        voices: ["Vivian", "Ryan"],
      },
    ]);
    ctx = new ToolsService({ Clients: ai } as any);
  });
  beforeEach(async () => {
    fake = await startFakeFiles();
    setArtifactUploader(fake.uploader);
  });
  afterEach(async () => {
    setArtifactUploader(undefined);
    await fake.close();
  });
  afterAll(async () => {
    await server.close();
  });

  test("createAudioGeneration returns inline base64 for a small clip", async () => {
    const res = await createAudioGeneration.call(ctx, "tpl-media", {
      model: "qwen3-tts",
      input: "hi",
      voice: "Vivian",
    });
    expect(res.format).toBe("wav");
    expect("base64" in res.audio).toBe(true);
    const bytes = await unpackArtifact(res.audio);
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(res.usd_cost).toBeUndefined();
  });

  test("createImageGeneration keeps b64 inline", async () => {
    const res = await createImageGeneration.call(ctx, "tpl-media", { model: "flux", prompt: "cat" });
    expect(res.data[0]).toEqual({ b64_json: PNG_B64 });
  });

  test("video job: create -> status -> download (4 KB under the inline limit by default)", async () => {
    const created = await createVideoGeneration.call(ctx, "tpl-media", { model: "wan", prompt: "waves" });
    const status = await getVideoStatus.call(ctx, "tpl-media", { jobId: created.jobId! });
    expect(status.status).toBe("completed");
    const dl = await downloadVideo.call(ctx, "tpl-media", { fileId: created.jobId! });
    expect(dl.mimeType).toBe("video/mp4");
    expect((await unpackArtifact(dl.data)).length).toBe(4096);
  });

  test("listVoicesForProvider returns the configured voices", async () => {
    const voices = await listVoicesForProvider.call(ctx, "tpl-media", "qwen3-tts");
    expect(voices.map((v) => v.id)).toEqual(["Vivian", "Ryan"]);
  });
});

describe("KnowhowMcpClient media decoding (backend side of the MCP channel)", () => {
  function clientWith(responses: Record<string, unknown>) {
    const calls: { tool: string; args: any }[] = [];
    const mcp: any = {
      callFunction: async (tool: string, args: any) => {
        calls.push({ tool, args });
        if (responses[tool] instanceof Error) throw responses[tool];
        return responses[tool];
      },
    };
    return { client: new KnowhowMcpClient(mcp), calls };
  }

  test("audio: decodes inline base64, forwards provider, strips signal", async () => {
    const { client, calls } = clientWith({
      createAudioGeneration: {
        format: "wav",
        usd_cost: undefined,
        audio: { base64: Buffer.from("RIFFxxxx").toString("base64"), sizeBytes: 8 },
      },
    });
    const res = await client.createAudioGeneration({
      model: "m",
      input: "x",
      voice: "v",
      provider: "tpl-media",
      signal: new AbortController().signal,
    } as any);
    expect(res.audio.toString()).toBe("RIFFxxxx");
    expect(res.format).toBe("wav");
    expect(calls[0].tool).toBe("createAudioGeneration");
    expect(calls[0].args.provider).toBe("tpl-media");
    expect(calls[0].args.options.signal).toBeUndefined();
    expect(calls[0].args.options.model).toBe("m");
  });

  test("image: refs are fetched and become b64_json", async () => {
    const fake = await startFakeFiles();
    try {
      const { client } = clientWith({});
      // a real ref through the uploader (presigned-URL stand-in served by the fake files server)
      const up = await fake.uploader.upload(Buffer.from("PNGDATA"), {
        fileName: "i.png",
        folderPath: "/ai-generated/worker-tmp/",
      });
      (client as any).mcpService.callFunction = async () => ({
        created: 1,
        data: [{ ref: { url: up.downloadUrl }, revised_prompt: "p" }, { b64_json: "AAAA" }],
      });
      const res = await client.createImageGeneration({ model: "m", prompt: "x" });
      expect(Buffer.from(res.data[0].b64_json!, "base64").toString()).toBe("PNGDATA");
      expect(res.data[0].revised_prompt).toBe("p");
      expect(res.data[1].b64_json).toBe("AAAA");
    } finally {
      await fake.close();
    }
  });

  test("errors from the worker propagate (callFunction used to swallow them)", async () => {
    const { client } = clientWith({ createAudioGeneration: new Error("boom") });
    await expect(
      client.createAudioGeneration({ model: "m", input: "x", voice: "v" })
    ).rejects.toThrow("boom");
  });
});

describe("AIClient hands `provider` to proxy clients for media calls", () => {
  test("receivesProvider clients get the resolved provider in the options", async () => {
    const ai = new AIClient();
    const seen: any[] = [];
    const proxy: any = {
      receivesProvider: true,
      setKey() {},
      getModels: async () => [],
      createAudioGeneration: async (o: any) => {
        seen.push(o);
        return { audio: Buffer.alloc(1), format: "wav" };
      },
    };
    ai.registerClient("tpl-media", proxy);
    ai.registerAudioModels("tpl-media", ["qwen3-tts"]);
    await ai.createAudioGeneration("tpl-media", { model: "qwen3-tts", input: "x", voice: "v" });
    expect(seen[0].provider).toBe("tpl-media");
    expect(seen[0].model).toBe("qwen3-tts");
  });
});

describe("withMediaTools", () => {
  test("adds the media tools to allow-lists that predate them (only when completions are allowed)", () => {
    const available = ["createAiCompletion", ...WORKER_MEDIA_TOOLS];
    expect(withMediaTools(["createAiCompletion", "readFile"], available)).toEqual([
      "createAiCompletion",
      "readFile",
      ...WORKER_MEDIA_TOOLS,
    ]);
    expect(withMediaTools(["readFile"], available)).toEqual(["readFile"]);
    const already = ["createAiCompletion", ...WORKER_MEDIA_TOOLS];
    expect(withMediaTools(already, available)).toBe(already);
  });
});
