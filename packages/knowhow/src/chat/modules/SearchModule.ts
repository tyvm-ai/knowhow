import { BaseChatModule } from "./BaseChatModule";
import { ChatContext, ChatCommand } from "../types";
import { getConfiguredEmbeddingMap, queryEmbedding } from "../../embeddings";
import { getConfig } from "../../config";
import { ask } from "../../utils";
import { marked } from "marked";

export class SearchModule extends BaseChatModule {
  name = "Search";
  description = "Search through embeddings for relevant information";

  getCommands(): ChatCommand[] {
    return [
      {
        name: "search",
        description: "Search embeddings",
        handler: this.handleSearchCommand.bind(this),
      },
    ];
  }

  async handleSearchCommand(args: string[]): Promise<void> {
    await this.askEmbedding("searching");
  }

  async executeCommand(command: string, context: ChatContext): Promise<void> {
    if (command === "search") {
      await this.askEmbedding("searching");
    }
  }

  async askEmbedding(promptText: string) {
    const options = ["next", "exit", "embeddings", "use"];
    console.log(`Commands: ${options.join(", ")}`);
    let input = await ask(promptText + ": ", options);
    let answer: any | undefined;
    let results = new Array<any>();
    let embedMap = await getConfiguredEmbeddingMap();
    const config = await getConfig();
    const files = Object.keys(embedMap);

    while (input !== "exit") {
      const embeddings = Object.values(embedMap).flat();

      switch (input) {
        case "next":
          answer = results.shift();
          break;
        case "embeddings":
          console.log(files);
          break;
        case "use":
          const searchOptions = ["all", ...files];
          console.log(searchOptions);
          const embeddingName = await ask(
            "Embedding to search: ",
            searchOptions
          );
          if (embeddingName === "all") {
            embedMap = await getConfiguredEmbeddingMap();
            break;
          }

          embedMap = { ...{ [embeddingName]: embedMap[embeddingName] } };
          break;
        default:
          results = await queryEmbedding(
            input,
            embeddings,
            config.embeddingModel
          );
          answer = results.shift();
          break;
      }
      if (answer) {
        console.log(
          marked.parse(
            "### TEXT \n" +
              answer.text +
              "\n### METADATA \n" +
              JSON.stringify(answer.metadata, null, 2)
          )
        );
      }

      input = await ask(promptText + ": ");
    }
  }
}
