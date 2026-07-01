# Custom Modules Guide (Knowhow CLI)

Knowhow **modules** are the primary extension mechanism for adding new capabilities—tools, agents, plugins, AI clients, and even chat commands—without modifying the Knowhow core.

This guide explains how modules are loaded and how to write your own.

---

## 1) What modules are

A **module** is a dynamically loaded JavaScript/TypeScript export (usually an **npm package**, sometimes a **local file**) that can extend Knowhow at runtime by providing:

- **Tools**: callable functions the LLM/agent can invoke
- **Agents**: additional agent definitions that can use tools
- **Plugins**: plugin instances registered into Knowhow’s plugin system
- **Clients**: AI clients (providers + model lists) registered into Knowhow
- **Commands**: chat commands the module can define

Knowhow loads modules listed in your config and then registers their contributions into the relevant services (Tools, Agents, Plugins, Clients).

---

## 2) Configuring modules (`modules` array in `knowhow.json`)

Add module package names and/or local paths to the `modules` array in `knowhow.json`.

### Local `knowhow.json` example

```jsonc
{
  "modules": [
    "@tyvm/knowhow-module-script",
    "./modules/my-company-module",
    "../../packages/knowhow-module-load-webpage"
  ]
}
```

### Supported module specifiers

From the loader behavior, `modules` entries can be:

- **npm package names** (e.g. `@scope/name`, `name`)
- **local file paths** that start with `"."` (relative to `process.cwd()`), e.g. `./modules/x`

**Resolution behavior highlights**
- Relative entries starting with `"."` are resolved with `path.resolve(process.cwd(), modulePath)`.
- Package names are resolved using `require.resolve()` with special search paths (see “Global vs local modules” below).

---

## 3) Global vs local modules (load order)

Knowhow supports:

- **Global modules**: `~/.knowhow/knowhow.json`
- **Local modules**: `./.knowhow/knowhow.json`

### Load order

Modules are loaded in this order:

1. **Global** `modules` array
2. **Local** `modules` array

This is done by concatenating:
- `...(globalConfig.modules || [])`
- `...(localConfig.modules || [])`

and then de-duplicating via `toUniqueArray(...)` (preserving order).

### Where module packages are resolved from

When loading module specifiers, Knowhow searches these locations (in order):

1. `./.knowhow/node_modules` (so `knowhow modules install` “just works”)
2. `~/.knowhow/node_modules` (global install)
3. `./node_modules` (project install)

---

## 4) The `KnowhowModule` interface (what a module must export)

A module must export an object that matches this interface:

```ts
export interface KnowhowModule {
  init: (params: InitParams) => Promise<void>;
  commands: ModuleChatCommand[];
  tools: ModuleTool[];
  agents: ModuleAgent[];
  plugins: ModulePlugin[];
  clients: ModuleClient[];
}
```

### Required exports / properties

#### `init(params)` (async)

```ts
init: (params: {
  config: Config;
  cwd: string;
  context?: ModuleContext;
}) => Promise<void>;
```

Knowhow calls `init()` before registering tools/agents/plugins/clients.

- `params.config` is your config (local + merged with globals by the caller)
- `params.cwd` is `process.cwd()`
- `params.context` may include services like `Tools`, `Agents`, `Plugins`, etc.
  - The loader checks `context.Agents`, `context.Tools`, etc. before registering.

#### `tools`

An array of:

```ts
type ModuleTool = {
  name: string;
  handler: (...args: any[]) => any;
  definition: Tool;
};
```

Knowhow registers each tool by:
- `context.Tools.addTool(tool.definition)`
- `context.Tools.setFunction(tool.definition.function.name, tool.handler)`

So your `definition` **must include** `definition.function.name`.

#### `agents`

```ts
export type ModuleAgent = IAgent;
```

So `agents` must be an array of `IAgent` objects (not just plain JSON configs), matching Knowhow’s agent interface.

#### `plugins`

```ts
type ModulePlugin = { name: string; plugin: PluginConstructor };
```

Knowhow registers each plugin with:

- `context.Plugins.registerPlugin(plugin.name, new plugin.plugin(context))`

So your module should provide a plugin constructor (`class ...`) that takes `PluginContext`.

#### `clients`

```ts
type ModuleClient = {
  client: GenericClient;
  provider: string;
  models: string[];
};
```

Knowhow registers each client with:

- `context.Clients.registerClient(client.provider, client.client)`
- `context.Clients.registerModels(client.provider, client.models)`

#### `commands`

```ts
type ModuleChatCommand = {
  name: string;
  description: string;
  handler: (ctx: any) => void;
};
```

Your module can define chat commands. (Registration happens elsewhere in the CLI; the interface is provided for modules to declare them.)

---

## 5) Writing a custom module (step-by-step)

Below is a realistic workflow you can follow.

### Step 1: Create the module file

Example local structure:

```
your-project/
  .knowhow/
  modules/
    my-company-module.ts
  .knowhow/knowhow.json
```

In `knowhow.json`, you’ll later point to:

```jsonc
{
  "modules": ["./modules/my-company-module"]
}
```

---

### Step 2: Implement `init(params)`

Typically used to:
- read config
- set up clients or API keys
- do any async initialization (discover endpoints, validate auth, etc.)

```ts
export async function init(params: InitParams) {
  // do async setup
}
```

In practice, you export the whole module object with `init`.

---

### Step 3: Add a custom tool

A tool is the most common extension. Provide:

- a unique tool `name`
- a `handler` function
- a `definition` object with `definition.function.name`

Knowhow will connect `definition.function.name` → `handler`.

---

### Step 4: Add a custom agent

Your module must provide `IAgent` objects. The exact shape depends on `IAgent` implementation in your Knowhow version.

**Pattern:** create an agent class/instance using Knowhow’s agent interfaces and add it to `agents`.

> Note: Since `IAgent` isn’t shown in the provided code, the exact constructor/signature may differ. Use Knowhow’s built-in agent implementations as reference and then export them as module `agents`.

---

### Step 5: Register the module in `knowhow.json`

```jsonc
{
  "modules": [
    "./modules/my-company-module"
  ]
}
```

Then run:

```bash
knowhow
```

(or restart the CLI) so the module gets loaded.

---

## 6) Plugin packages (plugin-only npm registrations)

Knowhow also supports **plugin-only packages** via a `pluginPackages`-style map (a simpler way to load/register plugins without a full “module” object).

Conceptually:

- `modules` are full modules (tools + agents + plugins + clients + commands)
- `pluginPackages` is for registering **plugins only** from npm packages

> The exact config schema can vary by Knowhow version. If you use `pluginPackages`, ensure the referenced package exports a plugin constructor compatible with Knowhow’s plugin system.

---

## 7) Use cases

Common reasons teams create custom modules:

1. **Connect to internal APIs**
   - Add tools that call `https://internal.company/api/...`
   - Add clients for proprietary model providers
   - Add agents that follow company workflows

2. **Company-specific tools**
   - e.g., “Create Jira ticket”, “Search internal docs”, “Trigger deployment”
   - Provide tool definitions with strict JSON schemas and safe handlers

3. **Company-specific agents**
   - Add agents with tailored instructions and model/provider selection
   - Reuse built-in tools and add new company-only tools

4. **Environment-specific behavior**
   - In `init`, detect environment variables, feature flags, or endpoint availability
   - Register only the tools/clients that are valid for this deployment

---

# Complete working TypeScript example (minimal module)

This minimal module registers **one tool**: `getGreeting({ name })`.

It includes:
- `init()`
- `tools` with a proper `definition.function.name`
- everything else left empty

> Save this file as: `./modules/minimal-greeting-module.ts` and reference it in `./.knowhow/knowhow.json`.

## `modules/minimal-greeting-module.ts`

```ts
import type { KnowhowModule, InitParams, ModuleTool } from "../src/services/modules/types";
import type { Tool } from "../src/clients/types";

/**
 * Minimal, working module:
 * - provides 1 tool
 * - no agents/plugins/clients/commands
 */
const toolDefinition: Tool = {
  type: "function",
  function: {
    name: "getGreeting",
    description: "Return a friendly greeting for a given name.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name to greet" }
      },
      required: ["name"]
    }
  }
};

const greetingTool: ModuleTool = {
  name: "getGreeting",
  definition: toolDefinition,
  handler: ({ name }: { name: string }) => {
    return `Hello, ${name}! 👋`;
  }
};

const module: KnowhowModule = {
  async init(_params: InitParams) {
    // Optional initialization.
    // You could validate env vars or configure SDK clients here.
  },

  commands: [],

  tools: [greetingTool],

  agents: [],
  plugins: [],
  clients: []
};

export default module;
```

## Register it in `./.knowhow/knowhow.json`

```jsonc
{
  "modules": ["./modules/minimal-greeting-module"]
}
```

Then restart Knowhow.

---

If you share your Knowhow version and (optionally) the `IAgent` / `Tool` type definitions from your repo, I can provide a fully compiling example that also includes a custom agent and a plugin/client.