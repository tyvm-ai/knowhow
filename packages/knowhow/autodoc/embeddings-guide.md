# Embeddings Guide (Knowhow CLI)

Embeddings are the backbone of Knowhow’s semantic search. Instead of matching exact keywords, Knowhow turns **text chunks** into **vectors** (arrays of numbers) and later searches by **meaning** using vector similarity.

This guide explains how to generate, configure, store, and use embeddings with the Knowhow CLI.

---

## 1) What embeddings are

**Embeddings** are **vector representations** of text.

In Knowhow:

- Your inputs are converted into text (for files: `convertToText(filePath)`).
- The text is split into **chunks** (optional `chunkSize`).
- Each chunk is embedded by an embedding model, producing a `vector: number[]`.
- The result is stored in a local JSON file with entries shaped like:

```json
{
  "id": "some-chunk-id",
  "text": "chunk content (or summarized content)",
  "vector": [0.0123, -0.0045, ...],
  "metadata": {
    "filepath": "...",
    "date": "2026-05-23T..."
  }
}
```

### Chunk IDs and pruning behavior

Knowhow assigns chunk IDs like:

- If `chunkSize` is set: `chunkId = "${id}-${chunkIndex}"`
- If the chunk ID already ends with a numeric suffix, it won’t be re-suffixed.

It also **prunes old chunks**: any existing chunk under the same base `id` that is not part of the newly generated chunk set is removed from the embeddings JSON.

---

## 2) `knowhow embed` — generate embeddings

The CLI’s embedding generation is driven by your `embedSources` configuration.

`knowhow embed`:

1. Loads `.knowhow/knowhow.json`
2. Reads `config.embeddingModel` (fallback: OpenAI Ada v2)
3. For each entry in `config.embedSources`, runs embedding generation and writes the result to `embedSources[].output`

### Example config (local embeddings for docs + code)

```jsonc
{
  "embeddingModel": "openai.EmbeddingAda2",
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

Then run:

```bash
knowhow embed
```

---

## 3) `embedSources` config

Each `embedSources[]` entry controls **what** to embed, **how** to chunk/transform, and **where** to store the resulting embedding JSON.

### Supported fields (from code)

| Field | Type | What it does |
|---|---:|---|
| `input` | string | Glob pattern (or special kind input) describing what to embed |
| `output` | string | Path to the `.json` embeddings file |
| `chunkSize` | number | Split text into chunks of this many characters (template default is commonly `2000`) |
| `minLength` | number | Skip chunks shorter than this many characters |
| `prompt` | string | Optional prompt name/string used to *summarize/transform* each chunk before embedding |
| `kind` | string | Embedding strategy kind (default: `"file"`). Can also be a plugin kind like `asana`, `github`, `url`, etc. |

### Scenario: embed file globs (`kind` defaults to `"file"`)

```jsonc
{
  "embedSources": [
    {
      "input": "docs/**/*.md",
      "output": ".knowhow/embeddings/docs.json",
      "chunkSize": 2000,
      "minLength": 50
    }
  ]
}
```

### Scenario: embed text files by using `kind: "text"`

If `kind` is `"text"`, Knowhow treats the source input as raw text and embeds it as a single item (no file globbing).

```jsonc
{
  "embedSources": [
    {
      "kind": "text",
      "input": "This is the content I want embedded",
      "output": ".knowhow/embeddings/notes.json"
    }
  ]
}
```

### Scenario: transform before embedding with `prompt`

When `prompt` is provided, Knowhow calls a summarization step before generating vectors.

```jsonc
{
  "embedSources": [
    {
      "input": "src/**/*.ts",
      "output": ".knowhow/embeddings/code.json",
      "prompt": "BasicEmbeddingExplainer",
      "chunkSize": 2000
    }
  ]
}
```

> Tip: The prompt is loaded via `loadPrompt(promptName)` which supports either a prompt name (from `.knowhow/prompts/*.mdx`) or a direct prompt string.

### Scenario: skip very small chunks with `minLength`

```jsonc
{
  "embedSources": [
    {
      "input": "docs/**/*.md",
      "output": ".knowhow/embeddings/docs.json",
      "chunkSize": 2000,
      "minLength": 120
    }
  ]
}
```

---

## 4) Embedding models (`embeddingModel`)

Your embedding model is configured via:

```jsonc
{
  "embeddingModel": "openai.EmbeddingAda2"
}
```

Knowhow passes `embeddingModel` directly to the embedding provider client when creating embeddings.

### Supported models

The code exports embedding model sets under:

- `EmbeddingModels.openai.*`
- `EmbeddingModels.google.*`

So supported values are those available in `EmbeddingModels.openai` and `EmbeddingModels.google` in your installed Knowhow version.

> If you also use remote uploads to Knowhow Cloud, be aware that **vectors generated with different models are not comparable**. Knowhow warns on upload when local `embeddingModel` differs from the backend’s stored model.

---

## 5) Remote storage options

Embeddings can be uploaded to remote storage using `knowhow upload`.

Your `embedSources[]` entry must specify:

- `remote`: destination identifier (varies by remote type)
- `remoteType`: which backend to use
- optionally `remoteId` (required for `remoteType: "knowhow"`)

### A) Upload to S3 (`remoteType: "s3"`)

```jsonc
{
  "embedSources": [
    {
      "input": "src/**/*.ts",
      "output": ".knowhow/embeddings/code.json",
      "chunkSize": 2000,

      "remoteType": "s3",
      "remote": "my-embeddings-bucket"
    }
  ]
}
```

Run:

```bash
knowhow embed
knowhow upload
```

How it maps:
- Local `output` JSON is uploaded as something like:  
  `bucketName/embeddingName.json`

### B) Upload to GitHub via git LFS (`remoteType: "github"`)

```jsonc
{
  "embedSources": [
    {
      "input": ".knowhow/docs/**/*.mdx",
      "output": ".knowhow/embeddings/docs.json",
      "chunkSize": 2000,

      "remoteType": "github",
      "remote": "org-or-user/repo-name"
    }
  ]
}
```

Run:

```bash
knowhow embed
knowhow upload
```

> The exact LFS paths/commit behavior is implemented by the Embeddings service resolver for `github`.

### C) Upload to Knowhow Cloud KB (`remoteType: "knowhow"`)

```jsonc
{
  "embedSources": [
    {
      "input": ".knowhow/docs/**/*.mdx",
      "output": ".knowhow/embeddings/docs.json",
      "chunkSize": 2000,

      "remoteType": "knowhow",
      "remote": "unused-or-label",
      "remoteId": "KB_ID_FROM_KNOWHOW_DASHBOARD"
    }
  ]
}
```

Run:

```bash
knowhow embed
knowhow upload
```

---

## 6) `knowhow upload` — upload embeddings to remote

`knowhow upload` iterates `config.embedSources` and uploads the JSON file at each `source.output`.

### Behavior by remote type

- If `remoteType` is known (resolver exists) and `remoteType !== "knowhow"`: uploads using the embeddings resolver.
- If `remoteType === "knowhow"`:
  1. Requires `remoteId`
  2. Fetches (and warns about) model mismatches
  3. Requests a **presigned upload URL**
  4. Uploads the local embedding file via S3 under the hood
  5. Syncs metadata back to the KB (glob, chunk size, etc.)

---

## 7) `knowhow download` — download embeddings from remote

`knowhow download` downloads each embeddings file defined in `embedSources` where `remoteType` is set.

### Example: S3 download

```bash
knowhow download
```

Where it goes:
- For non-knowhow resolvers: it uses the embeddings resolver’s download logic.
- For `remoteType: "knowhow"`: it requests a presigned download URL from the Knowhow API, then saves to your configured `source.output`.

---

## 8) Uploading to knowhow.tyvm.ai (Knowhow Cloud KB)

### Step 1: Get your KB ID

From the Knowhow web app / dashboard, locate the KB (knowledge base) you want embeddings uploaded into and copy its **KB ID**.

### Step 2: Configure your `embedSources` entry

```jsonc
{
  "embedSources": [
    {
      "input": ".knowhow/docs/**/*.mdx",
      "output": ".knowhow/embeddings/docs.json",
      "chunkSize": 2000,

      "remoteType": "knowhow",
      "remoteId": "your-kb-id"
    }
  ]
}
```

### Step 3: Generate + upload

```bash
knowhow embed
knowhow upload
```

Knowhow Cloud upload flow:
- uses the KB ID (`remoteId`) to request a presigned upload URL
- uploads your embeddings JSON
- syncs embed configuration metadata back to the backend

---

## 9) Using embeddings in chat

When the **embeddings plugin** is enabled (it is included in the default plugin list), Knowhow can:

1. Embed the user query using your configured embedding model
2. Compare the query vector against stored vectors using cosine similarity
3. Retrieve the most relevant chunks
4. Inject relevant context into the agent/chat prompt automatically

In other words, chat becomes semantic:
- “Where is the auth code?” matches the meaning even if your code uses different keywords.

> The similarity computation is done by `cosineSimilarity(embedding.vector, queryVector)` and results are sorted descending.

---

## 10) Special input kinds (plugins)

In embedding generation, Knowhow checks:

- If `Plugins.isPlugin(kind)` → it delegates to `Plugins.embed(kind, input)`
- Otherwise it falls back to built-in kinds (`file`, `text`)

That means “special input kinds” work as long as the corresponding plugin is installed/enabled.

Examples include (as referenced by your default enabled plugin list / mentions):
- `asana`
- `github`
- `download`
- `url`
- `jira`
- `linear`
- etc.

### A) Embed a URL/web page (`kind: "url"`)

```jsonc
{
  "embedSources": [
    {
      "kind": "url",
      "input": "https://example.com/docs",
      "output": ".knowhow/embeddings/web.json",
      "chunkSize": 2000
    }
  ]
}
```

### B) Embed Asana tasks (`kind: "asana"`)

```jsonc
{
  "embedSources": [
    {
      "kind": "asana",
      "input": "project:MY_PROJECT_ID or task:123456",
      "output": ".knowhow/embeddings/asana.json",
      "chunkSize": 2000
    }
  ]
}
```

### C) Embed GitHub content (`kind: "github"`)

```jsonc
{
  "embedSources": [
    {
      "kind": "github",
      "input": "org/repo",
      "output": ".knowhow/embeddings/github.json",
      "chunkSize": 2000
    }
  ]
}
```

### D) Embed YouTube videos (plugin kind)

If you have a YouTube embedding plugin installed, you can use it similarly:

```jsonc
{
  "embedSources": [
    {
      "kind": "youtube",
      "input": "https://www.youtube.com/watch?v=VIDEO_ID",
      "output": ".knowhow/embeddings/youtube.json",
      "chunkSize": 2000
    }
  ]
}
```

> The exact `input` format is plugin-specific—use the plugin’s documentation/examples for how it expects URLs, IDs, or project selectors.

---

# Recommended workflow

1. **Configure** `embedSources` locally
2. Run:  
   ```bash
   knowhow embed
   ```
3. If desired, store remotely:
   ```bash
   knowhow upload
   ```
4. For other environments/machines:
   ```bash
   knowhow download
   ```

---

If you paste your current `.knowhow/knowhow.json` (especially `embedSources`), I can suggest an optimal setup (chunk sizing, minLength, prompt strategy, and the best remoteType for your workflow).