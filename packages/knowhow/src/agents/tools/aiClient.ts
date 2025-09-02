import { ToolsService } from "../../services/Tools";
import {
  GenericClient,
  CompletionOptions,
  CompletionResponse,
  EmbeddingOptions,
  EmbeddingResponse,
} from "../../clients/types";
import { services } from "../../services";

export function createAiCompletion(
  provider: string,
  options: CompletionOptions
): Promise<CompletionResponse> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.createCompletion(provider, options);
}

export function createEmbedding(
  provider: string,
  options: EmbeddingOptions
): Promise<EmbeddingResponse> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.createEmbedding(provider, options);
}

export async function listModelsForProvider(
  provider: string
): Promise<string[]> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.getRegisteredModels(provider);
}

export async function listAllModels(
): Promise<Record<string, string[]>> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.listAllModels();
}

export async function listAllProviders(): Promise<string[]> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.listAllProviders();
}

export async function listAllCompletionModels(): Promise<Record<string, string[]>> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.listAllCompletionModels();
}

export async function listAllEmbeddingModels(): Promise<Record<string, string[]>> {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;

  const toolContext = toolService.getContext();
  const { Clients: contextClients } = toolContext;

  if (!contextClients) {
    throw new Error("Clients not available in tool context");
  }

  return contextClients.listAllEmbeddingModels();
}
