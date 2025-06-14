import { readFile, fileExists, fileStat } from "../utils";
import { Language } from "../types";
import { getConfig, getLanguageConfig } from "../config";
import { PluginBase, PluginMeta } from "./PluginBase";
import { Plugin } from "./types";
import { GitHubPlugin } from "./github";
import { AsanaPlugin } from "./asana";
import { JiraPlugin } from "./jira";
import { LinearPlugin } from "./linear";
import { PluginService } from "./plugins";

export class LanguagePlugin extends PluginBase implements Plugin {
  static readonly meta: PluginMeta = {
    key: "language",
    name: "Language Plugin",
    requires: []
  };

  constructor(private pluginService: PluginService) {
    super(LanguagePlugin.meta);
  }

  async embed(userPrompt: string) {
    return [];
  }

  async call(userPrompt: string): Promise<string> {
    const config = await getConfig();
    const languageConfig = await getLanguageConfig();
    // Extract terms from the language configuration
    const terms = Object.keys(languageConfig);

    // Find all matching terms in the userPrompt
    const matchingTerms = terms.filter((term) =>
      term
        .split(",")
        .some((w) => userPrompt.toLowerCase().includes(w.toLowerCase()))
    );
    if (matchingTerms.length > 0) {
      console.log("LANGUAGE PLUGIN: Found matching terms", matchingTerms);
    }

    const sources = matchingTerms.flatMap(
      (term) => languageConfig[term].sources
    );

    const contexts = [];

    // Load the files for the matching terms
    const filesToLoad = sources
      .filter((f) => f.kind === "file")
      .map((f) => f.data)
      .flat();

    // Read the contents of the files
    const fileContents = await Promise.all(
      filesToLoad.map(async (filePath) => {
        const exists = await fileExists(filePath);
        if (!exists) {
          return { filePath, content: `File ${filePath} does not exist` };
        }
        const content = (await readFile(filePath, "utf8")).toString();
        console.log("LANGUAGE PLUGIN: Read file", filePath);
        return { filePath, content };
      })
    );
    contexts.push(...fileContents);

    const textContexts = matchingTerms
      .flatMap((term) =>
        languageConfig[term].sources.filter((s) => s.kind === "text")
      )
      .map((s) => s.data);
    contexts.push(...textContexts);

    const plugins = this.pluginService.listPlugins();
    for (const plugin of plugins) {
      if (config.plugins.includes(plugin)) {
        const matchingSources = sources.filter((s) => s.kind === plugin);
        if (matchingSources.length === 0) {
          continue;
        }

        const data = matchingSources
          .map((s) => s.data)
          .flat()
          .join("\n");
        console.log("LANGUAGE PLUGIN: Calling plugin", plugin, data);
        const pluginContext = await this.pluginService.call(plugin, data);

        contexts.push(...pluginContext);
      }
    }

    if (!matchingTerms || !matchingTerms.length) {
      return "LANGUAGE PLUGIN: No matching terms found";
    }

    // Return the file contents in a format that can be added to the prompt context
    return `LANGUAGE PLUGIN: The user mentioned these terms triggering contextual expansions ${matchingTerms} expanded to: ${JSON.stringify(
      contexts
    )}
    These terms are directly related to what the user is asking about so be sure to contextualize your response to this information.
    `;
  }
}

// Since this uses other plugins, it needs to be registered
// Plugins.registerPlugin("language", new LanguagePlugin());
