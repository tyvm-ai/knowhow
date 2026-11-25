import http from "http";
import { AddressInfo } from "net";

/**
 * Tiny fake OpenAI-compatible media server (no deps) used by the HttpMediaClient tests.
 * Mirrors the shapes in .knowhow/tasks/2026-11-13-voices-machines/round3/worker-provider-contract.md.
 */
export interface FakeMediaServer {
  url: string;
  requests: {
    method: string;
    path: string;
    body?: any;
    /** Set for multipart/form-data requests (e.g. /v1/images/edits). */
    multipart?: {
      contentType: string;
      /** Every part name in order, repeats included (e.g. ["model","prompt","image","image"]). */
      fieldNames: string[];
      /** String fields by name (last value wins). */
      fields: Record<string, string>;
      /** File parts: field name, file name, mime type, byte length. */
      files: { field: string; fileName: string; type: string; size: number }[];
    };
  }[];
  close(): Promise<void>;
}

// 1x1 transparent PNG
export const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A tiny valid-looking WAV: 44-byte header + `samples` zero samples (16-bit mono 24 kHz). */
export function makeWav(samples = 2400) {
  const data = Buffer.alloc(samples * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24);
  h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export async function startFakeMediaServer(
  opts: { videoPolls?: number; videoBytes?: number; voices?: boolean } = {}
): Promise<FakeMediaServer> {
  const requests: FakeMediaServer["requests"] = [];
  const jobs = new Map<string, { polls: number }>();
  const videoPolls = opts.videoPolls ?? 2;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const contentType = String(req.headers["content-type"] || "");
      const isMultipart = contentType.startsWith("multipart/form-data");
      const raw = isMultipart ? "" : Buffer.concat(chunks).toString("utf8");
      let body: any;
      let multipart: FakeMediaServer["requests"][number]["multipart"];
      if (isMultipart) {
        const form = await new Response(Buffer.concat(chunks), {
          headers: { "content-type": contentType },
        }).formData();
        multipart = { contentType, fieldNames: [], fields: {}, files: [] };
        for (const [name, value] of (form as any).entries() as Iterable<[string, any]>) {
          multipart.fieldNames.push(name);
          if (typeof value === "string") multipart.fields[name] = value;
          else
            multipart.files.push({
              field: name,
              fileName: value.name,
              type: value.type,
              size: value.size,
            });
        }
        body = multipart.fields;
      } else {
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = raw;
        }
      }
      const path = (req.url || "").split("?")[0];
      requests.push({ method: req.method || "", path, body, multipart });
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      if (req.method === "POST" && path === "/v1/audio/speech") {
        if (body?.voice === "boom") return json(400, { error: "unknown voice" });
        res.writeHead(200, { "content-type": "audio/wav" });
        return res.end(makeWav());
      }
      if (req.method === "POST" && path === "/v1/images/generations") {
        const n = body?.n ?? 1;
        return json(200, {
          created: 1,
          data: Array.from({ length: n }, () => ({ b64_json: PNG_B64 })),
        });
      }
      if (req.method === "POST" && path === "/v1/images/edits") {
        if (!multipart) return json(415, { error: "multipart/form-data required" });
        if (!multipart.files.some((f) => f.field === "image"))
          return json(422, { error: "image is required" });
        if (multipart.fields.prompt === "boom") return json(400, { error: "bad prompt" });
        const n = Number(multipart.fields.n ?? 1);
        return json(200, {
          created: 1,
          data: Array.from({ length: n }, () => ({ b64_json: PNG_B64 })),
        });
      }
      if (req.method === "POST" && path === "/v1/videos") {
        const id = `vid_${jobs.size + 1}`;
        jobs.set(id, { polls: 0 });
        return json(200, { id, status: "queued", model: body?.model });
      }
      const m = path.match(/^\/v1\/videos\/([^/]+)(\/content)?$/);
      if (m && req.method === "GET") {
        const job = jobs.get(m[1]);
        if (!job) return json(404, { error: "no such job" });
        if (m[2]) {
          res.writeHead(200, { "content-type": "video/mp4" });
          return res.end(Buffer.alloc(opts.videoBytes ?? 1024, 7));
        }
        job.polls++;
        return json(200, {
          id: m[1],
          status: job.polls > videoPolls ? "completed" : "in_progress",
          progress: Math.min(100, job.polls * 40),
        });
      }
      if (req.method === "GET" && path === "/v1/audio/voices" && opts.voices) {
        return json(200, { voices: ["Vivian", { id: "Ryan", gender: "male" }] });
      }
      if (req.method === "GET" && path === "/v1/models") {
        return json(200, { data: [{ id: "everything", object: "model" }] });
      }
      json(404, { error: `not found ${req.method} ${path}` });
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
