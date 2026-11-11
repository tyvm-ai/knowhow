import { getConfiguredEmbeddings } from "../../embeddings";
import { toUniqueArray } from "../../utils";
import {
  fileTermToRegExp,
  isExcludedPath,
  listFiles,
  pathTargetsExcludedDir,
} from "./searchBackends";

export const FILE_SEARCH_DEFAULT_LIMIT = 200;

/**
 * Find files whose path contains `searchTerm` (case-insensitive, literal; `*`
 * and `?` act as wildcards). Uses `rg --files` / `git ls-files` / a node walk
 * (never a shell) and skips node_modules, dist, build, .git, .next, coverage,
 * Pods and *.min.js unless `searchPath` points inside one of them.
 *
 * Returns an array of paths. When more than `limit` paths match, the array is
 * cut and a final "[N more ...]" entry tells the agent to narrow the term.
 */
export async function fileSearch(
  searchTerm: string,
  limit?: number | string,
  searchPath?: string
) {
  const term = String(searchTerm ?? "").trim();
  if (!term) return [];
  const max = Number(limit) > 0 ? Number(limit) : FILE_SEARCH_DEFAULT_LIMIT;
  const regex = fileTermToRegExp(term);
  const target = searchPath && String(searchPath).trim() ? String(searchPath).trim() : undefined;

  const listed = await listFiles(process.cwd(), target);
  const pathMatches = listed.files.filter((f) => regex.test(f));

  // Embedding ids are "<filepath>-<chunk>"; include indexed files too.
  let embeddingIds: string[] = [];
  try {
    const embeddings = await getConfiguredEmbeddings();
    const embeddingsArray = Array.isArray(embeddings) ? embeddings : [];
    embeddingIds = embeddingsArray
      .filter((e) => typeof e?.id === "string" && regex.test(e.id))
      .map((e) => e.id.split("-").slice(0, -1).join("-"))
      .filter(
        (f) => f && regex.test(f) && (pathTargetsExcludedDir(target) || !isExcludedPath(f))
      );
  } catch {
    // embeddings are optional
  }

  const all = toUniqueArray([...pathMatches, ...embeddingIds]);
  if (all.length <= max) {
    return listed.truncated
      ? [...all, "[file listing was cut short (timeout/size limit); pass a narrower path]"]
      : all;
  }
  const shown = all.slice(0, max);
  shown.push(
    `[${all.length - max} more matching files not shown (${all.length} total). Use a more specific term or pass a path.]`
  );
  return shown;
}
