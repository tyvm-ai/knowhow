/**
 * Tests for the automation-SDK extensions (Contract 3).
 */
import { gazeExtension, voiceExtension, AUTOMATION_SDK_EXTENSION, AutomationExtensionContext } from "../src/extensions";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<AutomationExtensionContext>): AutomationExtensionContext {
  const disposers: Array<() => void | Promise<void>> = [];
  const abort = new AbortController();
  return {
    automationName: "test-automation",
    dryRun: false,
    signal: abort.signal,
    isPaused: () => false,
    log: () => {},
    onDispose: (fn) => { disposers.push(fn); },
    sdk: {},
    _abort: abort,
    _disposers: disposers,
    ...overrides,
  } as any;
}

// ─── Extension metadata ───────────────────────────────────────────────────────

describe("gazeExtension", () => {
  it("has correct type and name", () => {
    expect(gazeExtension.type).toBe(AUTOMATION_SDK_EXTENSION);
    expect(gazeExtension.name).toBe("gaze");
    expect(typeof gazeExtension.description).toBe("string");
    expect(gazeExtension.description.length).toBeGreaterThan(10);
  });

  it("has typings string", () => {
    expect(typeof gazeExtension.typings).toBe("string");
    expect(gazeExtension.typings).toContain("GazeSample");
  });

  it("has index signature compatible with ModuleExtension", () => {
    // ModuleExtension requires [key: string]: unknown — check our extension is compatible
    const ext: Record<string, unknown> = gazeExtension as any;
    expect(typeof ext.type).toBe("string");
    expect(typeof ext.name).toBe("string");
  });
});

describe("voiceExtension", () => {
  it("has correct type and name", () => {
    expect(voiceExtension.type).toBe(AUTOMATION_SDK_EXTENSION);
    expect(voiceExtension.name).toBe("voice");
    expect(typeof voiceExtension.description).toBe("string");
  });

  it("has typings string", () => {
    expect(typeof voiceExtension.typings).toBe("string");
    expect(voiceExtension.typings).toContain("VoiceCommandEvent");
  });
});

// ─── Gaze API creation ────────────────────────────────────────────────────────

describe("gazeExtension.create", () => {
  // Point at a closed port so a live eye-tracking hub on 7465 can't leak in.
  const previousEyeUrl = process.env.KNOWHOW_EYE_URL;
  beforeAll(() => {
    process.env.KNOWHOW_EYE_URL = "http://127.0.0.1:9";
  });
  afterAll(() => {
    if (previousEyeUrl === undefined) delete process.env.KNOWHOW_EYE_URL;
    else process.env.KNOWHOW_EYE_URL = previousEyeUrl;
  });

  it("creates an API with expected methods", () => {
    const ctx = makeCtx();
    const api = gazeExtension.create(ctx) as any;
    expect(typeof api.current).toBe("function");
    expect(typeof api.at).toBe("function");
    expect(typeof api.history).toBe("function");
    expect(typeof api.errorRadius).toBe("function");
    expect(typeof api.correct).toBe("function");
  });

  it("errorRadius returns default values", () => {
    const ctx = makeCtx();
    const api = gazeExtension.create(ctx) as any;
    const r = api.errorRadius();
    expect(r.x).toBe(200);
    expect(r.y).toBe(260);
  });

  it("current returns null when hub is not available", async () => {
    const ctx = makeCtx();
    const api = gazeExtension.create(ctx) as any;
    // Hub not running — should return null gracefully
    const result = await api.current();
    expect(result).toBeNull();
  });

  it("at returns null when hub is not available", async () => {
    const ctx = makeCtx();
    const api = gazeExtension.create(ctx) as any;
    const result = await api.at(Date.now());
    expect(result).toBeNull();
  });

  it("history returns [] when hub is not available", async () => {
    const ctx = makeCtx();
    const api = gazeExtension.create(ctx) as any;
    const result = await api.history(Date.now() - 5000);
    expect(result).toEqual([]);
  });

  it("correct does not throw when hub is not available", async () => {
    const ctx = makeCtx();
    const api = gazeExtension.create(ctx) as any;
    await expect(api.correct({ x: 100, y: 200 })).resolves.toBeUndefined();
  });
});

// ─── Voice API creation ───────────────────────────────────────────────────────

describe("voiceExtension.create", () => {
  it("creates an API with expected methods", () => {
    const ctx = makeCtx();
    const api = voiceExtension.create(ctx) as any;
    expect(typeof api.onCommand).toBe("function");
    expect(typeof api.nextCommand).toBe("function");
  });

  it("onCommand returns a dispose function", () => {
    const ctx = makeCtx();
    const api = voiceExtension.create(ctx) as any;
    const dispose = api.onCommand("slice", () => {});
    expect(typeof dispose).toBe("function");
    // Should not throw when called
    expect(() => dispose()).not.toThrow();
  });

  it("nextCommand resolves null on abort", async () => {
    const abort = new AbortController();
    const ctx = makeCtx({ signal: abort.signal });
    const api = voiceExtension.create(ctx) as any;

    const promise = api.nextCommand("slice", { timeoutMs: 5000 });
    // Abort immediately
    abort.abort();

    const result = await promise;
    expect(result).toBeNull();
  });

  it("nextCommand resolves null after timeout", async () => {
    const ctx = makeCtx();
    const api = voiceExtension.create(ctx) as any;
    const result = await api.nextCommand("never-matched-xyz", { timeoutMs: 50 });
    expect(result).toBeNull();
  });

  it("onDispose cleans up registrations", () => {
    const disposers: Array<() => void | Promise<void>> = [];
    const abort = new AbortController();
    const ctx: AutomationExtensionContext = {
      automationName: "test",
      dryRun: false,
      signal: abort.signal,
      isPaused: () => false,
      log: () => {},
      onDispose: (fn) => { disposers.push(fn); },
      sdk: {},
    };
    const api = voiceExtension.create(ctx) as any;
    api.onCommand("slice", () => {});
    expect(disposers.length).toBeGreaterThan(0);
    // Run all disposers — should not throw
    for (const d of disposers) {
      expect(() => d()).not.toThrow();
    }
  });
});

// ─── Routing test: fake transcript source ─────────────────────────────────────

describe("VoiceSession routing with fake TranscriptSource", () => {
  // We test the ModeRouter directly since VoiceSession requires heavy dependencies.
  // Full integration tests go in VoiceSession.test.ts.
  const { ModeRouter } = require("../src/commandMode");

  it("routes wake-phrase detection to agent mode", () => {
    const modeChanges: string[] = [];
    const router = new ModeRouter({ onModeChanged: (m: string) => modeChanges.push(m) });
    // Simulate: session starts in command mode, wake matched → agent mode
    router.setMode("agent");
    expect(modeChanges).toContain("agent");
  });

  it("command mode unmatched drops to onUnmatched", async () => {
    const unmatched: string[] = [];
    const router = new ModeRouter({ onUnmatched: (t: string) => unmatched.push(t) });
    await router.routeCommandModeUtterance("hello world foo bar", "id", Date.now(), undefined);
    expect(unmatched).toContain("hello world foo bar");
  });
});
