/**
 * Price-aware compaction threshold and pre-cache-expiry compaction.
 */
import { BaseAgent } from "../../src/agents/base/base";
import { ToolsService } from "../../src/services/Tools";
import { Message } from "../../src/clients/types";
import {
  cacheExpiryCheckDelayMs,
  chooseLongTtlSwitch,
  getContextPrices,
  getPromptCacheInfo,
  optimalCompactionThreshold,
  promptCacheTtlMs,
  shouldCompactBeforeCacheExpiry,
  usesLongTtlCache,
} from "../../src/agents/base/compactionPolicy";

class TestAgent extends BaseAgent {
  name = "TestAgent";
  description = "test";
  async getInitialMessages(): Promise<any[]> {
    return [];
  }
}

const sent: Message[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "task" },
  { role: "assistant", content: "", tool_calls: [] },
  { role: "tool", tool_call_id: "1", content: "result" },
];

function setup(model = "claude-fable-5-2") {
  const events: any = { setListener: () => {}, emit: () => {}, on: () => {} };
  const agent = new TestAgent({ Tools: new ToolsService(), Events: events } as any);
  agent.setModel(model);
  agent.setProvider((model.startsWith("claude") ? "anthropic" : "openai") as any);
  agent.newTask("t1");
  const a = agent as any;
  a.lastPromptTokens = 266_000;
  a.threadStartPromptTokens = 16_000;
  a.threadRequestCount = 50;
  const start = jest
    .spyOn(a, "startBackgroundCompaction")
    .mockImplementation(() => undefined);
  return { agent, a, start };
}

describe("compaction policy", () => {
  it("puts the Fable 5.2 optimum near 150k and standard Claude near 90k", () => {
    const fable = getContextPrices("claude-fable-5-2")!;
    const sonnet = getContextPrices("anthropic/claude-sonnet-4-6")!;
    const at = (prices: any) =>
      optimalCompactionThreshold({ prices, baseTokens: 20_000, growthPerRequest: 5_000 });
    expect(at(fable)).toBeGreaterThan(140_000);
    expect(at(fable)).toBeLessThan(160_000);
    expect(at(sonnet)).toBeGreaterThan(75_000);
    expect(at(sonnet)).toBeLessThan(100_000);
  });

  it("only compacts before expiry when it beats the cache miss", () => {
    const prices = getContextPrices("claude-fable-5-2")!;
    const decide = (contextTokens: number) =>
      shouldCompactBeforeCacheExpiry({
        prices,
        contextTokens,
        baseTokens: 20_000,
        compactionCalls: 2,
        longTtl: true,
      });
    expect(decide(266_000)).toBe(true);
    expect(decide(30_000)).toBe(false);
  });

  it("takes cache lifetimes from the model catalog", () => {
    const claude = getPromptCacheInfo("claude-fable-5-2");
    expect(promptCacheTtlMs(claude, false)).toBe(300_000);
    expect(promptCacheTtlMs(claude, true)).toBe(3_600_000);
    expect(usesLongTtlCache(300_000, claude)).toBe(false);
    expect(usesLongTtlCache(300_001, claude)).toBe(true);

    // GPT-5.6+: guaranteed 30m, agents never move to 12h.
    const gpt56 = getPromptCacheInfo("gpt-5.6-terra");
    expect(promptCacheTtlMs(gpt56, false)).toBe(30 * 60_000);
    expect(promptCacheTtlMs(gpt56, true)).toBe(30 * 60_000);
    expect(usesLongTtlCache(3_600_000, gpt56)).toBe(false);

    // Best-effort caches have no lifetime to plan around.
    for (const model of ["gpt-5.4", "gemini-2.5-flash", "grok-4.3"]) {
      expect(promptCacheTtlMs(getPromptCacheInfo(model), false)).toBeUndefined();
    }
    // Other hosts never get explicit TTLs; the knowhow proxy forwards them.
    expect(getPromptCacheInfo("claude-fable-5-2", "openrouter")?.mode).toBe("automatic");
    expect(getPromptCacheInfo("anthropic/claude-fable-5-2", "knowhow")?.mode).toBe("explicit");

    expect(cacheExpiryCheckDelayMs(3_600_000)).toBe(51 * 60_000);
    expect(cacheExpiryCheckDelayMs(300_000)).toBe(3 * 60_000);
  });

  it("prices long-TTL writes from the catalog multipliers", () => {
    const fable = getContextPrices("claude-fable-5-2")!;
    expect(fable.write * 1e6).toBeCloseTo(10); // 5m: 1.25 × $8
    expect(fable.writeLong * 1e6).toBeCloseTo(16); // 1h: 2 × $8
    const terra = getContextPrices("gpt-5.6-terra")!;
    expect(terra.write * 1e6).toBeCloseTo(2.5);
    expect(terra.writeLong).toBe(terra.write);
  });

  it("moves to the long TTL by compacting only when that beats a re-write", () => {
    const prices = getContextPrices("claude-fable-5-2")!;
    const decide = (contextTokens: number) =>
      chooseLongTtlSwitch({ prices, contextTokens, baseTokens: 20_000, compactionCalls: 2 });
    expect(decide(150_000)).toBe("compact");
    expect(decide(35_000)).toBe("switch");
  });
});

describe("BaseAgent compaction", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("uses the price-aware threshold instead of 70% of a 1M window", () => {
    const { agent, a } = setup();
    a.threadRequestCount = 0;
    expect(agent.getCompressThreshold()).toBe(700_000); // nothing measured yet
    a.threadRequestCount = 50;
    a.lastPromptTokens = 16_000 + 49 * 5_000;
    const threshold = agent.getCompressThreshold();
    expect(threshold).toBeGreaterThan(130_000);
    expect(threshold).toBeLessThan(180_000);
  });

  it("compacts on the warm cache shortly before it expires", () => {
    const { a, start } = setup();
    a.armCacheExpiryCheck(sent, true);
    jest.advanceTimersByTime(50 * 60_000);
    expect(start).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60_000);
    expect(start).toHaveBeenCalledWith(sent);
  });

  it.each([
    ["paused", (agent: BaseAgent) => agent.pause()],
    ["killed", (agent: BaseAgent) => agent.kill()],
    ["done", (agent: BaseAgent) => agent.agentEvents.emit("done", "x")],
  ])("never compacts when the agent is %s", async (_label, stop) => {
    const { agent, a, start } = setup();
    a.armCacheExpiryCheck(sent, true);
    await stop(agent);
    jest.advanceTimersByTime(2 * 60 * 60_000);
    expect(start).not.toHaveBeenCalled();
    // Even a check that fires anyway refuses to compact a stopped agent.
    if (_label !== "done") {
      expect(a.compactBeforeCacheExpiry(sent, true)).toBe(false);
    }
  });

  it("arms the expiry check only where the lifetime is guaranteed", () => {
    const terra = setup("gpt-5.6-terra");
    terra.a.armCacheExpiryCheck(sent, false);
    expect(terra.a._cacheExpiryTimer).not.toBeNull();
    jest.advanceTimersByTime(25 * 60_000);
    expect(terra.start).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60_000);
    expect(terra.start).toHaveBeenCalledWith(sent);

    const bestEffort = setup("gpt-5.4");
    bestEffort.a.armCacheExpiryCheck(sent, false);
    expect(bestEffort.a._cacheExpiryTimer).toBeNull();
  });

  it("keeps a thread's TTL; only new threads after 5 minutes start on 1h", () => {
    const { a } = setup();
    a.threadLongTtl = undefined;
    expect(a.useLongTtlCache()).toBe(false);
    a.threadLongTtl = false; // fixed by the thread's first request
    jest.advanceTimersByTime(5 * 60_000 + 1);
    expect(a.useLongTtlCache()).toBe(false);
    a.startNewThread([]);
    expect(a.useLongTtlCache()).toBe(true);

    const openai = setup("gpt-5.6-terra");
    jest.advanceTimersByTime(5 * 60_000 + 1);
    openai.a.startNewThread([]);
    expect(openai.a.useLongTtlCache()).toBe(false);
  });

  it("at the 5 minute mark compacts a big short-TTL thread on the warm cache", () => {
    const { a, start } = setup();
    a.threadLongTtl = false;
    expect(a.maybeSwitchToLongTtl(sent)).toBe(false); // not 5 minutes yet
    jest.advanceTimersByTime(5 * 60_000 + 1);
    expect(a.maybeSwitchToLongTtl(sent)).toBe(true);
    expect(start).toHaveBeenCalledWith(sent);
    expect(a.useLongTtlCache()).toBe(false); // compaction still reads the 5m cache
    // If that compaction never lands, the next turn switches in place.
    expect(a.maybeSwitchToLongTtl(sent)).toBe(false);
    expect(a.useLongTtlCache()).toBe(true);
  });

  it("at the 5 minute mark re-writes a small thread on 1h in place", () => {
    const { a, start } = setup();
    a.threadLongTtl = false;
    a.lastPromptTokens = 25_000;
    jest.advanceTimersByTime(5 * 60_000 + 1);
    expect(a.maybeSwitchToLongTtl(sent)).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(a.useLongTtlCache()).toBe(true);
  });

  it("skips small contexts and a new request", () => {
    const small = setup();
    small.a.lastPromptTokens = 30_000;
    small.a.armCacheExpiryCheck(sent, true);
    jest.advanceTimersByTime(60 * 60_000);
    expect(small.start).not.toHaveBeenCalled();

    const busy = setup();
    busy.a.armCacheExpiryCheck(sent, true);
    busy.a.clearCacheExpiryCheck(); // a new request refreshes the cache
    jest.advanceTimersByTime(60 * 60_000);
    expect(busy.start).not.toHaveBeenCalled();
  });
});
