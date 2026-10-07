import { BaseAgent, AgentContext } from "@tyvm/knowhow/ts_build/src/agents/base/base";
import type { Message } from "@tyvm/knowhow/ts_build/src/clients/types";
import { COMPUTER_USE_PROMPT } from "./prompt";

/** Dedicated, low-latency agent registered for voice and direct computer control. */
export class ComputerUseAgent extends BaseAgent {
  name = "ComputerUseAgent";
  description = "A concise, low-latency agent that can see and control the computer";

  constructor(
    context: AgentContext,
    model = "gpt-5.6-luna",
    provider: any = "openai"
  ) {
    super(context);
    this.setModelPreferences([{ model, provider }]);
  }

  async getInitialMessages(userInput: string): Promise<Message[]> {
    const instructions = COMPUTER_USE_PROMPT.replace(/\nTask:\n\{text\}\s*$/, "");
    return [
      {
        role: "system",
        content:
          `${instructions}\n\nYou are being controlled conversationally by voice. ` +
          "Keep spoken responses concise and act promptly. Use computer-use tools only when the " +
          "request actually concerns the visible screen, GUI, mouse, or keyboard. For factual " +
          "questions and direct operating-system queries, prefer the normal Knowhow tools: enable " +
          "and use execCommand for shell commands (for example date/time) rather than opening or " +
          "driving a terminal window through the GUI.",
      },
      { role: "user", content: userInput },
    ];
  }
}
