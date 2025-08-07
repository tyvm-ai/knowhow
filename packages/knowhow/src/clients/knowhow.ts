import {
  GenericClient,
  CompletionOptions,
  CompletionResponse,
  EmbeddingOptions,
  EmbeddingResponse,
} from "./types";
import { KnowhowSimpleClient } from "../services/KnowhowClient";

const envUrl = process.env.KNOWHOW_API_URL;
export class KnowhowGenericClient implements GenericClient {
  private client: KnowhowSimpleClient;

  constructor(private baseUrl = envUrl, jwt?: string) {
    this.setKey(jwt);
  }

  setKey(jwt: string): void {
    this.client = new KnowhowSimpleClient(this.baseUrl, jwt);
  }

  async createChatCompletion(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    const response = await this.client.createChatCompletion(options);
    return response.data;
  }

  async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
    const response = await this.client.createEmbedding(options);
    return response.data;
  }

  async getModels(): Promise<{ id: string }[]> {
    const response = await this.client.getModels();
    return response.data;
  }
}
