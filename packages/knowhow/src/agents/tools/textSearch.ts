import { getConfiguredEmbeddings } from "../../embeddings";
import { execAsync } from "./execCommand";

export async function textSearch(searchTerm) {
  try {
    // Escape the search term for safe shell usage
    // Replace single quotes with '\'' which closes quote, adds escaped quote, reopens quote
    // 1) Normalize whitespace (turn newlines/tabs into spaces)
    const normalized = String(searchTerm)
      .replace(/\r\n?/g, "\n") // normalize CRLF/CR → LF
      .replace(/\n/g, " ") // kill newlines
      .replace(/\t/g, " ") // kill tabs
      .replace(/\s+/g, " ") // collapse
      .trim();

    // 2) Escape single quotes for safe single-quoted shell arg
    const escapedTerm = normalized.replace(/'/g, "'\\''");

    const command = `ag -m 3 -Q '${escapedTerm}'`;
    return await execAsync(command);
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
