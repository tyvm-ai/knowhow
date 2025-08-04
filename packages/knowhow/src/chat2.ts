#!/usr/bin/env node

/**
 * New Modular Chat Interface - Simplified and cleaner than original chat.ts
 */

import { CliChatService } from './chat/CliChatService.js';
import { InternalChatModule } from './chat/modules/InternalChatModule.js';

async function main() {
  try {
    // Create chat service
    const chatService = new CliChatService();
    
    // Load internal chat module (includes all core functionality)
    const internalModule = new InternalChatModule();
    await internalModule.initialize(chatService);
    
    // Commands are already registered through module initialization
    // Modes need to be registered manually since they're not auto-registered
    for (const mode of internalModule.getModes()) {
      chatService.registerMode(mode);
    }

    // Start the chat loop
    await chatService.startChatLoop();
    
  } catch (error) {
    console.error('Error starting chat:', error);
    process.exit(1);
  }
}

// Check if this file is being run directly
const isMainModule = process.argv[1] && process.argv[1].endsWith('chat2.ts') || 
                     process.argv[1] && process.argv[1].endsWith('chat2.js');

if (isMainModule) {
  main().catch(console.error);
}

export { main as startChat2 };