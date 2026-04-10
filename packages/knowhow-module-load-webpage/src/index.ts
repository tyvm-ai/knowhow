import { KnowhowModule, ModuleTool } from "@tyvm/knowhow";
import { loadWebpage } from "./loadWebpage";
export type { LoadWebpageOptions } from "./loadWebpage";

const loadWebpageDefinition = {
  type: "function" as const,
  function: {
    name: "loadWebpage",
    description: "Load and extract text content or screenshot from a webpage using a headless browser. Handles JavaScript-rendered content, SPAs, and sites with bot protection.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        url: { type: "string", description: "The URL to load" },
        mode: { type: "string", enum: ["text", "screenshot"], description: "text returns page content, screenshot returns base64 PNG" },
        waitForSelector: { type: "string", description: "Optional CSS selector to wait for before extracting content" },
        timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
      },
      required: ["url"],
    },
  },
};

const tools: ModuleTool[] = [
  {
    name: "loadWebpage",
    handler: loadWebpage,
    definition: loadWebpageDefinition,
  },
];

const module: KnowhowModule = {
  async init() {},
  tools,
  agents: [],
  plugins: [],
  clients: [],
  commands: [],
};

export default module;
export { loadWebpage };
