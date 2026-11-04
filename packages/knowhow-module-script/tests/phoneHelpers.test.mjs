import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { PHONE_HELPERS_JS, PHONE_HELPERS_TYPEDEFS } from "../ts_build/phoneHelpers.js";
import { generateScriptTypeDefs } from "../ts_build/typeDefs.js";

const wrap = (obj) => `<UntrustedContent source="worker:x">\n${JSON.stringify(obj)}\n</UntrustedContent>`;
const el = (id, text, extra = {}) => ({
  id,
  class: "android.widget.TextView",
  text,
  bounds: [0, 100, 200, 140],
  actions: ["click"],
  flags: { clickable: true, visible: true, editable: false, password: false, focused: false, scrollable: false },
  ...extra,
});

/** Fake phone: handler(tool, args) -> object | string | throws. Tool names are worker_0_<tool>. */
function makeCtx(handler, toolNames) {
  const calls = [];
  const names = toolNames ?? [
    "worker_0_computerUseAccessibilityElements",
    "worker_0_computerUseClickAt",
    "worker_0_computerUsePerformAccessibilityAction",
    "worker_0_computerUseScroll",
    "worker_0_phone_wait_for",
    "worker_0_phone_launch_app",
    "worker_1_browser_navigate",
    "worker_1_browser_read",
  ];
  const ctx = vm.createContext({
    __tool_names: names,
    sleep: async () => {},
    callTool: async (name, args) => {
      calls.push({ name, args });
      return handler(name.replace(/^worker_\d+_/, ""), args, name);
    },
  });
  ctx.globalThis = ctx;
  vm.runInContext(PHONE_HELPERS_JS, ctx);
  return { ctx, calls };
}
const run = (ctx, code) => vm.runInContext(code, ctx);

test("elements strips the UntrustedContent wrapper and parses JSON; texts() returns labels in order", async () => {
  const { ctx, calls } = makeCtx((tool) =>
    wrap({ snapshotId: "s1", package: "com.cal", windowId: 1, title: "Cal", truncated: false, elements: [el("a", "Today"), el("b", "", { contentDescription: "Add event" }), el("c", "9:00 Standup")] })
  );
  const t = await run(ctx, `phone.texts()`);
  assert.deepEqual(JSON.parse(JSON.stringify(t)), ["Today", "Add event", "9:00 Standup"]);
  assert.equal(calls[0].name, "worker_0_computerUseAccessibilityElements");
});

test("MCP content arrays and functionResp envelopes are unwrapped", async () => {
  const body = { snapshotId: "s", package: "p", windowId: 1, title: "", truncated: false, elements: [el("a", "Hello")] };
  const { ctx } = makeCtx(() => ({ functionResp: [{ type: "text", text: wrap(body) }] }));
  const snap = await run(ctx, `phone.elements()`);
  assert.equal(snap.elements[0].text, "Hello");
});

test("a locked companion throws code=locked with an unlock hint", async () => {
  const { ctx } = makeCtx(() => JSON.stringify({ error: "locked", message: "Phone control is locked" }));
  await assert.rejects(run(ctx, `phone.texts()`), (e) => {
    assert.equal(e.code, "locked");
    assert.match(e.message, /unlock/i);
    return true;
  });
});

test("a locked phone SCREEN throws code=device_locked with an unlock hint", async () => {
  const { ctx } = makeCtx(() => wrap({ error: "device_locked", message: "The phone screen is locked." }));
  await assert.rejects(run(ctx, `phone.activeWindow()`), (e) => e.code === "device_locked" && /unlock the phone/i.test(e.message));
});

test("text() uses computerUseAccessibilityText when the companion offers it, else falls back to elements", async () => {
  const names = ["worker_0_computerUseAccessibilityElements", "worker_0_computerUseAccessibilityText"];
  const a = makeCtx((tool) => (tool === "computerUseAccessibilityText" ? wrap({ snapshotId: "s", package: "p", title: "t", truncated: false, total: 2, text: "Today\n9:00 Standup" }) : "{}"), names);
  assert.equal(await run(a.ctx, `phone.text({ expectedPackage: "p" })`), "Today\n9:00 Standup");
  assert.equal(a.calls[0].name, "worker_0_computerUseAccessibilityText");
  assert.equal(a.calls[0].args.expectedPackage, "p");
  const b = makeCtx(() => wrap({ snapshotId: "s", package: "p", windowId: 1, title: "", truncated: false, elements: [el("a", "One"), el("b", "Two")] }));
  assert.equal(await run(b.ctx, `phone.text()`), "One\nTwo");
});

test("approval-pending markers throw code=approval_pending", async () => {
  const { ctx } = makeCtx(() => "[[KNOWHOW_WAIT:abc]]");
  await assert.rejects(run(ctx, `phone.launch("com.x")`), (e) => e.code === "approval_pending");
});

test("tapByText clicks via accessibility action, falls back to coordinates, and reports visible text when not found", async () => {
  const snap = { snapshotId: "s9", package: "p", windowId: 1, title: "", truncated: false, elements: [el("e1", "Open now"), el("e2", "Closed", { actions: [], flags: { clickable: false, visible: true, editable: false, password: false, focused: false, scrollable: false }, bounds: [10, 20, 30, 60] })] };
  const { ctx, calls } = makeCtx((tool) => (tool === "computerUseAccessibilityElements" ? wrap(snap) : JSON.stringify({ ok: true })));
  await run(ctx, `phone.tapByText("open now")`);
  const click = calls.find((c) => c.name.endsWith("PerformAccessibilityAction"));
  assert.deepEqual(JSON.parse(JSON.stringify(click.args)), { snapshotId: "s9", id: "e1", action: "click" });
  await run(ctx, `phone.tapByText(/^closed$/i)`);
  const at = calls.find((c) => c.name.endsWith("ClickAt"));
  assert.deepEqual(JSON.parse(JSON.stringify(at.args)), { x: 20, y: 40 });
  await assert.rejects(run(ctx, `phone.tapByText("nope")`), (e) => e.code === "not_found" && /Open now/.test(e.message));
});

test("scrollCollect gathers unique labels across scrolls and stops when nothing new appears", async () => {
  const pages = [["A", "B"], ["B", "C"], ["C"]];
  let page = 0;
  const { ctx, calls } = makeCtx((tool) => {
    if (tool === "computerUseScroll") { page++; return JSON.stringify({ ok: true }); }
    return wrap({ snapshotId: "s" + page, package: "p", windowId: 1, title: "", truncated: false, elements: pages[Math.min(page, 2)].map((t, i) => el("i" + i, t)) });
  });
  const out = await run(ctx, `phone.scrollCollect({ maxScrolls: 5 })`);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), ["A", "B", "C"]);
  assert.ok(calls.filter((c) => c.name.endsWith("Scroll")).length <= 3);
});

test("waitForText uses the on-device poll for string matchers and throws timeout otherwise", async () => {
  const snap = { snapshotId: "s", package: "p", windowId: 1, title: "", truncated: false, elements: [el("a", "Events")] };
  let found = true;
  const { ctx, calls } = makeCtx((tool) => (tool === "phone_wait_for" ? JSON.stringify({ found }) : wrap(snap)));
  const e = await run(ctx, `phone.waitForText("events")`);
  assert.equal(e.text, "Events");
  assert.equal(calls[0].name, "worker_0_phone_wait_for");
  found = false;
  await assert.rejects(run(ctx, `phone.waitForText("zzz")`), (err) => err.code === "timeout");
});

test("browser.* routes to the app worker; missing workers give a clear error", async () => {
  const { ctx, calls } = makeCtx(() => JSON.stringify({ ok: true }));
  await run(ctx, `phone.browser.navigate("https://x.test")`);
  assert.equal(calls[0].name, "worker_1_browser_navigate");
  assert.deepEqual(JSON.parse(JSON.stringify(run(ctx, `phone.available()`))), { companion: true, browser: true });
  const none = makeCtx(() => "{}", []);
  await assert.rejects(run(none.ctx, `phone.texts()`), (e) => e.code === "no_phone_worker");
});

test("type() requires expectedPackage", async () => {
  const { ctx } = makeCtx(() => JSON.stringify({ ok: true }));
  await assert.rejects(run(ctx, `phone.type("hi")`), (e) => e.code === "bad_args");
});

test("typeDefs include the phone global", () => {
  const defs = generateScriptTypeDefs([]);
  assert.match(defs, /declare const phone:/);
  assert.ok(PHONE_HELPERS_TYPEDEFS.length > 10);
});
