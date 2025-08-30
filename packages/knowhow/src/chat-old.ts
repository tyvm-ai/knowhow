import { ChatCompletionMessageParam } from "openai/resources/chat";
import Ora from "ora";
import editor from "@inquirer/editor";
import { cosineSimilarity } from "./utils";
import {
  EmbeddingBase,
  GptQuestionEmbedding,
  Embeddable,
  ChatInteraction,
} from "./types";
import { Marked } from "./utils";
import { ask } from "./utils";
import { services } from "./services";
import { queryEmbedding, getConfiguredEmbeddingMap } from "./embeddings";
import { FlagsService } from "./services/flags";
import { IAgent } from "./agents/interface";
import { Message } from "./clients";
import { recordAudio, voiceToText } from "./microphone";
import { Models } from "./ai";
import { BaseAgent } from "./agents";
import { getConfig } from "./config";
import { TokenCompressor } from "./processors/TokenCompressor";
import { ToolResponseCache } from "./processors/ToolResponseCache";
import { CustomVariables, XmlToolCallProcessor, HarmonyToolProcessor } from "./processors";

enum ChatFlags {
  agent = "agent",
  agents = "agents",
  debug = "debug",
  multi = "multi",
  model = "model",
  search = "search",
  clear = "clear",
  provider = "provider",
  voice = "voice",
}

const Flags = new FlagsService(
  [ChatFlags.agent, ChatFlags.debug, ChatFlags.multi, ChatFlags.voice],
  true
);

const taskRegistry = new Map<string, BaseAgent>();

export async function askEmbedding<E>(promptText: string) {
  const options = ["next", "exit", "embeddings", "use"];
  console.log(`Commands: ${options.join(", ")}`);
  let input = await ask(promptText + ": ", options);
  let answer: EmbeddingBase<any> | undefined;
  let results = new Array<EmbeddingBase>();
  let embedMap = await getConfiguredEmbeddingMap();
  const config = await getConfig();
  const files = Object.keys(embedMap);

  while (input !== "exit") {
    const embeddings = Object.values(embedMap).flat();

    switch (input) {
      case "next":
        answer = results.shift();
        break;
      case "embeddings":
        console.log(files);
        break;
      case "use":
        const searchOptions = ["all", ...files];
        console.log(searchOptions);
        const embeddingName = await ask("Embedding to search: ", searchOptions);
        if (embeddingName === "all") {
          embedMap = await getConfiguredEmbeddingMap();
          break;
        }

        embedMap = { ...{ [embeddingName]: embedMap[embeddingName] } };
        break;
      default:
        results = await queryEmbedding(
          input,
          embeddings,
          config.embeddingModel
        );
        answer = results.shift();
        break;
    }
    if (answer) {
      console.log(
        Marked.parse(
          "### TEXT \n" +
            answer.text +
            "\n### METADATA \n" +
            JSON.stringify(answer.metadata, null, 2)
        )
      );
    }

    input = await ask(promptText + ": ");
  }
}

const ChatModelDefaults = {
  openai: Models.openai.GPT_4o,
  anthropic: Models.anthropic.Sonnet4,
  google: Models.google.Gemini_25_Flash_Preview,
  xai: Models.xai.Grok3Beta,
};
export async function askAI<E extends EmbeddingBase>(
  query: string,
  provider = "openai",
  model = ChatModelDefaults[provider]
) {
  const gptPrompt = `

The user has asked:
  ${query}

  Output Format in Markdown
`;
  if (Flags.enabled("debugger")) {
    console.log(gptPrompt);
  }

  const thread = [
    {
      role: "system",
      content:
        "Helpful Codebase assistant. Answer users questions using the embedding data that is provided with the user's question. You have limited access to the codebase based off of how similar the codebase is to the user's question. You may reference file paths by using the IDs present in the embedding data, but be sure to remove the chunk from the end of the filepaths.",
    },
    { role: "user", content: gptPrompt },
  ] as Message[];

  const { Clients } = services();
  const response = await Clients.createCompletion(provider, {
    messages: thread,
    model,
  });

  return response.choices[0].message.content;
}

export async function getInput(
  question: string,
  options = [],
  chatHistory: ChatInteraction[] = []
): Promise<string> {
  const multiLine = Flags.enabled(ChatFlags.multi);
  const voice = Flags.enabled(ChatFlags.voice);

  let value = "";
  if (voice) {
    value = await voiceToText();
  } else if (multiLine) {
    value = await editor({ message: question });
    Flags.disable(ChatFlags.multi);
  } else {
    const history = chatHistory.map((c) => c.input).reverse();
    value = await ask(question, options, history);
  }

  return value.trim();
}

export async function formatChatInput(
  input: string,
  plugins: string[] = [],
  chatHistory: ChatInteraction[] = []
) {
  const { Plugins } = services();
  const pluginText = await Plugins.callMany(plugins, input);
  const historyMessage = `<PreviousChats>
  This information is provided as historical context and is likely not related to the current task:
  ${JSON.stringify(chatHistory)}
    </PreviousChats>`;
  const fullPrompt = `
    ${historyMessage} \n
    <PluginContext> ${pluginText} </PluginContext>
    <CurrentTask>${input}</CurrentTask>
  `;
  return fullPrompt;
}

export async function chatLoop<E extends GptQuestionEmbedding>(
  aiName: string,
  embeddings: Embeddable<E>[],
  plugins: string[] = []
) {
  const { Agents, Clients } = services();
  let activeAgent = Agents.getAgent("Developer") as BaseAgent;
  let provider = "openai" as keyof typeof Clients.clients;
  let model = ChatModelDefaults[provider];
  const providers = Object.keys(Clients.clients);
  const commands = [
    "agent",
    "agents",
    "clear",
    "debugger",
    "exit",
    "model",
    "multi",
    "provider",
    "search",
    "voice",
  ];
  console.log("Commands: ", commands.join(", "));
  const promptText = () =>
    Flags.enabled(ChatFlags.agent)
      ? `\nAsk ${aiName} ${activeAgent.name}: `
      : `\nAsk ${aiName}: `;

  let chatHistory = new Array<ChatInteraction>();
  let input = await getInput(promptText(), commands, chatHistory);

  let results = "";
  while (input !== "exit") {
    try {
      switch (input) {
        case ChatFlags.agents:
          Flags.enable(ChatFlags.agent);
          const agents = Agents.listAgents();
          console.log(agents);
          const selected = await ask(
            "Which agent would you like to use: ",
            agents
          );
          activeAgent = Agents.getAgent(selected) as BaseAgent;
          model = activeAgent.getModel();
          provider = activeAgent.getProvider() as keyof typeof Clients.clients;
          break;
        case ChatFlags.agent:
          Flags.flip(ChatFlags.agent);
          break;
        case ChatFlags.debug:
          Flags.flip(ChatFlags.debug);
          break;
        case ChatFlags.multi:
          Flags.flip(ChatFlags.multi);
          break;
        case ChatFlags.voice:
          Flags.flip(ChatFlags.voice);
          break;
        case ChatFlags.search:
          await askEmbedding("searching");
          break;
        case ChatFlags.clear:
          chatHistory = [];
          break;
        case ChatFlags.provider:
          console.log(providers);
          provider = await ask(
            `\n\nCurrent Provider: ${provider}\nCurrent Model: ${model}\n\nWhich provider would you like to use: `,
            providers
          );
          model =
            ChatModelDefaults[provider] ||
            (await Clients.getRegisteredModels(provider))[0];

          if (Flags.enabled("agent")) {
            activeAgent.setProvider(provider);
            activeAgent.setModel(model);
          }

          break;
        case ChatFlags.model:
          const models = Clients.getRegisteredModels(provider);
          console.log(models);
          const selectedModel = await ask(
            `\n\nCurrent Provider: ${provider}\nCurrent Model: ${model}\n\nWhich model would you like to use: `,
            models
          );
          model = selectedModel;

          if (Flags.enabled("agent")) {
            activeAgent.setProvider(provider);
            activeAgent.setModel(model);
          }
          break;
        case "attach":
          if (taskRegistry.size > 0) {
            const options = Array.from(taskRegistry.keys());
            const selectedInitialMessage = await ask(
              "Select an agent to attach to:",
              options
            );
            activeAgent = taskRegistry.get(selectedInitialMessage)!;
            console.log(
              `Attached to agent with task: "${selectedInitialMessage}"`
            );
            await startAgent(activeAgent, null, true);
          } else {
            console.log("No detached agents available.");
          }
        case "":
          break;
        default:
          console.log("Thinking...");
          console.log(input);
          const interaction = {
            input,
            output: "",
          } as ChatInteraction;
          if (Flags.enabled("agent")) {
            taskRegistry.set(input, activeAgent);
            await startAgent(activeAgent, {
              initialInput: input,
              plugins,
              chatHistory,
              interaction,
            });
          } else {
            const formattedPrompt = await formatChatInput(
              input,
              plugins,
              chatHistory
            );
            results = await askAI(formattedPrompt, provider, model);
            interaction.output = results;
            console.log(Marked.parse(results || "No response from the AI"));
          }
          console.log("\n\n");
          chatHistory.push(interaction);
          break;
      }
    } catch (e) {
      console.log(e);
    } finally {
      input = await getInput(promptText(), commands, chatHistory);
    }
  }
}

export async function startAgent(
  activeAgent: BaseAgent,
  newTask?: {
    initialInput: string;
    plugins: string[];
    chatHistory: ChatInteraction[];
    interaction: ChatInteraction;
  },
  attach = false
) {
  let done = false;
  let output = "Done";

  if (newTask) {
    const { initialInput, plugins, chatHistory, interaction } = newTask;
    await activeAgent.newTask();
    const formattedPrompt = await formatChatInput(
      initialInput,
      plugins,
      chatHistory
    );
    activeAgent.call(formattedPrompt);

    // Compress tokens of tool responses
    activeAgent.messageProcessor.setProcessors("pre_call", [
      new ToolResponseCache(activeAgent.tools).createProcessor(),

      new TokenCompressor(activeAgent.tools).createProcessor((msg) =>
        Boolean(msg.role === "tool" && msg.tool_call_id)
      ),
      new CustomVariables(activeAgent.tools).createProcessor(),
    ]);

    // Process XML and Harmony tool calls in assistant responses
    activeAgent.messageProcessor.setProcessors("post_call", [
      new XmlToolCallProcessor().createProcessor(),
      new HarmonyToolProcessor().createProcessor(),
    ]);

    if (
      !activeAgent.agentEvents.listenerCount(activeAgent.eventTypes.toolUsed)
    ) {
      activeAgent.agentEvents.on(
        activeAgent.eventTypes.toolUsed,
        (responseMsg) => {
          console.log(` 🔨 Tool used: ${JSON.stringify(responseMsg, null, 2)}`);
        }
      );
    }

    activeAgent.agentEvents.once(activeAgent.eventTypes.done, (doneMsg) => {
      console.log("Agent has finished.");
      done = true;
      taskRegistry.delete(initialInput);
      output = doneMsg || "No response from the AI";
      interaction.output = output;
      console.log(Marked.parse(output));
    });
  }

  // Define available commands
  const commands = ["pause", "unpause", "kill", "detach"];
  const history = [];

  let input = await getInput(
    `Enter command or message for ${activeAgent.name}: `,
    commands,
    history
  );

  history.push(input);

  const donePromise = new Promise<string>((resolve) => {
    activeAgent.agentEvents.on(activeAgent.eventTypes.done, () => {
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
        break;
      case "pause":
        await activeAgent.pause();
        console.log("Agent paused.");
        break;
      case "unpause":
        await activeAgent.unpause();
        console.log("Agent unpaused.");
        break;
      case "kill":
        await activeAgent.kill();
        console.log("Agent terminated.");
        break;
      case "detach":
        return "Detached from agent";
        break;
      default:
        activeAgent.addPendingUserMessage({ role: "user", content: input });
    }

    input = await Promise.race([
      getInput(
        `Enter command or message for ${activeAgent.name}: `,
        commands,
        history
      ),
      donePromise,
    ]);
  }

  return output;
}
