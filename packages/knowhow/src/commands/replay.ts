import { Command } from "commander";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { KnowhowSimpleClient, KNOWHOW_API_URL } from "../services/KnowhowClient";
import { ToolCall } from "../clients/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReplayResult {
  toolName: string;
  toolId: string;
  status: "success" | "failed" | "skipped";
  error?: string;
  output?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Flatten all tool_use blocks from all threads in order */
function extractToolCalls(threads: any[][]): { toolCall: ToolCall; threadIdx: number; msgIdx: number }[] {
  const calls: { toolCall: ToolCall; threadIdx: number; msgIdx: number }[] = [];

  for (let ti = 0; ti < threads.length; ti++) {
    const thread = threads[ti];
    for (let mi = 0; mi < thread.length; mi++) {
      const msg = thread[mi];
      if (msg.role !== "assistant") continue;

      const content = msg.content;

      // Handle Anthropic-style: content is an array of blocks with type "tool_use"
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== "tool_use") continue;
          // Convert from Anthropic tool_use block to our ToolCall shape
          const toolCall: ToolCall = {
            id: block.id || `replay_${Date.now()}_${Math.random()}`,
            type: "function",
            function: {
              name: block.name,
              arguments:
                typeof block.input === "string"
                  ? block.input
                  : JSON.stringify(block.input ?? {}),
            },
          };
          calls.push({ toolCall, threadIdx: ti, msgIdx: mi });
        }
      }

      // Handle OpenAI-style: tool_calls array on the message (content may be a string)
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          calls.push({ toolCall: tc, threadIdx: ti, msgIdx: mi });
        }
      }
    }
  }

  return calls;
}

/** Fetch threads by taskId (direct task) */
async function fetchThreadsByTaskId(
  client: KnowhowSimpleClient,
  taskId: string
): Promise<any[][]> {
  return client.getTaskThreads(taskId);
}

/** Fetch threads from a session's messages and find the task embedded within */
async function fetchThreadsBySessionMessage(
  client: KnowhowSimpleClient,
  sessionId: string,
  messageId: string
): Promise<any[][]> {
  // GET /api/chat/sessions/:sessionId/messages
  const baseUrl = (client as any).baseUrl || KNOWHOW_API_URL;
  const headers = (client as any).headers || {};

  const resp = await fetch(`${baseUrl}/api/chat/sessions/${sessionId}/messages`, {
    headers,
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch session messages: ${resp.status} ${resp.statusText}`);
  }

  const messages: any[] = await resp.json();

  // Find the message with our target messageId
  let targetMsg = messages.find((m: any) => m.id === messageId);
  if (!targetMsg) {
    // messageId might be on a task inside an assistant message
    for (const m of messages) {
      if (m.tasks) {
        for (const task of m.tasks) {
          if (task.id === messageId) {
            targetMsg = m;
            break;
          }
        }
      }
      if (targetMsg) break;
    }
  }

  if (!targetMsg) {
    throw new Error(`Message ${messageId} not found in session ${sessionId}`);
  }

  // Extract threads - they may be directly on a task inside the message
  if (targetMsg.tasks && targetMsg.tasks.length > 0) {
    // Find task that contains our messageId, or use first task
    let task = targetMsg.tasks.find((t: any) => t.id === messageId);
    if (!task) task = targetMsg.tasks[0];

    if (task.threads && Array.isArray(task.threads)) {
      return task.threads;
    }

    // If task has an id but no inline threads, fetch via task API
    if (task.id) {
      return client.getTaskThreads(task.id);
    }
  }

  // Fallback: if threads are directly on the message
  if (targetMsg.threads) return targetMsg.threads;

  throw new Error(`No threads found for message ${messageId}`);
}

/** Prompt user for approval (y/n/s for skip/q for quit) */
async function promptApproval(toolName: string, args: string): Promise<"run" | "skip" | "quit"> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const preview = args.length > 200 ? args.slice(0, 200) + "…" : args;
    rl.question(
      `\n🔧 Tool: ${toolName}\n   Args: ${preview}\n   Run this? [y/n/q] (y=run, n=skip, q=quit): `,
      (answer) => {
        rl.close();
        const a = answer.trim().toLowerCase();
        if (a === "q" || a === "quit") resolve("quit");
        else if (a === "n" || a === "skip" || a === "s") resolve("skip");
        else resolve("run");
      }
    );
  });
}

/**
 * Parse --replace-path options like "/workspace/repo:./" into a list of [from, to] pairs.
 * Multiple --replace-path flags are supported.
 */
function parseReplacePaths(replacePaths: string[]): Array<[string, string]> {
  return replacePaths.map((rp) => {
    const colonIdx = rp.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(`Invalid --replace-path value "${rp}": expected format "from:to" (e.g. /workspace/repo:./)`);
    }
    const from = rp.slice(0, colonIdx);
    const to = rp.slice(colonIdx + 1);
    return [from, to];
  });
}

/** Apply all path replacements to a tool arguments string */
function applyPathReplacements(argsStr: string, replacements: Array<[string, string]>): string {
  let result = argsStr;
  for (const [from, to] of replacements) {
    // Replace all occurrences globally
    result = result.split(from).join(to);
  }
  return result;
}

/**
 * Normalize an MCP tool name by stripping the numeric index prefix (mcp_N_).
 * e.g. "mcp_4_knowhow-web_GetOrgFileText" → "knowhow-web_GetOrgFileText"
 *
 * The ToolsService uses endsWith matching, so the suffix (without the mcp_N_ prefix)
 * will correctly resolve to the currently-registered tool regardless of connection order.
 */
function normalizeMcpToolName(name: string): string {
  const match = name.match(/^mcp_\d+_(.+)$/);
  if (match) {
    return match[1];
  }
  return name;
}

// ─── Main replay logic ────────────────────────────────────────────────────────

async function runReplay(options: {
  taskId?: string;
  sessionId?: string;
  messageId?: string;
  approve: boolean;
  fromStep?: number;
  toStep?: number;
  only?: string[];
  ignore?: string[];
  dryRun: boolean;
  replacePaths: Array<[string, string]>;
  exportFile?: string;
}) {
  // 1. Setup services + tools
  console.log("🔧 Setting up services...");
  const { setupServices } = await import("./services");
  const { Tools } = await setupServices();

  // 2. Fetch the threads from the remote API
  const client = new KnowhowSimpleClient(KNOWHOW_API_URL);

  let threads: any[][] = [];

  if (options.taskId && !options.sessionId) {
    console.log(`\n📡 Fetching threads for task: ${options.taskId}`);
    threads = await fetchThreadsByTaskId(client, options.taskId);
  } else if (options.sessionId && options.messageId) {
    console.log(`\n📡 Fetching threads for session=${options.sessionId} message=${options.messageId}`);
    threads = await fetchThreadsBySessionMessage(client, options.sessionId, options.messageId);
  } else if (options.taskId) {
    // taskId might actually be a task UUID from a message
    console.log(`\n📡 Fetching threads for task: ${options.taskId}`);
    threads = await fetchThreadsByTaskId(client, options.taskId);
  } else {
    throw new Error("Provide --task-id or --session-id + --message-id");
  }

  if (!threads || threads.length === 0) {
    console.log("⚠️  No threads found. Nothing to replay.");
    return;
  }

  console.log(`✅ Loaded ${threads.length} thread(s)`);

  // 3. Extract all tool calls
  const allToolCalls = extractToolCalls(threads);

  if (allToolCalls.length === 0) {
    console.log("⚠️  No tool calls found in threads. Nothing to replay.");
    return;
  }

  console.log(`\n📋 Found ${allToolCalls.length} tool call(s) total`);

  // 4. Apply filters
  let filtered = allToolCalls;

  if (options.fromStep != null) {
    filtered = filtered.slice(options.fromStep - 1);
  }
  if (options.toStep != null) {
    const end = options.toStep - (options.fromStep ?? 1) + 1;
    filtered = filtered.slice(0, end);
  }
  if (options.only && options.only.length > 0) {
    filtered = filtered.filter(({ toolCall }) =>
      options.only!.some((n) => toolCall.function.name.includes(n))
    );
    console.log(`   Filtered to tools matching: ${options.only.join(", ")} → ${filtered.length} call(s)`);
  }
  if (options.ignore && options.ignore.length > 0) {
    filtered = filtered.filter(({ toolCall }) =>
      !options.ignore!.some((n) => toolCall.function.name.includes(n))
    );
    console.log(`   Ignoring tools matching: ${options.ignore.join(", ")} → ${filtered.length} call(s)`);
  }

  if (options.replacePaths.length > 0) {
    const pairs = options.replacePaths.map(([f, t]) => `"${f}" → "${t}"`).join(", ");
    console.log(`   Path replacements: ${pairs}`);
  }

  if (filtered.length === 0) {
    console.log("⚠️  No tool calls remain after filtering. Nothing to replay.");
    return;
  }

  // 5. Print summary table
  console.log("\n┌─────────────────────────────────────────────────────────────┐");
  console.log(`│  Replay Plan: ${filtered.length} tool call(s)${" ".repeat(Math.max(0, 47 - String(filtered.length).length))}│`);
  console.log("├──────┬──────────────────────────────────────────────────────┤");
  console.log("│  #   │  Tool Name                                           │");
  console.log("├──────┼──────────────────────────────────────────────────────┤");
  for (let i = 0; i < filtered.length; i++) {
    const name = filtered[i].toolCall.function.name.padEnd(52).slice(0, 52);
    const num = String(i + 1).padStart(4);
    console.log(`│ ${num} │  ${name}│`);
  }
  console.log("└──────┴──────────────────────────────────────────────────────┘\n");

  // 5b. Export to script file if requested
  if (options.exportFile) {
    const lines: string[] = [
      "// Auto-generated by: knowhow replay --export",
      `// Source task: ${options.taskId || options.sessionId + "/" + options.messageId}`,
      `// Generated: ${new Date().toISOString()}`,
      `// Tool calls: ${filtered.length}`,
      "//",
      "// Edit the args below to fix IDs or paths, then run with:",
      "//   knowhow script <this-file>",
      "//",
      "// Available in sandbox: callTool(toolName, args), console.log()",
      "",
    ];

    for (let i = 0; i < filtered.length; i++) {
      const { toolCall } = filtered[i];
      const originalName = toolCall.function.name;
      const toolName = normalizeMcpToolName(originalName);
      const argsStr =
        typeof toolCall.function.arguments === "string"
          ? toolCall.function.arguments
          : JSON.stringify(toolCall.function.arguments ?? {});

      const patchedArgsStr =
        options.replacePaths.length > 0
          ? applyPathReplacements(argsStr, options.replacePaths)
          : argsStr;

      // Pretty-print the args JSON for readability
      let prettyArgs: string;
      try {
        prettyArgs = JSON.stringify(JSON.parse(patchedArgsStr), null, 2);
      } catch {
        prettyArgs = JSON.stringify(patchedArgsStr);
      }

      lines.push(`// Step ${i + 1}: ${originalName}`);
      lines.push(`await callTool(${JSON.stringify(toolName)}, ${prettyArgs});`);
      lines.push("");
    }

    const outPath = path.resolve(options.exportFile);
    fs.writeFileSync(outPath, lines.join("\n"), "utf-8");
    console.log(`📝 Exported ${filtered.length} tool call(s) to: ${outPath}`);
    console.log(`   Edit the file to fix any stale IDs/paths, then run:`);
    console.log(`   knowhow script ${outPath}\n`);

    if (options.dryRun) {
      return;
    }
  }

  if (options.dryRun) {
    console.log("🏃 Dry-run mode: no tools will be executed.");
    return;
  }

  // 6. Execute tool calls
  const results: ReplayResult[] = [];
  let stepNum = 0;

  for (const { toolCall } of filtered) {
    stepNum++;
    const originalToolName = toolCall.function.name;
    // Normalize MCP tool names: strip mcp_N_ prefix so endsWith matching works
    // regardless of the connection order during replay vs. original recording.
    const toolName = normalizeMcpToolName(originalToolName);
    const argsStr =
      typeof toolCall.function.arguments === "string"
        ? toolCall.function.arguments
        : JSON.stringify(toolCall.function.arguments);

    // Apply path replacements to the arguments string before execution
    const patchedArgsStr =
      options.replacePaths.length > 0
        ? applyPathReplacements(argsStr, options.replacePaths)
        : argsStr;

    const patchedToolCall: ToolCall = {
      ...toolCall,
      function: { ...toolCall.function, name: toolName, arguments: patchedArgsStr },
    };

    // Prompt for approval if requested
    if (options.approve) {
      const decision = await promptApproval(originalToolName, patchedArgsStr);
      if (decision === "quit") {
        console.log("\n⛔ Quit by user.");
        break;
      }
      if (decision === "skip") {
        console.log(`   ⏭  Skipped: ${originalToolName}`);
        results.push({ toolName: originalToolName, toolId: toolCall.id, status: "skipped" });
        continue;
      }
    }

    process.stdout.write(`[${stepNum}/${filtered.length}] Running ${originalToolName}... `);
    try {
      const { functionResp } = await Tools.callTool(patchedToolCall, Tools.getToolNames());
      const output = typeof functionResp === "string" ? functionResp : JSON.stringify(functionResp);
      const preview = output.length > 120 ? output.slice(0, 120) + "…" : output;
      console.log(`✅`);
      if (output) {
        console.log(`         → ${preview}`);
      }
      results.push({ toolName, toolId: toolCall.id, status: "success", output });
    } catch (err: any) {
      console.log(`❌`);
      const errMsg = err?.message || String(err);
      console.log(`         ⚠ ${errMsg}`);
      results.push({ toolName, toolId: toolCall.id, status: "failed", error: errMsg });
    }
  }

  // 7. Print summary
  const succeeded = results.filter((r) => r.status === "success").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Replay Complete");
  console.log(`  ✅ ${succeeded} succeeded   ❌ ${failed} failed   ⏭  ${skipped} skipped`);

  if (failed > 0) {
    console.log("\n  Failed tool calls:");
    results
      .filter((r) => r.status === "failed")
      .forEach((r) => {
        console.log(`    • ${r.toolName}: ${r.error}`);
      });
  }

  console.log("═══════════════════════════════════════════════════════════════\n");
}

// ─── Command registration ─────────────────────────────────────────────────────

export function addReplayCommand(program: Command): void {
  program
    .command("replay")
    .description(
      "Replay tool calls from a remote session/task locally. " +
      "Useful for recreating agent work from a cloud sandbox on your local machine."
    )
    .option("--task-id <taskId>", "Task UUID to replay tool calls from")
    .option("--session-id <sessionId>", "Chat session UUID (use with --message-id)")
    .option("--message-id <messageId>", "Message UUID within a session to replay")
    .option(
      "--approve",
      "Approval mode: prompt before each tool call (y=run, n=skip, q=quit)"
    )
    .option("--dry-run", "List tool calls without executing them")
    .option(
      "--from-step <n>",
      "Start replaying from step N (1-based)",
      (v) => parseInt(v, 10)
    )
    .option(
      "--to-step <n>",
      "Stop replaying after step N (1-based)",
      (v) => parseInt(v, 10)
    )
    .option(
      "--only <tools>",
      "Comma-separated list of tool name substrings to include (e.g. writeFile,patchFile)",
      (v) => v.split(",").map((s) => s.trim()).filter(Boolean)
    )
    .option(
      "--ignore <tools>",
      "Comma-separated list of tool name substrings to skip (e.g. execCommand,readFile)",
      (v) => v.split(",").map((s) => s.trim()).filter(Boolean)
    )
    .option(
      "--replace-path <mapping>",
      'Replace a path prefix in all tool call arguments. Format: "from:to" (e.g. /workspace/repo:./). ' +
      "Can be specified multiple times.",
      (v: string, acc: string[]) => { acc.push(v); return acc; },
      [] as string[]
    )
    .option(
      "--export <file>",
      "Export tool calls as a knowhow script file instead of executing them. " +
      "Edit the exported file to fix stale IDs/paths, then run with: knowhow script <file>"
    )
    .action(async (options) => {
      try {
        const replacePaths = parseReplacePaths(options.replacePath || []);
        await runReplay({
          taskId: options.taskId,
          sessionId: options.sessionId,
          messageId: options.messageId,
          approve: options.approve || false,
          fromStep: options.fromStep,
          toStep: options.toStep,
          only: options.only,
          ignore: options.ignore,
          dryRun: options.dryRun || false,
          replacePaths,
          exportFile: options.export,
        });
      } catch (err: any) {
        console.error(`\n❌ Replay failed: ${err?.message || err}`);
        process.exit(1);
      }
    });
}
