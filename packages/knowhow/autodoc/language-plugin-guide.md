# Knowhow Language Plugin Guide

## 1) What the language plugin does

The **Language Plugin** lets you define custom “hotwords” (called **terms**) in `.knowhow/language.json`. When you use one of those terms in a chat (or when specific file events happen), Knowhow automatically:

1. **Finds matching terms** inside your input (via glob/wildcard + substring matching).
2. **Resolves the configured sources** for each matching term (files, raw text, GitHub content, URLs, etc.).
3. **Injects the resolved context** into the workflow by emitting an internal agent message (`agent:msg`) containing the expanded sources.

In short: **typing words like “frontend”, “API”, “prod” can automatically pull in the right docs, specs, PR details, or environment notes—without you manually copying/pasting them.**

---

## 2) Configuration file: `.knowhow/language.json`

Knowhow reads **only** the local file:

- **Local:** `.knowhow/language.json`

If the file does not exist, the plugin behaves as if there are **no language terms**.

### Structure (high level)

Your file is a JSON object where each **key** is a term (or multiple patterns in one key), and each value defines:

- `events` (optional): triggers for file events / agent events
- `sources`: what to load when the term matches

```jsonc
{
  "term-or-patterns": {
    "events": ["file:open", "file:save", "agent:message", "..."],
    "sources": [
      { "kind": "file",   "data": ["path-or-glob", "..."] },
      { "kind": "text",   "data": "some inline text" },
      { "kind": "github", "data": ["pr:123", "issue:456", "..."] },
      { "kind": "url",    "data": ["https://example.com/docs", "..."] }
    ]
  }
}
```

### Term key format (important)
A single JSON key can contain **multiple comma-separated patterns**. Those patterns are treated as alternatives that map to the same `sources`.

Example key with alternatives:

```json
{
  "frontend,fe,ui": {
    "sources": [
      { "kind": "file", "data": [".knowhow/docs/frontend-architecture.md"] }
    ]
  }
}
```

---

## 3) Term matching (glob/wildcard + comma-separated keys)

### 3.1 User prompt matching (generic events)
When the plugin checks a message, it:

- iterates over all term keys
- splits each key by commas: `term.split(",")`
- trims each pattern
- checks for match using:
  - **glob/wildcard** matching when the pattern contains `*`
  - otherwise **case-insensitive substring** match

**Rule from the code:**
- If pattern contains `*`: uses `minimatch(userPrompt, pattern)`
- Else: `userPrompt.toLowerCase().includes(pattern.toLowerCase())`

✅ Examples:
- `"API"` matches when user prompt contains `"api"` anywhere.
- `"api*"` matches when user prompt matches the glob.
- `"prod,production"` matches either `prod` or `production`.

### 3.2 File operation matching (file events)
For `file:*` events, the plugin finds matching terms based on:

- **file path** pattern matching (glob via `minimatch(filePath, pattern)`)
- OR **file content** containing the pattern as a substring (case-insensitive)

So file triggers can be far more contextual, e.g.:
- Opening `apps/web/src/routes/login.tsx` can match terms like `apps/web/*` or keywords found in the file.

---

## 4) Supported source kinds

The Language Plugin loads **sources** for every matching term.

### 4.1 `file` — load file contents
- **Purpose:** read local file content and include it in the context.
- **Supports glob patterns** (configure `data` as globs like `specs/**/*.md`).
- Internally, it reads each resolved path as UTF-8 and includes `{ filePath, content }` for file expansions.

Example:
```json
{
  "API": {
    "sources": [
      { "kind": "file", "data": [".knowhow/docs/api/**/*.md"] }
    ]
  }
}
```

> Tip: Prefer smaller “topic” files (or glob only within a narrow folder) to keep prompts readable.

---

### 4.2 `text` — inline raw text
- **Purpose:** embed static text directly in the configuration.
- No file IO or fetching.

Example:
```json
{
  "triage": {
    "sources": [
      {
        "kind": "text",
        "data": "Triage checklist:\n1) Identify user impact\n2) Repro steps\n3) Logs/metrics\n4) Proposed fix area\n5) Risk assessment"
      }
    ]
  }
}
```

---

### 4.3 `github` — load GitHub PR/issue/file content
- **Purpose:** fetch and include GitHub content.
- **Implemented via the `github` plugin.**
- The Language Plugin does not parse GitHub URLs itself; it **hands off the `data`** to the enabled plugin matching the `kind`.

So `kind: "github"` means: *“call the `github` plugin with these selectors/identifiers.”*

Example:
```json
{
  "my PR": {
    "sources": [
      { "kind": "github", "data": ["pr:current", "repo:my-org/my-repo"] }
    ]
  }
}
```

> Use the selector format your `github` plugin expects (commonly things like `pr:<number>`, `issue:<number>`, repo selectors, or URL strings).

---

### 4.4 `url` — fetch web content
- **Purpose:** fetch a URL and include its contents.
- **Implemented via the `url` plugin.**
- Like `github`, the Language Plugin delegates to the enabled plugin where `kind === plugin key`.

Example:
```json
{
  "security model": {
    "sources": [
      { "kind": "url", "data": ["https://example.com/security/model"] }
    ]
  }
}
```

---

### How other `kind` values work
The Language Plugin treats any `kind` that matches an **enabled plugin key** as a delegated call. In other words, besides `file` and `text`, your `kind` values typically should correspond to the plugin names you enabled in `.knowhow/knowhow.json` (the default enables `github` and `url`).

---

## 5) Event-driven triggers (`events` field)

The Language Plugin can trigger context expansions not just from chat text, but also from **events**.

### 5.1 What `events` does
In the Language Plugin constructor, it:

1. loads `.knowhow/language.json`
2. collects all unique event names from all terms’ `events`
3. registers handlers:
   - events starting with `"file"` → special file handler
   - everything else → generic handler

### 5.2 Common patterns
Even though event names are configured by your environment, the code clearly distinguishes:

- **File events:** anything like `file:*`
  - matching uses file path + file content
  - good for “while I edit this area, always bring these docs”

- **Non-file events:** anything else (e.g. agent messages)
  - matching uses the event payload serialized as JSON (`JSON.stringify(eventData)`)

### Example: trigger when saving frontend files
```json
{
  "frontend": {
    "events": ["file:save", "file:open"],
    "sources": [
      { "kind": "file", "data": [".knowhow/docs/frontend-architecture.md"] }
    ]
  }
}
```

When you open/save frontend files, the term can auto-inject the architecture doc.

---

## 6) Practical examples (full config snippets)

Below are real-world, copy/paste-ready examples. You can combine multiple terms in the same `language.json`.

---

### Example A — Load frontend/backend architecture docs for “frontend” / “backend”

```json
{
  "frontend": {
    "sources": [
      {
        "kind": "file",
        "data": [".knowhow/docs/architecture/frontend-architecture.md"]
      }
    ]
  },
  "backend": {
    "sources": [
      {
        "kind": "file",
        "data": [".knowhow/docs/architecture/backend-architecture.md"]
      }
    ]
  }
}
```

**Workflow:**
- Say **“frontend”** → the frontend architecture doc is injected
- Say **“backend”** → the backend architecture doc is injected

---

### Example B — Load your current PR when you say “my PR”

```json
{
  "my PR": {
    "sources": [
      {
        "kind": "github",
        "data": ["pr:current"]
      },
      {
        "kind": "file",
        "data": [".knowhow/docs/pr-review-checklist.md"]
      }
    ]
  }
}
```

**Workflow:**
- You ask: “Can you review my PR for risk and edge cases?”
- The plugin injects:
  - your PR content (via `github` plugin)
  - a review checklist (via `file` kind)

> If `pr:current` isn’t supported in your setup, replace it with whatever your `github` plugin accepts (e.g. `pr:123`, or `https://github.com/org/repo/pull/123`).

---

### Example C — Load a spec file when you mention a feature name

Assume you keep specs under:
- `specs/features/<feature-name>/spec.md`

Use globs so the term can map to the right file(s):

```json
{
  "payments, payment-processing": {
    "sources": [
      {
        "kind": "file",
        "data": ["specs/features/payments/spec.md"]
      }
    ]
  },
  "search": {
    "sources": [
      {
        "kind": "file",
        "data": ["specs/features/search/**/*.md"]
      }
    ]
  }
}
```

**Workflow:**
- “Explain the payments flow” → loads payments spec(s)
- “What’s the intended behavior for search?” → loads search spec(s)

---

### Example D — Load API docs when you say “API” (and optionally “endpoints”, “REST”, etc.)

```json
{
  "API, api, rest*, endpoints*": {
    "sources": [
      {
        "kind": "file",
        "data": [".knowhow/docs/api/**/*.md"]
      }
    ]
  }
}
```

**Matching behavior examples:**
- Saying “API” or “api” triggers via substring match.
- Saying “endpoints v2” can trigger via patterns like `endpoints*`.

---

### Example E — Load environment info when you say “prod” or “staging”

Keep environment runbooks locally:

```json
{
  "prod, production": {
    "events": ["file:open", "file:save"],
    "sources": [
      { "kind": "file", "data": [".knowhow/env/prod-runbook.md"] },
      { "kind": "file", "data": [".knowhow/env/prod-env-variables.md"] }
    ]
  },
  "staging, stage": {
    "sources": [
      { "kind": "file", "data": [".knowhow/env/staging-runbook.md"] }
    ]
  }
}
```

**Workflow:**
- Ask “Is this safe to roll out to prod?” → injects prod runbook + env vars.
- Say “staging” while working on deployment-related files → brings staging context.

---

## 7) Dynamic language terms (runtime)

The guide mentions an `addLanguageTerm` tool. While it’s not shown in the provided plugin source, the intended workflow is:

- Add new terms **at runtime** (e.g. term = feature name, term = ticket title, term = customer name)
- Knowhow persists them into your local language config (commonly `.knowhow/language.json`)
- Subsequent messages immediately benefit from the new hotword mappings

**Common use cases:**
- Add “ACME widget” → map it to the widget spec file URL/path.
- Add “Jira ABC-123” → map it to an issue link or local sprint notes.
- Add “Release 2026-05” → map it to a release checklist.

Example conceptual usage (tool name/arguments may vary in your installation):
- Call `addLanguageTerm(term="my-customer", sources=[...])`
- Then say “my-customer” in chat to trigger expansions.

> If you tell me the exact `addLanguageTerm` tool signature available in your Knowhow version, I can provide a precise snippet.

---

## 8) Global vs local language config

### What Knowhow loads for language terms
From the code:
- `getLanguageConfig()` reads **only**: `.knowhow/language.json`

So in practice:

- **Local language terms** in `.knowhow/language.json` are what the Language Plugin uses.
- The **global template** `~/.knowhow/language.json` may be created during `knowhow init`, but it is not directly read by the Language Plugin in the shown implementation.

### Recommended workflow
- Use `knowhow init` to generate the local `.knowhow/language.json`
- Edit **local** terms per project
- Keep environment-specific terms (prod/staging, feature specs, architecture docs) in that local file

---

## Summary: why teams love this

With a well-tuned `.knowhow/language.json`, developers can:

- Reduce “where is the doc?” interruptions
- Guarantee consistent architecture context (frontend/backend)
- Speed up PR review by pulling PR content + checklists automatically
- Tie feature names/ticket identifiers to specs
- Make environment questions (prod/staging) immediately grounded in runbooks
- Trigger expansions automatically while editing relevant files via `events`

If you share your current `language.json` (or your repo’s docs layout), I can propose an optimized set of terms and globs tailored to your workflow.