import axios from "axios";
import {
  GenericClient,
  CompletionOptions,
  CompletionResponse,
  EmbeddingOptions,
  EmbeddingResponse,
} from "./types";
import fs from "fs";
import path from "path";

export class HttpClient implements GenericClient {
  constructor(private baseUrl: string, private headers = {}) {}

  setJwt(jwt: string) {
    this.headers = {
      ...this.headers,
      Authorization: `Bearer ${jwt}`,
    };
  }

  setBaseUrl(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  setKey(key: string) {
    this.setJwt(key);
  }

  loadJwtFile(filePath: string) {
    try {
      const jwtFile = path.join(process.cwd(), filePath);
      if (!fs.existsSync(jwtFile)) {
        throw new Error(`JWT file not found: ${filePath}`);
      }
      const jwt = fs.readFileSync(jwtFile, "utf-8").trim();
      this.setJwt(jwt);
    } catch (error) {
      console.error(`Error loading JWT file: ${error}`);
    }
  }

  async createChatCompletion(
    options: CompletionOptions
  ): Promise<CompletionResponse> {
    const body = {
      ...options,
      model: options.model,
      messages: options.messages,
      max_tokens: options.max_tokens || 3000,

      ...(options.tools && {
        tools: options.tools,
        tool_choice: "auto",
      }),
    };

    const response = await axios.post(
      `${this.baseUrl}/v1/chat/completions`,
      body,
      {
        headers: this.headers,
      }
    );

    const data = response.data;

    // Since this uses a keepalive, we need to detect 200 with error in body
    if (data.error) {
      throw new Error(JSON.stringify(data.error, null, 2));
    }

    return {
      choices: data.choices.map((choice: any) => ({
        message: {
          role: choice.message.role,
          content: choice.message.content,
          tool_calls: choice.message.tool_calls,
        },
      })),
      model: data.model,
      usage: data.usage,
      usd_cost: data.usd_cost,
    };
  }

  async createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse> {
    const response = await axios.post(
      `${this.baseUrl}/v1/embeddings`,
      {
        model: options.model,
        input: options.input,
      },
      {
        headers: this.headers,
      }
    );

    const data = response.data;

    // Since this uses a keepalive, we need to detect 200 with error in body
    if (data.error) {
      throw new Error(JSON.stringify(data.error, null, 2));
    }

    return {
      data: data.data,
      model: options.model,
      usage: data.usage,
      usd_cost: data.usd_cost,
    };
  }

  async getModels() {
    const response = await axios.get(`${this.baseUrl}/v1/models`, {
      headers: this.headers,
    });

    const data = response.data?.data;

    return data.map((model: any) => ({
      id: model.id,
      object: model.object,
      owned_by: model.owned_by,
    }));
  }
}
