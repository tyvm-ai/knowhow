/**
 * Agent Chat Module - Handles agent interactions
 */

import { formatChatInput } from '../../chat.js';
import { BaseChatModule } from './BaseChatModule.js';
import { services } from '../../services/index.js';
import { BaseAgent } from '../../agents/index.js';
import { ChatCommand, ChatMode, ChatContext } from '../types.js';
import { ChatInteraction } from '../../types.js';
import { Marked } from '../../utils/index.js';
import { TokenCompressor } from '../../processors/TokenCompressor.js';
import { ToolResponseCache } from '../../processors/ToolResponseCache.js';
import { CustomVariables, XmlToolCallProcessor } from '../../processors/index.js';

export class AgentModule extends BaseChatModule {
  name = 'agent';
  description = 'Agent interaction functionality';
  
  // Task registry for managing active agents
  private taskRegistry = new Map<string, BaseAgent>();

  getCommands(): ChatCommand[] {
    return [
      {
        name: 'agent',
        description: 'Start an agent by name',
        handler: this.handleAgentCommand.bind(this)
      },
      {
        name: 'agents',
        description: 'List available agents',
        handler: this.handleAgentsCommand.bind(this)
      },
      {
        name: 'attach',
        description: 'Attach to an existing agent task',
        handler: this.handleAttachCommand.bind(this)
      },
      {
        name: 'tasks',
        description: 'List active agent tasks',
        handler: this.handleTasksCommand.bind(this)
      }
    ];
  }

  getModes(): ChatMode[] {
    return [
      {
        name: 'agent',
        description: 'Agent interaction mode',
        active: false
      }
    ];
  }

  async handleAgentCommand(args: string[]): Promise<void> {
    if (args.length === 0) {
      console.log('Please specify an agent name. Use /agents to list available agents.');
      return;
    }

    const agentName = args[0];
    const { agents } = await import('../../agents/index.js');
    const allAgents = agents();
    
    try {
      if (allAgents && allAgents[agentName]) {
        // Set selected agent in context and enable agent mode
        const context = this.chatService?.getContext();
        if (context) {
          context.selectedAgent = allAgents[agentName];
          context.mode = 'agent';
        }
        console.log(`Agent mode enabled. Selected agent: ${agentName}. Type your task to get started.`);
      } else {
        console.log(`Agent "${agentName}" not found. Use /agents to list available agents.`);
      }
    } catch (error) {
      console.error(`Error selecting agent ${agentName}:`, error);
    }
  }

  async handleAttachCommand(args: string[]): Promise<void> {
    if (args.length === 0) {
      // Show active tasks
      const activeTasks = this.getActiveTasks();
      if (activeTasks.length === 0) {
        console.log('No active agent tasks found.');
        return;
      }
      
      console.log('Active agent tasks:');
      activeTasks.forEach(({ taskId, agent }) => {
        console.log(`  ${taskId}: ${agent.name}`);
      });
      return;
    }

    const taskId = args[0];
    this.attachToTask(taskId);
  }

  async handleTasksCommand(args: string[]): Promise<void> {
    const activeTasks = this.getActiveTasks();
    if (activeTasks.length === 0) {
      console.log('No active agent tasks found.');
      return;
    }
    
    console.log('Active agent tasks:');
    activeTasks.forEach(({ taskId, agent }) => {
      console.log(`  ${taskId}: ${agent.name}`);
    });
  }

  async handleAgentsCommand(args: string[]): Promise<void> {
    try {
      const { agents } = await import('../../agents/index.js');
      const allAgents = agents();
      
      if (allAgents && Object.keys(allAgents).length > 0) {
        const agentNames = Object.keys(allAgents);
        
        console.log('Available agents:');
        Object.entries(allAgents).forEach(([name, agent]: [string, any]) => {
          console.log(`  - ${name}: ${agent.description || 'No description'}`);
        });
        
        // Interactive selection with autocomplete
        const selectedAgent = await this.chatService?.getInput(
          'Select an agent to start: ',
          agentNames // Pass agent names as autocomplete options
        );
        
        if (selectedAgent && selectedAgent.trim() && agentNames.includes(selectedAgent.trim())) {
          // Start the selected agent
          await this.handleAgentCommand([selectedAgent.trim()]);
        } else if (selectedAgent && selectedAgent.trim()) {
          console.log(`Agent "${selectedAgent.trim()}" not found.`);
        }
      } else {
        console.log('No agents available.');
      }
    } catch (error) {
      console.error('Error listing agents:', error);
      console.log('Could not load agents list.');
    }
  }

  async handleInput(input: string, context: ChatContext): Promise<boolean> {
    // If in agent mode, start agent with the input as initial task (like original chat.ts)
    if (context.mode === 'agent' && context.selectedAgent) {
      const result = await this.startAgent(context.selectedAgent, input, []);
      return result;
    }
    return false;
  }

  /**
   * Get list of active agent tasks
   */
  getActiveTasks(): Array<{ taskId: string; agent: BaseAgent }> {
    return Array.from(this.taskRegistry.entries()).map(([taskId, agent]) => ({
      taskId,
      agent
    }));
  }

  /**
   * Attach to an existing agent task
   */
  attachToTask(taskId: string): boolean {
    if (this.taskRegistry.has(taskId)) {
      console.log(Marked.parse(`**Attached to agent task: ${taskId}**`));
      return true;
    }
    console.log(Marked.parse(`**Task ${taskId} not found or already completed.**`));
    return false;
  }

  /**
   * Start an agent with an initial task (simplified version for now)
   */
  private async startAgent(
    selectedAgent: BaseAgent,
    initialInput: string,
    chatHistory: ChatInteraction[] = []
  ): Promise<boolean> {
    let done = false;
    let output = "Done";
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // Add the agent to task registry
      this.taskRegistry.set(taskId, selectedAgent);

      console.log(Marked.parse(`**Starting ${selectedAgent.name} with task ID: ${taskId}...**`));
      console.log(Marked.parse(`**Task:** ${initialInput}`));
      
      // Initialize new task
      await selectedAgent.newTask();
      
      // Get context for plugins
      const context = this.chatService?.getContext();
      const plugins = context?.plugins || [];
      
      // Format the prompt with plugins and chat history
      const { formatChatInput } = await import('../../chat.js');
      const formattedPrompt = await formatChatInput(
        initialInput,
        plugins,
        chatHistory
      );
      
      // Start the agent with the formatted prompt
      selectedAgent.call(formattedPrompt);

      // Set up message processors like in original startAgent
      const { ToolResponseCache } = await import('../../processors/ToolResponseCache.js');
      const { TokenCompressor } = await import('../../processors/TokenCompressor.js');
      const { CustomVariables, XmlToolCallProcessor } = await import('../../processors/index.js');

      selectedAgent.messageProcessor.setProcessors("pre_call", [
        new ToolResponseCache(selectedAgent.tools).createProcessor(),
        new TokenCompressor(selectedAgent.tools).createProcessor((msg) =>
          Boolean(msg.role === "tool" && msg.tool_call_id)
        ),
        new CustomVariables(selectedAgent.tools).createProcessor(),
      ]);

      selectedAgent.messageProcessor.setProcessors("post_call", [
        new XmlToolCallProcessor().createProcessor(),
      ]);

      // Set up event listeners
      if (!selectedAgent.agentEvents.listenerCount(selectedAgent.eventTypes.toolUsed)) {
        selectedAgent.agentEvents.on(
          selectedAgent.eventTypes.toolUsed,
          (responseMsg) => {
            console.log(` 🔨 Tool used: ${JSON.stringify(responseMsg, null, 2)}`);
          }
        );
      }

      selectedAgent.agentEvents.once(selectedAgent.eventTypes.done, (doneMsg) => {
        console.log("Agent has finished.");
        done = true;
        this.taskRegistry.delete(taskId);
        output = doneMsg || "No response from the AI";
        console.log(Marked.parse(output));
      });

      // Define available commands
      const commands = ["pause", "unpause", "kill", "detach"];
      const history: string[] = [];

      let input = await this.chatService?.getInput(
        `Enter command or message for ${selectedAgent.name}: `,
        commands
      ) || '';

      history.push(input);

      const donePromise = new Promise<string>((resolve) => {
        selectedAgent.agentEvents.on(selectedAgent.eventTypes.done, () => {
          done = true;
          resolve("done");
        });
      });

      while (!done) {
        switch (input) {
          case "":
            break;
          case "done":
            output = "Exited agent interaction.";
            done = true;
            break;
          case "pause":
            await selectedAgent.pause();
            console.log("Agent paused.");
            break;
          case "unpause":
            await selectedAgent.unpause();
            console.log("Agent unpaused.");
            break;
          case "kill":
            await selectedAgent.kill();
            console.log("Agent terminated.");
            done = true;
            break;
          case "detach":
            console.log("Detached from agent");
            return true;
          default:
            selectedAgent.addPendingUserMessage({ role: "user", content: input });
        }

        if (!done) {
          input = await Promise.race([
            this.chatService?.getInput(
              `Enter command or message for ${selectedAgent.name}: `,
              commands
            ) || Promise.resolve(''),
            donePromise,
          ]);
        }
      }

      // Clean up task registry
      this.taskRegistry.delete(taskId);
      
      return true;

    } catch (error) {
      console.error('Agent execution failed:', error);
      this.taskRegistry.delete(taskId);
      return false;
    }
  }

}