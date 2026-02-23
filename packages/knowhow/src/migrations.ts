/**
 * Configuration Migration System
 * 
 * This module provides a framework for migrating configuration files
 * as the schema evolves over time. Each migration is a function that
 * transforms the config and returns whether it made changes.
 */

import { Config } from "./types";

export type Migration = {
  version: number;
  description: string;
  migrate: (config: any, context?: MigrationContext) => { modified: boolean; config: any };
};

export type MigrationContext = {
  allPluginKeys?: string[];
};

/**
 * Default list of all known plugins at time of migration
 * This list is used if the migration context doesn't provide plugin keys
 */
const DEFAULT_PLUGINS = [
  "embeddings",
  "language",
  "git",
  "vim",
  "linter",
  "github",
  "asana",
  "jira",
  "linear",
  "notion",
  "download",
  "figma",
  "url",
  "tmux",
  "agents-md",
];

/**
 * Migration 1: Convert plugins from string[] to { enabled, disabled } format
 * Also ensures all registered plugins are in the enabled list
 */
const migration1: Migration = {
  version: 1,
  description: "Convert plugins from string[] to { enabled, disabled } format and add missing plugins",
  migrate: (config: any, context?: MigrationContext) => {
    const allPluginKeys = context?.allPluginKeys || DEFAULT_PLUGINS;
    let modified = false;

    // If plugins doesn't exist, no migration needed
    if (!config.plugins) {
      // Create default plugins config with all plugins enabled
      config.plugins = {
        enabled: [...allPluginKeys],
        disabled: [],
      };
      return { modified: true, config };
    }

    // If plugins is a string array, convert it
    if (Array.isArray(config.plugins)) {
      config.plugins = {
        enabled: config.plugins,
        disabled: [],
      };
      modified = true;
    }

    // Ensure config.plugins is an object with enabled/disabled arrays
    if (typeof config.plugins === "object" && !Array.isArray(config.plugins)) {
      // Ensure enabled array exists
      if (!config.plugins.enabled) {
        config.plugins.enabled = [...allPluginKeys];
        modified = true;
      }

      // Ensure disabled array exists
      if (!config.plugins.disabled) {
        config.plugins.disabled = [];
        modified = true;
      }

      // Add any missing plugins to enabled list
      const missingPlugins = allPluginKeys.filter(
        (key) =>
          !config.plugins.enabled.includes(key) &&
          !config.plugins.disabled.includes(key)
      );
      
      if (missingPlugins.length > 0) {
        config.plugins.enabled.push(...missingPlugins);
        modified = true;
      }
    }

    return { modified, config };
  },
};

/**
 * All migrations in order
 */
export const migrations: Migration[] = [migration1];

/**
 * Apply all migrations to a config object
 * @param config The config object to migrate
 * @param context Optional context for migrations (e.g., list of all plugin keys)
 * @returns Object containing the migrated config and whether any changes were made
 */
export function applyMigrations(config: any, context?: MigrationContext): {
  modified: boolean;
  config: any;
} {
  let modified = false;
  let currentConfig = { ...config };

  for (const migration of migrations) {
    try {
      const result = migration.migrate(currentConfig, context);
      if (result.modified) {
        console.log(
          `Applied migration ${migration.version}: ${migration.description}`
        );
        modified = true;
        currentConfig = result.config;
      }
    } catch (error) {
      console.error(
        `Failed to apply migration ${migration.version}: ${migration.description}`,
        error
      );
      // Continue with other migrations even if one fails
    }
  }

  return { modified, config: currentConfig };
}

/**
 * Get the current migration version (highest migration number)
 */
export function getCurrentMigrationVersion(): number {
  return migrations.length > 0
    ? Math.max(...migrations.map((m) => m.version))
    : 0;
}
