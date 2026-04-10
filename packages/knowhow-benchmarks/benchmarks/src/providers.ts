import { AIClient, HttpClient } from "../../ts_build/src/clients";

export async function registerProvider(
  provider: string,
  url: string,
  headers: Record<string, string>,
  clients: AIClient
): Promise<void> {
  const client = new HttpClient(url, headers);

  clients.registerClient(provider, client);
  await clients.loadProviderModels(provider);
}
