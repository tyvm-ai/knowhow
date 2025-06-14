import glob from "glob";
import { Plugin } from "./types";
import { VimPlugin } from "./vim";
import { LanguagePlugin } from "./language";
import { EmbeddingPlugin } from "./embedding";
import { GitHubPlugin } from "./github";
import { AsanaPlugin } from "./asana";
import { LinearPlugin } from "./linear";
import { JiraPlugin } from "./jira";
import { NotionPlugin } from "./notion";
import { DownloaderPlugin } from "./downloader/plugin";
import { FigmaPlugin } from "./figma";
import { UrlPlugin } from "./url";

export class PluginService {
  private pluginMap = new Map<string, Plugin>();

  constructor() {
    // Register migrated PluginBase plugins
    this.pluginMap.set("embeddings", new EmbeddingPlugin());
    this.pluginMap.set("vim", new VimPlugin());
    this.pluginMap.set("github", new GitHubPlugin());
    this.pluginMap.set("asana", new AsanaPlugin());
    this.pluginMap.set("linear", new LinearPlugin());
    this.pluginMap.set("jira", new JiraPlugin());
    this.pluginMap.set("notion", new NotionPlugin());
    this.pluginMap.set("download", new DownloaderPlugin());
    this.pluginMap.set("figma", new FigmaPlugin());
    this.pluginMap.set("language", new LanguagePlugin(this));
    this.pluginMap.set("url", new UrlPlugin());

    // Keep legacy plugins for backward compatibility
    // These will be removed once all consumers are updated
  }

  /* -------- lifecycle helpers ------------------------------------ */

  /**
   * Dynamically import a package / file and register it.
   * @param spec ESM import specifier, e.g. "my-linear-plugin" or "./plugins/foo"
   * @returns the key under which it was stored
   */
  async loadPlugin(spec: string): Promise<string> {
    const { default: PluginCtor } = await import(spec);
    const instance: Plugin = new PluginCtor(this); // assumes default export
    this.pluginMap.set(instance.meta.key, instance);
    return instance.meta.key;
  }

  /** Disable a plugin by its key; returns `true` if found. */
  disablePlugin(key: string): boolean {
    const p = this.pluginMap.get(key);
    if (!p) return false;
    p.disable();
    return true;
  }

  /** Enable a plugin by its key; returns `true` if found. */
  enablePlugin(key: string): boolean {
    const p = this.pluginMap.get(key);
    if (!p) return false;
    p.enable();
    return true;
  }

  /* -------- existing public API (updated for compatibility) ---------------------- */

  listPlugins() {
    const newPlugins = [...this.pluginMap.keys()];
    return newPlugins;
  }

  isPlugin(name: string) {
    return this.pluginMap.has(name);
  }

  registerPlugin(name: string, plugin: Plugin) {
    this.pluginMap.set(name, plugin);
  }

  async callMany(plugins: string[], userInput?: string) {
    const calls = plugins.map(async (p) => {
      return this.call(p, userInput);
    });

    const results = await Promise.all(calls);
    return results.filter((result) => result !== "").join("\n\n");
  }

  async call(kind: string, userInput?: string) {
    // Check new plugin system first
    const newPlugin = this.pluginMap.get(kind);

    if (!newPlugin) {
      throw new Error(`Plugin ${kind} not found`);
    }

    const enabled = await newPlugin.isEnabled();
    if (!enabled) {
      console.log(`Plugin ${kind} is disabled, skipping`);
      return "";
    }
    return newPlugin.call(userInput);
  }

  async embed(kind: string, userInput: string) {
    // Check new plugin system first
    const newPlugin = this.pluginMap.get(kind);
    if (!newPlugin) {
      throw new Error(`Plugin ${kind} not found`);
    }

    const enabled = await newPlugin.isEnabled();
    if (!enabled) {
      console.log(`Plugin ${kind} is disabled, skipping`);
      return [];
    }
    return newPlugin.embed ? newPlugin.embed(userInput) : [];
  }
}

export const Plugins = new PluginService();
