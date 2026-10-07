/**
 * Tests for the voice hub endpoints on the eye-tracking server (Contract 2).
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startEyeTrackingServer, GazeSample } from "../src/eyeTracking";

let server: Awaited<ReturnType<typeof startEyeTrackingServer>>;
let baseUrl: string;

beforeAll(async () => {
  server = await startEyeTrackingServer({
    port: 0, // random port
    host: "127.0.0.1",
    open: false,
    worker: false,
    cacheDir: mkdtempSync(join(tmpdir(), "voice-hub-test-")),
  });
  baseUrl = server.url.replace(/\/$/, "");
}, 15_000);

afterAll(async () => {
  await server.close();
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function postGaze(sample: GazeSample): Promise<void> {
  const res = await fetch(`${baseUrl}/api/gaze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sample),
  });
  expect(res.ok).toBe(true);
}

function makeGaze(x: number, y: number, ts: number): GazeSample {
  return {
    x, y,
    normalized: { x: x / 2560, y: y / 1440 },
    confidence: 0.9,
    phase: "live",
    monitor: { x: 0, y: 0, width: 2560, height: 1440 },
    timestamp: ts,
  };
}

// ─── Gaze history ring buffer ─────────────────────────────────────────────────

describe("GET /api/gaze/history", () => {
  it("returns empty array when no samples", async () => {
    const res = await fetch(`${baseUrl}/api/gaze/history?sinceMs=0`);
    expect(res.ok).toBe(true);
    const data = await res.json() as { samples: GazeSample[] };
    expect(Array.isArray(data.samples)).toBe(true);
  });

  it("accumulates live gaze samples (non-page)", async () => {
    const now = Date.now();
    await postGaze(makeGaze(100, 200, now - 1000));
    await postGaze(makeGaze(150, 250, now - 500));
    await postGaze(makeGaze(200, 300, now));

    const res = await fetch(`${baseUrl}/api/gaze/history?sinceMs=0`);
    const data = await res.json() as { samples: GazeSample[] };
    expect(data.samples.length).toBeGreaterThanOrEqual(3);
  });

  it("filters by sinceMs", async () => {
    const now = Date.now();
    await postGaze(makeGaze(50, 60, now - 4000));
    await postGaze(makeGaze(70, 80, now - 1000));

    const res = await fetch(`${baseUrl}/api/gaze/history?sinceMs=${now - 2000}`);
    const data = await res.json() as { samples: GazeSample[] };
    // Should only include the sample at now-1000
    const old = data.samples.find((s) => s.x === 50 && s.y === 60);
    expect(old).toBeUndefined();
    const recent = data.samples.find((s) => s.x === 70 && s.y === 80);
    expect(recent).toBeDefined();
  });

  it("does NOT buffer page-originated samples", async () => {
    const beforeCount = await fetch(`${baseUrl}/api/gaze/history?sinceMs=0`)
      .then((r) => r.json() as Promise<{ samples: GazeSample[] }>)
      .then((d) => d.samples.length);

    const pageSample: GazeSample = {
      ...makeGaze(999, 999, Date.now()),
      source: "page",
    };
    await postGaze(pageSample);

    const afterCount = await fetch(`${baseUrl}/api/gaze/history?sinceMs=0`)
      .then((r) => r.json() as Promise<{ samples: GazeSample[] }>)
      .then((d) => d.samples.length);

    expect(afterCount).toBe(beforeCount); // page samples not stored in history
  });
});

// ─── Voice command registration ───────────────────────────────────────────────

describe("POST /api/voice/register", () => {
  it("registers phrases", async () => {
    const res = await fetch(`${baseUrl}/api/voice/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phrases: [{ phrase: "slice" }], owner: "test-owner-1", ttlMs: 60_000 }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as { ok: boolean; owner: string };
    expect(data.ok).toBe(true);
    expect(data.owner).toBe("test-owner-1");
  });

  it("returns 400 for invalid body", async () => {
    const res = await fetch(`${baseUrl}/api/voice/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: "x" }), // missing phrases
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/voice/commands", () => {
  it("returns registered specs", async () => {
    await fetch(`${baseUrl}/api/voice/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phrases: [{ phrase: "test-cmd-123", aliases: ["tc"] }], owner: "test-owner-2", ttlMs: 60_000 }),
    });

    const res = await fetch(`${baseUrl}/api/voice/commands`);
    expect(res.ok).toBe(true);
    const data = await res.json() as { specs: Array<{ phrase: string }> };
    expect(data.specs.some((s) => s.phrase === "test-cmd-123")).toBe(true);
  });
});

describe("POST /api/voice/unregister", () => {
  it("removes a registration", async () => {
    await fetch(`${baseUrl}/api/voice/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phrases: [{ phrase: "temp-phrase" }], owner: "temp-owner", ttlMs: 60_000 }),
    });

    // Verify it's there.
    let data = await fetch(`${baseUrl}/api/voice/commands`).then((r) => r.json()) as { specs: Array<{ phrase: string }> };
    expect(data.specs.some((s) => s.phrase === "temp-phrase")).toBe(true);

    // Unregister.
    const unres = await fetch(`${baseUrl}/api/voice/unregister`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner: "temp-owner" }),
    });
    expect(unres.ok).toBe(true);

    // Verify it's gone.
    data = await fetch(`${baseUrl}/api/voice/commands`).then((r) => r.json()) as { specs: Array<{ phrase: string }> };
    expect(data.specs.some((s) => s.phrase === "temp-phrase")).toBe(false);
  });

  it("returns 400 for missing owner", async () => {
    const res = await fetch(`${baseUrl}/api/voice/unregister`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ─── Voice command broadcast ──────────────────────────────────────────────────

describe("POST /api/voice/command", () => {
  it("accepts a valid VoiceCommandEvent", async () => {
    const event = {
      type: "voice.command",
      id: "test-id-001",
      phrase: "slice",
      text: "slice",
      spokenAt: Date.now() - 200,
      recognizedAt: Date.now(),
    };
    const res = await fetch(`${baseUrl}/api/voice/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  it("returns 400 for missing id", async () => {
    const res = await fetch(`${baseUrl}/api/voice/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "voice.command", phrase: "x", text: "x", spokenAt: 0, recognizedAt: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for wrong type", async () => {
    const res = await fetch(`${baseUrl}/api/voice/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "other", id: "x" }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── SSE event stream ─────────────────────────────────────────────────────────

describe("GET /api/voice/events SSE", () => {
  it("receives a broadcast VoiceCommandEvent over SSE", async () => {
    const controller = new AbortController();
    const received: any[] = [];

    const ssePromise = (async () => {
      const res = await fetch(`${baseUrl}/api/voice/events`, {
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined as any }));
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (line) {
            try { received.push(JSON.parse(line.slice(5).trim())); } catch {}
          }
        }
        if (received.length >= 1) break;
      }
    })();

    // Wait a tick for SSE connection to establish.
    await new Promise((r) => setTimeout(r, 100));

    await fetch(`${baseUrl}/api/voice/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "voice.command", id: "sse-test", phrase: "slice", text: "slice", spokenAt: Date.now(), recognizedAt: Date.now() }),
    });

    // Wait for SSE to receive or timeout.
    await Promise.race([ssePromise, new Promise((r) => setTimeout(r, 2000))]);
    controller.abort();

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].phrase).toBe("slice");
  });
});

// ─── Health check still fast ─────────────────────────────────────────────────

describe("GET /api/health", () => {
  it("responds quickly and correctly", async () => {
    const start = Date.now();
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.ok).toBe(true);
    expect(Date.now() - start).toBeLessThan(200);
    const data = await res.json() as { ok: boolean };
    expect(data.ok).toBe(true);
  });
});
