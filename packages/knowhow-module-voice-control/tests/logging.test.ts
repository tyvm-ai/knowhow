/** One tagged logger: formatting policy (list trimming), tagged loggers for helper code, no raw console in sessions. */

import { createMemoryLogger, createVoiceLogger, formatList, stderrSink, taggedLogger } from "../src/services";
import { resolveLogLevel } from "../src/services/logger";

describe("formatList (the 'first 60 … +N more' policy)", () => {
  it("joins short lists and trims long ones", () => {
    expect(formatList(["a", "b"])).toBe("a, b");
    const many = Array.from({ length: 65 }, (_, i) => `L${i}`);
    const out = formatList(many);
    expect(out.startsWith("L0, L1")).toBe(true);
    expect(out).toContain("L59");
    expect(out).not.toContain("L60,");
    expect(out.endsWith("… +5 more")).toBe(true);
    expect(formatList(many, 3)).toBe("L0, L1, L2, … +62 more");
  });
});

describe("tagged loggers", () => {
  it("prefix the tag and honour levels", () => {
    const lines: string[] = [];
    const log = createVoiceLogger({ level: "warn", sink: (_l, line) => void lines.push(line) });
    log.info("hidden");
    log.child("hints").warn("shown");
    expect(lines).toEqual(["[hints] shown"]);
    const mem = createMemoryLogger();
    mem.info("x");
    expect(mem.lines).toEqual(["[voice] x"]);
  });

  it("taggedLogger(tag, sink) writes through the given sink; stderrSink goes to stderr", () => {
    const lines: string[] = [];
    taggedLogger("eye", (_l, line) => void lines.push(line)).info("ready");
    expect(lines).toEqual(["[eye] ready"]);
    const write = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      taggedLogger("ax-enabler", stderrSink).error("boom");
      expect(write).toHaveBeenCalledWith("[ax-enabler] boom\n");
    } finally {
      write.mockRestore();
    }
  });

  it("resolveLogLevel reads the log.level setting (env > default)", () => {
    expect(resolveLogLevel({ KNOWHOW_VOICE_LOG_LEVEL: "debug" })).toBe("debug");
    expect(resolveLogLevel({ KNOWHOW_VOICE_LOG_LEVEL: "nonsense" })).toBe("info");
    expect(resolveLogLevel({})).toBe("info");
  });
});

describe("no raw console in session code", () => {
  it("VoiceSession / recovery / whisper logs go through the logger", () => {
    const { readFileSync } = require("fs");
    const { join } = require("path");
    for (const f of ["VoiceSession.ts", "recovery/engine.ts", "whisperServer.ts", "packs/meta.ts"]) {
      const text = readFileSync(join(__dirname, "..", "src", f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      expect(text).not.toMatch(/console\.(log|warn|error)\(/);
    }
  });
});
