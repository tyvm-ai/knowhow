// Tool to search for files related to the user's goal
import { services } from "../../services";
export async function embeddingSearch(keyword: string): Promise<string> {
  const { Plugins } = services();
  return Plugins.call("embeddings", keyword);
}
