import fs from "fs";
import os from "os";
import path from "path";
import {
  ChatHistoryIndex,
  buildChatHistoryContext,
  extractFinalAnswer,
  readSessionInitialInput,
  remoteApiUrlForMetadata,
  truncate,
} from "../../src/services/ChatHistoryIndex";

// Deterministic fake embedding: a bag of topic keywords.
const TOPICS = ["pricing", "video", "commit", "cache", "grok", "embedding"];
async function fakeEmbed(text: string): Promise<number[]> {
  const lower = text.toLowerCase();
  return [...TOPICS.map((t): number => (lower.includes(t) ? 1 : 0)), 0.01];
}

function session(taskId: string, input: string, answer: string | undefined, startTime: number, extra: any = {}) {
  const thread: any[] = [
    { role: "system", content: "sys" },
    { role: "user", content: `<PreviousChats>…</PreviousChats><CurrentTask>${input}</CurrentTask>` },
  ];
  if (answer !== undefined) {
    thread.push({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "t1", type: "function", function: { name: "finalAnswer", arguments: JSON.stringify({ answer }) } },
      ],
    });
    thread.push({ role: "tool", tool_call_id: "t1", name: "finalAnswer", content: answer });
  }
  return {
    sessionId: taskId,
    taskId,
    agentName: "Developer",
    initialInput: input,
    status: answer === undefined ? "running" : "completed",
    startTime,
    endTime: answer === undefined ? undefined : startTime + 1000,
    totalCost: 0.5,
    threads: [thread],
    model: "claude-opus-5-5",
    ...extra,
  };
}

describe("ChatHistoryIndex", () => {
  let root: string;
  let sessionsDir: string;

  function writeSession(s: any) {
    fs.writeFileSync(path.join(sessionsDir, `${s.taskId}.json`), JSON.stringify(s));
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-history-"));
    sessionsDir = path.join(root, ".knowhow/chats/sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(root, ".knowhow/chats/history.json"),
      JSON.stringify({
        inputs: [
          "add pricing for the new models",
          "make a video with omni",
          "can you commit what we have",
          "are we up to date with grok models?",
          "still running task",
        ],
      })
    );
    writeSession(session("1-pricing", "add pricing for the new models", "Added pricing for 3 models.", 1000));
    writeSession(session("2-video", "make a video with omni", "Video generated with Omni.", 2000));
    writeSession(session("3-commit", "can you commit what we have", "Made 2 commits.", 3000));
    writeSession(
      session("4-grok", "are we up to date with grok models?", "Added grok pricing for image 2.0.", 4000, {
        knowhowTaskId: "11111111-2222-4333-8444-555555555555",
      })
    );
    // spawned by an agent (not typed in the chat)
    writeSession(session("5-sub", "sub-agent: research video caching", "Sub-agent answer.", 5000));
    // still running
    writeSession(session("6-running", "still running task", undefined, 6000));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("indexes chat tasks with their final answers and metadata", async () => {
    const index = new ChatHistoryIndex({ root, embed: fakeEmbed, apiUrl: "http://localhost:4000/" });
    const result = await index.sync();
    expect(result.added).toBe(4);
    expect(result.embedded).toBe(4);
    const ids = index.entries().map((e) => e.id).sort();
    expect(ids).toEqual(["1-pricing", "2-video", "3-commit", "4-grok"]);
    const grok = index.get("4-grok")!;
    expect(grok.output).toBe("Added grok pricing for image 2.0.");
    expect(grok.metadata).toMatchObject({
      taskId: "4-grok",
      sessionFile: path.join(".knowhow/chats/sessions", "4-grok.json"),
      source: "chat",
      knowhowTaskId: "11111111-2222-4333-8444-555555555555",
      apiUrl: "http://localhost:4000",
    });
    // local-only tasks don't get an api url
    expect(index.get("1-pricing")!.metadata.apiUrl).toBeUndefined();
  });

  it("is incremental and picks up a running task once it answers", async () => {
    const embed = jest.fn(fakeEmbed);
    const index = new ChatHistoryIndex({ root, embed });
    await index.sync();
    expect(embed).toHaveBeenCalledTimes(4);

    const again = new ChatHistoryIndex({ root, embed });
    expect((await again.sync()).added).toBe(0);
    expect(embed).toHaveBeenCalledTimes(4);

    writeSession(session("6-running", "still running task", "Done now.", 6000));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(sessionsDir, "6-running.json"), future, future);
    expect((await again.sync()).added).toBe(1);
    expect(again.get("6-running")!.output).toBe("Done now.");
  });

  it("can include agent-spawned tasks", async () => {
    const index = new ChatHistoryIndex({ root, embed: fakeEmbed, includeAgentTasks: true });
    await index.sync();
    expect(index.get("5-sub")!.metadata.source).toBe("agent");
  });

  it("builds a recent window plus relevant older interactions", async () => {
    const index = new ChatHistoryIndex({ root, embed: fakeEmbed });
    await index.sync();
    const ctx = await buildChatHistoryContext({
      index,
      input: "what pricing did we add?",
      options: { recent: 2, relevant: 5, minSimilarity: 0.5, recentMaxAgeHours: 0 },
      inProcess: [{ taskId: "7-live", input: "live task in this process", output: "" }],
    });
    // recent: newest two (in-process one + 4-grok), oldest first
    expect(ctx.recentIds).toEqual(["4-grok", "7-live"]);
    // relevant excludes the recent ones and needs similarity >= 0.5
    expect(ctx.relevant.map((r) => r.id)).toEqual(["1-pricing"]);
    expect(ctx.text).toContain("<ChatHistory>");
    expect(ctx.text).toContain("still running, no answer yet");
    expect(ctx.text).toContain("remote task 11111111-2222-4333-8444-555555555555");
    expect(ctx.text).toContain("searchChatHistory");
    expect(ctx.text.indexOf("4-grok")).toBeLessThan(ctx.text.indexOf("7-live"));
  });

  it("respects asOf, recentMaxAgeHours and falls back to recency without embeddings", async () => {
    const index = new ChatHistoryIndex({ root, embed: fakeEmbed });
    await index.sync({ embed: false });
    const ctx = await buildChatHistoryContext({
      index,
      input: "pricing",
      asOf: 3500, // 2-video ended at 3000, 3-commit at 4000
      options: { recent: 4, relevant: 5, recentMaxAgeHours: 0 },
    });
    expect(ctx.recentIds).toEqual(["1-pricing", "2-video"]);
    expect(ctx.relevant).toEqual([]);

    const none = await buildChatHistoryContext({
      index,
      input: "pricing",
      now: 10 * 3600_000,
      options: { recent: 4, relevant: 0, recentMaxAgeHours: 1 },
    });
    expect(none.text).toBe("");
  });

  it("survives an embedding failure", async () => {
    const index = new ChatHistoryIndex({ root, embed: fakeEmbed });
    await index.sync();
    const failing = new ChatHistoryIndex({
      root,
      embed: async () => {
        throw new Error("no provider");
      },
    });
    const ctx = await buildChatHistoryContext({
      index: failing,
      input: "pricing",
      options: { recent: 1, relevant: 5, recentMaxAgeHours: 0 },
    });
    expect(ctx.recentIds).toEqual(["4-grok"]);
    expect(ctx.relevant).toEqual([]);
  });

  it("upserts finished interactions and searches them", async () => {
    const index = new ChatHistoryIndex({ root, embed: fakeEmbed });
    await index.sync();
    await index.upsert({
      id: "8-cache",
      input: "why is the cache missing?",
      output: "The first message was a string.",
      metadata: { taskId: "8-cache", source: "chat", endTime: 9000 },
    });
    const reloaded = new ChatHistoryIndex({ root, embed: fakeEmbed });
    expect(reloaded.get("8-cache")!.vector!.length).toBeGreaterThan(0);
    const results = await reloaded.search("cache", { limit: 1 });
    expect(results[0].id).toBe("8-cache");
  });
});

describe("chat history helpers", () => {
  it("extracts the last finalAnswer", () => {
    expect(
      extractFinalAnswer([
        [
          { role: "tool", name: "finalAnswer", content: "first" },
          {
            role: "assistant",
            tool_calls: [{ function: { name: "finalAnswer", arguments: '{"answer":"second"}' } }],
          },
        ],
      ])
    ).toBe("second");
    expect(extractFinalAnswer([[{ role: "user", content: "x" }]])).toBe("");
    expect(extractFinalAnswer(undefined)).toBe("");
  });

  it("reads initialInput from the session head", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "head-")), "s.json");
    fs.writeFileSync(file, JSON.stringify({ taskId: "x", initialInput: 'say "hi"\nplease', threads: [] }));
    expect(readSessionInitialInput(file)).toBe('say "hi"\nplease');
  });

  it("only records non-production api urls", () => {
    expect(remoteApiUrlForMetadata("https://api.knowhow.tyvm.ai/")).toBeUndefined();
    expect(remoteApiUrlForMetadata("https://api.dev.knowhow.tyvm.ai")).toBe("https://api.dev.knowhow.tyvm.ai");
    expect(remoteApiUrlForMetadata(undefined)).toBeUndefined();
  });

  it("truncates with a marker", () => {
    expect(truncate("abcdef", 3)).toBe("abc… [+3 chars]");
    expect(truncate("abc", 0)).toBe("abc");
  });
});
