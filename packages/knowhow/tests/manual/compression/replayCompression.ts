/**
 * One-off: replay a real agent thread through the default message-processor
 * pipeline and report which large tool outputs survive uncompressed, and why.
 *
 * Usage:
 *   npx tsx tests/manual/compression/replayCompression.ts <metadata.json> [--build]
 *
 * --build uses ts_build (what the global `knowhow` CLI actually runs).
 */
import fs from "fs";
import path from "path";

const file = process.argv[2];
const useBuild = process.argv.includes("--build");
// --simple: replay each tool result as if it were the only call in its turn
const simple = process.argv.includes("--simple");
const root = path.resolve(__dirname, "../../..");
const base = useBuild ? path.join(root, "ts_build/src") : path.join(root, "src");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ToolsService } = require(path.join(base, "services/Tools"));
const { MessageProcessor } = require(path.join(base, "services/MessageProcessor"));
const { applyDefaultMessageProcessors } = require(
  path.join(base, "processors/defaultProcessors")
);
const { TokenCompressor } = require(path.join(base, "processors/TokenCompressor"));

const meta = JSON.parse(fs.readFileSync(file, "utf8"));
const thread: any[] = meta.threads[0];

/** What the stored thread looks like vs. a fresh replay of the same turn. */
async function main() {
  const tools = new ToolsService();
  const agent = { tools, messageProcessor: new MessageProcessor() };
  applyDefaultMessageProcessors(agent);

  const len = (m: any) =>
    typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
  const isCompressed = (m: any) =>
    typeof m.content === "string" && m.content.trimStart().startsWith("[COMPRESSED_STRING");

  console.log(`source: ${useBuild ? "ts_build" : "src"}`);
  console.log(
    "idx  tool          stored   replayed  (exempt?)"
  );
  for (let i = 0; i < thread.length; i++) {
    const m = thread[i];
    if (m.role !== "tool" || len(m) < 8000) continue;

    // Rebuild the turn exactly as the agent sees it at post_tools. The
    // Anthropic client splits one response with N parallel tool_use blocks
    // into N assistant "choices"; only the first carries _reasoning_details.
    // base.ts pushes an assistant/tool pair per choice and runs post_tools
    // ONCE afterwards, so the whole response group is the tail of the list.
    let end = i + 1;
    let groupSize = 1;
    while (
      !simple &&
      end < thread.length &&
      (thread[end].role === "tool" ||
        (thread[end].role === "assistant" &&
          !thread[end]._reasoning_details &&
          thread[end].tool_calls?.length))
    ) {
      if (thread[end].role === "assistant") groupSize++;
      end++;
    }
    const msgs = thread.slice(0, end);

    // The agent ran pre_call on the request that produced this response
    // before post_tools saw its results; replay that so the processor knows
    // which tool results are already in the (cached) history.
    let requestEnd = i - 1;
    while (requestEnd > 0 && thread[requestEnd].role !== "assistant") requestEnd--;
    while (
      requestEnd > 1 &&
      thread[requestEnd - 1].role === "tool" &&
      thread[requestEnd - 2].role === "assistant" &&
      !thread[requestEnd]._reasoning_details
    ) {
      requestEnd -= 2;
    }
    await agent.messageProcessor.processMessages(thread.slice(0, requestEnd), "pre_call");
    const out = await agent.messageProcessor.processMessages(msgs, "post_tools");
    const replayed = out[i];
    const exempt = TokenCompressor.DO_NOT_COMPRESS.has(m.name)
      ? "DO_NOT_COMPRESS"
      : len(m) <= 16000
      ? `under threshold (${Math.ceil(len(m) / 4)} tok <= 4000)`
      : "";
    console.log(
      `${String(i).padEnd(4)} ${String(m.name).padEnd(13)} ${String(len(m)).padStart(6)}${
        isCompressed(m) ? "C" : " "
      }  ${String(len(replayed)).padStart(6)}${isCompressed(replayed) ? "C" : " "}   ${exempt}${
        groupSize > 1 ? ` [+${groupSize - 1} later parallel call(s) in same response]` : ""
      }`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
