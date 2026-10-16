import {
  BaseControl,
  Channel,
  InputItem,
  MemoryChannel,
  ProcessCancelledError,
  ProcessDocument,
  ProcessMirror,
  StatefulProcess,
} from "../../../src/services/stateful";

type S = { n: number; log: string[]; inputCursors?: Record<string, unknown> };
type E = { type: string; n?: number };

const quiet = { info() {}, warn() {}, error() {} };

class Counter extends StatefulProcess<S, BaseControl, E> {
  hooks: string[] = [];
  constructor() {
    super({ kind: "test", state: { n: 0, log: [] }, log: quiet });
  }
  inc(events: E[] = []) {
    this.update((s) => {
      s.n++;
    }, { events, reason: "inc" });
  }
  evt(e: E) {
    this.emit(e);
  }
  status(...a: Parameters<StatefulProcess["setStatus"]>) {
    this.setStatus(...a);
  }
  protected onPause() {
    this.hooks.push("pause");
  }
  protected onResume() {
    this.hooks.push("resume");
  }
  protected onCancel() {
    this.hooks.push("cancel");
  }
  protected onInterrupt(m?: string) {
    this.hooks.push("interrupt:" + m);
  }
  consumeNow(items: InputItem[], cursor: { source: string; value: unknown }) {
    this.consume(items, cursor, (d, its) => {
      d.log.push(...its.map((i) => i.id));
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("StatefulProcess", () => {
  it("single writer: a mirror cannot change state, only control/inputs", async () => {
    const p = new Counter();
    const mem = new MemoryChannel<S, BaseControl, E>();
    await p.attach(mem);
    p.inc();
    await p.flush();
    const mirror = await ProcessMirror.open(mem);
    expect(mirror.getState().n).toBe(1);

    // the mirror has no update/setStatus, and its state object is only ever replaced by a newer owner doc
    expect((mirror as any).update).toBeUndefined();
    expect((mirror as any).setStatus).toBeUndefined();
    await mirror.pause();
    await p.flush();
    expect(p.getState().n).toBe(1); // state untouched
    expect(p.getControl().desired).toBe("paused"); // control changed
    expect(p.getLifecycle().status).toBe("created");

    p.inc();
    await p.flush();
    expect(mirror.getState().n).toBe(2);
    expect(mirror.getControl().desired).toBe("paused");
    mirror.close();
  });

  it("update is synchronous and commits one version each", () => {
    const p = new Counter();
    const versions: number[] = [];
    p.onStateUpdated((c) => versions.push(c.version));
    p.inc();
    p.inc();
    expect(p.getState().n).toBe(2);
    expect(p.snapshot().version).toBe(2);
    expect(versions).toEqual([1, 2]);
  });

  it("coalescing: slow channel skips versions but receives all events, in order", async () => {
    const p = new Counter();
    const seen: Array<{ v: number; events: E[] }> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const ch = new MemoryChannel<S, BaseControl, E>({
      id: "slow",
      publish: async (doc, events) => {
        seen.push({ v: doc.version, events });
        if (first) {
          first = false;
          await gate; // hold the first publish (attach snapshot) in flight
        }
      },
    });
    await p.attach(ch);
    for (let i = 1; i <= 5; i++) p.inc([{ type: "inc", n: i }]);
    p.evt({ type: "extra" });
    release();
    await p.flush();

    expect(seen.map((s) => s.v)).toEqual([0, 5]); // versions 1-4 skipped
    expect(seen[1].events.map((e) => e.n ?? e.type)).toEqual([1, 2, 3, 4, 5, "extra"]);
    expect(ch.doc!.state.n).toBe(5);
  });

  it("terminal flush: terminal doc bypasses throttle and is always published", async () => {
    const p = new Counter();
    const ch = new MemoryChannel<S, BaseControl, E>({
      id: "throttled",
      policy: { minIntervalMs: 60_000 },
      record: true,
    });
    await p.attach(ch);
    p.inc();
    const result = await p.run(async () => 42);
    expect(result).toBe(42);
    expect(ch.doc!.lifecycle.status).toBe("completed");
    expect(ch.doc!.lifecycle.result).toBe(42);
    expect(ch.doc!.state.n).toBe(1);
  });

  it("per-channel error isolation + retry", async () => {
    const p = new Counter();
    let attempts = 0;
    const bad = new MemoryChannel<S, BaseControl, E>({
      id: "bad",
      policy: { retry: { attempts: 2, backoffMs: 1 } },
      publish: async () => {
        attempts++;
        throw new Error("boom");
      },
    });
    const good = new MemoryChannel<S, BaseControl, E>({ id: "good" });
    let flaky = 0;
    const flakyCh = new MemoryChannel<S, BaseControl, E>({
      id: "flaky",
      policy: { retry: { attempts: 3, backoffMs: 1 } },
      publish: async () => {
        if (flaky++ < 2) throw new Error("transient");
      },
    });
    await p.attach(bad);
    await p.attach(good);
    await p.attach(flakyCh);
    p.inc();
    await p.flush(); // never throws because of a channel
    expect(good.doc!.state.n).toBe(1);
    expect(flakyCh.doc!.state.n).toBe(1); // retried until success
    expect(bad.doc).toBeUndefined();
    expect(attempts).toBeGreaterThanOrEqual(2);
    await expect(p.persisted(1, "good")).resolves.toBeUndefined();
  });

  it("consume advances the cursor in the same version as the effect", () => {
    const p = new Counter();
    const changes: Array<{ version: number; log: string[]; cursor: unknown }> = [];
    p.onStateUpdated((c) =>
      changes.push({
        version: c.version,
        log: c.next.log,
        cursor: c.next.inputCursors?.fs,
      })
    );
    const item: InputItem = { id: "a", kind: "message", payload: {}, at: "", source: "fs" };
    p.consumeNow([item], { source: "fs", value: { offset: 7 } });
    expect(changes).toHaveLength(1); // ONE version
    expect(changes[0].log).toEqual(["a"]);
    expect(changes[0].cursor).toEqual({ offset: 7 });
  });

  it("persisted() resolves once the channel has persisted that version", async () => {
    const p = new Counter();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ch = new MemoryChannel<S, BaseControl, E>({
      id: "gated",
      publish: async (doc) => {
        if (doc.version >= 1) await gate;
      },
    });
    await p.attach(ch);
    p.inc();
    let done = false;
    const pr = p.persisted(1, "gated").then(() => (done = true));
    await sleep(20);
    expect(done).toBe(false);
    release();
    await pr;
    expect(done).toBe(true);
    await expect(p.persisted(1)).resolves.toBeUndefined(); // all durable channels
  });

  it("checkpoint blocks while paused and resumes without polling", async () => {
    const p = new Counter();
    p.status("running");
    p.pause();
    let passed = false;
    const cp = p.checkpoint().then(() => (passed = true));
    await sleep(20);
    expect(passed).toBe(false);
    expect(p.getLifecycle().status).toBe("paused");
    await p.flush();
    expect(p.hooks).toEqual(["pause"]);
    expect(p.snapshot().observedControlVersion).toBe(1);

    p.resume();
    await cp;
    expect(passed).toBe(true);
    expect(p.getLifecycle().status).toBe("running");
    expect(p.hooks).toEqual(["pause", "resume"]);
  });

  it("checkpoint throws ProcessCancelledError on cancel; run() records cancelled", async () => {
    const p = new Counter();
    const run = p.run(async (self) => {
      await sleep(10);
      await self.checkpoint();
      return "never";
    });
    p.cancel();
    await expect(run).rejects.toBeInstanceOf(ProcessCancelledError);
    expect(p.getLifecycle().status).toBe("cancelled");
    expect(p.hooks).toContain("cancel");
  });

  it("interrupt hook and a repeated identical control is a no-op", async () => {
    const p = new Counter();
    p.interrupt("poke");
    await p.flush();
    expect(p.hooks).toEqual(["interrupt:poke"]);
    const v = p.snapshot().controlVersion;
    p.applyControl({ interrupt: p.getControl().interrupt });
    expect(p.snapshot().controlVersion).toBe(v);
  });

  it("send() goes through onInput default: waitForInput resolves, cursor recorded", async () => {
    const p = new Counter();
    p.status("running");
    const waiting = p.waitForInput({ kind: "go" });
    p.send("other", {});
    p.send("go", { x: 1 }, { id: "g1" });
    const item = await waiting;
    expect(item.id).toBe("g1");
    await p.flush();
    expect(p.getState().inputCursors?.local).toBe(2);
  });

  it("changes() yields committed changes and ends at terminal status", async () => {
    const p = new Counter();
    const reasons: string[] = [];
    const reader = (async () => {
      for await (const c of p.changes()) reasons.push(c.reason ?? "");
    })();
    p.inc();
    await p.run(async () => 1);
    await reader;
    expect(reasons).toContain("inc");
    expect(reasons[reasons.length - 1]).toBe("status:completed");
  });

  it("mirror attached mid-run gets the full snapshot, then follows", async () => {
    const p = new Counter();
    p.inc();
    p.inc();
    p.inc();
    const mem = new MemoryChannel<S, BaseControl, E>({ record: true });
    await p.attach(mem); // mid-run
    const mirror = await ProcessMirror.open(mem);
    expect(mirror.getState().n).toBe(3);
    expect(mirror.getLifecycle().status).toBe("created");
    const seen: number[] = [];
    mirror.onStateUpdated((c) => seen.push(c.next.n));
    p.inc();
    await p.flush();
    expect(seen).toEqual([4]);
    expect(mem.publishes[0].version).toBe(3); // first publish = full snapshot
  });

  it("setLink / channels() / duplicate attach", async () => {
    const p = new Counter();
    const ch: Channel = {
      id: "x",
      direction: "in",
      async start(ctx) {
        ctx.setLink("remoteTaskId", "abc");
      },
      async stop() {},
    };
    await p.attach(ch);
    expect(p.meta.links).toEqual({ remoteTaskId: "abc" });
    await expect(p.attach(ch)).rejects.toThrow(/already attached/);
    expect(p.channels()).toHaveLength(1);
    await p.close();
    expect(p.channels()).toHaveLength(0);
  });

  it("restores from a document", () => {
    const p = new Counter();
    p.inc();
    const doc: ProcessDocument<S, BaseControl> = p.snapshot();
    const q = new (class extends StatefulProcess<S> {})({ kind: "test", document: doc });
    expect(q.getState().n).toBe(1);
    expect(q.snapshot().version).toBe(1);
    expect(q.meta.id).toBe(p.meta.id);
  });
});
