/**
 * Per-call sleep cap (maxSleepMs quota > KNOWHOW_SCRIPT_MAX_SLEEP_MS > 2000).
 * Run: npm test (compiles to ts_build first).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveMaxSleepMs, DEFAULT_MAX_SLEEP_MS } from "../ts_build/SandboxContext.js";

describe("resolveMaxSleepMs", () => {
  test("defaults to 2000ms", () => {
    const prev = process.env.KNOWHOW_SCRIPT_MAX_SLEEP_MS;
    delete process.env.KNOWHOW_SCRIPT_MAX_SLEEP_MS;
    try {
      assert.equal(DEFAULT_MAX_SLEEP_MS, 2000);
      assert.equal(resolveMaxSleepMs(), 2000);
      assert.equal(resolveMaxSleepMs({}), 2000);
    } finally {
      if (prev !== undefined) process.env.KNOWHOW_SCRIPT_MAX_SLEEP_MS = prev;
    }
  });

  test("env var raises the default, quota wins over env", () => {
    const prev = process.env.KNOWHOW_SCRIPT_MAX_SLEEP_MS;
    process.env.KNOWHOW_SCRIPT_MAX_SLEEP_MS = "60000";
    try {
      assert.equal(resolveMaxSleepMs({}), 60000);
      assert.equal(resolveMaxSleepMs({ maxSleepMs: 500 }), 500);
    } finally {
      if (prev === undefined) delete process.env.KNOWHOW_SCRIPT_MAX_SLEEP_MS;
      else process.env.KNOWHOW_SCRIPT_MAX_SLEEP_MS = prev;
    }
  });

  test("ignores invalid env values", () => {
    const prev = process.env.KNOWHOW_SCRIPT_MAX_SLEEP_MS;
    process.env.KNOWHOW_SCRIPT_MAX_SLEEP_MS = "nope";
    try {
      assert.equal(resolveMaxSleepMs({}), 2000);
    } finally {
      if (prev === undefined) delete process.env.KNOWHOW_SCRIPT_MAX_SLEEP_MS;
      else process.env.KNOWHOW_SCRIPT_MAX_SLEEP_MS = prev;
    }
  });
});
