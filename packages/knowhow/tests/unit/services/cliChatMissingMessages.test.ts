/**
 * Regression tests for messages the website shows but `knowhow chat` missed.
 * See knowhow-web/.knowhow/tasks/2026-11-22-share-and-app-controls/cli-chat-missing-messages-report.md
 */
import {
  contentToText,
  messagesToRenderEvents,
} from "../../../src/chat/renderer/messagesToRenderEvents";
import { ThreadDiffer } from "../../../src/services/stateful/agent/agentProjection";
import { KnowhowWebSource } from "../../../src/services/stateful/agent/agentMirror";
import { ProcessMirror } from "../../../src/services/stateful/ProcessMirror";
import { RemoteThreadCursor } from "../../../src/services/RemoteTaskWatcher";
import type { KnowhowSimpleClient } from "../../../src/services/KnowhowClient";

const say = (content: unknown) => ({ role: "assistant", content });
const user = (content: string) => ({ role: "user", content });

describe("A: messagesToRenderEvents content parts", () => {
  it("renders assistant messages whose content is an array of parts", () => {
    const events = messagesToRenderEvents(
      [say([{ type: "text", text: "hello" }, { type: "image_url" }, { type: "text", text: "world" }]) as any],
      "t1",
      "agent"
    );
    expect(events).toEqual([
      { type: "agentMessage", taskId: "t1", agentName: "agent", message: "hello\nworld", role: "assistant" },
    ]);
  });

  it("renders the reasoning summary like the live agent does", () => {
    const events = messagesToRenderEvents(
      [{ role: "assistant", content: "answer", reasoning_summary: "thinking" } as any],
      "t1",
      "agent"
    );
    expect(events.map((e: any) => e.message)).toEqual(["💭 thinking", "answer"]);
  });

  it("skips empty assistant content but keeps its tool calls", () => {
    const events = messagesToRenderEvents(
      [
        {
          role: "assistant",
          content: [],
          tool_calls: [{ id: "c1", function: { name: "readFile", arguments: "{}" } }],
        } as any,
      ],
      "t1",
      "agent"
    );
    expect(events.map((e) => e.type)).toEqual(["toolCall"]);
  });

  it("contentToText handles strings, parts, null and objects", () => {
    expect(contentToText("x")).toBe("x");
    expect(contentToText([{ type: "output_text", text: "a" }, "b"])).toBe("a\nb");
    expect(contentToText(null)).toBe("");
    expect(contentToText({ text: "t" })).toBe("t");
  });
});

describe("B: ThreadDiffer across new threads", () => {
  it("returns plain growth of the last thread", () => {
    const d = new ThreadDiffer([[user("task")]]);
    expect(d.next([[user("task"), say("a"), say("b")]])).toEqual([say("a"), say("b")]);
    expect(d.next([[user("task"), say("a"), say("b")]])).toEqual([]);
  });

  it("emits the unseen tail of the previous thread when a new thread appears", () => {
    const d = new ThreadDiffer([[user("task"), say("a")]]);
    const prev = [user("task"), say("a"), say("unseen tail")];
    const next = [user("summary"), say("unseen tail"), say("after")];
    expect(d.next([prev, next])).toEqual([say("unseen tail"), say("after")]);
  });

  it("emits threads in between when several threads appear at once", () => {
    const d = new ThreadDiffer([[user("task"), say("a")]]);
    const t0 = [user("task"), say("a"), say("b")];
    const t1 = [user("summary 1"), say("c")];
    const t2 = [user("summary 2"), say("d")];
    expect(d.next([t0, t1, t2])).toEqual([say("b"), user("summary 1"), say("c"), user("summary 2"), say("d")]);
  });

  it("does not repeat the message a compacted thread retains", () => {
    const retained = say("before");
    const d = new ThreadDiffer([[user("task"), retained]]);
    expect(d.next([[user("task"), retained], [user("summary"), retained, say("after")]])).toEqual([
      say("after"),
    ]);
  });

  it("handles a shrunk (in-place compacted) last thread without duplicates", () => {
    const d = new ThreadDiffer([[user("task"), say("a"), say("b"), say("c")]]);
    expect(d.next([[user("summary"), say("c"), say("d")]])).toEqual([say("d")]);
  });
});

describe("C/D: KnowhowWebSource", () => {
  const makeClient = (responses: any[]) => {
    let i = 0;
    const getTaskDetails = jest.fn(async () => ({ data: responses[Math.min(i++, responses.length - 1)] }));
    return { client: { getTaskDetails } as unknown as KnowhowSimpleClient, getTaskDetails };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("delivers a change that landed between open() and the first poll", async () => {
    const { client } = makeClient([
      { status: "running", threads: [[user("task")]] },
      { status: "completed", result: "done", threads: [[user("task"), say("final")]] },
    ]);
    const mirror = await ProcessMirror.open(new KnowhowWebSource("t1", client, 60_000));
    await flush();
    await flush();
    // before the fix the first poll was only a baseline: the mirror stayed "running"
    expect(mirror.getLifecycle().status).toBe("completed");
    expect(mirror.getState().threads[0]).toHaveLength(2);
    mirror.close();
  });

  it("does not call back when nothing changed since open()", async () => {
    const { client, getTaskDetails } = makeClient([{ status: "running", threads: [[user("task")]] }]);
    const mirror = await ProcessMirror.open(new KnowhowWebSource("t1", client, 60_000));
    const seen: any[] = [];
    mirror.onStateUpdated(() => seen.push(1));
    await flush();
    await flush();
    expect(getTaskDetails).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([]);
    mirror.close();
  });

  it.each(["failed", "error"])("maps a %s task to the terminal failed status", async (status) => {
    const { client } = makeClient([{ status, threads: [] }]);
    const src = new KnowhowWebSource("t1", client, 60_000);
    const doc = await src.readDocument();
    expect(doc!.lifecycle.status).toBe("failed");
  });
});

describe("F: RemoteThreadCursor echo skipping", () => {
  it("each sent text hides only one echo", () => {
    const cursor = new RemoteThreadCursor("t1");
    cursor.seed([[user("task")]]);
    const sent = new Set(["yes"]);
    const t = [user("task"), user("yes"), say("ok"), user("yes, and also this")];
    const out = cursor.next([t], sent);
    expect(out.map((e) => (e.payload as any).message)).toEqual(["ok", "🧑 yes, and also this"]);
    expect(sent.size).toBe(0);
  });

  it("still hides an echo wrapped in plugin context", () => {
    const cursor = new RemoteThreadCursor("t1");
    cursor.seed([[user("task")]]);
    const out = cursor.next([[user("task"), user("<context>…</context>\nfix the bug")]], new Set(["fix the bug"]));
    expect(out).toEqual([]);
  });
});
