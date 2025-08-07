import { services } from "../../services";
import { login } from "../../login";
import { ask } from "../../utils";
import { CliChatService } from "../CliChatService";
import { ChatCommand, ChatMode } from "../types";
import { AgentModule } from "./AgentModule";
import { BaseChatModule } from "./BaseChatModule";

export class SetupModule extends BaseChatModule {
  name = "setup";
  description = "Setup commands";
  private agentModule?: AgentModule;

  getCommands(): ChatCommand[] {
    return [
      {
        name: "setup",
        description: "Check environment setup and run Setup agent",
        handler: this.handleSetupCommand.bind(this),
      },
    ];
  }

  getModes(): ChatMode[] {
    return [];
  }

  async initialize(chatService: CliChatService): Promise<void> {
    await super.initialize(chatService);
    // We'll need access to AgentModule for launching Setup agent
    this.agentModule = new AgentModule();
    await this.agentModule.initialize(chatService);
  }

  /**
   * Check environment variables and show setup status
   */
  private async checkEnvironmentSetup(): Promise<{
    available: string[];
    missing: string[];
    setupNeeded: boolean;
  }> {
    const envCheck = (varName: string): boolean => {
      return !!process.env[varName];
    };

    const envChecks = [
      {
        name: "OpenAI",
        vars: ["OPENAI_KEY"],
        feature: "OpenAI models (GPT-4o, etc.)",
      },
      {
        name: "Anthropic",
        vars: ["ANTHROPIC_API_KEY"],
        feature: "Claude models",
      },
      { name: "Google", vars: ["GEMINI_API_KEY"], feature: "Gemini models" },
      { name: "XAI", vars: ["XAI_API_KEY"], feature: "Grok models" },
      {
        name: "GitHub",
        vars: ["GITHUB_TOKEN"],
        feature: "GitHub integration (PRs, issues, repos)",
      },
      {
        name: "Linear",
        vars: ["LINEAR_API_KEY"],
        feature: "Linear integration",
      },
      {
        name: "Asana",
        vars: ["ASANA_ACCESS_TOKEN"],
        feature: "Asana integration",
      },
      {
        name: "Jira",
        vars: ["JIRA_HOST", "JIRA_USER", "JIRA_PASSWORD"],
        feature: "Jira integration",
      },
      { name: "Notion", vars: ["NOTION_TOKEN"], feature: "Notion integration" },
      {
        name: "Google Search",
        vars: ["GOOGLE_SEARCH_API_KEY"],
        feature: "Google Search",
      },
    ];

    const available: string[] = [];
    const missing: string[] = [];

    for (const check of envChecks) {
      const missingEnv = check.vars.filter((varName) => !process.env[varName]);
      if (!missingEnv.length) {
        available.push(`✅ ${check.name}: ${check.feature}`);
      } else {
        missing.push(
          `❌ ${check.name}: ${check.feature} (missing: ${missingEnv.join(
            " and "
          )})`
        );
      }
    }

    const canLogin = await this.checkKnowhowLogin();
    if (canLogin) {
      available.push("✅ Knowhow: Logged in successfully");
    } else {
      missing.push("❌ Knowhow: Not logged in");
    }

    const models = await this.canGetKnowhowModels();
    if (models && models.length > 0) {
      available.push(
        `✅ Knowhow: ${models.length} Models available: ${models
          .slice(0, 3)
          .join(", ")}...`
      );
    } else {
      missing.push("❌ Knowhow: No models available");
    }

    return { available, missing, setupNeeded: missing.length > 0 };
  }

  async checkKnowhowLogin(): Promise<boolean> {
    try {
      const canLogin = await login();
      return true;
    } catch (error) {
      return false;
    }
  }

  async canGetKnowhowModels() {
    const { Clients } = services();
    const models = await Clients.loadProviderModels("knowhow");
    return Clients.getRegisteredModels("knowhow");
  }

  async handleSetupCommand(args: string[]): Promise<void> {
    console.log("\n🔧 Knowhow Environment Setup Status\n");

    const { available, missing, setupNeeded } =
      await this.checkEnvironmentSetup();

    console.log("📋 Available Features:");
    available.forEach((item) => console.log(`  ${item}`));

    if (missing.length > 0) {
      console.log("\n⚠️  Missing Features:");
      missing.forEach((item) => console.log(`  ${item}`));
    }

    if (setupNeeded) {
      console.log(
        "\n💡 To enable missing features, set the required environment variables."
      );

      const proceedSetup = await ask(
        "\nWould you like me to help you set up your configuration? (y/n): ",
        ["y", "n"]
      );

      if (
        proceedSetup.toLowerCase() === "y" ||
        proceedSetup.toLowerCase() === "yes"
      ) {
        // Launch Setup agent to guide user through configuration
        if (this.agentModule) {
          const { taskId, agent } = await this.agentModule.setupAgent({
            agentName: "Setup",
            run: true,
            input:
              "Help me set up my Knowhow configuration with the missing features and optimize my setup.",
          });
          await this.agentModule.attachedAgentChatLoop(taskId, agent);
        }
      }
    } else {
      console.log(
        "\n🎉 Great! All major features are available. Your setup looks good!"
      );
    }
  }
}
