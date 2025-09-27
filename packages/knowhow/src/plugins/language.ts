import { readFile, fileExists, fileStat } from "../utils";
import { minimatch } from "minimatch";
import { EventService } from "../services/EventService";
import { Language } from "../types";
import { getConfig, getLanguageConfig } from "../config";
import { PluginBase, PluginMeta } from "./PluginBase";
import { Plugin, PluginContext } from "./types";
import { GitHubPlugin } from "./github";
import { AsanaPlugin } from "./asana";
import { JiraPlugin } from "./jira";
import { LinearPlugin } from "./linear";
import { PluginService } from "./plugins";

/**
 * Language Plugin with event-driven context loading
 */
export class LanguagePlugin extends PluginBase implements Plugin {
  static readonly meta: PluginMeta = {
    key: "language",
    name: "Language Plugin",
    requires: [],
  };

  meta = LanguagePlugin.meta;
  private eventService: EventService;

  constructor(context: PluginContext) {
    super(context);
    this.eventService = context.Events;
    this.setupEventHandlers();
  }

  /**
   * Register event handlers based on language configuration
   */
  private async setupEventHandlers() {
    try {
      const languageConfig = await getLanguageConfig();

      // Collect all unique events from all language terms
      const allEvents = new Set<string>();
      Object.values(languageConfig).forEach((termConfig) => {
        if (termConfig.events) {
          termConfig.events.forEach((event) => allEvents.add(event));
        }
      });

      // Register handlers for each event
      allEvents.forEach((eventType) => {
        this.eventService.on(eventType, async (eventData) => {
          await this.handleFileEvent(eventType, eventData);
        });
      });
    } catch (error) {
      console.error("LANGUAGE PLUGIN: Error setting up event handlers:", error);
    }
  }

  /**
   * Resolve sources for given terms and return loaded contexts
   */
  private async resolveSources(matchingTerms: string[]): Promise<any[]> {
    const languageConfig = await getLanguageConfig();
    const config = await getConfig();

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

    const plugins = this.context.Plugins.listPlugins();
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
        const pluginContext = await this.context.Plugins.call(plugin, data);

        contexts.push(...pluginContext);
      }
    }

    return contexts;
  }

  /**
   * Handle file operation events and emit agent messages when patterns match
   */
  private async handleFileEvent(eventType: string, eventData: any) {
    try {
      const languageConfig = await getLanguageConfig();
      const filePath = eventData?.filePath || eventData?.path;
      const fileContent = await readFile(filePath, "utf8");

      if (!filePath) {
        return;
      }

      // Find matching language terms based on file patterns
      const matchingFileTerms = Object.entries(languageConfig)
        .filter(([term, config]) => {
          // Check if this event type is configured for this term
          if (!config.events || !config.events.includes(eventType)) {
            return false;
          }

          // Check if file path matches any of the term patterns
          // Or if the file content includes any of the term patterns
          const patterns = term.split(",").map((p) => p.trim());
          const matches = patterns.some(
            (pattern) =>
              minimatch(filePath, pattern) ||
              fileContent.toString().toLowerCase().includes(pattern.toLowerCase())
          );
          return matches;
        })
        .map(([term]) => term);

      if (matchingFileTerms.length > 0) {
        // Resolve sources for matching terms
        const resolvedSources = await this.resolveSources(matchingFileTerms);

        // Emit agent message event with resolved context
        this.eventService.emit(
          "agent:msg",
          JSON.stringify({
            type: "language_context_trigger",
            filePath,
            matchingTerms: matchingFileTerms,
            eventType,
            resolvedSources,
            contextMessage: `LANGUAGE PLUGIN: File event ${eventType} on ${filePath} triggered contextual expansions for terms: ${matchingFileTerms.join(
              ", "
            )}.
            Expanded context: ${JSON.stringify(resolvedSources)}
            These terms are directly related to the file operation so be sure to contextualize your response to this information.`,
          })
        );
      }
    } catch (error) {
      console.error("LANGUAGE PLUGIN: Error handling file event:", error);
    }
  }

  async embed(userPrompt: string) {
    return [];
  }

  async call(userPrompt: string) {
    // Get language configuration
    const languageConfig = await getLanguageConfig();
    const terms = Object.keys(languageConfig);

    // Find all matching terms in the userPrompt using glob patterns
    const matchingTerms = terms.filter((term) =>
      term.split(",").some((pattern) => {
        const trimmedPattern = pattern.trim();
        // Use minimatch for file patterns, fallback to string contains for non-glob patterns
        return trimmedPattern.includes("*")
          ? minimatch(userPrompt, trimmedPattern)
          : userPrompt.toLowerCase().includes(trimmedPattern.toLowerCase());
      })
    );

    if (matchingTerms.length === 0) {
      return "LANGUAGE PLUGIN: No matching terms found";
    }

    // Use the extracted resolveSources method
    const contexts = await this.resolveSources(matchingTerms);

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
