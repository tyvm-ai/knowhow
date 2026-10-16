import type { ToolsService } from "../services/Tools";
import type { MessageProcessor } from "../services/MessageProcessor";
import { Base64ImageProcessor } from "./Base64ImageDetector";
import { CustomVariables } from "./CustomVariables";
import { TokenCompressor } from "./TokenCompressor";
import { ToolResponseCache } from "./ToolResponseCache";
import { XmlToolCallProcessor } from "./XmlToolCallProcessor";
import { HarmonyToolProcessor } from "./HarmonyToolProcessor";
import { GemmaToolProcessor } from "./GemmaToolProcessor";
import { MinimalToolsMessageProcessor } from "./MinimalToolsMessageProcessor";

interface ProcessableAgent {
  tools: ToolsService;
  messageProcessor: MessageProcessor;
}

/**
 * Install the standard message-processor pipeline on an agent:
 *  - Base64ImageProcessor turns tool results that carry images (e.g. computer-use
 *    screenshots returned as `[{type:"image_url",...}]`) into real multimodal
 *    parts instead of leaving megabytes of base64 inside a text tool message.
 *  - ToolResponseCache / TokenCompressor keep large tool outputs out of context.
 *  - Xml/Harmony/Gemma processors normalise model-specific tool-call formats.
 *
 * `setProcessors` replaces each stage, so calling this repeatedly is idempotent.
 * Every entry point that runs an agent loop (CLI chat, interactive/voice
 * sessions, ...) should use this rather than running a bare BaseAgent.
 */
export function applyDefaultMessageProcessors(agent: ProcessableAgent): void {
  const tools = agent.tools;
  const caching = [
    new ToolResponseCache(tools).createProcessor(),
    new TokenCompressor(tools).createProcessor((msg) =>
      Boolean(msg.role === "tool" && msg.tool_call_id)
    ),
  ];
  const customVariables = new CustomVariables(tools);

  agent.messageProcessor.setProcessors("pre_call", [
    new Base64ImageProcessor(tools).createProcessor(),
    ...caching,
    customVariables.createProcessor(),
  ]);
  agent.messageProcessor.setProcessors("post_call", [
    new XmlToolCallProcessor().createProcessor(),
    new HarmonyToolProcessor().createProcessor(),
    new GemmaToolProcessor().createProcessor(),
  ]);
  agent.messageProcessor.setProcessors("pre_tools", [
    new MinimalToolsMessageProcessor().createProcessor(),
  ]);
  agent.messageProcessor.setProcessors("post_tools", [
    new Base64ImageProcessor(tools).createProcessor(),
    ...caching,
    customVariables.createRepetitionHintProcessor(),
  ]);
}
