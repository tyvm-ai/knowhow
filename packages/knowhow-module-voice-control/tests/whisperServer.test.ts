import { EventEmitter } from "events";
import { PassThrough } from "stream";
import {
  FallbackRecognizer,
  WhisperServerRecognizer,
  createWhisperRecognizer,
  parseSttBackend,
  siblingWhisperServer,
} from "../src/whisperServer";
import type { UtteranceRecognizer } from "../src/continuous";

function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = jest.fn(() => { child.killed = true; child.exitCode = 0; child.emit("exit", 0); });
  return child;
}

function response(status: number, body: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as any;
}

const wav = Buffer.from("RIFF....WAVE");
const signal = () => new AbortController().signal;

describe("WhisperServerRecognizer", () => {
  test("spawns whisper-server once, waits for readiness, POSTs WAV to /inference, kills on close", async () => {
    const child = fakeChild();
    const spawn = jest.fn(() => child);
    let readyChecks = 0;
    const requests: Array<{ url: string; init?: any }> = [];
    const fetchMock = jest.fn(async (url: string, init?: any) => {
      requests.push({ url, init });
      if (url.endsWith("/")) {
        readyChecks++;
        if (readyChecks < 3) throw new Error("ECONNREFUSED");
        return response(200, "<html>");
      }
      return response(200, " Slice.\n");
    });
    const rec = new WhisperServerRecognizer({
      command: "/opt/homebrew/bin/whisper-server", model: "/m/ggml-small.en.bin", port: 18999,
      prompt: "hey knowhow.", spawn, fetch: fetchMock as any, pollMs: 1,
    });
    await rec.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect((spawn.mock.calls[0] as any)[1]).toEqual(["-m", "/m/ggml-small.en.bin", "--host", "127.0.0.1", "--port", "18999", "-nt"]);
    expect(rec.url).toBe("http://127.0.0.1:18999");

    // F3: Only multi-word phrases (≥2 words) are added to the STT prompt.
    // Single-word phrases like "slice" and "click" are excluded to prevent Whisper hallucination.
    rec.setPromptPhrases(["slice", "click", "eye control mouse", "double click"]);
    expect(await rec.recognize(wav, signal())).toBe("Slice.");
    expect(await rec.recognize(wav, signal())).toBe("Slice.");
    expect(spawn).toHaveBeenCalledTimes(1);

    const post = requests.find((r) => r.url.endsWith("/inference"))!;
    expect(post.init.method).toBe("POST");
    const form = post.init.body as FormData;
    expect(form.get("response_format")).toBe("text");
    // Only multi-word phrases appear in the prompt (F3 filter)
    expect(form.get("prompt")).toBe("hey knowhow. eye control mouse. double click.");
    const file = form.get("file") as Blob;
    expect(file.size).toBe(wav.length);

    await rec.close();
    expect(child.kill).toHaveBeenCalled();
    await expect(rec.recognize(wav, signal())).rejects.toThrow(/not running/);
  });

  test("start fails if the server exits during startup", async () => {
    const child = fakeChild();
    const rec = new WhisperServerRecognizer({
      command: "whisper-server", model: "m", port: 1, spawn: () => child,
      fetch: (async () => { throw new Error("refused"); }) as any, pollMs: 1,
    });
    setTimeout(() => { child.stderr.write("error: failed to load model\n"); child.exitCode = 1; child.emit("exit", 1); }, 5);
    await expect(rec.start()).rejects.toThrow(/exited during startup/);
  });

  test("non-2xx responses throw", async () => {
    const rec = new WhisperServerRecognizer({
      command: "whisper-server", model: "m", port: 2, spawn: () => fakeChild(),
      fetch: (async (url: string) => url.endsWith("/") ? response(200, "") : response(500, "boom")) as any,
    });
    await rec.start();
    await expect(rec.recognize(wav, signal())).rejects.toThrow(/500/);
    await rec.close();
  });
});

describe("FallbackRecognizer", () => {
  test("switches to the fallback after the primary fails", async () => {
    const primary: UtteranceRecognizer = { label: "whisper-server", recognize: jest.fn(async () => { throw new Error("down"); }) };
    const fallback: UtteranceRecognizer = { label: "whisper-cli", recognize: jest.fn(async () => "Slice.") };
    const onFallback = jest.fn();
    const rec = new FallbackRecognizer(primary, fallback, onFallback);
    expect(rec.label).toBe("whisper-server");
    expect(await rec.recognize(wav, signal())).toBe("Slice.");
    expect(await rec.recognize(wav, signal())).toBe("Slice.");
    expect(primary.recognize).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(rec.label).toBe("whisper-cli");
  });
});

describe("createWhisperRecognizer", () => {
  const cli: UtteranceRecognizer = { label: "whisper-cli", recognize: async () => "cli" };
  const base = {
    cliCommand: "/opt/homebrew/bin/whisper-cli",
    model: "/m/ggml-small.en.bin",
    cliArgs: ["-m", "/m", "-f", "{file}"],
    createCli: () => cli,
  };

  test("defaults to the server when whisper-server exists next to whisper-cli", async () => {
    const start = jest.fn(async () => undefined);
    const createServer = jest.fn((opts: any) => ({ label: "whisper-server", url: "http://x", start, close: async () => undefined, recognize: async () => "server" }) as any);
    const rec = await createWhisperRecognizer({ ...base, exists: (p) => p === "/opt/homebrew/bin/whisper-server", createServer });
    expect(createServer).toHaveBeenCalledWith(expect.objectContaining({ command: "/opt/homebrew/bin/whisper-server", model: "/m/ggml-small.en.bin" }));
    expect(start).toHaveBeenCalled();
    expect(rec).toBeInstanceOf(FallbackRecognizer);
    expect(await rec.recognize(wav, signal())).toBe("server");
  });

  test("--stt-backend cli skips the server", async () => {
    const createServer = jest.fn();
    const rec = await createWhisperRecognizer({ ...base, backend: "cli", exists: () => true, createServer });
    expect(rec).toBe(cli);
    expect(createServer).not.toHaveBeenCalled();
  });

  test("falls back to whisper-cli when the server fails to start", async () => {
    const logs: string[] = [];
    const createServer = () => ({ start: async () => { throw new Error("bind failed"); }, close: async () => undefined }) as any;
    const rec = await createWhisperRecognizer({ ...base, exists: () => true, createServer, log: (m) => logs.push(m) });
    expect(rec).toBe(cli);
    expect(logs.join("\n")).toMatch(/failed to start \(bind failed\); falling back/);
  });

  test("falls back to whisper-cli when whisper-server isn't installed", async () => {
    const rec = await createWhisperRecognizer({ ...base, exists: () => false, createServer: jest.fn() });
    expect(rec).toBe(cli);
  });

  test("parseSttBackend / siblingWhisperServer", () => {
    expect(parseSttBackend(undefined, true)).toBe("server");
    expect(parseSttBackend(undefined, false)).toBe("cli");
    expect(parseSttBackend("cli", true)).toBe("cli");
    expect(() => parseSttBackend("gpu", true)).toThrow(/cli.*server/);
    expect(siblingWhisperServer("/usr/local/bin/whisper-cli", () => true)).toBe("/usr/local/bin/whisper-server");
    expect(siblingWhisperServer("/usr/local/bin/other", () => true)).toBeUndefined();
  });
});
