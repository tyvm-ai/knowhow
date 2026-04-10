# Language Plugin Guide (Knowhow CLI)

The **Language Plugin** is one of the most powerful features of Knowhow. It lets you define custom **hotwords / terms** (like `frontend`, `backend`, `my PR`, `API`, `prod`) that automatically **inject context** into your chat sessions whenever you use those terms—pulling in **files, inline text, GitHub content, and URLs**.

---

## 1) What the Language Plugin does

When you send a message (or when certain file events occur), the Language Plugin:

1. Loads your term configuration from **`.knowhow/language.json`**
2. Finds which configured **term keys/patterns** match your input
3. Expands each matching term into one or more **sources**:
   - file contents from disk
   - raw inline text
   - GitHub PR/issue/file content
   - content fetched from a URL
4. Injects the loaded context into the session so your agent can answer using your real project/docs.

**In short:** typing a term like `API` can automatically attach your local API docs/specs—no copy/paste required.

---

## 2) Configuration file: `.knowhow/language.json`

Create or edit this file in your project:

```text
./.knowhow/language.json
```

### Example structure

```jsonc
{
  "term-or-pattern-key": {
    "sources": [
      { "kind": "file",  "data": ["glob-or-path-1", "glob-or-path-2"] },
      { "kind": "text",  "data": "Inline raw text to inject" },
      { "kind": "github","data": ["github input payload(s)"] },
      { "kind": "url",   "data": ["https://example.com/..."] }
    ],
    "events": ["file:open", "file:save"]
  }
}
```

### Required fields
- **`sources`**: an array of source entries, each with:
  - **`kind`**: one of `file`, `text`, `github`, `url`
  - **`data`**: varies by kind (see section 4)

### Optional fields
- **`events`**: an array of event names (commonly file events).  
  When present, the term is considered for **event-driven triggers** based on the file operation type.

---

## 3) Term matching (comma-separated keys + glob/wildcard matching)

### Comma-separated keys = multiple match patterns

A single top-level JSON key can represent multiple patterns:

```jsonc
{
  "frontend, ui, web": {
    "sources": [ /* ... */ ]
  }
}
```

This means any of these can trigger the same term expansion:
- `frontend`
- `ui`
- `web`

### Matching behavior for generic prompt text

For normal chat input matching:

- If a pattern contains `*`, Knowhow treats it as a **glob/wildcard pattern**
  - matching is performed with glob logic (e.g., via `minimatch`)
- Otherwise, Knowhow performs **case-insensitive substring** matching:
  - `userPrompt.toLowerCase().includes(pattern.toLowerCase())`

**Implication:**
- Use `*` for families like `api*`, `payment*`, `spec-*`
- Use plain words for hotphrases like `API`, `prod`, `staging`

### Matching behavior for file open/save events

For event-driven matching (file open/save), Knowhow checks patterns against the file:

- It only considers terms whose config includes the event type in **`events`**
- For each pattern in the comma-separated key:
  - Match if `minimatch(filePath, pattern)` succeeds **(path glob match)**  
  **OR**
  - Match if the file contents contain the pattern (case-insensitive substring match)

**Implication:**
- You can target files by **path globs** (recommended)
- Or by **content markers** when the path is unpredictable

---

## 4) Source kinds supported

A matching term expands into one or more sources. Knowhow supports these kinds:

### `file` — load file contents (supports glob patterns)

Loads matching files from your repo/workspace.

- `data` is treated as a list of glob/path strings
- Each file is:
  - checked to exist
  - verified not to be a directory
  - read as UTF-8

**Example:**

```jsonc
{
  "API, apis": {
    "sources": [
      { "kind": "file", "data": ["docs/api/**/*.md", "specs/openapi*.{json,yaml}"] }
    ]
  }
}
```

> Tip: keep paths tight to avoid injecting huge irrelevant bundles.

---

### `text` — inline raw text

Injects literal text directly.

**Example:**

```jsonc
{
  "review rubric": {
    "sources": [
      {
        "kind": "text",
        "data": "Review checklist:\n- correctness\n- edge cases\n- performance\n- tests\n- migration plan\n"
      }
    ]
  }
}
```

---

### `github` — loads GitHub PR/issue/file content

This is resolved through the **GitHub plugin** mechanism. In the language config, you specify what you want loaded via `data`.

**Example (conceptual locator payloads):**

```jsonc
{
  "my PR, current PR": {
    "sources": [
      { "kind": "github", "data": ["CURRENT_PR"] }
    ]
  }
}
```

> The exact `github` payload format depends on your GitHub plugin configuration, but the language plugin will delegate fetching/injection to that plugin.

---

### `url` — fetches a web URL

Resolved via the **URL plugin**. You provide the URL(s) in `data`.

**Example:**

```jsonc
{
  "k8s docs": {
    "sources": [
      { "kind": "url", "data": ["https://kubernetes.io/docs/home/"] }
    ]
  }
}
```

---

## 5) Event-driven triggers (`events` field)

If you want terms to expand based on file activity (open/save), include an **`events`** array on the term.

Typical usage:

```jsonc
{
  "OpenAPI, swagger": {
    "events": ["file:open", "file:save"],
    "sources": [
      { "kind": "file", "data": ["specs/openapi*.yaml", "specs/openapi*.json"] }
    ]
  }
}
```

### How it behaves
- Knowhow collects all event types referenced in `events`
- When those events occur, it:
  - filters terms to those that include the active event
  - runs matching against file path and (optionally) file contents
  - injects the configured sources

---

## 6) Practical examples (full config snippets)

Below are copy/paste-friendly examples you can adapt.

> Put these entries into `./.knowhow/language.json`.

---

### Example A — Load frontend/backend architecture docs when you say “frontend” or “backend”

```jsonc
{
  "frontend, ui, web": {
    "sources": [
      { "kind": "file", "data": ["docs/architecture/frontend/**/*.md", "docs/architecture/web-frontend.md"] },
      {
        "kind": "text",
        "data": "Frontend conventions:\n- Prefer feature-based folder structure\n- Keep API calls in data layer\n- Use typed DTOs\n"
      }
    ]
  },

  "backend, api, service": {
    "sources": [
      { "kind": "file", "data": ["docs/architecture/backend/**/*.md", "docs/architecture/services/**/*.md"] },
      {
        "kind": "text",
        "data": "Backend conventions:\n- Validate at boundaries\n- Prefer idempotent endpoints when possible\n- Log correlation IDs\n"
      }
    ]
  }
}
```

**Workflow payoff**
- Ask: “How does auth work in the frontend?” → Knowhow injects frontend architecture docs automatically.
- Ask: “Where should we implement input validation in backend?” → Knowhow injects backend guidance.

---

### Example B — Load your current PR when you say “my PR”

```jsonc
{
  "my PR, current PR, pr": {
    "sources": [
      { "kind": "github", "data": ["CURRENT_PR"] },
      {
        "kind": "text",
        "data": "Review approach:\n- Summarize intent\n- Identify risks (correctness, security, perf)\n- Suggest tests and rollback strategy\n"
      }
    ]
  }
}
```

**Workflow payoff**
- “Review my PR for concurrency issues and test coverage.”
- “Summarize changes + highlight any breaking behavior.”

---

### Example C — Load a spec file when you mention a feature name (wildcards)

Assume specs are organized like:

```text
specs/features/<feature>.md
specs/features/<feature>/openapi*.yaml
```

```jsonc
{
  "feature search, search feature": {
    "sources": [
      { "kind": "file", "data": ["specs/features/search.md", "specs/features/search/**/*.md"] }
    ]
  },

  "payments*, payment*": {
    "sources": [
      { "kind": "file", "data": ["specs/features/payments*.md", "specs/features/payments/**/openapi*.{yaml,json}"] },
      { "kind": "text", "data": "Focus for payments:\n- retries & idempotency\n- refund/reconciliation flows\n- edge cases\n" }
    ]
  }
}
```

**How it works**
- `payments*` includes `*`, so it matches using wildcard/glob logic.
- `feature search` is a plain substring hotphrase.

**Workflow payoff**
- “Explain the payments retry strategy.” → injects payments specs automatically.

---

### Example D — Load API docs when you say “API”

```jsonc
{
  "API, apis, api documentation": {
    "sources": [
      { "kind": "file", "data": ["docs/api/**/*.md", "docs/api/**/*.mdx"] },
      { "kind": "file", "data": ["specs/openapi*.json", "specs/openapi*.yaml"] },
      {
        "kind": "text",
        "data": "API answering guidelines:\n- Prefer documented behavior\n- Include request/response schema notes\n- Call out auth and error codes\n- Mention rate limits and pagination\n"
      }
    ]
  }
}
```

**Workflow payoff**
- “What’s the contract for POST /sessions and what errors can it return?”
- “How do I authenticate for the payments endpoints?”

---

### Example E — Load environment info when you say “prod” or “staging”

```jsonc
{
  "prod, production, live": {
    "sources": [
      { "kind": "file", "data": ["ops/runbooks/prod/**/*.md"] },
      { "kind": "file", "data": ["ops/env/prod.env.example", "ops/env/prod.*.example"] },
      { "kind": "url", "data": ["https://status.yourcompany.com/"] }
    ]
  },

  "staging, stage, preprod": {
    "sources": [
      { "kind": "file", "data": ["ops/runbooks/staging/**/*.md"] },
      { "kind": "file", "data": ["ops/env/staging.env.example"] }
    ]
  }
}
```

**Workflow payoff**
- “How do we roll out this change to prod safely?”
- “What’s the rollback procedure for staging failures?”

---

## 7) Dynamic language terms (runtime): `addLanguageTerm` tool

Static `.knowhow/language.json` is great, but sometimes you want **temporary terms** created at runtime—for example:
- “incident-123” should load the incident doc
- “release candidate 1.2.3” should load the right notes
- “my PR” should load the PR for the current branch/selection

Knowhow provides an `addLanguageTerm` capability to add language terms during execution.

### Typical pattern (conceptual)
1. Call `addLanguageTerm` with:
   - the term key
   - its sources (kind/data)
   - optional `events`
2. The new term becomes matchable immediately
3. Next user message can trigger it

**Example (conceptual)**
```ts
addLanguageTerm({
  key: "incident-123",
  sources: [
    { kind: "file", data: ["ops/incidents/incident-123.md"] }
  ]
});
```

**Workflow payoff**
- During an incident response flow, you can dynamically register terms so the agent always references the correct incident/runbook material.

> Exact tool argument shapes vary by environment, but the core idea is: **runtime registration of term → sources**.

---

## 8) Global vs local language config

### Local (project) config
- Active config for term matching:
  - `./.knowhow/language.json`

### Global config
- Your Knowhow installation may create a template at:
  - `~/.knowhow/language.json`
- Whether it is merged automatically depends on your Knowhow version/config behavior.

### Recommended practice
- Put **project/team-specific** rules in `./.knowhow/language.json`
  - architecture docs
  - feature specs
  - environment runbooks
  - repo-specific review rubrics
- If you maintain global defaults, keep them **broad and non-conflicting**
  - e.g., standard “review rubric”, “testing strategy”, “security checklist”

**Tip:** avoid overly broad patterns like `"api"` if other teams/tools use the same word differently—prefer `"API,"` or `"api docs"`.

---

## Best practices (real-world)

- **Target sources tightly**
  - A “frontend” term that injects *every* frontend file can overwhelm answers.
- **Use globs intentionally**
  - Great: `payments*`, `openapi*`, `docs/api/**/*.md`
  - Risky: `*` or extremely short substrings that match too often
- **Use `events` for file-driven workflows**
  - Example: expand API spec context only when editing OpenAPI files.
- **Layer sources**
  - Combine `file` (authoritative docs) + `text` (answering rules)
- **Prefer human hotphrases**
  - `my PR`, `release notes`, `prod rollback`, `incident <id>`

---

If you paste your current directory structure (or a redacted `.knowhow/language.json`), I can propose an optimized set of term keys + globs tailored to your repo and workflows.