/**
 * End-to-end: how the interactive chat now seeds a task, vs. the legacy block,
 * plus the searchChatHistory tool. Run from anywhere:
 *   npx tsx tests/manual/chatHistory/chatIntegration.ts [projectRoot]
 */
const root = process.argv[2] || "/Users/micah/dev/knowhow";
process.chdir(root);

async function main() {
  const { CliChatService } = await import("../../../src/chat/CliChatService");
  const { searchChatHistory } = await import("../../../src/agents/tools/searchChatHistory");
  const chat = new CliChatService([]);
  const input = "remind me what we decided about prompt caching across tasks";
  const inProcess = [{ taskId: "x-live", input: "earlier question in this process", output: "earlier answer" }];

  const start = Date.now();
  const prompt = await chat.formatChatInput(input, [], inProcess, { persistentHistory: true });
  console.log(`persistent history prompt: ${prompt.length} chars in ${Date.now() - start}ms`);
  console.log(prompt.slice(0, 1500), "\n…\n", prompt.slice(-1800));

  const legacy = await chat.formatChatInput(input, [], inProcess);
  console.log(`\nlegacy prompt (spawned agents / AskModule): ${legacy.length} chars`);

  const results = JSON.parse(await searchChatHistory({ query: "Sora deprecation", limit: 3, maxAnswerChars: 200 }));
  console.log("\nsearchChatHistory('Sora deprecation'):");
  for (const r of results) console.log(`  ${r.similarity}  ${r.taskId}  ${r.prompt.slice(0, 80)}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
