import { readFile, fileExists, fileStat } from "../utils";
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
 * Simple glob pattern matcher supporting * and ** wildcards
 */
function matchGlobPattern(pattern: string, text: string): boolean {
  // If no wildcards, use string contains matching for backward compatibility
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }

  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/\*\*/g, ".*") // ** matches any characters including /
    .replace(/\*/g, "[^/]*") // * matches any characters except /
    .replace(/\?/g, ".") // ? matches single character
    .replace(/\./g, "\\."); // Escape literal dots

  const regex = new RegExp(`^${regexPattern}$`, "i");
  return regex.test(text);
}

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
      console.log("LANGUAGE PLUGIN: Handler function executing");
      allEvents.forEach((eventType) => {
        this.eventService.on(eventType, async (eventData) => {
          await this.handleFileEvent(eventType, eventData);
        });
      });

      console.log(
        `LANGUAGE PLUGIN: Registered handlers for events: ${Array.from(
          allEvents
        ).join(", ")}`
      );
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
        console.log("LANGUAGE PLUGIN: Calling plugin", plugin, data);
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
      console.log("LANGUAGE PLUGIN: handleFileEvent called with:", {
        eventType,
        eventData,
      });
      const languageConfig = await getLanguageConfig();
      const filePath = eventData?.filePath || eventData?.path;

      console.log({ languageConfig, filePath });

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
          return term
            .split(",")
            .some((pattern) => matchGlobPattern(pattern.trim(), filePath));
        })
        .map(([term]) => term);

      if (matchingFileTerms.length > 0) {
        console.log(
          `LANGUAGE PLUGIN: File event ${eventType} on ${filePath} matches terms: ${matchingFileTerms.join(
            ", "
          )}`
        );

        // Resolve sources for matching terms
        console.log("LANGUAGE PLUGIN: About to emit agent:msg event");
        console.log("LANGUAGE PLUGIN: this.eventService:", !!this.eventService);
        const resolvedSources = await this.resolveSources(matchingFileTerms);

        // Emit agent message event with resolved context
        console.log(
          `LANGUAGE PLUGIN: Emitting agent:msg event for file ${filePath}`
        );

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
        console.log("LANGUAGE PLUGIN: agent:msg event emitted successfully");
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
        // Use glob pattern matching for file-like patterns, fallback to string contains
        return matchGlobPattern(trimmedPattern, userPrompt);
      })
    );

    if (matchingTerms.length > 0) {
      console.log("LANGUAGE PLUGIN: Found matching terms", matchingTerms);
    } else {
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
