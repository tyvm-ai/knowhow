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
