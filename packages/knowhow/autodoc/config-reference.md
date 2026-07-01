# `knowhow.json` Configuration Reference

`knowhow.json` is the main configuration file for the **Knowhow CLI**. In a project, it lives at:

- `./.knowhow/knowhow.json`

During `knowhow init`, Knowhow also creates a global config at:

- `~/.knowhow/knowhow.json`

> This reference is derived from the `Config` type (`src/types.ts`) and the default config/template behavior (`src/config.ts`).

---

## Example (minimal)

```json
{
  "promptsDir": ".knowhow/prompts",
  "modules": [],
  "plugins": { "enabled": [], "disabled": [] },
  "sources": [],
  "embedSources": [],
  "embeddingModel": "openai:EmbeddingAda2",
  "agents": [],
  "mcps": [],
  "modelProviders": []
}
```

---

## Top-level keys

| Key | Type | Required | Default | Description |
|---|---|---:|---|---|
| `openaiBaseUrl` | `string` | No | — | Base URL override for OpenAI-compatible APIs. |
| `promptsDir` | `string` | **Yes** | `.knowhow/prompts` | Directory containing prompt templates (`*.mdx`). |
| `lintCommands` | `{ [fileExtension: string]: string }` | No | see defaults | Lint commands run after successful patches (by extension). |
| `orgId` | `string` | No | — | Organization ID (used by some providers / services). |
| `syncRemote` | `boolean` | No | `false` | Whether remote operations should use sync behavior (tooling-dependent). |
| `micCommand` | `string` | No | — | Mic command (for audio-related workflows; provider/tool-dependent). |
| `defaultMic` | `string` | No | — | Default microphone identifier (if applicable). |
| `sources` | `GenerationSource[]` | **Yes** | see defaults | File generation pipeline for `knowhow generate`. |
| `embedSources` | `EmbedSource[]` | **Yes** | see defaults | Embedding pipeline for `knowhow embed`. |
| `embeddingModel` | `string` | **Yes** | `EmbeddingModels.openai.EmbeddingAda2` | Embedding model ID/name. |
| `skills` | `string[]` | No | — | Directories to load “skills” from (custom behavior; plugin/tooling dependent). |
| `plugins` | `{ enabled: string[]; disabled: string[] }` | **Yes** | see defaults | Plugin enable/disable lists. |
| `chat` | `{ rootModule?: string; renderer?: string; modules?: string[] }` | No | — | Chat UI/runtime configuration. |
| `modules` | `string[]` | **Yes** | `[]` | Extra NPM modules to load (tools/agents/plugins/clients). |
| `agents` | `Assistant[]` | **Yes** | see default | Custom chat agents available in Knowhow chat. |
| `mcps` | `McpConfig[]` | **Yes** | see defaults | MCP servers to start/connect. |
| `modelProviders` | `ModelProvider[]` | **Yes** | see defaults | Custom model provider endpoints/config. |
| `ycmd` | `{ enabled?: boolean; installPath?: string; port?: number; logLevel?: ...; completionTimeout?: number }` | No | see defaults | ycmd language server configuration. |
| `files` | `{ remotePath: string; localPath: string; direction?: "download" \| "upload" \| "sync" }[]` | No | — | Remote/local file sync configuration. |
| `worker` | `worker` config object | No | partial defaults | Worker runtime sandbox/tunnel/tools. |

---

## `promptsDir`

- **Type:** `string`
- **Required:** Yes
- **Description:** Directory where prompt templates are stored. Prompt files are looked up as:
  - `${promptsDir}/${promptName}.mdx`
- **Default:** `.knowhow/prompts`

**Example**
```json
{
  "promptsDir": ".knowhow/prompts"
}
```

---

## `modules`

- **Type:** `string[]`
- **Required:** Yes
- **Description:** List of extra NPM modules to load. These can provide custom tools, agents, plugins, or clients.
- **Default:** `[]`

**Example**
```json
{
  "modules": ["@myorg/knowhow-tools", "@myorg/knowhow-agent-awesome"]
}
```

> Note: `knowhow init` automatically ensures `@tyvm/knowhow-module-script` is present in the global config.

---

## `plugins`

- **Type:**
  ```ts
  { enabled: string[]; disabled: string[] }
  ```
- **Required:** Yes
- **Default:**
  ```json
  {
    "enabled": [
      "embeddings","language","git","vim","github","asana","jira","linear",
      "download","figma","url","tmux","agents-md","exec"
    ],
    "disabled": []
  }
  ```
- **Description:** Enables/disables plugin names. Plugins provide integrations/tools and (for embedding) implementations keyed by `embedSources[].kind`.

### Default/commonly referenced plugins

| Plugin name | What it does (based on shipped examples) |
|---|---|
| `embeddings` | Provides embedding support; used by `embedSources` via `kind`. |
| `language` | Language terms/hotkeys that expand into larger content (configured in `.knowhow/language.json`). |
| `git` | Git integration (resolve/operate on git-related data; exact behavior plugin-defined). |
| `vim` | Vim integration for loading/editing files (chat tools and patching flows). |
| `github` | Resolve GitHub resources (PRs/issues) and fetch content referenced by URLs. |
| `asana` | Resolve Asana tasks/lists referenced in inputs. |
| `jira` | Resolve Jira issues/projects referenced in inputs. |
| `linear` | Resolve Linear issues referenced in inputs. |
| `download` | Download remote content referenced by `embedSources` / other pipelines. |
| `figma` | Resolve design files from Figma. |
| `url` | Resolve/generalize URL references into usable content. |
| `tmux` | Integrate with tmux sessions (tooling-dependent). |
| `agents-md` | Markdown-backed agent definitions (tooling-dependent). |
| `exec` | Execute commands (tooling-dependent). |
| `notion` *(seen in examples)* | Notion integration (tooling-dependent). |

**Example**
```json
{
  "plugins": {
    "enabled": ["embeddings", "language", "github", "asana"],
    "disabled": ["exec"]
  }
}
```

---

## `lintCommands`

- **Type:** `{ [fileExtension: string]: string }`
- **Required:** No
- **Default (partial):**
  ```json
  { "js": "eslint", "ts": "tslint" }
  ```
- **Description:** Commands run after an agent successfully patches a file, when the patched file extension matches the key.  
  - `$1` is replaced with the patched file path.

**Example**
```json
{
  "lintCommands": {
    "js": "eslint $1",
    "ts": "tsc -p tsconfig.json && eslint $1"
  }
}
```

---

## `sources` (generation pipeline)

- **Type:** `GenerationSource[]`
- **Required:** Yes
- **Purpose:** Used by `knowhow generate` to process input files and write output artifacts.

Each `GenerationSource` has:

| Field | Type | Required | Default | Description |
|---|---|---:|---|---|
| `input` | `string` | Yes | — | Glob/path(s) to read input files. |
| `output` | `string` | Yes | — | Output directory or file target. |
| `prompt` | `string` | Yes | — | Prompt name (looks up `${promptsDir}/${prompt}.mdx`) or a direct prompt string. |
| `kind` | `string` | No | — | Optional kind for pipeline/tooling behavior. |
| `agent` | `string` | No | — | Agent name to use for generating output. |
| `model` | `string` | No | — | Model override. |
| `outputExt` | `string` | No | — | Output file extension override. |
| `outputName` | `string` | No | — | Output file name override. |

**Example**
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
      "prompt": "BasicProjectDocumenter"
    }
  ]
}
```

**Example (agent + model)**
```json
{
  "sources": [
    {
      "input": ".knowhow/downloads/**/*.webm",
      "output": ".knowhow/organized/",
      "prompt": "FSOrganizer",
      "agent": "Developer",
      "model": "gpt-5.4-nano"
    }
  ]
}
```

---

## `embedSources` (embedding pipeline)

- **Type:** `EmbedSource[]`
- **Required:** Yes
- **Purpose:** Used by `knowhow embed` to generate embedding JSON and optionally upload/download remote embeddings.

Each `EmbedSource` has:

| Field | Type | Required | Default | Description |
|---|---|---:|---|---|
| `input` | `string` | Yes | — | Glob/path(s) or remote input. |
| `output` | `string` | Yes | — | Where the embeddings JSON is written locally. |
| `prompt` | `string` | No | — | Optional prompt name for preprocessing before embedding (`${promptsDir}/${prompt}.mdx`). |
| `kind` | `string` | No | — | Plugin “kind” that implements embedding for this source (any plugin that implements embedding for that `kind`). |
| `chunkSize` | `number` | No | — | Embedding chunk size (e.g., `2000`). |
| `minLength` | `number` | No | — | Minimum text length threshold before embedding. |
| `remote` | `string` | No | — | Remote target name used by upload tooling (plugin/tooling-dependent). |
| `remoteType` | `string` | No | — | Remote type; examples include `s3` and `github*`. |
| `remoteId` | `string` | No | — | Remote identifier (e.g., bucket/object or known embedding set id). |
| `uploadMode` | `boolean` | No | — | Controls uploading behavior (tooling-dependent). |

### Upload/download remote options (from examples)
- **S3:** `remoteType: "s3"` (upload via `knowhow upload`)
- **GitHub (`github*`):** download/upload via git LFS workflows (tooling-dependent)

**Example (local docs + prompt preprocessing)**
```json
{
  "embedSources": [
    {
      "input": ".knowhow/docs/**/*.mdx",
      "output": ".knowhow/embeddings/docs.json",
      "prompt": "BasicEmbeddingExplainer",
      "chunkSize": 2000
    }
  ]
}
```

**Example (code embedding)**
```json
{
  "embedSources": [
    {
      "input": "src/**/*.ts",
      "output": ".knowhow/embeddings/code.json",
      "chunkSize": 2000
    }
  ]
}
```

**Example (remote embeddings via S3 + kind)**
```json
{
  "embedSources": [
    {
      "input": "https://app.asana.com/0/111111111111111/list",
      "output": ".knowhow/embeddings/asana.json",
      "remote": "mybucket",
      "remoteType": "s3",
      "kind": "asana",
      "chunkSize": 2000
    }
  ]
}
```

---

## `embeddingModel`

- **Type:** `string`
- **Required:** Yes
- **Default:** `EmbeddingModels.openai.EmbeddingAda2`
- **Description:** The embedding model identifier to use for embedding generation.

**Example**
```json
{
  "embeddingModel": "openai:EmbeddingAda2"
}
```

---

## `agents` (custom chat agents)

- **Type:** `Assistant[]`
- **Required:** Yes
- **Default:** includes an “Example agent”
- **Description:** Defines named agents that can be selected in chat sessions. Agents are provided with:
  - tool access (as determined by enabled plugins and loaded modules)
  - prompt instructions
  - an optional model/provider

**Important:** Your prompt/examples mention `assistants`, but the current `Config` type only defines **`agents`**.

### `Assistant` fields

| Field | Type | Required | Default | Description |
|---|---|---:|---|---|
| `name` | `string` | No | — | Agent name (used in chat selection). |
| `description` | `string` | No | — | Short agent description. |
| `instructions` | `string` | **Yes** | — | Agent behavior/instructions. |
| `model` | `string` | No | — | Model override. |
| `provider` | `keyof Providers` | No | — | Provider key (e.g., `openai`, `anthropic`, `google`, `xai`, etc.). |

**Example**
```json
{
  "agents": [
    {
      "name": "Example agent",
      "description": "You can define agents in the config. They will have access to all tools.",
      "instructions": "Reply to the user saying 'Hello, world!'",
      "model": "gpt-5.4-nano",
      "provider": "openai"
    }
  ]
}
```

---

## `mcps` (MCP servers)

- **Type:** `McpConfig[]`
- **Required:** Yes
- **Default:** includes a `browser` MCP example
- **Description:** Configure MCP servers Knowhow can launch/connect to.

### `McpConfig` fields

| Field | Type | Required | Default | Description |
|---|---|---:|---|---|
| `name` | `string` | **Yes** | — | MCP server name. |
| `autoConnect` | `boolean` | No | — | Whether to auto-connect. |
| `command` | `string` | No | — | Command to run (e.g., `npx`). |
| `args` | `string[]` | No | — | Command arguments. |
| `url` | `string` | No | — | If provided, connect via URL instead of launching a process. |
| `env` | `{ [key: string]: string }` | No | — | Environment variables for the process. |
| `params` | `Partial<{ socket: WebSocket }>` | No | — | Advanced socket parameters (implementation-dependent). |
| `authorization_token` | `string` | No | — | Authorization token for the MCP endpoint. |
| `authorization_token_file` | `string` | No | — | Path to a file containing the token. |

**Example**
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

## `modelProviders` (custom model providers)

- **Type:** `ModelProvider[]`
- **Required:** Yes
- **Default (examples):** includes `openai`, `anthropic`, `google`, `xai`, `knowhow`, and `lms`.

### `ModelProvider` fields

| Field | Type | Required | Default | Description |
|---|---|---:|---|---|
| `provider` | `string` | **Yes** | — | Provider key (must match Knowhow’s provider selection). |
| `url` | `string` | No | — | Base URL for the provider endpoint. |
| `envKey` | `string` | No | — | Environment variable name holding provider auth (e.g., `OPENAI_API_KEY`). |
| `headers` | `{ [key: string]: string }` | No | — | Additional HTTP headers. |
| `jwtFile` | `string` | No | — | Path to a JWT file. |
| `timeout` | `number` | No | — | Request timeout. |
| `extra_body` | `Record<string, any>` | No | — | Extra fields injected into provider requests. |
| `pricing` | `Record<string, { input?: number; output?: number; cached_input?: number; cache_hit?: number }>` | No | — | Optional model pricing map. |
| *(Note)* `pricing` is passed to `HttpClient.setPrices()` per code comments. | | | | |

**Example (LMS Studio / custom endpoint)**
```json
{
  "modelProviders": [
    {
      "url": "http://localhost:1234",
      "provider": "lms"
    }
  ]
}
```

---

## `chat` (chat config)

- **Type:**
  ```ts
  {
    rootModule?: string;
    renderer?: string;
    modules?: string[];
  }
  ```
- **Required:** No
- **Description:** Configures chat runtime: renderer and module loading for chat UI/tooling.

**Example**
```json
{
  "chat": {
    "renderer": "@knowhow/chat-renderer-default",
    "rootModule": "@knowhow/chat-root",
    "modules": ["@myorg/knowhow-chat-mods"]
  }
}
```

---

## `worker` (worker runtime config)

- **Type:**
  ```ts
  {
    allowedTools?: string[];
    workerId?: string;
    sandbox?: boolean;
    volumes?: string[];
    envFile?: string;
    auth?: { ... };
    commandAuth?: { [toolName: string]: "always" | "session" | "never" };
    tunnel?: {
      enabled?: boolean;
      allowedPorts?: number[];
      maxConcurrentStreams?: number;
      portMapping?: { [containerPort: number]: number };
      localHost?: string;
      enableUrlRewriting?: boolean;
    };
  }
  ```
- **Required:** No
- **Default (partial):**
  ```json
  {
    "worker": {
      "tunnel": { "enabled": false, "allowedPorts": [] }
    }
  }
  ```

### Worker fields

| Field | Type | Required | Default | Description |
|---|---|---:|---|---|
| `allowedTools` | `string[]` | No | — | Tools the worker is allowed to expose. |
| `workerId` | `string` | No | — | Identifier for the worker instance. |
| `sandbox` | `boolean` | No | — | Whether to run tools in a sandbox. |
| `volumes` | `string[]` | No | — | Volume mappings for containerized execution. |
| `envFile` | `string` | No | — | Path to an env file used by the worker. |
| `auth` | object | No | — | Authentication requirements for worker access. |
| `commandAuth` | `{ [toolName: string]: "always" \| "session" \| "never" }` | No | — | Per-tool authorization policy. |
| `tunnel` | object | No | — | Network tunneling configuration. |

#### `worker.auth`

| Field | Type | Description |
|---|---|---|
| `required` | `boolean` | Whether auth is required. |
| `passkey.publicKey` | `string` | Passkey public key. |
| `passkey.credentialId` | `string` | Passkey credential id. |
| `passkey.algorithm` | `string` | Passkey algorithm. |
| `sessionDurationHours` | `number` | Session TTL in hours. |

#### `worker.tunnel`

| Field | Type | Description |
|---|---|---|
| `enabled` | `boolean` | Enable tunneling. |
| `allowedPorts` | `number[]` | Ports allowed for tunneling. |
| `maxConcurrentStreams` | `number` | Max concurrent tunnel streams. |
| `portMapping` | `{ [containerPort: number]: number }` | Container→local port mapping. |
| `localHost` | `string` | Host used for local forwarding. |
| `enableUrlRewriting` | `boolean` | Rewrite URLs for proxied access. |

**Example (expose tools via tunnel disabled)**
```json
{
  "worker": {
    "allowedTools": [
      "embeddingSearch",
      "finalAnswer",
      "readFile",
      "writeFileChunk",
      "mcp_0_puppeteer_screenshot"
    ],
    "tunnel": {
      "enabled": false,
      "allowedPorts": []
    }
  }
}
```

---

## `skills`

- **Type:** `string[]`
- **Required:** No
- **Description:** List of directories to load skills from (implementation-specific; used by skill/tool orchestration).

**Example**
```json
{
  "skills": ["./skills/common", "./skills/my-special-skill"]
}
```

---

## `files` (file sync configuration)

- **Type:**
  ```ts
  {
    remotePath: string;
    localPath: string;
    direction?: "download" | "upload" | "sync";
  }[]
  ```
- **Required:** No
- **Description:** Declare remote↔local file sync entries.

**Example**
```json
{
  "files": [
    {
      "remotePath": "s3://mybucket/embeddings/docs.json",
      "localPath": ".knowhow/embeddings/docs.json",
      "direction": "download"
    }
  ]
}
```

---

## `ycmd` (language server config)

- **Type:**
  ```ts
  {
    enabled?: boolean;
    installPath?: string;
    port?: number;            // 0 for auto-assign
    logLevel?: "debug" | "info" | "warning" | "error";
    completionTimeout?: number;
  }
  ```
- **Required:** No
- **Default (from `config.ts`):**
  ```json
  {
    "enabled": false,
    "installPath": undefined,
    "port": 0,
    "logLevel": "info",
    "completionTimeout": 5000
  }
  ```
- **Description:** Configures **ycmd** installation and server behavior.

**Example**
```json
{
  "ycmd": {
    "enabled": true,
    "port": 8123,
    "logLevel": "debug",
    "completionTimeout": 8000
  }
}
```

---

## Other configuration keys

### `openaiBaseUrl`
- **Type:** `string`
- **Default:** —  
- **Description:** Base URL override for OpenAI-compatible clients.

**Example**
```json
{
  "openaiBaseUrl": "http://localhost:11434/v1"
}
```

### `orgId`
- **Type:** `string`
- **Description:** Organization ID (provider/service dependent).

### `syncRemote`
- **Type:** `boolean`
- **Description:** Enables sync behavior for remote operations (tooling-dependent).

### `micCommand` / `defaultMic`
- **Type:** `string`
- **Description:** Audio/microphone configuration (implementation/tooling dependent).

---

If you want, paste your current `knowhow.json` and I’ll validate it against this schema-style reference and suggest fixes for missing/invalid fields.