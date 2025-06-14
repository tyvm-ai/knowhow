import { Embeddable, MinimalEmbedding } from "../types";

export interface PluginMeta {
  key: string;
  name: string;
  description?: string;
  requires?: string[]; // Environment variables required
}

export interface Plugin {
  call(userInput?: string): Promise<string>;
  embed(userInput?: string): Promise<MinimalEmbedding[]>;
  enable(): void;
  disable(): void;
  isEnabled(): Promise<boolean>;

  meta: PluginMeta;
}
