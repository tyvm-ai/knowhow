#!/usr/bin/env node

/**
 * New Modular Chat Interface - Simplified and cleaner than original chat.ts
 */

import { CliChatService } from "./chat/CliChatService.js";
import { InternalChatModule } from "./chat/modules/InternalChatModule.js";
import { getConfig } from "./config.js";

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
    const chatService = new CliChatService(config.plugins.enabled);

    // Load internal chat module (includes all core functionality)
    const internalModule = new InternalChatModule();
    await internalModule.initialize(chatService);

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
  (process.argv[1] && process.argv[1].endsWith("chat2.js"));

if (isMainModule) {
  main().catch(console.error);
}

export { main as startChat };
