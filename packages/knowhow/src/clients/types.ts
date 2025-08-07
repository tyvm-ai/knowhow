export type MessageContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | MessageContent[];

  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface OutputMessage extends Message {
  content: string;
}

export interface ToolProp {
  type: string;
  description: string;
  properties?: { [key: string]: ToolProp };
  items?: ToolProp;
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      positional?: boolean;
      properties: {
        [key: string]: ToolProp;
      };
      required: string[];
    };
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface CompletionOptions {
  model: string;
  messages: Message[];
  tools?: Tool[];
  tool_choice?: "auto" | "none";
  max_tokens?: number;
}

export interface CompletionResponse {
  choices: {
    message: OutputMessage;
  }[];

  model: string;
  usage: any;
  usd_cost?: number;
}

export interface EmbeddingOptions {
  input: string;
  model?: string;
}

export interface EmbeddingResponse {
  data: {
    object: string;
    embedding: number[];
    index: number;
  }[];
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
  usd_cost?: number;
}

export interface GenericClient {
  setKey(key: string): void;
  createChatCompletion(options: CompletionOptions): Promise<CompletionResponse>;
  createEmbedding(options: EmbeddingOptions): Promise<EmbeddingResponse>;
  getModels(): Promise<{ id: string }[]>;
}
