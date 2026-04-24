import { clients as knowhowClients } from "@tyvm/knowhow";
const { AIClient, HttpClient } = knowhowClients;

export async function registerProvider(
  provider: string,
  url: string,
  headers: Record<string, string>,
  aiClient: InstanceType<typeof AIClient>,
  timeout?: number
): Promise<void> {
  const client = new HttpClient(url, headers, timeout);

  aiClient.registerClient(provider, client);
  await aiClient.loadProviderModels(provider);
}
