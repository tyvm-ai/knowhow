import { ThreadCursor, appendDelta, hashJson } from "../../../src/services/stateful";

const msgs = (n: number, prefix = "m") => Array.from({ length: n }, (_, i) => ({ role: "user", content: `${prefix}${i}` }));
const view = (a: any[]) => ({ length: a.length, lastHash: a.length ? hashJson(a[a.length - 1]) : undefined });

describe("appendDelta", () => {
  it("noop when identical", () => {
    const a = msgs(3);
    expect(appendDelta(view(a), a).kind).toBe("noop");
    expect(appendDelta({ length: 0 }, []).kind).toBe("noop");
  });

  it("append from persisted length, tolerating skipped versions", () => {
    const persisted = msgs(3); // medium has v1 (3 msgs); in-memory is now v9 (8 msgs)
    const next = msgs(8);
    const d = appendDelta(view(persisted), next);
    expect(d).toEqual({ kind: "append", from: 3, items: next.slice(3) });
  });

  it("append from empty", () => {
    const next = msgs(2);
    expect(appendDelta({ length: 0 }, next)).toEqual({ kind: "append", from: 0, items: next });
  });

  it("detects rewrites (shorter, or boundary item changed) -> replace", () => {
    const persisted = msgs(5);
    expect(appendDelta(view(persisted), msgs(2)).kind).toBe("replace");
    const rewritten = [...msgs(4), { role: "user", content: "EDITED" }, ...msgs(2, "x")];
    expect(appendDelta(view(persisted), rewritten).kind).toBe("replace");
    expect(appendDelta(view(persisted), [...msgs(4), { role: "user", content: "EDITED" }]).kind).toBe("replace");
  });

  it("without a hash only lengths are compared", () => {
    expect(appendDelta({ length: 2 }, msgs(4))).toMatchObject({ kind: "append", from: 2 });
    expect(appendDelta({ length: 4 }, msgs(2)).kind).toBe("replace");
  });
});

describe("ThreadCursor", () => {
  it("plans per thread, acks, and skips versions", () => {
    const c = new ThreadCursor<any>();
    let threads = [msgs(2), msgs(1, "t")];
    let plan = c.plan(threads);
    expect(plan.map((p) => [p.index, p.kind])).toEqual([[0, "append"], [1, "append"]]);
    plan.forEach((s) => c.ackStep(s, threads[s.index]));
    expect(c.plan(threads)).toEqual([]);

    threads = [msgs(6), msgs(1, "t")]; // several versions happened in between
    plan = c.plan(threads);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ index: 0, kind: "append", from: 2 });
    c.ackStep(plan[0], threads[0]);
    expect(c.plan(threads)).toEqual([]);
  });

  it("rewrite -> replace, removed thread -> replace with [], reset -> full replace", () => {
    const c = new ThreadCursor<any>();
    const threads = [msgs(4)];
    c.plan(threads).forEach((s) => c.ackStep(s, threads[s.index]));
    const compressed = [[{ role: "assistant", content: "summary" }]];
    expect(c.plan(compressed)[0].kind).toBe("replace");
    expect(c.plan([])).toEqual([{ index: 0, kind: "replace", items: [] }]);
    c.reset();
    expect(c.plan(threads)[0]).toMatchObject({ kind: "append", from: 0 });
    c.ackFrom({ lengths: [4], lastHashes: [hashJson(threads[0][3])] });
    expect(c.plan(threads)).toEqual([]);
  });
});
