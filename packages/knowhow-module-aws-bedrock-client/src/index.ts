import { BedrockAIClient, BEDROCK_DEFAULT_MODELS } from "./BedrockClient";

/**
 * knowhow-module-aws-bedrock-client
 *
 * Adds AWS Bedrock AI model access to knowhow via the Converse API.
 *
 * ## Setup
 * 1. Install: `npm install @tyvm/knowhow-module-aws-bedrock-client`
 * 2. Add to your knowhow.config.json:
 *    ```json
 *    {
 *      "modules": ["@tyvm/knowhow-module-aws-bedrock-client"]
 *    }
 *    ```
 * 3. Configure AWS credentials via env vars or ~/.aws/credentials:
 *    - AWS_ACCESS_KEY_ID
 *    - AWS_SECRET_ACCESS_KEY
 *    - AWS_REGION (default: us-east-1)
 *    - AWS_PROFILE (optional, for named profiles)
 *
 * ## Usage
 * Models are registered under the "bedrock" provider.
 * Use model IDs like:
 *   - "anthropic.claude-3-5-sonnet-20241022-v2:0"
 *   - "meta.llama3-1-70b-instruct-v1:0"
 *   - "amazon.nova-pro-v1:0"
 *   - "mistral.mistral-large-2402-v1:0"
 */

// KnowhowModule shape (inline to avoid hard runtime dep on @tyvm/knowhow)
interface KnowhowModule {
  init: (params: any) => Promise<void>;
  commands: any[];
  tools: any[];
  agents: any[];
  plugins: any[];
  clients: any[];
}

const bedrockModule: KnowhowModule = {
  async init({ context }) {
    if (!context?.Clients) {
      console.warn("[knowhow-module-aws-bedrock-client] No Clients context available.");
      return;
    }

    const region = process.env.AWS_REGION || "us-east-1";
    const client = new BedrockAIClient(region);

    // Register the client class so Clients.resolveClient() can use it
    context.Clients.registerClientClass("bedrock", {
      createClient: () => client as any,
    });

    // Register the client directly
    context.Clients.registerClient("bedrock", client as any);

    // Fetch and register models — falls back to static list if AWS call fails
    try {
      const models = await client.getModels();
      const modelIds = models.map((m) => m.id);
      const completionModels = models
        .filter((m) => m.modality?.includes("completion"))
        .map((m) => m.id);
      const embeddingModels = models
        .filter((m) => m.modality?.includes("embedding"))
        .map((m) => m.id);
      const imageModels = models
        .filter((m) => m.modality?.includes("image"))
        .map((m) => m.id);

      if (completionModels.length > 0) {
        context.Clients.registerModels("bedrock", completionModels);
      }
      if (embeddingModels.length > 0) {
        context.Clients.registerEmbeddingModels("bedrock", embeddingModels);
      }
      if (imageModels.length > 0) {
        context.Clients.registerImageModels("bedrock", imageModels);
      }

      console.log(
        `[knowhow-module-aws-bedrock-client] Registered ${modelIds.length} Bedrock models (region: ${region})`
      );
    } catch (error: any) {
      console.error(
        "[knowhow-module-aws-bedrock-client] Failed to register models:",
        error.message
      );
    }
  },
  commands: [],
  tools: [],
  agents: [],
  plugins: [],
  clients: [],
};

export default bedrockModule;
export { BedrockAIClient, BEDROCK_DEFAULT_MODELS };
