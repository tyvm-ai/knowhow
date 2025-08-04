/**
 * Ask Chat Module - Handles basic AI question/answer functionality
 */

import { BaseChatModule } from './BaseChatModule.js';
import { ChatCommand, ChatMode, ChatContext } from '../types.js';
import { ChatInteraction } from '../../types.js';
import { Models } from '../../ai.js';
import { services } from '../../services/index.js';
import { Plugins } from '../../plugins/plugins.js';
import { Marked } from '../../utils/index.js';
import { formatChatInput } from '../../chat.js';

export class AskModule extends BaseChatModule {
  name = 'ask';
  description = 'Basic AI question/answer functionality';

  getCommands(): ChatCommand[] {
    return [
      // AskModule provides chat functionality, commands are handled by SystemModule
    ];
  }

  getModes(): ChatMode[] {
    return [
      {
        name: 'chat',
        description: 'Basic AI chat mode',
        active: true
      }
    ];
  }

  async handleInput(input: string, context: ChatContext): Promise<boolean> {
    // AskModule is the default handler - it handles input when no other module does
    // Skip if in agent mode (let AgentModule handle it)
    if (context.mode === 'agent') {
      return false; 
    }

    // This is the default handler for all non-command input
    return await this.processAIQuery(input, context);
  }

  /**
   * Process AI query with full chat functionality (like original chat.ts)
   */
  private async processAIQuery(input: string, context: ChatContext): Promise<boolean> {
    try {
      const { Clients } = services();
      const provider = context.currentProvider || 'openai';
      const model = context.currentModel || Models.openai.GPT_4o;
      
      // Format the input with plugin context and chat history like original chat.ts
      const formattedPrompt = await formatChatInput(
        input,
        context.plugins || [],
        context.chatHistory || []
      );

      // Get AI response using the same pattern as original chat.ts
      const response = await Clients.createCompletion(provider, {
        messages: [
          {
            role: 'system',
            content: 'Helpful Codebase assistant. Answer users questions using the embedding data that is provided with the user\'s question. You have limited access to the codebase based off of how similar the codebase is to the user\'s question. You may reference file paths by using the IDs present in the embedding data, but be sure to remove the chunk from the end of the filepaths.',
          },
          { role: 'user', content: formattedPrompt },
        ],
        model,
      });

      const result = response.choices[0].message.content || 'No response from the AI';
      
      // Create interaction with proper ChatInteraction structure (input/output)
      const interaction: ChatInteraction = {
        input,
        output: result,
      } as ChatInteraction;
      
      context.chatHistory?.push(interaction);

      // Display the result using Marked parser like in original chat.ts
      console.log(Marked.parse(result));

      return true;
    } catch (error) {
      console.error('Error getting AI response:', error);
      console.log('Failed to get AI response. Please try again.');
      return false;
    }
  }
}