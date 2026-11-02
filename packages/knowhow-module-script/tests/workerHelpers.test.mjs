import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { WORKER_HELPERS_JS, WORKER_HELPERS_TYPEDEFS } from "../ts_build/workerHelpers.js";
import { generateScriptTypeDefs } from "../ts_build/typeDefs.js";

function makeCtx(handler) {
  const calls = [];
  const ctx = vm.createContext({
    callTool: async (name, args) => {
      calls.push({ name, args });
      return handler(name, args);
    },
  });
  ctx.globalThis = ctx;
  vm.runInContext(WORKER_HELPERS_JS, ctx);
  return { ctx, calls };
}

const run = (ctx, code) => vm.runInContext(code, ctx);

test("workers.* parse JSON-string tool results and pass args", async () => {
  const { ctx, calls } = makeCtx((name) => {
    if (name === "workerExec") return JSON.stringify({ worker: "w", stdout: "hi", stderr: "", exitCode: 0 });
    if (name === "forkCloudWorker") return { functionResp: JSON.stringify({ sandboxId: "sb", workerId: "w1" }) };
    return "[]";
  });
  const r = await run(ctx, `workers.exec("w", "echo hi", 1000)`);
  assert.equal(r.stdout, "hi");
  const f = await run(ctx, `workers.fork("snap1", { name: "x" })`);
  assert.equal(f.sandboxId, "sb");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { name: "workerExec", args: { worker: "w", command: "echo hi", timeoutMs: 1000 } });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), { name: "forkCloudWorker", args: { name: "x", snapshotId: "snap1" } });
});

test("{error} results throw", async () => {
  const { ctx } = makeCtx(() => JSON.stringify({ error: "nope" }));
  await assert.rejects(run(ctx, `workers.destroy("sb")`), /destroyForkedSandbox: nope/);
});

test("remoteAgent waits for completion and returns taskId + finalAnswer", async () => {
  const { ctx, calls } = makeCtx(() => ({
    success: true, status: "completed", taskId: "t", remoteTaskId: "t-remote", finalAnswer: "42", workerName: "w",
  }));
  const r = await run(ctx, `remoteAgent({ worker: "w", prompt: "p" })`);
  assert.equal(r.taskId, "t-remote");
  assert.equal(r.finalAnswer, "42");
  assert.equal(calls[0].name, "startAgentTask");
  assert.equal(calls[0].args.waitForCompletion, true);
  await assert.rejects(run(ctx, `remoteAgent({ prompt: "p" })`), /worker is required/);
});

test("typeDefs include workers + remoteAgent", () => {
  const defs = generateScriptTypeDefs([]);
  assert.match(defs, /declare const workers:/);
  assert.match(defs, /declare function remoteAgent/);
  assert.ok(WORKER_HELPERS_TYPEDEFS.length > 5);
});

test("workers.fork passes resources + checkout; workers.checkout resolves targets", async () => {
  const { ctx, calls } = makeCtx((name) => {
    if (name === "forkCloudWorker") return JSON.stringify({ sandboxId: "sb1", workerId: "w1", name: "n", memoryMb: 4096, cpuCount: 2, checkout: { cwd: "/work/repo" } });
    if (name === "checkoutCloudWorker") return JSON.stringify({ checkoutId: "c1", sandboxId: "sb1", cwd: "/work/repo", commitSha: "a".repeat(40), branch: "b", verified: true });
    return "{}";
  });
  const f = await run(ctx, `workers.fork("snap", { memoryMb: 4096, cpuCount: 2, checkout: { taskId: "current" } })`);
  assert.equal(f.checkout.cwd, "/work/repo");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args)), { memoryMb: 4096, cpuCount: 2, checkout: { taskId: "current" }, snapshotId: "snap" });

  // fork/start result -> sandboxId, string -> cloudWorker, { cloudWorkerId } -> cloudWorker
  await run(ctx, `workers.checkout({ sandboxId: "sb1", workerId: "w1" }, { branch: "main" })`);
  await run(ctx, `workers.checkout("Knowhow-web", { commitSha: "${"a".repeat(40)}" })`);
  await run(ctx, `workers.checkout({ cloudWorkerId: "cw1" }, { taskId: "current", pushSnapshot: true })`);
  const c = calls.slice(1).map((x) => JSON.parse(JSON.stringify(x)));
  assert.deepEqual(c[0], { name: "checkoutCloudWorker", args: { branch: "main", sandboxId: "sb1" } });
  assert.deepEqual(c[1].args, { commitSha: "a".repeat(40), cloudWorker: "Knowhow-web" });
  assert.deepEqual(c[2].args, { taskId: "current", pushSnapshot: true, cloudWorker: "cw1" });
  await assert.rejects(run(ctx, `workers.checkout({}, { branch: "x" })`), /target must be/);
});

test("stopCloud / destroy / list return the tool shapes; checkout {error} throws", async () => {
  const { ctx } = makeCtx((name) => {
    if (name === "stopCloudWorker") return JSON.stringify({ stopped: true, cloudWorker: "kw" });
    if (name === "destroyForkedSandbox") return JSON.stringify({ destroyed: true, sandboxId: "sb" });
    if (name === "listWorkers") return JSON.stringify([{ id: "w", name: "h", os: "posix", root: "/r", connected: true, status: "online", shared: false, cloudWorkerId: null, lastConnected: "x" }]);
    if (name === "checkoutCloudWorker") return JSON.stringify({ error: "Checkout c failed: boom\n--- log tail ---\nx" });
    return "{}";
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await run(ctx, `workers.stopCloud("kw")`))), { stopped: true, cloudWorker: "kw" });
  assert.deepEqual(JSON.parse(JSON.stringify(await run(ctx, `workers.destroy("sb")`))), { destroyed: true, sandboxId: "sb" });
  const l = await run(ctx, `workers.list()`);
  assert.equal(l[0].status, "online");
  await assert.rejects(run(ctx, `workers.checkout("kw", { branch: "main" })`), /checkoutCloudWorker: Checkout c failed: boom/);
});

test("remoteAgent: cwd becomes a prompt instruction; failed agent resolves instead of throwing", async () => {
  const { ctx, calls } = makeCtx(() => ({
    success: false, status: "failed", taskId: "t", remoteTaskId: "tr", error: "agent crashed", workerName: "w",
  }));
  const r = await run(ctx, `remoteAgent({ worker: "w", prompt: "do it", cwd: "/work/repo" })`);
  assert.equal(r.status, "failed");
  assert.equal(r.error, "agent crashed");
  assert.equal(r.taskId, "tr");
  assert.equal(calls[0].args.cwd, undefined);
  assert.match(calls[0].args.prompt, /^Your working directory for this task is \/work\/repo\./);
  assert.match(calls[0].args.prompt, /\n\ndo it$/);

  const { ctx: ctx2 } = makeCtx(() => JSON.stringify({ error: "no such worker" }));
  await assert.rejects(run(ctx2, `remoteAgent({ worker: "w", prompt: "p" })`), /startAgentTask: no such worker/);
});

test("typeDefs describe the real return shapes", () => {
  const defs = WORKER_HELPERS_TYPEDEFS.join("\n");
  assert.match(defs, /stopCloud\(.*Promise<\{ stopped: boolean; cloudWorker: string \}>/);
  assert.match(defs, /destroy\(.*Promise<\{ destroyed: boolean; sandboxId: string \}>/);
  assert.match(defs, /declare interface WorkerSummary/);
  assert.match(defs, /fork\(.*memoryMb\?: number.*checkout\?: CheckoutSpec.*Promise<ForkResult>/);
  assert.match(defs, /checkout\(target:/);
  assert.match(defs, /cwd\?: string/);
});
