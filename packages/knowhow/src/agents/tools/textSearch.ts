import { getConfiguredEmbeddings } from "../../embeddings";
import { execCommand } from "./execCommand";

export async function textSearch(searchTerm) {
  try {
    // Escape the search term for safe shell usage
    // Replace single quotes with '\'' which closes quote, adds escaped quote, reopens quote
    const escapedTerm = searchTerm.replace(/'/g, "'\\''");
    const command = `ag -m 3 -Q '${escapedTerm}'`;
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
