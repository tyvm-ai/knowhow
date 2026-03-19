#!/usr/bin/env node

/**
 * New Modular Chat Interface - Simplified and cleaner than original chat.ts
 *
 * Supports custom renderers and root modules via .knowhow/knowhow.json:
 *
 * ```json
 * {
 *   "chat": {
 *     "renderer": "./my-renderer.ts",       // local TS/JS file or npm package
 *     "rootModule": "./my-module.ts"        // local TS/JS file or npm package
 *   }
 * }
 * ```
 */

import { CliChatService } from "./chat/CliChatService.js";
import { InternalChatModule } from "./chat/modules/InternalChatModule.js";
import { getConfig } from "./config.js";
import { loadRenderer, loadRootModule, loadChatModule } from "./chat/renderer/loadRenderer.js";
import { AgentModule } from "./chat/modules/AgentModule.js";

async function main() {
  try {
    // Load configuration and plugins
    let config;
    try {
      config = await getConfig();
    } catch (configError) {
      console.warn(
        "Warning: Could not load config, using default plugins:",
        configError
      );
      config = {
        plugins: {
          enabled: [
            "embeddings",
            "language",
            "vim",
            "github",
            "asana",
            "jira",
            "linear",
            "download",
            "figma",
            "url",
          ],
          disabled: [],
        },
      };
    }

    // Create chat service with plugins
    const chatService = new CliChatService(config.plugins?.enabled ?? []);

    // ── Renderer ──────────────────────────────────────────────────────────────
    // Load a custom renderer if configured, otherwise use the default
    // ConsoleRenderer (already the default inside AgentModule).
    const rendererSpecifier = config.chat?.renderer;
    if (rendererSpecifier) {
      try {
        const customRenderer = await loadRenderer(rendererSpecifier);
        // Inject the renderer into AgentModule via the chat service context
        // AgentModule picks it up from context.renderer
        chatService.setContext({ renderer: customRenderer });
        console.log(`✓ Loaded custom renderer: ${rendererSpecifier}`);
      } catch (err: any) {
        console.warn(`⚠ Could not load renderer "${rendererSpecifier}": ${err.message}`);
        console.warn("  Falling back to default ConsoleRenderer.");
      }
    }

    // ── Root Module ───────────────────────────────────────────────────────────
    // Allow swapping the root chat module entirely via config.
    // The root module drives the whole CLI chat experience.
    const rootModuleSpecifier = config.chat?.rootModule;
    if (rootModuleSpecifier) {
      try {
        const customModule = await loadRootModule(rootModuleSpecifier);
        await customModule.initialize(chatService);
        console.log(`✓ Loaded custom root module: ${rootModuleSpecifier}`);
      } catch (err: any) {
        console.warn(`⚠ Could not load root module "${rootModuleSpecifier}": ${err.message}`);
        console.warn("  Falling back to InternalChatModule.");
        const internalModule = new InternalChatModule();
        await internalModule.initialize(chatService);
      }
    } else {
      // Default: use the internal module
      const internalModule = new InternalChatModule();
      await internalModule.initialize(chatService);
    }

    // ── Additional Chat Modules ────────────────────────────────────────────────
    // Load any additional chat modules specified in config.chat.modules.
    // These are loaded AFTER the root module so they can add commands/modes
    // on top of whatever the root module provides.
    const moduleSpecifiers = config.chat?.modules ?? [];
    for (const specifier of moduleSpecifiers) {
      try {
        const chatModule = await loadChatModule(specifier);
        await chatModule.initialize(chatService);
        console.log(`✓ Loaded chat module: ${specifier}`);
      } catch (err: any) {
        console.warn(`⚠ Could not load chat module "${specifier}": ${err.message}`);
      }
    }

    // Start the chat loop
    await chatService.startChatLoop();
  } catch (error) {
    console.error("Error starting chat:", error);
    process.exit(1);
  }
}

// Check if this file is being run directly
const isMainModule =
  (process.argv[1] && process.argv[1].endsWith("chat2.ts")) ||
  (process.argv[1] && process.argv[1].endsWith("chat2.js")) ||
  (process.argv[1] && process.argv[1].endsWith("chat.ts")) ||
  (process.argv[1] && process.argv[1].endsWith("chat.js"));

if (isMainModule) {
  main().catch(console.error);
}

export { main as startChat };
