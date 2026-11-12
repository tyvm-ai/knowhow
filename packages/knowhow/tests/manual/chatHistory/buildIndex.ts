/**
 * Build/refresh the chat history embedding index for a project.
 *   npx tsx tests/manual/chatHistory/buildIndex.ts [projectRoot]
 */
import { ChatHistoryIndex } from "../../../src/services/ChatHistoryIndex";

async function main() {
  const root = process.argv[2] || process.cwd();
  const index = new ChatHistoryIndex({ root });
  const start = Date.now();
  const result = await index.sync();
  const entries = index.entries();
  console.log(
    `added=${result.added} embedded=${result.embedded} total=${entries.length} ` +
      `withVector=${entries.filter((e) => e.vector?.length).length} in ${Date.now() - start}ms → ${index.indexFile}`
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
