# Plugins Guide (Knowhow CLI)

Knowhow **plugins** are modular “context providers” and helpers that can enrich an agent session with additional information and tooling. Depending on the plugin, it can:

- **Expand shorthand terms / hotkeys** into files, snippets, and/or URLs (`language`)
- **Load live editor/session context** (e.g., open Vim buffers) (`vim`)
- **Perform semantic retrieval** using embeddings (`embeddings`)
- **Resolve work-item references** (GitHub, Asana, Jira, Linear) into readable context (`github`, `asana`, `jira`, `linear`)
- **Load rich external content** (web pages, downloads/transcripts, design docs) (`url`, `download`, `figma`, `notion`)
- **Add codebase signals** (git diff/log) (`git`)
- **Run safety/quality tooling** after edits (linting) (`linter`)
- **Incorporate terminal/session state** (`tmux`)
- **Load local guidance docs** (`agents-md`, `skills`)
- **Execute commands for context** (`exec`)

Internally, Knowhow maintains a **plugin registry** and can call plugins by their **plugin key** (e.g., `github`, `language`). Plugins can also support **embeddings** via an `embed()`-style capability.

---

## 1) What plugins are (how they provide context)

### 1.1 Plugin “capabilities”
Most plugins fall into one or more of these roles:

- **Context generation (`call`)**  
  Reads input (prompt content, URLs, IDs, etc.) and returns text/markdown context.

- **Batch processing (`callMany`)**  
  Used when multiple values must be resolved at once (e.g., many URLs).

- **Embeddings (`embed`)**  
  Returns `MinimalEmbedding[]` items so Knowhow can do semantic retrieval over fetched/constructed content.

### 1.2 Common patterns
- **URL / identifier resolution**  
  A plugin detects an identifier in the user prompt and fetches/normalizes it into agent-ready context.  
  Examples: GitHub PR/issue, Jira ticket, Linear issue, Notion page.

- **Language-term expansion** (`language`)  
  A plugin mapping turns configured tokens/hotkeys into:
  - local file contents (`kind: "file"`)
  - literal text snippets (`kind: "text"`)
  - URLs or references (often via `kind: "url"` or a service plugin key like `github`)

- **Local environment context**
  - `vim`: injects currently open Vim buffers
  - `git`: injects git diff/log context
  - `tmux`: injects terminal pane/session context

- **Post-edit automation**
  - `linter`: runs lint after file edits
  - `exec`: runs commands for context (powerful; see security note)

---

## 2) Enable / disable plugins (`knowhow.json`)

Plugins are controlled in `knowhow.json` using:

- `plugins.enabled`: array of plugin keys to enable
- `plugins.disabled`: array of plugin keys to disable

### 2.1 Enable a subset
```jsonc
{
  "plugins": {
    "enabled": ["language", "github", "embeddings", "git", "url", "linter"],
    "disabled": []
  }
}
```

### 2.2 Disable specific plugins
```jsonc
{
  "plugins": {
    "enabled": ["language", "vim", "tmux", "github", "url", "download"],
    "disabled": ["exec", "tmux"]
  }
}
```

> **Tip:** Avoid putting the same plugin in both lists. Use one source of truth in your config.

---

## 3) Built-in plugins (keys + config examples)

Built-in plugins are identified by these keys:

- `language`
- `vim`
- `embeddings`
- `github`
- `git`
- `asana`
- `jira`
- `linear`
- `figma`
- `notion`
- `download`
- `url`
- `linter`
- `tmux`
- `agents-md`
- `exec`
- `skills`

Below are practical configuration examples for each plugin key. Some plugin config fields are implementation-specific; the examples show **typical / commonly used** fields and where you’d place plugin-specific options.

---

### 3.1 `language` — language terms / hotkeys expansion

**What it does**
- Detects configured **language terms / hotkeys**
- Expands them into context sources like:
  - local files
  - literal snippets
  - plugin-backed resolutions (e.g., `github`)
  - URLs

**Typical config shape**
```jsonc
{
  "plugins": {
    "enabled": ["language"]
  },
  "language": {
    "terms": {
      "@spec": {
        "events": ["file:read", "agent:msg"],
        "sources": [
          { "kind": "file", "data": ["./docs/spec.md"] }
        ]
      },
      "@pr": {
        "events": ["agent:msg"],
        "sources": [
          { "kind": "github", "data": ["owner/repo#123"] }
        ]
      }
    },
    "hotkeys": {
      ":runbook": {
        "events": ["agent:msg"],
        "sources": [
          { "kind": "file", "data": ["./RUNBOOKS/security.md"] }
        ]
      }
    }
  }
}
```

**Env vars**
- Usually none.

---

### 3.2 `vim` — loads currently open vim buffers as context

**What it does**
- Reads the contents of **open Vim buffers**
- Supplies them to the agent as context

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["vim"]
  },
  "vim": {
    "maxBuffers": 10,
    "maxBytesPerBuffer": 200000
  }
}
```

**Env vars**
- Usually none.

---

### 3.3 `embeddings` — semantic search over embeddings

**What it does**
- Provides embedding-based retrieval (semantic search)
- In the provided embedding-plugin behavior:
  - subscribes to file lifecycle events (e.g., post-edit)
  - may run `knowhow embed` asynchronously in the background after edits
  - returns top results (implementation chooses the final limit)

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["embeddings"]
  },
  "embeddings": {
    "embeddingModel": "text-embedding-3-small",
    "topK": 7,
    "indexDirs": ["./docs", "./src", "./skills"]
  }
}
```

**Env vars**
- Depends on embedding provider/model backend (commonly an OpenAI/compatible API key). Verify the plugin’s `meta.requires` for your build.

---

### 3.4 `github` — resolves GitHub PRs, issues, code

**What it does**
- Resolves GitHub identifiers / URLs found in prompts into context:
  - PRs
  - issues
  - (often) code changes/diffs and structured summaries

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["github"]
  },
  "github": {
    "repos": ["my-org/my-repo", "my-org/another-repo"],
    "includeDiff": true,
    "maxItems": 10
  }
}
```

**Env vars**
- `GITHUB_TOKEN` (commonly required)

---

### 3.5 `git` — git diff/log context

**What it does**
- Adds codebase history context from git:
  - diff outputs
  - commit history / logs
  - related change signals

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["git"]
  },
  "git": {
    "mode": "diff",
    "logDepth": 20,
    "maxChars": 20000
  }
}
```

**Env vars**
- Usually none.

---

### 3.6 `asana` — Asana task context

**What it does**
- Finds Asana task/list URLs in prompts
- Fetches task details and formats them for the agent

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["asana"]
  },
  "asana": {
    "workspaceId": "1234567890",
    "includeSubtasks": true,
    "maxTasks": 5
  }
}
```

**Env vars**
- `ASANA_TOKEN` (required/expected)

---

### 3.7 `jira` — Jira issue context

**What it does**
- Detects Jira issue keys/URLs
- Fetches ticket context and formats it for the agent

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["jira"]
  },
  "jira": {
    "site": "https://your-company.atlassian.net",
    "includeComments": true,
    "maxIssues": 5
  }
}
```

**Env vars**
- Commonly one or more of:
  - `JIRA_TOKEN`
  - (sometimes) `JIRA_EMAIL`, `JIRA_BASE_URL`
- Check your plugin’s `meta.requires` list for exact names.

---

### 3.8 `linear` — Linear issue context

**What it does**
- Resolves Linear issue URLs/keys and fetches issue context

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["linear"]
  },
  "linear": {
    "includeComments": false,
    "maxIssues": 5
  }
}
```

**Env vars**
- `LINEAR_TOKEN` (commonly required)

---

### 3.9 `figma` — Figma design file context

**What it does**
- Accepts Figma file links (often with optional `node-id` targets)
- Uses Figma API to fetch frame/node images or metadata
- Can use vision/LLM to describe relevant nodes (implementation-dependent)

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["figma"]
  },
  "figma": {
    "maxNodes": 20
  }
}
```

**Env vars**
- `FIGMA_API_KEY` (or `FIGMA_TOKEN`, depending on your plugin implementation)
- Verify against the plugin’s `meta.requires`.

---

### 3.10 `notion` — Notion page context

**What it does**
- Extracts Notion URLs from prompts
- Retrieves page blocks/content and produces context for the agent
- Often supports recursive traversal up to a configured depth

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["notion"]
  },
  "notion": {
    "maxDepth": 2,
    "maxBlocks": 500
  }
}
```

**Env vars**
- `NOTION_TOKEN` (commonly required)
- Some implementations may also need database/page identifiers (config-based).

---

### 3.11 `download` — download/transcribe URLs, YouTube videos

**What it does**
- Downloads and/or transcribes content from URLs (including video sources like YouTube)
- Converts to text context for the agent
- May use chunking + transcription + optional vision keyframe descriptions (implementation-dependent)

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["download"]
  },
  "download": {
    "outputRoot": ".knowhow/downloads",
    "transcribe": true,
    "transcriptionLanguage": "en",
    "reuseCachedTranscripts": true
  }
}
```

**Env vars**
- Often depends on the transcription/vision provider used by the plugin
- Commonly an OpenAI/compatible API key, but verify the plugin’s `meta.requires`.

---

### 3.12 `url` — load web pages as context

**What it does**
- Detects URLs in prompts
- Fetches webpage contents and returns context
- Can support embedding retrieval from the fetched page text

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["url"]
  },
  "url": {
    "maxUrls": 10,
    "maxCharsPerPage": 120000,
    "followRedirects": true
  }
}
```

**Env vars**
- Usually none.

---

### 3.13 `linter` — runs lint after file edits

**What it does**
- Watches for file lifecycle events after the agent edits files
- Runs lint commands (by extension or configured command list)
- Emits lint failures/results into the agent context

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["linter"]
  },
  "linter": {
    "commands": {
      ".ts": "npm run lint --silent -- $1",
      ".js": "npm run lint --silent -- $1",
      ".md": "markdownlint $1"
    },
    "failOnError": false
  }
}
```

**Env vars**
- Usually none.

---

### 3.14 `tmux` — tmux session context

**What it does**
- Detects tmux environment (e.g., using `$TMUX`)
- Reads session/window/pane context and makes it available to the agent

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["tmux"]
  },
  "tmux": {
    "includePaneHistory": true,
    "maxCharsPerPane": 20000
  }
}
```

**Env vars**
- Usually none (but requires tmux availability in your environment).

---

### 3.15 `agents-md` — loads AGENTS.md files

**What it does**
- Loads repository/directory guidance files (commonly `AGENTS.md`)
- Intended for agent behavior instructions, conventions, constraints, etc.

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["agents-md"]
  },
  "agents-md": {
    "glob": "**/AGENTS.md",
    "maxFiles": 30
  }
}
```

**Env vars**
- Usually none.

---

### 3.16 `exec` — execute commands for context

**What it does**
- Executes shell commands to generate context
- In the provided implementation behavior:
  - `callMany(input)` only dispatches when input starts with `!` or `/!`
  - `call(input)` runs the command string and returns stdout/stderr formatted context
- **Security risk:** can run arbitrary commands.

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["exec"]
  }
}
```

**Example usage with `language` trigger**
```jsonc
{
  "plugins": {
    "enabled": ["language", "exec"]
  },
  "language": {
    "terms": {
      "!now": {
        "events": ["agent:msg"],
        "sources": [
          { "kind": "text", "data": "!date" }
        ]
      }
    }
  }
}
```

**Env vars**
- None inherent to the plugin, but your executed commands may depend on your environment.

---

### 3.17 `skills` — loads SKILL.md files from configured directories

**What it does (as implemented by the Skills plugin)**
- Configures an array of directories to scan
- Recursively finds `SKILL.md`
- Parses YAML-like frontmatter at the top:
  - `name`
  - `description`
- If a skill name appears in the user prompt (case-insensitive substring match):
  - returns the matched skill file content
- If no skill names match:
  - returns a discovery list of available skills and how to reference them

**Example config**
```jsonc
{
  "plugins": {
    "enabled": ["skills"]
  },
  "skills": [
    "./skills",
    "./docs/skills"
  ]
}
```

**Example `SKILL.md`**
```md
---
name: sql-tuning
description: Optimize SQL queries with indexes and query plans
---

# sql-tuning

When tuning a query:
1. Inspect `EXPLAIN`
2. Find missing indexes
3. Rewrite joins/filters
```

**Env vars**
- Usually none.

---

## 4) Custom plugins via `pluginPackages` (npm packages)

Knowhow can load **custom plugins** from npm packages listed under `pluginPackages` in `knowhow.json`.

### 4.1 Register a custom plugin package

```jsonc
{
  "plugins": {
    "enabled": ["my-custom-plugin"]
  },
  "pluginPackages": {
    "my-custom-plugin": "@your-scope/knowhow-my-custom-plugin"
  }
}
```

> In this model, the **key** in `pluginPackages` should map to the plugin key you enable in `plugins.enabled`.

### 4.2 What a custom plugin must provide
A custom plugin package should export a plugin constructor/class that Knowhow can instantiate (typically with a plugin context/service). The plugin instance should include metadata, especially:

- `meta.key` (must match the key you enable)
- `meta.requires` (optional; env vars needed for auth/integration)

And implement one or more plugin methods, commonly:
- `call(input?)`
- `callMany(input?)`
- `embed(input)`

### 4.3 Example `knowhow.json` using multiple plugins
```jsonc
{
  "plugins": {
    "enabled": ["language", "my-custom-plugin", "embeddings"],
    "disabled": []
  },
  "pluginPackages": {
    "my-custom-plugin": "@acme/knowhow-my-custom-plugin"
  }
}
```

---

## 5) Required environment variables (per plugin)

Knowhow uses each plugin’s metadata (typically `meta.requires`) to decide whether the plugin is enabled. If env vars are missing, the plugin may be skipped.

Below are the **expected** environment variables for the standard external-service integrations:

| Plugin key | Environment variables (expected) |
|---|---|
| `github` | `GITHUB_TOKEN` |
| `asana` | `ASANA_TOKEN` |
| `jira` | `JIRA_TOKEN` (or provider-specific equivalents); often also `JIRA_BASE_URL` / `JIRA_EMAIL` depending on setup |
| `linear` | `LINEAR_TOKEN` |
| `figma` | `FIGMA_API_KEY` or `FIGMA_TOKEN` (verify exact `meta.requires`) |
| `notion` | `NOTION_TOKEN` |
| `embeddings` | depends on embedding provider (commonly an API key like `OPENAI_API_KEY`, but verify in plugin code/config) |
| `download` | depends on transcription/vision provider (often an API key; verify in plugin code/config) |
| `language`, `vim`, `git`, `url`, `linter`, `tmux`, `agents-md`, `exec`, `skills` | typically none required for auth (but `exec` depends on your system tools) |

### Example: setting environment variables
```bash
export GITHUB_TOKEN="ghp_xxx"
export ASANA_TOKEN="asca_xxx"
export JIRA_TOKEN="xxx"
export LINEAR_TOKEN="linear_xxx"
export FIGMA_API_KEY="figma_xxx"
export NOTION_TOKEN="secret_notion_xxx"
export OPENAI_API_KEY="sk_xxx"
```

---

## Recommended “starter” config

A safe, useful baseline that covers local context, issue resolution, and retrieval:

```jsonc
{
  "plugins": {
    "enabled": [
      "language",
      "skills",
      "agents-md",
      "github",
      "jira",
      "linear",
      "asana",
      "notion",
      "url",
      "embeddings",
      "git",
      "linter"
    ],
    "disabled": ["exec", "download", "vim", "tmux"]
  },
  "pluginPackages": {}
}
```

> Enable `exec`/`download` only if you trust prompts and external content sources you’ll process.

---

If you paste your repo’s `knowhow.json` schema (or the plugin `meta.requires` and config types for each built-in plugin), I can revise this guide so **every config block uses the exact field names** your Knowhow version supports.