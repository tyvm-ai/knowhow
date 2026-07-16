import * as fs from "fs";
import { readFile } from "./utils";

/** Options forwarded to startAgentTask when a generation source has an `agent` field */
export type AgentOptions = {
  syncFs?: boolean;
  taskId?: string;
  maxTimeLimit?: number;
  maxSpendLimit?: number;
};
import OpenAI from "openai";
import { Assistant } from "./types";
import { convertToText } from "./conversion";
import { getConfigSync } from "./config";
import { Clients } from "./clients";
import { getModelContextLimit } from "./clients/contextLimits";

const config = getConfigSync();
const OPENAI_KEY = process.env.OPENAI_KEY;

import { Models } from "./types";
import { services } from "./services";
export { Models };

export const openai = () =>
  new OpenAI({
    apiKey: OPENAI_KEY,
    ...(config.openaiBaseUrl && { baseURL: config.openaiBaseUrl }),
  });

export function readPromptFile(promptFile: string, input: string) {
  if (promptFile) {
    if (fs.existsSync(promptFile)) {
      const promptTemplate = fs.readFileSync(promptFile, "utf-8");
      if (promptTemplate.includes("{text}")) {
        // Only replace if input is provided
        if (input) {
          return promptTemplate.replaceAll("{text}", input);
        }
        // If no input provided but template expects it, return template as-is
        // This allows the calling code to handle the missing input
        return promptTemplate;
      } else {
        // Template doesn't have {text}, so input is optional
        if (input) {
          return `${promptTemplate}\n\n${input}`;
        }
        return promptTemplate;
      }
    }
  }

  return input;
}

export async function singlePrompt(
  userPrompt: string,
  model = "",
  agent = "",
  agentOptions?: AgentOptions
) {
  if (agent) {
    // Route through the full AgentModule pipeline (renderer, sync-fs, limits).
    // This ensures generate agent runs produce readable output and are observable
    // via `knowhow agents list/tail/status`, matching `knowhow agent --input` behaviour.
    const { startAgentTask } = await import("./agents/tools/startAgentTask");
    return startAgentTask({
      agentName: agent,
      prompt: userPrompt,
      model: model || undefined,
      waitForCompletion: true,
      ...(agentOptions ?? {}),
    });
  }

  if (!model) {
    model = Models.openai.GPT_54_Nano;
  }

  // Assume we're using provider/model format of model
  const resp = await Clients.createCompletion("", {
    model,
    messages: [{ role: "user", content: userPrompt }],
  });

  return resp?.choices?.[0]?.message?.content;
}

/**
 * Rough token estimate: ~4 characters per token (common heuristic).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Returns true if the error looks like a context-window-exceeded error from any provider.
 */
function isContextLengthError(err: any): boolean {
  const msg: string = (err?.message || "").toLowerCase();
  return (
    msg.includes("context window") ||
    msg.includes("context length") ||
    msg.includes("maximum context") ||
    msg.includes("input too long") ||
    msg.includes("too long") ||
    msg.includes("exceeds the context") ||
    msg.includes("input exceeds") ||
    (err?.status === 400 && msg.includes("context"))
  );
}

/**
 * Recursively summarize an array of texts using a split-and-summarize approach.
 * When the combined texts exceed the context window (either by estimate or actual API error),
 * split the array in half, summarize each half recursively, then combine.
 *
 * NOTE: when an `agent` is provided the recursive split path is skipped — agents
 * can handle large inputs themselves (they can read files). Splitting would create
 * multiple isolated agent runs each writing partial output. Instead the combined
 * content is passed directly to the agent.
 */
async function summarizeTextsRecursive(
  texts: string[],
  template: string,
  model: string,
  agent: string,
  contextLimit: number,
  depth = 0,
  agentOptions?: AgentOptions
): Promise<string> {
  const indent = "  ".repeat(depth);

  // Base case: single text — just run the prompt directly
  if (texts.length === 1) {
    const content = template.replaceAll("{text}", texts[0]);
    console.log(`${indent}summarizeTexts[depth=${depth}]: single text, ~${estimateTokens(content)} tokens`);
    return singlePrompt(content, model, agent, agentOptions);
  }

  // Check if combined fits in context window by estimate
  const combinedText = texts.join("\n\n");
  const combinedContent = template.replaceAll("{text}", combinedText);
  const estimatedTokens = estimateTokens(combinedContent);

  if (estimatedTokens < contextLimit) {
    // Try single combined prompt — if context error, fall through to split
    console.log(`${indent}summarizeTexts[depth=${depth}]: ${texts.length} texts, ~${estimatedTokens} tokens, trying combined`);
    try {
      return await singlePrompt(combinedContent, model, agent, agentOptions);
    } catch (err: any) {
      if (!isContextLengthError(err)) throw err;
      console.log(`${indent}summarizeTexts[depth=${depth}]: API rejected (context too long), splitting in half`);
    }
  } else {
    console.log(`${indent}summarizeTexts[depth=${depth}]: ${texts.length} texts, ~${estimatedTokens} tokens exceeds limit, splitting in half`);
  }

  // When an agent is assigned, don't split — agents can handle large inputs and
  // splitting would create multiple isolated agent runs that each write partial output.
  // Instead, pass the combined content as-is even if it may exceed context limit.
  if (agent) {
    console.log(`${indent}summarizeTexts[depth=${depth}]: agent mode — skipping split, passing combined content to agent`);
    return singlePrompt(combinedContent, model, agent, agentOptions);
  }

  // Split texts in half and recurse
  const mid = Math.ceil(texts.length / 2);
  const left = texts.slice(0, mid);
  const right = texts.slice(mid);

  const [leftSummary, rightSummary] = await Promise.all([
    summarizeTextsRecursive(left, template, model, agent, contextLimit, depth + 1, agentOptions),
    summarizeTextsRecursive(right, template, model, agent, contextLimit, depth + 1, agentOptions),
  ]);

  // Combine the two halves with a final summary prompt
  const combinedSummaries = [leftSummary, rightSummary].join("\n\n");
  const finalContent = template.replaceAll("{text}", combinedSummaries);
  const finalEstimate = estimateTokens(finalContent);
  console.log(`${indent}summarizeTexts[depth=${depth}]: combining halves, ~${finalEstimate} tokens`);

  if (finalEstimate < contextLimit) {
    return singlePrompt(finalContent, model, agent, agentOptions);
  }

  // If even the combined summaries are too long, recurse one more level
  return summarizeTextsRecursive([leftSummary, rightSummary], template, model, agent, contextLimit, depth + 1, agentOptions);
}

export async function summarizeTexts(
  texts: string[],
  template: string,
  model = "",
  agent = "",
  agentOptions?: AgentOptions
) {
  const effectiveModel = model || Models.openai.GPT_54_Nano;
  const contextLimit = getModelContextLimit(effectiveModel);

  console.log(
    `summarizeTexts: ${texts.length} text(s), context limit: ${contextLimit}, model: ${effectiveModel}`
  );

  return summarizeTextsRecursive(texts, template, model, agent, contextLimit, 0, agentOptions).catch((err) => {
    return `Texts of combined length ${texts.reduce((a, t) => a + t.length, 0)} could not be summarized due to error: ${err.message}`;
  });
}

export async function chunkText(text: string, chunkSize?: number) {
  chunkSize = chunkSize || text.length;

  const docs = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    docs.push(text.slice(i, i + chunkSize));
  }

  return docs;
}

export async function summarizeFiles(
  files: string[],
  template: string,
  model = "",
  agent = "",
  agentOptions?: AgentOptions
) {
  const texts = [];
  for (const file of files) {
    const text = `file: ${file}\n` + (await convertToText(file));
    texts.push(text);
  }
  return summarizeTexts(texts, template, model, agent, agentOptions);
}

export async function summarizeFile(
  file: string,
  template: string,
  model = "",
  agent = "",
  agentOptions?: AgentOptions
) {
  return await summarizeFiles([file], template, model, agent, agentOptions);
}

/*
 *export async function uploadToOpenAi(filePath: string) {
 *  // Upload a file with an "assistants" purpose
 *  const file = await openai.files.create({
 *    file: fs.createReadStream(filePath),
 *    purpose: "assistants",
 *  });
 *
 *  console.log(`File uploaded successfully. ID: ${file.id}`);
 *  return file;
 *}
 *
 */
/*
 *export async function createAssistant(assistant: Assistant) {
 *  const { name, tools, description, instructions, model } = assistant;
 *  console.log("Creating assistant is currently broken", assistant);
 *  return;
 *  const created = await openai.beta.assistants.create({
 *    name,
 *    tools,
 *    description,
 *    instructions,
 *    model,
 *  });
 *  console.log(`Assistant created successfully. ID: ${created.id}`);
 *  return created;
 *}
 */

export async function askGptVision(
  imageUrl: string,
  question: string,
  provider = "openai",
  model = Models.openai.GPT_4o
) {
  const response = await Clients.createCompletion(provider, {
    model,
    max_tokens: 2500,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: question },
          {
            type: "image_url",
            image_url: {
              url: imageUrl,
            },
          },
        ],
      },
    ],
  });

  return response;
}
