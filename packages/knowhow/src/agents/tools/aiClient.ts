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
  this: ToolsService,
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
  this: ToolsService,
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
  this: ToolsService,
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
  this: ToolsService
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

export async function listAllProviders(this: ToolsService): Promise<string[]> {
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

export async function listAllCompletionModels(
  this: ToolsService
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

  return contextClients.listAllCompletionModels();
}

export async function listAllEmbeddingModels(
  this: ToolsService
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

  return contextClients.listAllEmbeddingModels();
}
