# Knowhow Custom Modules Guide

Knowhow **modules** are the primary extension mechanism for adding new capabilities to the Knowhow CLI/runtime. A module is a dynamically loaded package (an npm package or a local file) that can register **tools**, **agents**, **plugins**, **AI clients**, and **chat commands**.

---

## 1) What modules are

When Knowhow starts, it reads configuration and **dynamically loads** each configured module. A module can extend Knowhow by contributing any of the following:

- **Tools**: functions that Knowhow/agents can call (tool calling)
- **Agents**: preconfigured agent definitions (prompts, tool access, etc.)
- **Plugins**: plugin objects registered under a module-provided name
- **AI clients**: provider/client/model registrations for model routing
- **Commands**: additional chat commands supported by the module
- **Initialization hook (`init`)**: async setup work before registration

---

## 2) Configuring modules (`knowhow.json`)

In your project’s `knowhow.json`, add a `modules` array.

```jsonc
{
  "modules": [
    "@acme/knowhow-module-internal-api",
    "./modules/local-module.js"
  ]
}
```

### Supported module entries
Each entry supports both:

- **npm package names** (e.g. `@acme/knowhow-module-internal-api`)
- **local file paths** (e.g. `./modules/local-module.js`)

> Tip: Use the correct extension/format for your runtime (often compiled `.js`). If you author in TypeScript, compile to a Node-loadable format first.

---

## 3) Global vs local modules

Knowhow supports both a global and local configuration:

1. **Global config**: `~/.knowhow/knowhow.json`
2. **Local config**: your project’s `knowhow.json`

### Load order
Modules load in this order:

1. **Global modules** from `~/.knowhow/knowhow.json` load **first**
2. **Local modules** from `./knowhow.json` load **after**

This means local modules can add additional capabilities or change behavior depending on how Knowhow merges/handles registrations (for example, tool name conflicts).

---

## 4) The `KnowhowModule` interface

A module must export an object compatible with the `KnowhowModule` interface. At minimum, a module must provide:

### `init(params)` (async initialization)
```ts
async init(params): Promise<void>
```

Knowhow calls `init` during module loading so you can perform setup such as:

- validate config
- read environment variables/secrets
- initialize API clients
- precompute schemas or caches

### `tools`
```ts
tools: Array<{
  name: string;
  handler: (...args: any[]) => any;
  definition: any;
}>
```

Your module provides tools as entries with:
- **`name`**: the tool name
- **`handler`**: the implementation function
- **`definition`**: tool metadata/schema

#### Important: tool definition shape
In Knowhow’s tool registration flow, tool metadata is used to register the tool, and the tool handler is bound using the tool definition’s function name. That implies your `definition` must include a function name (commonly via something like `definition.function.name`).

A typical definition looks like:

```ts
{
  type: "function",
  function: {
    name: "my_tool",
    description: "...",
    parameters: { /* JSON-schema-like */ }
  }
}
```

### `agents`
```ts
agents: any[] // array of agent configs (shape depends on Knowhow)
```

Agents are module-provided configurations. The exact schema depends on your Knowhow version, but typically includes:

- agent name
- instructions/system prompt
- allowed tools (by tool name)
- model/provider selection (or references to registered clients/models)

### `plugins`
```ts
plugins: Array<{
  name: string;
  plugin: any; // plugin instance/object
}>
```

### `clients`
```ts
clients: Array<{
  provider: string;
  client: any;     // AI client instance/constructor
  models: string[]; // supported model IDs
}>
```

### `commands`
```ts
commands: any[] // chat commands
```

Commands are additional chat-loop commands exposed by your module (exact handler signature depends on Knowhow’s command system).

---

## 5) Writing a custom module (step-by-step)

Below is a practical workflow with a concrete example at the end.

### Step 1 — Create the module file
Example layout:

```
your-project/
  knowhow.json
  modules/
    hello-module.js   (or hello-module.ts compiled to js)
```

### Step 2 — Implement `init(params)`
Create an async function that performs any setup once at startup.

### Step 3 — Add a custom tool (with a definition)
Add a tool entry:
- choose a unique tool `name`
- implement `handler`
- provide `definition` with a callable-function name (commonly `definition.function.name`)

### Step 4 — Add a custom agent
Add an agent config referencing your tools and setting prompt/model behavior.

### Step 5 — Register the module in `knowhow.json`
Add your module path or npm package to the `modules` array.

---

## 6) Plugin packages (`pluginPackages`)

In addition to full **modules**, Knowhow can load **plugin-only** npm packages via a configuration map called `pluginPackages`.

Conceptually, Knowhow will iterate `pluginPackages` entries and load/instantiate them, typically expecting a default export that represents a plugin constructor/class.

Example (conceptual):

```jsonc
{
  "pluginPackages": {
    "acme-lint": "@acme/knowhow-plugin-eslint",
    "kb": "./plugins/my-kb-plugin.js"
  }
}
```

**Use `pluginPackages` when** your package is intended to register plugins only and doesn’t need to define tools/agents/clients.

---

## 7) Use cases

Modules are ideal for connecting Knowhow to your organization’s environment, for example:

1. **Connect to internal APIs**
   - Build tools like `internal_ticket_create`, `internal_user_lookup`, `internal_doc_search`
   - Use `init` to authenticate and construct API clients

2. **Custom tools**
   - Wrap internal services as LLM-callable tools
   - Provide JSON-schema-like definitions so agents can call them safely

3. **Company-specific agents**
   - Ship agents tuned for your workflows (support triage, engineering review, compliance checks)
   - Restrict agents to only the tools you want them to use

4. **Custom AI clients**
   - Register model providers that point to internal gateways or custom hosting
   - Limit allowed models to those approved by your org

---

## Complete working TypeScript example (minimal module)

> This is a minimal module that:
> - implements `init`
> - registers one tool with a `definition.function.name`
> - registers one agent
> - leaves plugins/clients empty
> - registers one chat command
>
> **Save as:** `modules/minimal-module.ts`  
> **Compile to JS** (CommonJS or runtime-compatible output), then reference the compiled `.js` in `knowhow.json`.

### `modules/minimal-module.ts`
```ts
// modules/minimal-module.ts

// If you have the exact Knowhow types in your repo, replace `any` with real imports.
// This example is intentionally robust against type mismatches.

type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: any;
  };
};

type KnowhowModule = {
  init: (params: { config: any; cwd: string }) => Promise<void> | void;
  tools: Array<{
    name: string;
    handler: (args: any) => Promise<any> | any;
    definition: ToolDefinition;
  }>;
  agents: any[];
  plugins: Array<{ name: string; plugin: any }>;
  clients: Array<{ provider: string; client: any; models: string[] }>;
  commands: any[];
};

const toolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "demo_echo",
    description: "Echoes input back to the caller.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to echo" }
      },
      required: ["text"],
      additionalProperties: false
    }
  }
};

const module: KnowhowModule = {
  // 1) Required async initialization hook
  async init({ config, cwd }) {
    // Example: validate config or prepare resources once at startup
    // console.log("[minimal-module] init", { cwd, hasConfig: !!config });
    void config;
    void cwd;
  },

  // 2) Tool registrations
  tools: [
    {
      name: "demo_echo",
      definition: toolDefinition,

      // Important: handler is bound to definition.function.name by Knowhow’s loader
      handler: async (args: any) => {
        const text = typeof args?.text === "string" ? args.text : "";
        return { echoed: text };
      }
    }
  ],

  // 3) Agent registrations (shape depends on Knowhow’s IAgent schema)
  agents: [
    {
      name: "demo-echo-agent",
      description: "A demo agent that can call demo_echo.",
      // Common pattern: restrict the agent to specific tools by name
      tools: ["demo_echo"],
      // Provide instructions/prompt. (Field names vary by Knowhow version.)
      systemPrompt: "You are a demo agent. When asked to echo, call demo_echo."
    }
  ],

  // 4) Plugin registrations (optional)
  plugins: [],

  // 5) AI client registrations (optional)
  clients: [],

  // 6) Chat commands (optional; exact handler signature depends on Knowhow)
  commands: [
    {
      name: "/echo",
      description: "Echo text using the demo_echo tool.",
      handler: (ctx: any) => {
        // This is a minimal placeholder. Depending on Knowhow’s command system,
        // you may need to call a tool runner from ctx.
        const raw = typeof ctx?.args === "string" ? ctx.args : ctx?.args?.text;
        const text = typeof raw === "string" ? raw : "hello";
        ctx?.reply?.({ text: `Echo: ${text}` });
      }
    }
  ]
};

// Export strategy:
// - If your Knowhow loader uses require(), CommonJS export can be safest.
// - This `export =` pattern works with CommonJS outputs.
export = module;
```

### Register it in `knowhow.json`

After compiling, point to the compiled JS file, for example:

```jsonc
{
  "modules": [
    "./modules/dist/minimal-module.js"
  ]
}
```

---

If you paste (or link) the exact `KnowhowModule`, `Tool` definition, and `IAgent` type shapes from your source tree, I can tailor the example to be **fully type-checked** (no `any`) and ensure your command handler matches the exact runtime signature.