#!/usr/bin/env ts-node
/**
 * Test script: runs the repetition hint processor logic against a real agent metadata file
 * and prints whether the hint would fire and why/why not.
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
      if (sub.length <= best.length) break; // already found longer, skip shorter
      if (b.includes(sub)) {
        best = sub;
        break;
      }
    }
  }
  return best.length >= minLength ? best : null;
}

function runProcessor(
  messages: Message[],
  minLength = 50,
  minRepetitions = 2,
  minSubstringLength = 50
): { wouldHint: boolean; repeatedTools: string[]; details: Map<string, { count: number; tools: Set<string> }> } {
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
  // e.g. the same JWT embedded in many different commands
  const substringCounts = new Map<string, { count: number; tools: Set<string> }>();
  for (let i = 0; i < toolStrings.length; i++) {
    for (let j = i + 1; j < toolStrings.length; j++) {
      const a = toolStrings[i];
      const b = toolStrings[j];
      if (a.value === b.value) continue; // already handled by exact match
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

  // Merge substring counts: count = number of unique pairs, count+1 = number of occurrences
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

// ---- Main ----

const raw = fs.readFileSync(metadataPath, "utf-8");
const metadata = JSON.parse(raw);
const threads: Message[][] = metadata.threads || [];

console.log(`\n=== Repetition Hint Processor Test ===`);
console.log(`File: ${metadataPath}`);
console.log(`Threads: ${threads.length}`);

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
    // Show top repeated substrings
    const repeated = Array.from(newResult.details.entries())
      .filter(([, info]) => info.count >= 2)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5);
    console.log(`\n  Top repeated values (count, tools, preview):`);
    for (const [str, info] of repeated) {
      console.log(`    count=${info.count}, tools=${[...info.tools].join(",")}`);
      console.log(`    value=${JSON.stringify(str.slice(0, 120))}`);
    }
  } else {
    console.log(`❌ Would NOT hint.`);
    // Show top large strings for diagnosis
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
