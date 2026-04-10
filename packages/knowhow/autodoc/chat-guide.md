# `knowhow chat` Guide

`knowhow chat` is the primary interactive interface for the **Knowhow CLI**. It runs a REPL-style chat loop where you type messages and can control behavior using **slash commands** (`/…`).

At startup, Knowhow typically prints a list of available commands based on:
- enabled chat modules (agent/search/sessions/shell/voice/etc.)
- your configuration (`knowhow.json`)
- the current chat mode (agent vs attached vs voice)

> **Tip:** Always look at the startup line like `Commands: /agent, /agents, ...` to confirm what your build exposes.

---

## 1) Starting a chat session

Start chat with:

```bash
knowhow chat
```

You then enter a prompt loop where you can type normal messages or slash commands.

### Common CLI flags (version/build-dependent)
Your exact flags depend on the CLI build. Check:

```bash
knowhow chat --help
```

Common patterns you may see include:
- selecting a starting **agent**
- selecting a **renderer**
- enabling **voice**
- attaching/resuming a prior session/task (if your build supports it)

Examples (illustrative—verify with `--help`):
```bash
knowhow chat --agent Patcher
knowhow chat --renderer compact
knowhow chat --voice
```

---

## 2) Chat modes (agent, attached, voice)

Knowhow changes behavior based on mode. Mode determines:
- how inputs are interpreted
- which slash commands are enabled
- whether you’re controlling a running task (attached) vs just chatting

### Agent mode
You’re using a configured agent to respond.

In this mode, commands like `/agent`, `/agents`, `/render`, `/search`, `/multi`, etc. are usually available.

### Attached mode (`agent:attached`)
In attached mode, Knowhow is connected to a running agent task/session and you can inspect/steer it using attached-only commands (if provided by your agent module).

### Voice mode
If voice is available in your build, voice mode switches input handling so speech is transcribed and sent into the chat loop.

---

## 3) Built-in slash commands (`/…`)

Below is the command reference for the commands known to be implemented by the chat modules in the Knowhow codebase (agent/search/sessions/renderer/shell/voice modules).  
If your `Commands:` list includes additional items, use those as well—modules register commands at runtime.

### Agent switching
- **`/agent <name>`** — switch to a specific configured agent  
  **Example**
  ```text
  /agent Patcher
  ```

- **`/agents`** — list configured agents (and/or selection help)  
  **Example**
  ```text
  /agents
  ```

> In attached mode, some agent-control commands may be restricted to attached mode only (see below).

### Attached-mode controls (if provided by your agent module)
These commands are typically only enabled when you are attached to a running agent task:

- **`/pause`** — pause the attached agent
- **`/unpause`** — resume the attached agent
- **`/kill`** — terminate the attached agent task (and typically detach)
- **`/detach`** — detach from the attached agent task
- **`/done`** — finish/exit the current attached interaction

**Examples**
```text
/pause
/unpause
/detach
/done
```

### Multi-line input
- **`/multi`** — start a multi-line input editor for your *next* message (or until you exit the editor, depending on implementation)

**Example**
```text
/multi
Write a runbook for:
1) Setup
2) Daily use
3) Troubleshooting

Include a checklist.
```

### Rendering control
- **`/render`** — show current renderer / help for renderer switching
- **`/render <basic|compact|fancy>`** — switch built-in renderer

**Examples**
```text
/render basic
/render compact
/render fancy
```

#### Custom renderer support (from the renderer module)
Depending on build support, `/render` may also load a renderer from:
- a path
- an npm package specifier

**Examples**
```text
/render ./my-renderer.js
/render @my-org/knowhow-renderer
```

### Search
- **`/search`** — enter the interactive search loop (Search module)

**Example**
```text
/search
```

#### Inside `/search` (interactive sub-commands)
Within the search loop, Knowhow accepts:

- **`next`** — show the next result
- **`exit`** — leave search mode
- **`embeddings`** — list available embedding scopes
- **`use`** — choose which embedding scope(s) to search

Any other input is treated as a new search query.

**Example session**
```text
/search
searching: "postgres query planner tuning"

### TEXT
...match content...

### METADATA
{ "source": "...", "chunk": 12 }

searching: next
### TEXT
...next match...

searching: use
Embedding to search: snippets
searching: "how to configure agents"
(search results...)
searching: exit
```

### Session management (attach/resume/logs and listing)
These are implemented by the Sessions module.

- **`/attach [taskId] [--completed]`**
  - With **no args**, opens an interactive selection of attachable sessions/tasks.
  - With `<taskId>`, attaches directly.
  - `--completed` may include completed items in the chooser; completed items are routed to **`/resume`**.

**Examples**
```text
/attach
/attach 8d9f1c2b-3a4e-...
/attach --completed
```

- **`/resume [taskId]`**
  - With **no args**, opens an interactive list of saved/completed sessions to resume.
  - With `<taskId>`, resumes that session.
  - When resuming, Knowhow can prompt you to add additional context.

**Examples**
```text
/resume
/resume 8d9f1c2b-3a4e-...
```

- **`/sessions [--all] [--completed] [--csv]`**
  Lists sessions/tasks so you can choose to attach or resume.

  - `--completed` includes completed sessions
  - `--all` includes more history/scope (implementation-defined)
  - `--csv` outputs table data in CSV format

**Examples**
```text
/sessions
/sessions --completed
/sessions --completed --csv
```

- **`/logs [N]`**
  Shows the last **N** messages from the **currently attached** agent (default `N=20`).  
  Typically restricted to **attached mode**.

**Examples**
```text
/logs
/logs 50
```

> **Note on “save/load”:** the Sessions module primarily exposes **attach** (running tasks) and **resume** (completed/saved tasks). If your build includes explicit `save/load` subcommands under `/sessions`, they will appear in your runtime `Commands:` list or via `/sessions` help.

### Shell commands
These are provided by the shell module and work in agent/attached modes where enabled.

- **`/! [command]`** — run shell commands interactively (module behavior may vary)
- **`/!! <command>`** — run a shell command, capture output, and send it to the AI for analysis

**Examples**
```text
/! 
# (interactive shell mode, if your build uses it)

/!! ls -la
/!! cat ./build.log | tail -n 200
```

**Typical workflow**
```text
/!
npm test
/!!
npm test
# then ask the AI to explain failures based on captured output
```

### Voice input (if available)
If your build includes voice support, the Voice module typically exposes a command like:

- **`/voice`** — toggle voice mode on/off

**Example**
```text
/voice
```

If `/voice` isn’t present, voice may be controlled only via CLI flags—check:
```bash
knowhow chat --help
```

---

## 4) Switching agents (`/agent` and `/agents`)

### List agents
```text
/agents
```

### Switch to a configured agent
```text
/agent <AgentName>
```

**Example**
```text
/agents
/agent Researcher
Summarize the tradeoffs between two approaches...
```

> If you attach/resume a session, Knowhow may also restore the session’s agent context (when the agent still exists in your `knowhow.json`).

---

## 5) Multi-line input (`/multi`)

Use `/multi` when you want to paste structured content (requirements, logs, code blocks, JSON/YAML).

**Example**
```text
/multi
Create a step-by-step plan to debug a failing CI job.

Input:
- command I ran:
- relevant log excerpt:
- what I already tried:

Output:
- hypotheses
- commands to verify
- minimal fix suggestions
```

---

## 6) Shell commands (`/!` and `/!!`)

### `/!` — interactive shell
Use `/!` to run shell commands in an interactive way (depending on your build). For some builds, `/!` may also accept a command directly.

**Example**
```text
/!
ls -la
cat package.json
```

### `/!!` — send shell output to the AI
Use `/!!` when you want Knowhow to *capture* command output and include it in the AI context.

**Example**
```text
/!! npm test --silent
```

Then ask:
```text
What caused the failure, and what minimal changes should I make?
```

> **Safety note:** Shell commands run on your machine. Be careful with commands that modify or delete files.

---

## 7) Session management (attach/resume and listing)

Think of sessions in two categories:
- **Attach** to a **running** task/taskId
- **Resume** a **completed/saved** task/taskId

### List sessions/tasks
```text
/sessions
```

Include completed items:
```text
/sessions --completed
```

CSV output:
```text
/sessions --completed --csv
```

### Attach to a running task
```text
/attach
```

Direct attach:
```text
/attach <taskId>
```

### Resume a saved/completed session
Resume interactively:
```text
/resume
```

Resume by id:
```text
/resume <taskId>
```

### View logs from attached agent
```text
/attach <taskId>
/logs
```

---

## 8) Renderers (basic, compact, fancy) and switching with `/render`

Use renderers to change how output appears in your terminal.

### Switch renderer
```text
/render basic
/render compact
/render fancy
```

### Custom renderers (if supported)
```text
/render ./my-renderer.js
/render @my-org/knowhow-renderer
```

**Example flow**
```text
/render compact
Write release notes for version 1.4.2 based on these changes:
(multi-line text...)
```

---

## 9) Voice input (if available)

If voice is enabled in your build, toggle voice mode with:

```text
/voice
```

Then speak your prompt. Knowhow will transcribe and send it into the same pipeline as typed input.

If `/voice` isn’t available, use startup flags (check `knowhow chat --help`).

---

## 10) Custom agents (`knowhow.json` → `agents` array)

You can define custom agents in `knowhow.json` under an `agents` array.

### Example `knowhow.json` with custom agents

```json
{
  "agents": [
    {
      "name": "Patcher",
      "description": "Edits code safely and provides patch-style output.",
      "model": "gpt-4.1-mini",
      "provider": "openai",
      "tools": ["repo", "diff", "tests"],
      "systemPrompt": "You are a careful code patcher. Make minimal changes, explain reasoning, and include a test plan."
    },
    {
      "name": "Researcher",
      "description": "Focuses on explanation, tradeoffs, and decision guidance.",
      "model": "gpt-4.1-mini",
      "provider": "openai",
      "tools": ["web", "search"],
      "systemPrompt": "You are a research assistant. Provide sourced tradeoffs and clear recommendations."
    }
  ]
}
```

### Use your custom agents in chat
```text
/agents
/agent Researcher
Ask knowhow: What are the tradeoffs between approach A and approach B?
```

> **Field names can vary by version/build.** The key requirement is that each agent has a unique **`name`** so it can be selected via `/agent <name>`.

---

## Practical examples

### Example A: Switch agent + compact renderer + normal prompt
```text
/agents
/agent Researcher
/render compact
Summarize the pros/cons of using RAG vs fine-tuning for my product.
```

### Example B: Multi-line spec
```text
/multi
You are helping me design a CLI command system.

Requirements:
- Commands begin with `/`
- Support agent switching
- Include rendering and sessions

Return:
1) Proposed architecture
2) Command registry design
3) Example user flows
```

### Example C: Run shell command and ask the AI to interpret
```text
/!! cat ./build.log | tail -n 200
What does the failure indicate, and what is the likely fix?
```

### Example D: Attach to a running task and inspect logs
```text
/sessions
/attach <taskId>
/logs 30
```

### Example E: Resume a completed session later
```text
/resume <taskId>
Add a brief test plan for the next iteration.
```

---

## Quick command reference

- **Start chat:** `knowhow chat`
- **List agents:** `/agents`
- **Switch agent:** `/agent <name>`
- **Multi-line input:** `/multi`
- **Renderers:** `/render basic|compact|fancy`
- **Search:** `/search` (then use `next`, `exit`, `embeddings`, `use`)
- **Sessions listing:** `/sessions [--completed] [--all] [--csv]`
- **Attach:** `/attach [taskId] [--completed]`
- **Resume:** `/resume [taskId]`
- **Attached logs:** `/logs [N]`
- **Shell:** `/!` and `/!! <command>`
- **Voice (if available):** `/voice`

--- 

If you paste the actual module source files that register the `/…` commands in your environment (agent/search/sessions/shell/voice/system modules), I can turn the “known commands” above into a **fully exact** reference (including any optional flags and exact argument syntax for every subcommand).