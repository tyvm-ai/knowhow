# `knowhow.json` Configuration Reference

This document describes how to configure Knowhow CLI using a `knowhow.json` file (local or global).

- **Local path:** `.knowhow/knowhow.json`
- **Global path:** `~/.knowhow/knowhow.json`

> **Format:** JSON object  
> **Purpose:** Configure prompts, generation pipelines, embedding pipelines, plugins/modules, custom agents, MCP servers, model providers, chat UI, the worker sandbox, and language tooling (ycmd).

---

## Top-level keys

| Key | Type | Description | Example |
|---|---|---|---|
| `promptsDir` | `string` | Directory that contains prompt templates (`{promptName}.mdx`). | `.knowhow/prompts` |
| `sources` | `SourceConfig[]` | Generation pipeline(s) that turn inputs into generated outputs. | see “sources” section |
| `embedSources` | `EmbedSourceConfig[]` | Embedding pipeline(s) that turn inputs into embedding artifacts (often JSON). | see “embedSources” section |
| `embeddingModel` | `string` | Embedding model identifier used by the embedding pipeline. | `openai:EmbeddingAda2` *(value format depends on your setup)* |
| `plugins` | `PluginsConfig` | Enable/disable built-in plugins. | `{ "enabled": ["embeddings"], "disabled": [] }` |
| `pluginPackages` | `string[]` | Extra/custom plugin npm packages to load. | `["@myorg/knowhow-plugin-acme"]` |
| `modules` | `ModuleConfig[]` | Load custom npm modules that can add tools/agents/plugins/clients. | `[{"package":"@myorg/knowhow-module-x"}]` |
| `agents` | `AgentConfig[]` | Custom agent definitions (for generation/chat). | see “agents/assistants” section |
| `assistants` | `AgentConfig[]` | Additional/custom agent definitions (same shape as `agents`). | see “agents/assistants” section |
| `mcps` | `McpServerConfig[]` | MCP server configurations Knowhow can connect to. | see “mcps” section |
| `modelProviders` | `ModelProviderConfig[]` | Custom model provider endpoints. | see “modelProviders” section |
| `lintCommands` | `Record<string,string>` | Lint command per file extension. | `{ "ts": "eslint $1" }` |
| `chat` | `ChatConfig` | Chat runtime configuration (renderer + module wiring). | see “chat” section |
| `worker` | `WorkerConfig` | Worker execution and networking configuration. | see “worker” section |
| `skills` | `string[]` | Directories containing “skills” (domain/tool logic). | `[".knowhow/skills"]` |
| `files` | `FileSyncConfig` | File sync configuration (tooling-specific; schema varies by build). | see “files” section |
| `ycmd` | `YcmdConfig` | ycmd language-server configuration. | see “ycmd” section |

---

## `promptsDir`

- **Type:** `string`
- **Description:** Directory containing prompt templates as `{promptName}.mdx`.
- **How it’s used:** When a prompt name is referenced (e.g., `sources[].prompt`), Knowhow loads:
  - `path.join(promptsDir, `${promptName}.mdx`)`
- **Example:**
```json
{
  "promptsDir": ".knowhow/prompts"
}
```

---

## `sources` (generation pipeline)

- **Type:** `SourceConfig[]`
- **Description:** Defines how Knowhow generates outputs from inputs by selecting a prompt and (optionally) an agent and model.

### `SourceConfig`

| Key | Type | Required | Description | Example |
|---|---|---:|---|---|
| `input` | `string` | ✅ | Input path/glob/identifier for this stage. | `src/**/*.mdx` |
| `output` | `string` | ✅ | Output path (file or directory target). | `.knowhow/docs/` |
| `prompt` | `string` | ✅ | Prompt name (from `promptsDir`) or a prompt reference. | `BasicCodeDocumenter` |
| `kind` | `string` | ❌ | Generation “kind” (mode/behavior); often tied to plugins. | `summarization` |
| `agent` | `string` | ❌ | Name of a custom agent used for this source. | `Example agent` |
| `model` | `string` | ❌ | Model override for this source. | `gpt-4o-2024-08-06` |
| `outputExt` | `string` | ❌ | Output file extension override. | `.mdx` |
| `outputName` | `string` | ❌ | Output file/base name override. | `README.mdx` |

### Example
```json
{
  "sources": [
    {
      "input": "src/**/*.mdx",
      "output": ".knowhow/docs/",
      "prompt": "BasicCodeDocumenter"
    },
    {
      "input": ".knowhow/docs/**/*.mdx",
      "output": ".knowhow/docs/README.mdx",
      "prompt": "BasicProjectDocumenter",
      "kind": "project"
    }
  ]
}
```

---

## `embedSources` (embedding pipeline)

- **Type:** `EmbedSourceConfig[]`
- **Description:** Defines how Knowhow creates embeddings from inputs, with optional chunking and optional remote/upload settings.

### `EmbedSourceConfig`

| Key | Type | Required | Description | Example |
|---|---|---:|---|---|
| `input` | `string` | ✅ | Input path/glob/URL to embed. | `.knowhow/docs/**/*.mdx` |
| `output` | `string` | ✅ | Embedding artifact location (often JSON file). | `.knowhow/embeddings/docs.json` |
| `prompt` | `string` | ❌ | Optional preprocessing prompt name. | `BasicEmbeddingExplainer` |
| `kind` | `string` | ❌ | Embedding strategy/type (often plugin-driven). | `download` |
| `chunkSize` | `number` | ❌ | Chunk size for splitting content before embedding. | `2000` |
| `minLength` | `number` | ❌ | Minimum chunk length threshold. | `200` |
| `remote` | `string` | ❌ | Remote destination name/id (backend-specific). | `micahriggan/knowhow` |
| `remoteType` | `string` | ❌ | Remote backend type (e.g., `s3`, `github`). | `github` |
| `remoteId` | `string` | ❌ | Remote identity/index/collection id (backend-specific). | `docs-index-1` |
| `uploadMode` | `string` | ❌ | Upload/write mode (implementation-specific). | `overwrite` |

### Example
```json
{
  "embedSources": [
    {
      "input": ".knowhow/docs/**/*.mdx",
      "output": ".knowhow/embeddings/docs.json",
      "prompt": "BasicEmbeddingExplainer",
      "chunkSize": 2000
    },
    {
      "input": "src/**/*.ts",
      "output": ".knowhow/embeddings/code.json",
      "chunkSize": 2000
    }
  ]
}
```

### Example: embedding with `download` kind (URL input)
```json
{
  "embedSources": [
    {
      "input": "https://www.youtube.com/shorts/BYuMBK5Ll-s",
      "output": ".knowhow/embeddings/video.json",
      "chunkSize": 2000,
      "kind": "download"
    }
  ]
}
```

---

## `embeddingModel`

- **Type:** `string`
- **Description:** Embedding model identifier used by embedding tasks.
- **Example:**
```json
{
  "embeddingModel": "openai:EmbeddingAda2"
}
```

> Use the exact identifier format your Knowhow build expects (commonly defined by an `EmbeddingModels` enum/constant).

---

## `plugins`

- **Type:**
```ts
{
  enabled: string[];
  disabled: string[];
}
```
- **Description:** Enables/disables built-in plugins by name.

| Key | Type | Description | Example |
|---|---|---|---|
| `enabled` | `string[]` | List of enabled plugin identifiers. | `["embeddings","git"]` |
| `disabled` | `string[]` | List of disabled plugin identifiers. | `["github"]` |

### Example
```json
{
  "plugins": {
    "enabled": ["embeddings", "language", "git", "exec"],
    "disabled": []
  }
}
```

---

## `pluginPackages`

- **Type:** `string[]`
- **Description:** NPM package names to load additional/custom plugins from.

### Example
```json
{
  "pluginPackages": ["@myorg/knowhow-plugin-acme"]
}
```

---

## `modules`

- **Type:** `ModuleConfig[]` *(commonly represented as `{ package: string }` objects)*
- **Description:** Load custom npm modules that can provide tools/agents/plugins/clients.

### `ModuleConfig` (representative)
| Key | Type | Required | Description | Example |
|---|---|---:|---|---|
| `package` | `string` | ✅ | NPM package name (or module identifier) to load. | `@myorg/knowhow-module-mycopilot` |

### Example
```json
{
  "modules": [
    { "package": "@myorg/knowhow-module-custom-tools" },
    { "package": "@myorg/knowhow-module-chat-ui" }
  ]
}
```

---

## `agents` / `assistants`

- **Type:** `AgentConfig[]`
- **Description:** Custom agent definitions usable by generation/chat.
- **Note:** Both keys typically share the same schema; `assistants` may be treated as an alias/parallel list.

### `AgentConfig`

| Key | Type | Required | Description | Example |
|---|---|---:|---|---|
| `name` | `string` | ✅ | Agent identifier referenced by `sources[].agent`. | `Example agent` |
| `description` | `string` | ❌ | Short human-readable description. | `Docs writer` |
| `instructions` | `string` | ✅ | Agent system/developer instructions. | `Reply with ...` |
| `model` | `string` | ❌ | Model override used by this agent. | `gpt-4o-2024-08-06` |
| `provider` | `string` | ❌/✅ | Model provider key used by this agent. | `openai` |
| `tools` | `string[]` | ❌ | Tool names the agent is allowed to use. | `["git","exec"]` |
| `files` | `string[]` | ❌ | Files/dirs/globs provided as context for this agent. | `[".knowhow/docs/"]` |

### Example
```json
{
  "agents": [
    {
      "name": "Example agent",
      "description": "You can define agents in the config. They will have access to all tools.",
      "instructions": "Reply to the user saying 'Hello, world!'",
      "model": "gpt-4o-2024-08-06",
      "provider": "openai"
    }
  ]
}
```

### Example: agent with `tools` and `files`
```json
{
  "agents": [
    {
      "name": "Docs agent",
      "description": "Writes and updates project documentation.",
      "instructions": "Summarize changes and update docs with a clear changelog.",
      "model": "gpt-4o-2024-08-06",
      "provider": "openai",
      "tools": ["git", "exec"],
      "files": [".knowhow/docs/"]
    }
  ]
}
```

---

## `mcps` (MCP servers)

- **Type:** `McpServerConfig[]`
- **Description:** Configure MCP servers Knowhow can spawn or connect to.

### `McpServerConfig`

| Key | Type | Required | Description | Example |
|---|---|---:|---|---|
| `name` | `string` | ✅ | MCP server name. | `browser` |
| `command` | `string` | ❌ | Command used to start the MCP server. | `npx` |
| `args` | `string[]` | ❌ | Arguments for `command`. | `["-y","@playwright/mcp@latest", "..."]` |
| `url` | `string` | ❌ | Remote MCP URL (if applicable). | `http://localhost:3000` |
| `autoConnect` | `boolean` | ❌ | Whether Knowhow connects automatically. | `true` |

### Example
```json
{
  "mcps": [
    {
      "name": "browser",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--browser", "chrome"],
      "autoConnect": true
    }
  ]
}
```

---

## `modelProviders`

- **Type:** `ModelProviderConfig[]`
- **Description:** Register custom model providers/endpoints.

### `ModelProviderConfig`

| Key | Type | Required | Description | Example |
|---|---|---:|---|---|
| `url` | `string` | ✅ | Base URL of the provider endpoint. | `http://localhost:1234` |
| `provider` | `string` | ✅ | Provider key/name used by `agents.provider`. | `lms` |
| `jwtFile` | `string` | ❌ | Path to a JWT file for auth. | `~/.knowhow/.jwt/myprovider.jwt` |

### Example
```json
{
  "modelProviders": [
    { "url": "http://localhost:1234", "provider": "lms" }
  ]
}
```

---

## `lintCommands`

- **Type:** `Record<string,string>`
- **Description:** Map file extensions to lint commands.
  - Common behavior: keys are extensions like `"ts"`, and the command is run with `$1` replaced by the patched file path.

### Example
```json
{
  "lintCommands": {
    "js": "eslint $1",
    "ts": "eslint $1"
  }
}
```

---

## `chat`

- **Type:** `ChatConfig`
- **Description:** Configure chat renderer and module wiring.

### `ChatConfig`

| Key | Type | Required | Description | Example |
|---|---|---:|---|---|
| `renderer` | `string` | ❌ | Renderer module name/path. | `default` |
| `modules` | `string[]` | ❌ | Chat modules to load. | `["@myorg/knowhow-chat-ui"]` |
| `rootModule` | `string` | ❌ | Root module entry. | `knowhow-chat` |

### Example
```json
{
  "chat": {
    "renderer": "default",
    "modules": ["@myorg/knowhow-chat-ui"],
    "rootModule": "knowhow-chat"
  }
}
```

---

## `worker`

- **Type:** `WorkerConfig`
- **Description:** Worker execution/sandbox/tunnel configuration for tools.

### `worker` keys

| Key | Type | Required | Description | Example |
|---|---|---:|---|---|
| `allowedTools` | `string[]` | ❌ | Tool names permitted to run in the worker. | `["exec","download"]` |
| `sandbox` | `boolean` | ❌ | Enable/disable sandboxing for tool execution. | `true` |
| `volumes` | `string[]` | ❌ | Volume mounts (implementation-dependent). | `[".:/workspace"]` |
| `envFile` | `string` | ❌ | Path to an env file loaded by the worker. | `.env.worker` |
| `tunnel` | `WorkerTunnelConfig` | ❌ | Network tunnel configuration. | see below |

### `worker.tunnel`

- **Type:**
```ts
{
  enabled: boolean;
  allowedPorts: number[];
}
```

### Example
```json
{
  "worker": {
    "allowedTools": ["exec", "download"],
    "sandbox": true,
    "volumes": [".:/workspace"],
    "envFile": ".env.worker",
    "tunnel": {
      "enabled": true,
      "allowedPorts": [3000, 8080]
    }
  }
}
```

---

## `skills`

- **Type:** `string[]`
- **Description:** Directories to scan for “skills” definitions.

### Example
```json
{
  "skills": [".knowhow/skills", "skills"]
}
```

---

## `files` (file sync config)

- **Type:** `FileSyncConfig` *(schema varies by Knowhow build/version)*
- **Description:** Configure how files are synced between local filesystem and Knowhow’s filesystem/runtime.

### Example (illustrative shape)
```json
{
  "files": {
    "syncDir": ".knowhow/sync",
    "include": ["src/**/*", ".knowhow/docs/**/*"],
    "exclude": ["**/node_modules/**", "**/.git/**"]
  }
}
```

> If you paste your `Config`/`FileSyncConfig` type from `src/types.ts`, I can replace this “illustrative shape” with the exact keys/types.

---

## `ycmd` (language server)

- **Type:** `YcmdConfig`
- **Description:** Configure the ycmd language server.

### `YcmdConfig`

| Key | Type | Required | Description | Example |
|---|---|---:|---|---|
| `enabled` | `boolean` | ❌ | Whether ycmd is enabled. | `true` |
| `installPath` | `string` | ❌ | ycmd install path. | `~/.knowhow/ycmd` |
| `port` | `number` | ❌ | Listening port (`0` may mean “auto”). | `0` |
| `logLevel` | `string` | ❌ | Logging verbosity. | `info` |
| `completionTimeout` | `number` | ❌ | Completion request timeout (ms). | `5000` |

### Example
```json
{
  "ycmd": {
    "enabled": true,
    "installPath": "~/.knowhow/ycmd",
    "port": 0,
    "logLevel": "debug",
    "completionTimeout": 10000
  }
}
```

---

## Minimal `knowhow.json` example

```json
{
  "promptsDir": ".knowhow/prompts",
  "plugins": {
    "enabled": ["embeddings", "language", "git", "exec"],
    "disabled": []
  },
  "lintCommands": {
    "ts": "eslint $1",
    "js": "eslint $1"
  },
  "sources": [
    {
      "input": "src/**/*.mdx",
      "output": ".knowhow/docs/",
      "prompt": "BasicCodeDocumenter"
    }
  ],
  "embedSources": [
    {
      "input": ".knowhow/docs/**/*.mdx",
      "output": ".knowhow/embeddings/docs.json",
      "prompt": "BasicEmbeddingExplainer",
      "chunkSize": 2000
    }
  ],
  "embeddingModel": "openai:EmbeddingAda2",
  "agents": [
    {
      "name": "Example agent",
      "instructions": "Reply to the user saying 'Hello, world!'",
      "model": "gpt-4o-2024-08-06",
      "provider": "openai"
    }
  ],
  "mcps": [
    {
      "name": "browser",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--browser", "chrome"]
    }
  ],
  "modelProviders": [{ "url": "http://localhost:1234", "provider": "lms" }],
  "worker": {
    "tunnel": { "enabled": false, "allowedPorts": [] }
  }
}
```

---

### Want this to be 100% exact to your codebase?
If you paste `src/config.ts` and `src/types.ts` (the actual `Config`, `SourceConfig`, `EmbedSourceConfig`, `WorkerConfig`, `FileSyncConfig`, and `YcmdConfig` type definitions), I can regenerate this reference with:
- exact field names (no illustrative placeholders),
- exact optional/required fields,
- exact union literal types (e.g., allowed `uploadMode` values, `logLevel` enum values),
- and the real list of built-in plugin names + what each one does.