# `knowhow chat` Guide

`knowhow chat` is the primary interactive terminal experience for Knowhow. You’ll start a chat loop, then use built-in slash commands (`/…`) to control agents, sessions, rendering, input modes, and more.

---

## 1) Start a chat session

Start Knowhow’s interactive chat:

```bash
knowhow chat
```

After starting, Knowhow will show the available commands for the current mode.

> Tip: While chatting, you can usually discover functionality from `/` commands (documented below). If you’re ever unsure, run:
>
> ```bash
> knowhow chat --help
> ```

---

## 2) Chat modes (what changes with `/...`)

Knowhow’s CLI chat behavior changes based on active modes.

### Default (normal) chat
- You send plain text (no leading `/`) and Knowhow responds as a standard assistant.
- Agent mode is **off** until you enable it with `/agent`.

### Agent mode: `/agent` (agent interaction mode)
When you enable agent mode:
- Your prompt becomes: `Ask knowhow <AgentName>:`
- Your input becomes an initial task for that agent.
- The agent streams events into the active renderer.

Command:
- `/agent <agent_name>`

### Agent attached mode: `/attach` (agent:attached)
When you attach to a running task/session:
- You’re “attached” to a specific agent task that’s already running.
- Mode switches to `agent:attached`, unlocking attached-mode commands like:
  - `/logs`, `/pause`, `/unpause`, `/kill`, `/detach`, `/done`

Commands:
- `/attach <taskId>`
- `/resume <taskId>` (for completed/saved sessions)

### Voice mode: `/voice`
When voice mode is enabled:
- Input comes from `voiceToText()` instead of the normal text prompt.
- Mode affects how the CLI collects your next user input.

Command:
- `/voice`

### Multi-line mode: `/multi`
When multi-line mode is enabled:
- Input is collected using a text editor UI (via Inquirer’s editor).
- After submitting, multiline mode is reset.

Command:
- `/multi`

---

## 3) Built-in slash commands (`/`)

The following commands are available from the CLI modules shown in the code. (Additional commands may exist in other modules or via custom command modules/plugins.)

### Agent controls
| Command | Description | Mode |
|---|---|---|
| `/agent <agent_name>` | Enable agent mode and select an agent | default / non-agent |
| `/agents` | List available agents, then optionally select one | default / non-agent |
| `/pause` | Pause the attached agent | `agent:attached` |
| `/unpause` | Unpause the attached agent | `agent:attached` |
| `/kill` | Terminate the attached agent | `agent:attached` |
| `/detach` | Detach from the attached agent task (leaves agent running) | `agent:attached` |
| `/done` | Exit the current agent interaction (detaches) | `agent:attached` |

### Session / attachment management
| Command | Description | Mode |
|---|---|---|
| `/attach [taskId]` | Attach to a running session/task | any (but useful in agent workflows) |
| `/resume [taskId]` | Resume a completed/saved session | any |
| `/sessions` | List sessions (running + optionally completed) | any |
| `/logs [N]` | Show the last N messages from the attached agent (default `N=20`) | `agent:attached` |

Important flags for these commands:
- `/attach --completed` : show saved/completed sessions in addition to running ones
- `/sessions --completed` or `/sessions --all`
- `/sessions --csv` : output sessions as CSV

### Shell execution (command helpers)
| Command | Description | Mode |
|---|---|---|
| `/! <command>` | Execute a shell command (interactive: inherits stdio) | `agent` / `agent:attached` |
| `/!! <command>` | Execute a shell command, then send its output to the AI | `agent` / `agent:attached` |

### Renderer switching
| Command | Description | Mode |
|---|---|---|
| `/render [specifier]` | Switch output renderer, or show current renderer + built-ins | any |

Built-in renderers:
- `basic`
- `compact`
- `fancy`

Also supports:
- a filesystem path (e.g. `./my-renderer.js`)
- a package name (e.g. `@my-org/knowhow-renderer`)

### Input / chat behavior
| Command | Description | Mode |
|---|---|---|
| `/multi` | Toggle multiline input mode | any |
| `/voice` | Toggle voice input mode | any |
| `/exit` | Exit the chat process | any |

### Model / provider / debug / history
| Command | Description | Mode |
|---|---|---|
| `/model` | Select a model for the active context (and update active agent prefs) | any |
| `/provider` | Select a provider (and update active agent prefs) | any |
| `/debug` | Toggle debug mode | any |
| `/clear` | Clear chat history (AI will not remember previous messages) | any |

### Search
| Command | Description | Mode |
|---|---|---|
| `/search` | Search embeddings interactively | any |

Inside embedding search, it uses non-slash commands:
- `next`, `exit`, `embeddings`, `use`

### Notes about other commands
Some commands referenced in fuzzy-match logic (like `help`) may exist in modules not included in the provided code excerpts. If your build includes more modules, run `knowhow chat` and look at the “Commands:” line that appears at startup and updates per mode.

---

## 4) Switching agents (`/agent` and `/agents`)

### List agents
```text
/agents
```

Knowhow prints available agent names, then prompts:

```text
Select an agent to start:
```

### Start a specific agent
```text
/agent Researcher
```

When successful:
- agent mode is enabled
- your prompt changes to `Ask knowhow Researcher:`
- the agent begins a task when you type input (non-command text)

### Example: switch agents in one session
```text
> /agents
Available agents:
  - Patcher
  - Researcher
  - DevOpsBot
────────────────────────────────────────────────

Select an agent to start: Researcher

Agent mode enabled. Selected agent: Researcher. Type your task to get started.

Ask knowhow Researcher: Summarize the latest changes in X.
```

To switch again:
- start another agent with `/agent <name>` (or disable agent mode by `/agent` with no args—see next tip)

### Disable agent mode
In `AgentModule.handleAgentCommand`, `/agent` with **no arguments** toggles agent mode off (only if agent mode is already active):

```text
/agent
```

---

## 5) Multi-line input (`/multi`)

Toggle multi-line mode:

```text
/multi
```

Then enter a task in a multi-line editor UI.

After you submit the edited content:
- the CLI disables multiline mode automatically (`multilineMode = false` after use)

Example workflow:
```text
> /multi
Multiline mode: enabled

> (editor opens)
Write a detailed plan for migrating service A to service B:
- include risks
- include rollback steps
- include timeline
```

---

## 6) Shell commands (`/!` and `/!!`)

These commands exist specifically to help you run local shell work while an agent is active.

### `/!` — interactive execution
Runs a shell command and uses inherited stdio (so interactive prompts work):

```text
/! ls -la
```

### `/!!` — send output to the AI
Runs a command, captures its output, and sends that output to the agent as message content.

```text
/!! cat package.json
```

The command output will be wrapped and forwarded to the agent like:

```text
Command output from `cat package.json`:
<output...>
```

### Example: use shell output to guide an agent
```text
> /agent Patcher
Agent mode enabled. Selected agent: Patcher. Type your task to get started.

Ask knowhow Patcher: Inspect the repo and patch any failing tests.

Ask knowhow Patcher: /!! npm test
```

---

## 7) Session management (attach/resume + session persistence)

Knowhow supports continuing work across time and processes by saving agent session state.

### Key concepts
- **Running tasks** can be attached to with `/attach`.
- **Completed/saved sessions** can be resumed with `/resume`.
- Session metadata may also exist on disk under agent process directories (used for filesystem-backed attachments).

### List sessions
```text
/sessions
```

Options:
- `/sessions --completed` : include saved/completed
- `/sessions --all` : include more historical sessions
- `/sessions --csv` : CSV output

### Attach to a running task
```text
/attach <taskId>
```

Or interactively:
```text
/attach
```

The session list can include filesystem/web tasks, depending on what’s available.

### Resume a completed session
```text
/resume <taskId>
```

Or interactively:
```text
/resume
```

You’ll be prompted to add additional context for resuming.

### Attach/detach during `agent:attached`
While attached:
- `/detach` detaches from the running task
- `/done` exits interaction (detaches)

---

## 8) Renderers (`/render`)

Knowhow can change how messages/events are displayed.

### Built-in renderers
`/render` shows:
- Current renderer
- Built-ins: `basic`, `compact`, `fancy`

Switch to a built-in:
```text
/render compact
```

### Example: show renderer info
```text
/render
```

### Switching while an agent is running
When you switch renderers:
- the CLI preserves the active task id (if one exists)
- agent event wiring is rewired so live agent output continues to render in the new renderer

---

## 9) Voice input (`/voice`)

Enable voice mode:
```text
/voice
```

When enabled, the next input prompt is satisfied by calling `voiceToText()` (microphone integration). If voice input fails or isn’t configured, you may get an empty string / an error.

Disable it again:
```text
/voice
```

---

## 10) Custom agents (configure in `knowhow.json`)

Custom agents are loaded as agent constructors (used by `/agent` and `/agents`). In this guide, custom agents are configured in `knowhow.json` under an `agents` array.

> ⚠️ The exact schema of your agent config can depend on your Knowhow version and agent implementation. The examples below show the typical structure and the most important part: the **agent name** you will use with `/agent <name>`.

### Example `knowhow.json` with custom agents
```json
{
  "agents": [
    {
      "name": "ResearcherPro",
      "provider": "openai",
      "model": "gpt-5.4-nano",
      "systemPrompt": "You are a rigorous research agent. Provide sourced, structured answers.",
      "tools": ["search", "render", "code-execution"]
    },
    {
      "name": "PatchMaster",
      "provider": "anthropic",
      "model": "sonnet-4-6",
      "systemPrompt": "You are an expert software patching agent. Be precise and safe.",
      "tools": ["askHuman", "file-edit", "diff-preview"]
    }
  ]
}
```

### Using your custom agent
After updating `knowhow.json`, restart Knowhow and run:

```text
/agents
/agent ResearcherPro
```

Then provide your task as normal text (non-slash).

---

## End-to-end examples

### Example A: Start an agent and run work
```text
> /agent Patcher
Agent mode enabled. Selected agent: Patcher. Type your task to get started.

Ask knowhow Patcher: Fix the failing unit test in the repo.
```

### Example B: Run a shell command and feed output to the agent
```text
> /agent Patcher
Ask knowhow Patcher: /!! npm test
Ask knowhow Patcher: Based on the output, propose a minimal patch.
```

### Example C: Attach to a running agent task and view logs
```text
> /sessions
1) a1b2c3...  (running)  Patcher
2) d4e5f6...  (saved)    ResearcherPro

> /attach a1b2c3...
🔄 Attached to running task: a1b2c3...
   Agent : Patcher
   Task  : Fix the failing unit test...
   Status: running

> /logs 10
```

### Example D: Resume a completed session
```text
> /resume d4e5f6...
📋 Session found: d4e5f6...
   Agent  : ResearcherPro
   Task   : Summarize...

Add any additional context for resuming this session (or press Enter to skip): Focus on migration risks.
```

### Example E: Switch renderer mid-session
```text
> /render fancy
✅ Renderer switched to: fancy
```

---

If you want, paste your `knowhow.json` (redact secrets) and I can help you write a correct custom-agent schema that matches how your Knowhow build expects agent definitions.