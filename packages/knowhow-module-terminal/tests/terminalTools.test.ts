/**
 * Tests for the terminal module's AI-agent tools:
 *   - listTerminalSessions
 *   - readTerminalOutput
 *   - writeTerminalInput
 *
 * We test via the sessionAccessor layer (no real PTY needed) so the tests
 * run without a TTY and without node-pty native bindings needing a real
 * terminal device.
 */

import {
  sessions,
  terminatedSessions,
  markTerminated,
  getSessionList,
  getSessionByIndexOrId,
  writeToSession,
  PtySession,
} from "../src/sessionAccessor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal fake PtySession that satisfies the interface. */
function makeFakeSession(overrides: Partial<PtySession> = {}): PtySession {
  const written: string[] = [];
  const fakePty: any = {
    pid: 12345,
    write: (data: string) => { written.push(data); },
    kill: () => {},
    resize: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  };
  return {
    pty: fakePty,
    terminalId: "test-terminal-id",
    command: "bash",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    cols: 80,
    rows: 24,
    output: Buffer.from("hello world\r\n"),
    attachments: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  sessions.clear();
  terminatedSessions.clear();
});

afterEach(() => {
  sessions.clear();
  terminatedSessions.clear();
});

// ---------------------------------------------------------------------------
// getSessionList
// ---------------------------------------------------------------------------

describe("getSessionList", () => {
  it("returns an empty list when there are no sessions", () => {
    const list = getSessionList();
    expect(list).toEqual([]);
  });

  it("returns one entry per active session", () => {
    sessions.set("id-1", makeFakeSession({ terminalId: "id-1", command: "bash" }));
    sessions.set("id-2", makeFakeSession({ terminalId: "id-2", command: "zsh" }));

    const list = getSessionList();
    expect(list).toHaveLength(2);
    expect(list[0].terminalId).toBe("id-1");
    expect(list[1].terminalId).toBe("id-2");
  });

  it("includes pid, command, cols, rows, and createdAt in each entry", () => {
    sessions.set("id-1", makeFakeSession({ terminalId: "id-1" }));

    const [entry] = getSessionList();
    expect(entry.pid).toBe(12345);
    expect(entry.command).toBe("bash");
    expect(entry.cols).toBe(80);
    expect(entry.rows).toBe(24);
    expect(entry.createdAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("includes the output buffer in each entry", () => {
    sessions.set("id-1", makeFakeSession({ terminalId: "id-1", output: Buffer.from("foo") }));

    const [entry] = getSessionList();
    expect(entry.output.toString()).toBe("foo");
  });
});

// ---------------------------------------------------------------------------
// getSessionByIndexOrId – by terminalId
// ---------------------------------------------------------------------------

describe("getSessionByIndexOrId – by terminalId", () => {
  it("returns undefined when the terminalId is not found", () => {
    const result = getSessionByIndexOrId({ terminalId: "missing" });
    expect(result).toBeUndefined();
  });

  it("returns the matching session by terminalId", () => {
    sessions.set("abc", makeFakeSession({ terminalId: "abc", command: "sh" }));

    const result = getSessionByIndexOrId({ terminalId: "abc" });
    expect(result).not.toBeUndefined();
    expect(result!.terminalId).toBe("abc");
    expect(result!.command).toBe("sh");
  });

  it("exposes ptyInstance for writing", () => {
    sessions.set("abc", makeFakeSession({ terminalId: "abc" }));
    const result = getSessionByIndexOrId({ terminalId: "abc" });
    expect(result!.ptyInstance).toBeDefined();
    expect(typeof result!.ptyInstance.write).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// getSessionByIndexOrId – by index
// ---------------------------------------------------------------------------

describe("getSessionByIndexOrId – by index", () => {
  it("returns undefined for an out-of-range index", () => {
    sessions.set("id-1", makeFakeSession({ terminalId: "id-1" }));

    expect(getSessionByIndexOrId({ index: 5 })).toBeUndefined();
    expect(getSessionByIndexOrId({ index: -1 })).toBeUndefined();
  });

  it("returns the session at index 0", () => {
    sessions.set("first", makeFakeSession({ terminalId: "first", command: "bash" }));
    sessions.set("second", makeFakeSession({ terminalId: "second", command: "zsh" }));

    const result = getSessionByIndexOrId({ index: 0 });
    expect(result).not.toBeUndefined();
    expect(result!.terminalId).toBe("first");
  });

  it("returns the session at index 1", () => {
    sessions.set("first", makeFakeSession({ terminalId: "first" }));
    sessions.set("second", makeFakeSession({ terminalId: "second", command: "zsh" }));

    const result = getSessionByIndexOrId({ index: 1 });
    expect(result!.terminalId).toBe("second");
    expect(result!.command).toBe("zsh");
  });
});

// ---------------------------------------------------------------------------
// writeToSession
// ---------------------------------------------------------------------------

describe("writeToSession", () => {
  it("calls write on the ptyInstance with the given input", () => {
    const written: string[] = [];
    const fakePtyInstance: any = {
      write: (data: string) => written.push(data),
    };

    writeToSession({ ptyInstance: fakePtyInstance }, "ls -la\n");
    expect(written).toEqual(["ls -la\n"]);
  });

  it("passes control characters through unmodified", () => {
    const written: string[] = [];
    const fakePtyInstance: any = { write: (d: string) => written.push(d) };

    writeToSession({ ptyInstance: fakePtyInstance }, "\x03"); // Ctrl+C
    expect(written).toEqual(["\x03"]);
  });
});

// ---------------------------------------------------------------------------
// markTerminated
// ---------------------------------------------------------------------------

describe("markTerminated", () => {
  it("records the exit code for a terminalId", () => {
    markTerminated("id-1", 0);
    expect(terminatedSessions.get("id-1")).toBe(0);
  });

  it("overwrites a previous entry with the latest exit code", () => {
    markTerminated("id-1", 1);
    markTerminated("id-1", 0);
    expect(terminatedSessions.get("id-1")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tool shape validation
// ---------------------------------------------------------------------------

describe("terminalTools export", () => {
  it("exports exactly 3 tools with the correct names", async () => {
    const { terminalTools } = await import("../src/tools");
    expect(terminalTools).toHaveLength(3);

    const names = terminalTools.map((t) => t.name);
    expect(names).toContain("listTerminalSessions");
    expect(names).toContain("readTerminalOutput");
    expect(names).toContain("writeTerminalInput");
  });

  it("every tool has a handler function", async () => {
    const { terminalTools } = await import("../src/tools");
    for (const tool of terminalTools) {
      expect(typeof tool.handler).toBe("function");
    }
  });

  it("every tool definition has type='function'", async () => {
    const { terminalTools } = await import("../src/tools");
    for (const tool of terminalTools) {
      expect(tool.definition.type).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// listTerminalSessions handler (integration via tools.ts)
// ---------------------------------------------------------------------------

describe("listTerminalSessions handler", () => {
  let handler: () => Promise<any>;

  beforeEach(async () => {
    const { terminalTools } = await import("../src/tools");
    const tool = terminalTools.find((t) => t.name === "listTerminalSessions")!;
    handler = tool.handler as () => Promise<any>;
  });

  it("returns count=0 when there are no sessions", async () => {
    const result = await handler();
    expect(result.count).toBe(0);
    expect(result.sessions).toEqual([]);
  });

  it("returns count=1 and one session entry when a session exists", async () => {
    sessions.set("id-1", makeFakeSession({ terminalId: "id-1" }));

    const result = await handler();
    expect(result.count).toBe(1);
    expect(result.sessions[0].terminalId).toBe("id-1");
    expect(result.sessions[0].index).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readTerminalOutput handler
// ---------------------------------------------------------------------------

describe("readTerminalOutput handler", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(async () => {
    const { terminalTools } = await import("../src/tools");
    const tool = terminalTools.find((t) => t.name === "readTerminalOutput")!;
    handler = tool.handler as (args: any) => Promise<any>;
  });

  it("throws when neither terminalId nor index is provided", async () => {
    await expect(handler({})).rejects.toThrow();
  });

  it("throws when the terminalId does not match any session", async () => {
    await expect(handler({ terminalId: "not-found" })).rejects.toThrow(/No active terminal session found/i);
  });

  it("throws when the index is out of range", async () => {
    await expect(handler({ index: 99 })).rejects.toThrow(/No active terminal session found/i);
  });

  it("returns output for a session looked up by terminalId", async () => {
    sessions.set("id-1", makeFakeSession({ terminalId: "id-1", output: Buffer.from("hello\r\n") }));

    const result = await handler({ terminalId: "id-1" });
    expect(result.output).toBe("hello\r\n");
    expect(result.terminalId).toBe("id-1");
  });

  it("returns output for a session looked up by index", async () => {
    sessions.set("id-1", makeFakeSession({ terminalId: "id-1", output: Buffer.from("world") }));

    const result = await handler({ index: 0 });
    expect(result.output).toBe("world");
  });

  it("respects maxBytes by returning only the tail of the output", async () => {
    const bigOutput = Buffer.from("A".repeat(100) + "TAIL");
    sessions.set("id-1", makeFakeSession({ terminalId: "id-1", output: bigOutput }));

    const result = await handler({ terminalId: "id-1", maxBytes: 4 });
    expect(result.output).toBe("TAIL");
  });
});

// ---------------------------------------------------------------------------
// writeTerminalInput handler
// ---------------------------------------------------------------------------

describe("writeTerminalInput handler", () => {
  let handler: (args: any) => Promise<any>;

  beforeEach(async () => {
    const { terminalTools } = await import("../src/tools");
    const tool = terminalTools.find((t) => t.name === "writeTerminalInput")!;
    handler = tool.handler as (args: any) => Promise<any>;
  });

  it("throws when neither terminalId nor index is provided", async () => {
    await expect(handler({ input: "ls\n" })).rejects.toThrow();
  });

  it("throws when the session is not found", async () => {
    await expect(handler({ terminalId: "nope", input: "ls\n" })).rejects.toThrow(/No active terminal session found/i);
  });

  it("writes input to the PTY and returns status=ok", async () => {
    const written: string[] = [];
    const session = makeFakeSession({ terminalId: "id-1" });
    (session.pty as any).write = (d: string) => written.push(d);
    sessions.set("id-1", session);

    const result = await handler({ terminalId: "id-1", input: "ls -la\n" });
    expect(result.status).toBe("ok");
    expect(result.terminalId).toBe("id-1");
    expect(written).toContain("ls -la\n");
  });

  it("writes input by session index", async () => {
    const written: string[] = [];
    const session = makeFakeSession({ terminalId: "id-1" });
    (session.pty as any).write = (d: string) => written.push(d);
    sessions.set("id-1", session);

    await handler({ index: 0, input: "echo hi\n" });
    expect(written).toContain("echo hi\n");
  });

  it("returns bytesWritten equal to the byte length of the input", async () => {
    const session = makeFakeSession({ terminalId: "id-1" });
    sessions.set("id-1", session);

    const result = await handler({ terminalId: "id-1", input: "abc" });
    expect(result.bytesWritten).toBe(3);
  });
});
