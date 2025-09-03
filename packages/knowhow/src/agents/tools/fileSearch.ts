import { globSync } from "glob";
import { getConfiguredEmbeddings } from "../../embeddings";
import { execCommand } from "./execCommand";
import { getIgnorePattern } from "../../config";
import { toUniqueArray } from "../../utils";

export async function fileSearch(searchTerm) {
  const searchTermLower = searchTerm.toLowerCase();
  const pattern = `./**/*${searchTermLower}*`;
  const ignore = await getIgnorePattern();
  console.log({ pattern, ignore });
  const globFiles = globSync(pattern, {
    ignore,
    nocase: true,
  });

  const embeddings = await getConfiguredEmbeddings();
  const embeddingFiles = embeddings.filter((embedding) =>
    embedding.id.toLowerCase().includes(searchTermLower)
  );

  // ids are filepath.txt-part
  const embeddingIds = embeddingFiles.map((r) => {
    const parts = r.id.split("-");
    return parts.slice(0, -1).join("-");
  });

  const allFiles = toUniqueArray([...globFiles, ...embeddingIds]);

  return allFiles;
}
