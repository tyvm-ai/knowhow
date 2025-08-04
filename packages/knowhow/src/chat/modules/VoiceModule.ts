/**
 * Voice Chat Module - Handles voice input functionality
 */

import { BaseChatModule } from "./BaseChatModule.js";
import { ChatCommand, ChatMode, ChatContext, InputMethod } from "../types.js";
import { voiceToText } from "../../microphone.js";

export class VoiceModule extends BaseChatModule {
  name = "voice";
  description = "Voice input functionality";

  getCommands(): ChatCommand[] {
    return [
      {
        name: "voice",
        description: "Toggle voice input mode",
        handler: this.handleVoiceCommand.bind(this),
      },
    ];
  }

  getModes(): ChatMode[] {
    return [
      {
        name: "voice",
        description: "Voice input mode",
        active: false,
      },
    ];
  }

  async handleVoiceCommand(args: string[]): Promise<void> {
    const voiceMode = this.chatService?.getMode("voice");
    const context = this.chatService?.getContext();
    if (!voiceMode) return;

    voiceMode.active = !voiceMode.active;
    const newVoiceMode = !context?.voiceMode;
    this.chatService?.setContext({ voiceMode: newVoiceMode });

    console.log(`Voice mode: ${newVoiceMode ? 'enabled' : 'disabled'}`);
  }

  private async getVoiceInput(prompt?: string): Promise<string> {
    try {
      // This would integrate with actual voice recognition
      // For now, we'll simulate it
      console.log("🎤 Listening... (Press Enter to simulate voice input)");

      const value = await voiceToText();

      return value;
    } catch (error) {
      console.error("Error getting voice input:", error);
      return "";
    }
  }

  async handleInput(input: string, context: ChatContext): Promise<boolean> {
    const voiceMode = this.chatService?.getMode("voice");
    if (!voiceMode?.active) {
      return false;
    }

    // Voice mode doesn't handle input directly, it overrides the input method
    // The actual handling would be done by other modules
    return false;
  }
}
