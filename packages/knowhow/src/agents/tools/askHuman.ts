import Marked from "marked";
import { ask } from "../../utils";

// Simple, CLI-agnostic implementation
// CLI-specific behavior is handled via ToolsService override in AgentModule
export async function askHuman(question: string) {
  console.log("AI has asked: ");
  console.log(Marked.parse(question), "\n");
  return ask("response: ");
}
