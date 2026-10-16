import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  BaseControl,
  FileInputChannel,
  FsProcessChannel,
  InputCursor,
  InputItem,
  ProcessMirror,
  StatefulProcess,
  appendInput,
  readInputBatch,
} from "../../../src/services/stateful";

const quiet = { info() {}, warn() {}, error() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type S = { got: string[]; texts: string[]; inputCursors?: Record<string, any> };

class Inbox extends StatefulProcess<S> {
  constructor() {
    super({ kind: "inbox", state: { got: [], texts: [] }, log: quiet });
  }
  protected onInput(items: InputItem[], cursor: InputCursor) {
    this.consume(items, cursor, (d, its) => {
      for (const i of its) {
        d.got.push(i.id);
        d.texts.push((i.payload as any)?.text);
      }
    });
  }
}

async function until(cond: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await sleep(10);
  }
}

describe("input stream protocol", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "stateful-input-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("appendInput writes one JSON line per record, never overwrites", () => {
    const f = path.join(dir, "input.txt");
    appendInput(f, { text: "a", from: "x" });
    appendInput(f, { kind: "interrupt", text: "b" });
    const lines = fs.readFileSync(f, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ kind: "message", text: "a", from: "x" });
    expect(JSON.parse(lines[1])).toMatchObject({ kind: "interrupt", text: "b" });
  });

  it("readInputBatch: cursor-based, stops at last complete newline", async () => {
    const f = path.join(dir, "input.txt");
    appendInput(f, { text: "one", id: "1" });
    fs.appendFileSync(f, '{"kind":"message","text":"tw'); // half-written
    const b1 = await readInputBatch(f, undefined);
    expect(b1.items.map((i) => i.id)).toEqual(["1"]);
    expect(b1.partialPending).toBe(true);
    fs.appendFileSync(f, 'o","id":"2"}\n');
    const b2 = await readInputBatch(f, b1.cursor);
    expect(b2.items.map((i) => (i.payload as any).text)).toEqual(["two"]);
    const b3 = await readInputBatch(f, b2.cursor);
    expect(b3.items).toEqual([]);
  });

  it("plain-text compat: raw lines are one message; '/' lines and JSON lines split", async () => {
    const f = path.join(dir, "input.txt");
    fs.appendFileSync(f, "hello\nworld\n"); // echo >> input.txt
    const b = await readInputBatch(f, undefined);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ kind: "message", payload: { text: "hello\nworld" } });

    fs.rmSync(f);
    fs.appendFileSync(f, "before\n/poke wake up\nafter\n");
    appendInput(f, { text: "json" });
    const c = await readInputBatch(f, undefined);
    expect(c.items.map((i) => (i.payload as any).text)).toEqual([
      "before",
      "/poke wake up",
      "after",
      "json",
    ]);
  });

  it("FileInputChannel delivers plain text, even without a trailing newline (settled)", async () => {
    const p = new Inbox();
    const f = path.join(dir, "input.txt");
    fs.writeFileSync(f, "legacy writer no newline");
    await p.attach(
      new FileInputChannel({ path: f, pollMs: 10, partialSettleMs: 50, watch: false, trim: false })
    );
    await until(() => p.getState().texts.length === 1);
    expect(p.getState().texts).toEqual(["legacy writer no newline"]);
    await p.close();
  });

  it("concurrent appends + rename/drain trimming loses nothing and duplicates nothing", async () => {
    const p = new Inbox();
    const f = path.join(dir, "input.txt");
    // a persisted channel so trimming is exercised through persisted()
    await p.attach(
      new FileInputChannel({ path: f, pollMs: 5, watch: false, partialSettleMs: 50 })
    );
    const mem = new (require("../../../src/services/stateful").MemoryChannel)({ id: "mem" });
    await p.attach(mem);

    const total = 400;
    const writers = [0, 1, 2, 3].map(async (w) => {
      for (let i = 0; i < total / 4; i++) {
        appendInput(f, { id: `w${w}-${i}`, text: `m${w}-${i}` });
        if (i % 7 === 0) await sleep(1);
      }
    });
    await Promise.all(writers);
    await until(() => p.getState().got.length >= total, 15000);
    await sleep(100);
    await p.flush();

    const got = p.getState().got;
    expect(got.length).toBe(total);
    expect(new Set(got).size).toBe(total);

    // trimming happened: the old file is gone and nothing is left unconsumed
    await until(() => !fs.existsSync(f + ".consuming"), 5000);
    await p.close();
  }, 30000);

  it("trim: rename -> drain late appends -> delete, then continues on the new file", async () => {
    const p = new Inbox();
    const f = path.join(dir, "input.txt");
    appendInput(f, { id: "a", text: "a" });
    const ch = new FileInputChannel({ path: f, pollMs: 10, watch: false });
    await p.attach(ch);
    await until(() => p.getState().got.length === 1);
    await p.flush();
    // consumed + persisted (no output channel => immediately durable): file is rotated away
    await until(() => !fs.existsSync(f) && !fs.existsSync(f + ".consuming"));
    appendInput(f, { id: "b", text: "b" });
    await until(() => p.getState().got.length === 2);
    expect(p.getState().got).toEqual(["a", "b"]);
    await p.close();
  });

  it("crash recovery: restart resumes from the persisted cursor, nothing replayed", async () => {
    const f = path.join(dir, "input.txt");
    const p1 = new Inbox();
    appendInput(f, { id: "a", text: "a" });
    appendInput(f, { id: "b", text: "b" });
    await p1.attach(new FileInputChannel({ path: f, pollMs: 10, watch: false, trim: false }));
    await until(() => p1.getState().got.length === 2);
    const doc = p1.snapshot();
    await p1.close();

    appendInput(f, { id: "c", text: "c" }); // appended while nothing was running
    const p2 = new (class extends Inbox {})();
    const restored = new (class extends StatefulProcess<S> {
      protected onInput(items: InputItem[], cursor: InputCursor) {
        this.consume(items, cursor, (d, its) => {
          its.forEach((i) => d.got.push(i.id));
        });
      }
    })({ kind: "inbox", document: doc, log: quiet });
    void p2;
    await restored.attach(new FileInputChannel({ path: f, pollMs: 10, watch: false, trim: false }));
    await until(() => restored.getState().got.length === 3);
    expect(restored.getState().got).toEqual(["a", "b", "c"]);
    await restored.close();
  });

  it("FsProcessChannel: state.json out, control.json + input.txt in, mirror from a dir", async () => {
    const p = new Inbox();
    const ch = new FsProcessChannel<S, BaseControl, never>(dir, { pollMs: 10 });
    await p.attach(ch);
    await p.flush();
    expect(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).meta.id).toBe(p.meta.id);

    // a mirror in "another process": a fresh channel over the same dir, not attached
    const mirror = await ProcessMirror.open(new FsProcessChannel<S, BaseControl, never>(dir, { pollMs: 10 }));
    await mirror.pause(); // -> control.json
    await until(() => p.getControl().desired === "paused");
    await mirror.send("message", { text: "hi" }); // -> input.txt
    await until(() => p.getState().texts.includes("hi"));
    await until(() => mirror.getState().texts.includes("hi"));
    expect(mirror.getControl().desired).toBe("paused");
    mirror.close();
    await p.close();
  });
});
