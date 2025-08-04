import { getConfiguredEmbeddings } from "../../embeddings";
import { execCommand } from "./execCommand";

export async function textSearch(searchTerm) {
  try {
    const command = `ag -m 3 -Q "${searchTerm}"`;
    const output = await execCommand(command);
    return output;
  } catch (err) {
    console.log(
      "Falling back to embeddings text search since ag was not available"
    );
    const searchTermLower = searchTerm.toLowerCase();
    const embeddings = await getConfiguredEmbeddings();
    const results = embeddings.filter((embedding) =>
      embedding.text.toLowerCase().includes(searchTermLower)
    );
    results.forEach((r) => delete r.vector);
    return results;
  }
}
