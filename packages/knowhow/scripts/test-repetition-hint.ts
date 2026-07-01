#!/usr/bin/env ts-node
/**
 * Test script: runs the repetition hint processor logic against a real agent metadata file
 * and prints whether the hint would fire and why/why not, with token savings estimates.
 *
 * Usage:
 *   npx ts-node scripts/test-repetition-hint.ts [path-to-metadata.json]
 */

import * as fs from "fs";

const metadataPath =
  process.argv[2] ||
  "/Users/micah/dev/knowhow-web/.knowhow/processes/agents/1779684572-can-you-try-setting-mysql-postgres-this-sandbox-with/metadata.json";

interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string | Record<string, any>;
  };
}

interface Message {
  role: string;
  content?: string;
  tool_calls?: ToolCall[];
}

// ---- Replica of processor logic (mirrors CustomVariables.ts) ----

function extractStringValues(obj: any, results: string[] = []): string[] {
  if (typeof obj === "string") {
    results.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) extractStringValues(item, results);
  } else if (obj && typeof obj === "object") {
    for (const val of Object.values(obj)) extractStringValues(val, results);
  }
  return results;
}

function getToolCallStrings(toolCall: ToolCall): string[] {
  try {
    const args = toolCall.function.arguments;
    const parsed = typeof args === "string" ? JSON.parse(args) : args;
    return extractStringValues(parsed);
  } catch {
    const args = toolCall.function.arguments;
    return [typeof args === "string" ? args : JSON.stringify(args)];
  }
}

function collectToolCallStrings(
  messages: Message[],
  minLength: number
): Array<{ value: string; toolName: string }> {
  const collected: Array<{ value: string; toolName: string }> = [];
  for (const message of messages) {
    if (!message.tool_calls) continue;
    for (const toolCall of message.tool_calls) {
      const strings = getToolCallStrings(toolCall);
      for (const str of strings) {
        if (str.length >= minLength) {
          collected.push({ value: str, toolName: toolCall.function.name });
        }
      }
    }
  }
  return collected;
}

function longestCommonSubstring(a: string, b: string, minLength: number): string | null {
  let best = "";
  for (let i = 0; i < a.length - minLength + 1; i++) {
    for (let j = a.length; j > i + minLength - 1; j--) {
      const sub = a.slice(i, j);
      if (sub.length <= best.length) break;
      if (b.includes(sub)) {
        best = sub;
        break;
      }
    }
  }
  return best.length >= minLength ? best : null;
}

interface ProcessorResult {
  wouldHint: boolean;
  repeatedTools: string[];
  details: Map<string, { count: number; tools: Set<string> }>;
}

function runProcessor(
  messages: Message[],
  minLength = 50,
  minRepetitions = 2,
  minSubstringLength = 50
): ProcessorResult {
  const stringCounts = new Map<string, { count: number; tools: Set<string> }>();
  const toolStrings = collectToolCallStrings(messages, minLength);

  // Step 1: exact full-string matches
  for (const { value, toolName } of toolStrings) {
    const existing = stringCounts.get(value);
    if (existing) {
      existing.count++;
      existing.tools.add(toolName);
    } else {
      stringCounts.set(value, { count: 1, tools: new Set([toolName]) });
    }
  }

  // Step 2: repeated substrings across different full strings
  const substringCounts = new Map<string, { count: number; tools: Set<string> }>();
  for (let i = 0; i < toolStrings.length; i++) {
    for (let j = i + 1; j < toolStrings.length; j++) {
      const a = toolStrings[i];
      const b = toolStrings[j];
      if (a.value === b.value) continue;
      const common = longestCommonSubstring(a.value, b.value, minSubstringLength);
      if (common) {
        const existing = substringCounts.get(common);
        if (existing) {
          existing.count++;
          existing.tools.add(a.toolName);
          existing.tools.add(b.toolName);
        } else {
          substringCounts.set(common, { count: 1, tools: new Set([a.toolName, b.toolName]) });
        }
      }
    }
  }

  // Merge substring counts
  for (const [sub, info] of substringCounts.entries()) {
    if (info.count + 1 >= minRepetitions && !stringCounts.has(sub)) {
      stringCounts.set(sub, { count: info.count + 1, tools: info.tools });
    }
  }

  // Find entries that exceed the repetition threshold
  const repeatedTools: string[] = [];
  for (const [, info] of stringCounts.entries()) {
    if (info.count >= minRepetitions) {
      for (const toolName of info.tools) {
        if (!repeatedTools.includes(toolName)) repeatedTools.push(toolName);
      }
    }
  }

  return { wouldHint: repeatedTools.length > 0, repeatedTools, details: stringCounts };
}

/**
 * Estimate tokens saved by using variables for repeated strings.
 * Savings = (repetitions - 1) * str.length chars / 4 chars-per-token
 * Minus the cost of the reminder message itself (estimated tokens in hint message).
 */
function estimateNetTokenSavings(
  details: Map<string, { count: number; tools: Set<string> }>,
  hintMessageTokens: number
): { gross: number; net: number } {
  let totalCharsSaved = 0;
  for (const [str, info] of details.entries()) {
    if (info.count >= 2) {
      totalCharsSaved += (info.count - 1) * str.length;
    }
  }
  const gross = Math.round(totalCharsSaved / 4);
  const net = gross - hintMessageTokens;
  return { gross, net };
}

// ---- Main ----

const raw = fs.readFileSync(metadataPath, "utf-8");
const metadata = JSON.parse(raw);
const threads: Message[][] = metadata.threads || [];

console.log(`\n=== Repetition Hint Processor Test ===`);
console.log(`File: ${metadataPath}`);
console.log(`Threads: ${threads.length}`);

// Approximate tokens in the hint message itself (the reminder we send to the agent)
// ~100 tokens for the base message + ~30 per example
const HINT_BASE_TOKENS = 100;
const HINT_TOKENS_PER_EXAMPLE = 30;
const MAX_EXAMPLES = 3;
const HINT_MESSAGE_TOKENS = HINT_BASE_TOKENS + MAX_EXAMPLES * HINT_TOKENS_PER_EXAMPLE;

for (let ti = 0; ti < threads.length; ti++) {
  const thread = threads[ti];
  const toolCallMsgs = thread.filter((m) => m.tool_calls && m.tool_calls.length > 0);
  console.log(`\n--- Thread ${ti}: ${thread.length} messages, ${toolCallMsgs.length} with tool calls ---`);

  // Run with OLD logic (exact matches only)
  console.log(`\n[OLD Processor] exact full-string matches only, minLength=50, minRepetitions=2`);
  const oldResult = runProcessor(thread, 50, 2, Infinity);
  if (oldResult.wouldHint) {
    console.log(`✅ Would hint! Repeated tools: ${oldResult.repeatedTools.join(", ")}`);
  } else {
    console.log(`❌ Would NOT hint (bug - missed embedded repetitions).`);
  }

  // Run with NEW logic (exact + substring)
  console.log(`\n[NEW Processor] exact + substring matching, minLength=50, minRepetitions=2, minSubstringLength=50`);
  const newResult = runProcessor(thread, 50, 2, 50);
  if (newResult.wouldHint) {
    console.log(`✅ Would hint! Repeated tools: ${newResult.repeatedTools.join(", ")}`);

    const { gross, net } = estimateNetTokenSavings(newResult.details, HINT_MESSAGE_TOKENS);
    console.log(`\n  💰 Token savings estimate:`);
    console.log(`     Gross savings (repeated chars ÷ 4)  : ~${gross} tokens`);
    console.log(`     Cost of reminder message            : ~${HINT_MESSAGE_TOKENS} tokens`);
    console.log(`     Net savings                         : ~${net} tokens`);

    // Sort by impact (count * length) descending
    const repeated = Array.from(newResult.details.entries())
      .filter(([, info]) => info.count >= 2)
      .sort((a, b) => (b[1].count * b[0].length) - (a[1].count * a[0].length))
      .slice(0, 5);

    console.log(`\n  Top repeated values to store as variables (sorted by token impact):`);
    repeated.forEach(([str, info], i) => {
      const charsSaved = (info.count - 1) * str.length;
      const toksSaved = Math.round(charsSaved / 4);
      const preview = str.trim().slice(0, 80).replace(/\s+/g, " ");
      const ellipsis = str.length > 80 ? "…" : "";
      console.log(`\n  [var${i + 1}]`);
      console.log(`    count    : ${info.count}x`);
      console.log(`    tools    : ${[...info.tools].join(", ")}`);
      console.log(`    ~savings : ${toksSaved} tokens (${charsSaved} chars)`);
      console.log(`    value    : "${preview}${ellipsis}"`);
      if (str.length > 80) {
        console.log(`    (full len: ${str.length} chars)`);
      }
    });

    // Show what the actual hint message would look like
    const examples = repeated.slice(0, MAX_EXAMPLES).map(([str, info], i) => {
      const preview = str.trim().slice(0, 80).replace(/\s+/g, " ");
      const ellipsis = str.length > 80 ? "…" : "";
      const toksSaved = Math.round(((info.count - 1) * str.length) / 4);
      return `  • \`var${i + 1}\` (used ${info.count}x in ${[...info.tools].join(", ")}, ~${toksSaved} tokens saveable): "${preview}${ellipsis}"`;
    });
    console.log(`\n  Example hint message that would be shown to the agent:`);
    console.log(`  ---`);
    console.log(
      `  ⚠️ Tool inputs have large repetitions detected in: ${newResult.repeatedTools.join(", ")} ` +
      `(~${gross} output tokens could be saved, ~${net} net after this reminder).\n` +
      `  Consider storing repeated values with \`setVariable\` or \`storeToolCallToVariable\`,\n` +
      `  then reference them via {{variableName}} in future tool calls.\n` +
      `  Top repeated values to consider storing as variables:\n` +
      examples.join("\n")
    );
    console.log(`  ---`);
  } else {
    console.log(`❌ Would NOT hint.`);
    const toolStrings = collectToolCallStrings(thread, 50);
    console.log(`\n  Total large strings in tool calls: ${toolStrings.length}`);
    const top = toolStrings.slice(0, 3);
    for (const { value, toolName } of top) {
      console.log(`    tool=${toolName}, len=${value.length}, preview=${JSON.stringify(value.slice(0, 100))}`);
    }
  }

  // Check for Bearer tokens specifically
  console.log(`\n[Bearer Token Check]`);
  const jwtMap = new Map<string, { count: number; tools: Set<string> }>();
  const jwtPattern = /Bearer ([\w\-\.]+)/;
  for (const msg of thread) {
    if (!msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      const args = typeof tc.function.arguments === "string"
        ? tc.function.arguments
        : JSON.stringify(tc.function.arguments);
      const match = jwtPattern.exec(args);
      if (match) {
        const jwt = match[1];
        const existing = jwtMap.get(jwt);
        if (existing) {
          existing.count++;
          existing.tools.add(tc.function.name);
        } else {
          jwtMap.set(jwt, { count: 1, tools: new Set([tc.function.name]) });
        }
      }
    }
  }
  if (jwtMap.size > 0) {
    for (const [jwt, info] of jwtMap.entries()) {
      console.log(`  ⚠️  Bearer token appears ${info.count} times in: ${[...info.tools].join(", ")}`);
      console.log(`     ${jwt.slice(0, 80)}...`);
    }
  } else {
    console.log(`  No Bearer tokens found in tool calls.`);
  }
}

console.log("\n=== Done ===\n");
