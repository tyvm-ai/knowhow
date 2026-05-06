import { clients as knowhowClients } from "@tyvm/knowhow";
const { AIClient, HttpClient } = knowhowClients;

export async function registerProvider(
  provider: string,
  url: string,
  headers: Record<string, string>,
  aiClient: InstanceType<typeof AIClient>,
  timeout?: number,
  extra_body?: Record<string, any>
): Promise<void> {
  const client = new HttpClient(url, { headers, timeout, extra_body });

  aiClient.registerClient(provider, client);
  await aiClient.loadProviderModels(provider);
}
