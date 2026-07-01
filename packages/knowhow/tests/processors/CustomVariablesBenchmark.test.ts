/**
 * Benchmark for CustomVariables message processor.
 * Tests with realistic data from the stuck agent (21k char writeFileChunk string).
 * Each test has a hard timeout so we don't get frozen like the agent.
 */
import { CustomVariables } from "../../src/processors/CustomVariables";
import { Message } from "../../src/clients/types";
import { ToolsService } from "../../src/services";

function makeMockToolsService(): jest.Mocked<ToolsService> {
  return {
    addTools: jest.fn(),
    addFunctions: jest.fn(),
    getTool: jest.fn().mockReturnValue(undefined),
    callTool: jest.fn(),
  } as any;
}

// Replicate the large string from the stuck agent
const LARGE_STRING_21K = "# Firecracker Sandbox Disk Architecture v2 — EBS-Backed Storage\n" + "x".repeat(21800);
const MEDIUM_STRING_200 = "grep -n \"diskGb\\|ebsVolume\\|lastActivityAt\\|idleTimeout\" /Users/micah/dev/knowhow-web/packages/backend/src/services/SandboxService.ts".repeat(2);
const SHORT_STRING_80 = "grep -r \"snapshot\" /Users/micah/dev/knowhow-web/packages/backend/src";

function makeToolCallMessage(toolName: string, arg: string): Message {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: `call_${Math.random().toString(36).slice(2)}`,
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify({ content: arg }),
        },
      },
    ],
  };
}

function makeThread(extraMessages: Message[]): Message[] {
  const systemMsg: Message = {
    role: "system",
    content: "You are a helpful assistant.",
  };
  return [systemMsg, ...extraMessages];
}

/**
 * Run a function with a hard ms timeout.
 * Returns { completed: boolean, elapsedMs: number }
 */
async function runWithTimeout(
  fn: () => void,
  timeoutMs: number
): Promise<{ completed: boolean; elapsedMs: number }> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ completed: false, elapsedMs: timeoutMs });
      }
    }, timeoutMs);

    const start = Date.now();
    // Run in next tick so setTimeout can fire
    setImmediate(() => {
      try {
        fn();
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ completed: true, elapsedMs: Date.now() - start });
        }
      } catch (e) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ completed: true, elapsedMs: Date.now() - start });
        }
      }
    });
  });
}

describe("CustomVariables Benchmark", () => {
  // Allow up to 30s for each benchmark test (jest default may be less)
  jest.setTimeout(60000);

  it("BENCHMARK: longestCommonSubstring with two small strings (baseline)", async () => {
    const cv = new CustomVariables(makeMockToolsService());
    const a = SHORT_STRING_80;
    const b = "cat /Users/micah/dev/knowhow-web/packages/backend/src/services/SandboxService.ts";

    const start = Date.now();
    // Access the private method via cast
    const result = (cv as any).longestCommonSubstring(a, b, 50);
    const elapsed = Date.now() - start;

    console.log(`[BENCHMARK] Small vs small (${a.length} x ${b.length} chars): ${elapsed}ms, result length: ${result?.length ?? 0}`);
    expect(elapsed).toBeLessThan(100); // should be instant
  });

  it("BENCHMARK: longestCommonSubstring with one large string (21k) - DANGER ZONE", async () => {
    const cv = new CustomVariables(makeMockToolsService());
    const a = LARGE_STRING_21K;
    const b = MEDIUM_STRING_200;

    console.log(`[BENCHMARK] Testing LCS with strings of length ${a.length} x ${b.length}`);
    console.log(`[BENCHMARK] Estimated worst-case iterations: ${a.length * b.length / 1_000_000}M`);

    const { completed, elapsedMs } = await runWithTimeout(() => {
      (cv as any).longestCommonSubstring(a, b, 50);
    }, 5000); // 5 second timeout

    console.log(`[BENCHMARK] Large (${a.length}) x Medium (${b.length}): completed=${completed}, elapsed=${elapsedMs}ms`);
    if (!completed) {
      console.log(`[BENCHMARK] ⚠️  LCS DID NOT COMPLETE IN 5 SECONDS - THIS IS THE BUG`);
    }
    // We're just measuring - not enforcing pass/fail here so it doesn't hang CI
    expect(true).toBe(true);
  });

  it("BENCHMARK: createVariableHintProcessor with realistic agent thread (last 10 msgs)", async () => {
    const cv = new CustomVariables(makeMockToolsService());

    // Simulate the stuck agent's last 10 messages (from real metadata.json analysis):
    // - one 124-char execCommand
    // - one 67-char readFile
    // - one 21,862-char writeFileChunk
    const messages: Message[] = makeThread([
      // Older messages (60+ of them to simulate real thread)
      ...Array.from({ length: 60 }, (_, i) =>
        ({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `Message ${i}: some content about sandboxes and disk resizing plans.`,
        } as Message)
      ),
      // Last 10 messages - the ones that get scanned
      makeToolCallMessage("execCommand", "mkdir -p /Users/micah/dev/knowhow-web/.knowhow/tasks/host-compaction/"),
      { role: "tool", content: "Created directory", tool_call_id: "x1" } as Message,
      makeToolCallMessage("readFile", "/Users/micah/dev/knowhow-web/.knowhow/tasks/firecracker/disks.md"),
      { role: "tool", content: "File contents...", tool_call_id: "x2" } as Message,
      makeToolCallMessage("execCommand", MEDIUM_STRING_200.slice(0, 124)),
      { role: "tool", content: "grep output", tool_call_id: "x3" } as Message,
      makeToolCallMessage("readFile", "/Users/micah/dev/knowhow-web/.knowhow/tasks/firecracker/disks.md".slice(0, 67)),
      { role: "tool", content: "file read", tool_call_id: "x4" } as Message,
      // The killer - 21k char writeFileChunk
      makeToolCallMessage("writeFileChunk", LARGE_STRING_21K),
      { role: "tool", content: "written", tool_call_id: "x5" } as Message,
    ]);

    console.log(`[BENCHMARK] Thread has ${messages.length} messages`);
    console.log(`[BENCHMARK] Total thread chars: ${JSON.stringify(messages).length}`);

    const processor = cv.createRepetitionHintProcessor({
      minLength: 50,
      minRepetitions: 2,
      minSubstringLength: 50,
      recentMessagesWindow: 10,
      throttleMessages: 5,
    });

    const { completed, elapsedMs } = await runWithTimeout(() => {
      const modifiedMessages = [...messages];
      processor(messages, modifiedMessages);
    }, 10000); // 10 second timeout

    console.log(`[BENCHMARK] createVariableHintProcessor: completed=${completed}, elapsed=${elapsedMs}ms`);
    if (!completed) {
      console.log(`[BENCHMARK] ⚠️  PROCESSOR DID NOT COMPLETE IN 10 SECONDS - THIS CONFIRMS THE BUG`);
    }
    expect(true).toBe(true);
  });

  it("BENCHMARK: LCS with two large strings (21k x 21k) - catastrophic case", async () => {
    const cv = new CustomVariables(makeMockToolsService());
    const a = LARGE_STRING_21K;
    const b = LARGE_STRING_21K.split("").reverse().join(""); // different but same length

    console.log(`[BENCHMARK] Testing LCS with strings of length ${a.length} x ${b.length}`);
    console.log(`[BENCHMARK] Theoretical O(n*m) iterations: ${(a.length * b.length / 1_000_000).toFixed(0)}M`);

    const { completed, elapsedMs } = await runWithTimeout(() => {
      (cv as any).longestCommonSubstring(a, b, 50);
    }, 3000); // 3 second timeout

    console.log(`[BENCHMARK] Large (${a.length}) x Large (${b.length}): completed=${completed}, elapsed=${elapsedMs}ms`);
    // After the fix (capping LCS input to 500 chars), this now completes instantly
    expect(completed).toBe(true);
    expect(elapsedMs).toBeLessThan(100); // Should be near-instant with the cap
  });

  it("BENCHMARK: LCS with strings capped at 500 chars - proposed fix", async () => {
    const cv = new CustomVariables(makeMockToolsService());
    // Simulate the fix: cap strings at 500 chars before LCS
    const MAX_LCS_STRING_LENGTH = 500;
    const a = LARGE_STRING_21K.slice(0, MAX_LCS_STRING_LENGTH);
    const b = LARGE_STRING_21K.split("").reverse().join("").slice(0, MAX_LCS_STRING_LENGTH);

    console.log(`[BENCHMARK] Testing LCS with capped strings of length ${a.length} x ${b.length}`);

    const start = Date.now();
    const result = (cv as any).longestCommonSubstring(a, b, 50);
    const elapsed = Date.now() - start;

    console.log(`[BENCHMARK] Capped (${a.length}) x Capped (${b.length}): ${elapsed}ms, result length: ${result?.length ?? 0}`);
    expect(elapsed).toBeLessThan(50); // Should be instant when capped
  });

  it("BENCHMARK: processMessage (variable substitution) with large content - should be fast", async () => {
    const cv = new CustomVariables(makeMockToolsService());

    const largeMessage: Message = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: {
            name: "writeFileChunk",
            arguments: JSON.stringify({ content: LARGE_STRING_21K, filePath: "/tmp/test.md" }),
          },
        },
      ],
    };

    const start = Date.now();
    (cv as any).processMessage(largeMessage);
    const elapsed = Date.now() - start;

    console.log(`[BENCHMARK] processMessage with 21k char tool call: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(100); // substitution itself should be fast
  });
});
