# Embeddings Guide (Knowhow CLI)

Embeddings are the backbone of Knowhow’s semantic search. Instead of searching for exact words, Knowhow converts *text chunks* into **vectors** (arrays of numbers) that represent meaning. Later, when you ask a question, Knowhow embeds the question and finds the most similar vectors across your docs/code/other sources.

This guide explains how to generate, configure, store, and use embeddings in Knowhow.

---

## 1) What embeddings are

An **embedding** is a numeric vector representing a piece of text.

When Knowhow runs embedding generation:

- It **chunks** your content into pieces (default ~2000 characters per chunk).
- For each chunk, it may optionally **summarize/transform** the text with a prompt.
- It then calls the configured embedding model to create a vector.
- It saves an entry shaped like:

```json
{
  "id": "chunk-id",
  "text": "chunk content (possibly summarized)",
  "vector": [0.0123, -0.0045, ...],
  "metadata": {
    "...": "source-specific metadata"
  }
}
```

### Chunk IDs (how Knowhow identifies chunks)
- If `chunkSize` is set, Knowhow typically uses:
  - `id-index` (e.g. `path/to/file.ts-3`)
- If `chunkSize` is not set, it may keep the original `id`.

Knowhow also prunes old chunk embeddings that no longer match the current input (to keep embeddings in sync).

---

## 2) `knowhow embed` (generate embeddings)

Run the embedding generation step:

```bash
knowhow embed
```

Knowhow will:

1. Load `.knowhow/knowhow.json`
2. For each entry in `embedSources`, embed content into the configured `.json` output file(s)
3. Save updated embeddings locally under paths like:
   - `.knowhow/embeddings/docs.json`
   - `.knowhow/embeddings/code.json`

> In code, the embedding step iterates `config.embedSources` and calls `embedSource(...)` for each configured source.

---

## 3) `embedSources` config (what to embed)

In `.knowhow/knowhow.json`, embeddings are configured under:

```json
{
  "embedSources": [ ... ]
}
```

Each entry supports these fields (from the config types and embedding logic):

### `input` (required)
**Glob pattern** or a direct input string (depending on `kind`).

- If `kind` is `"file"` (default), Knowhow globs the filesystem:
  - `input: ".knowhow/docs/**/*.mdx"`
- For non-`file` kinds, Knowhow may treat `input` as a single input value.

### `output` (required)
Path where the generated embeddings JSON file is saved.

Example:
- `.knowhow/embeddings/docs.json`

Knowhow writes the file as a JSON array:
- Sorted by `id`
- Each element includes `id`, `text`, `vector`, `metadata`

### `chunkSize` (optional)
How many **characters per chunk**.

- Default in the template config is `2000`
- If provided, chunk IDs include `-index`

### `minLength` (optional)
Skip chunks shorter than this number of characters.

Implementation detail:
```ts
const tooShort = minLength && textOfChunk.length < minLength;
```

### `prompt` (optional)
If set, Knowhow transforms each chunk *before* embedding by summarizing it with a prompt.

- The prompt is loaded via `summarizeTexts([textOfChunk], prompt)`
- Metadata stores extra text when a prompt is used:
  - `metadata.text` is set to the original chunking output (see code path)

This is especially useful to:
- compress long chunks
- standardize content for better retrieval
- emphasize relevant information

### `kind` (optional)
Controls how the input is interpreted.

- If omitted: defaults to `"file"`
- Supported patterns:
  - `"file"`: embed content from files on disk (converted to text)
  - `"text"`: embed a provided text string
  - Other kinds: typically handled by embeddings plugins (see “Special input kinds” below)

---

### `embedSources` example: embed docs (MDX) with chunking + prompt

```json
{
  "embeddingModel": "text-embedding-ada-002",
  "embedSources": [
    {
      "kind": "file",
      "input": ".knowhow/docs/**/*.mdx",
      "output": ".knowhow/embeddings/docs.json",
      "prompt": "BasicEmbeddingExplainer",
      "chunkSize": 2000
    }
  ]
}
```

---

### `embedSources` example: embed TypeScript source files

```json
{
  "embedSources": [
    {
      "kind": "file",
      "input": "src/**/*.ts",
      "output": ".knowhow/embeddings/code.json",
      "chunkSize": 2000,
      "minLength": 200
    }
  ]
}
```

---

### `embedSources` example: embed a literal text string

```json
{
  "embedSources": [
    {
      "kind": "text",
      "input": "This is a short paragraph I want searchable.",
      "output": ".knowhow/embeddings/notes.json",
      "chunkSize": 0,
      "minLength": 1
    }
  ]
}
```

> With `kind: "text"`, Knowhow treats `input` as the content to embed (it hashes it to generate an ID).

---

## 4) Embedding models (`embeddingModel`)

Knowhow uses `embeddingModel` from config to request vectors from the embedding provider.

Default (from the template config):
- `text-embedding-ada-002`

Supported models in the codebase:

### OpenAI embedding models
- `text-embedding-ada-002` (`EmbeddingAda2`)
- `text-embedding-3-small` (`EmbeddingSmall3`)
- `text-embedding-3-large` (`EmbeddingLarge3`)

### Google embedding models
- `gemini-embedding-exp` (`Gemini_Embedding`)
- `gemini-embedding-001` (`Gemini_Embedding_001`)

Example config:

```json
{
  "embeddingModel": "text-embedding-3-small",
  "embedSources": [
    {
      "input": "docs/**/*.md",
      "output": ".knowhow/embeddings/docs.json",
      "chunkSize": 2000
    }
  ]
}
```

---

## 5) Remote storage options (upload/download embeddings)

Knowhow can store the generated embeddings JSON remotely using `remote` and `remoteType` in each `embedSources` entry.

### A) Upload to S3: `remoteType: "s3"`
**Config**
- `remote`: S3 bucket name
- `output`: local path to the `.json` embeddings file to upload

Upload behavior (from `knowhow upload`):
- uploads `source.output` to `${bucket}/${embeddingName}.json` (where `embeddingName` is derived from the local filename)

Example:

```json
{
  "embedSources": [
    {
      "input": ".knowhow/docs/**/*.mdx",
      "output": ".knowhow/embeddings/docs.json",
      "remoteType": "s3",
      "remote": "my-knowhow-embeddings",
      "chunkSize": 2000
    }
  ]
}
```

Download behavior (from `knowhow download`):
- downloads `${name}.json` from the bucket into `source.output`

---

### B) Upload via GitHub (git LFS): `remoteType: "github"`
The downloader supports `remoteType: "github"` (implemented in `knowhow download`).

From `knowhow download`:
- downloads `".knowhow/embeddings/<fileName>.json"` from a configured GitHub remote into `destinationPath`

Example:

```json
{
  "embedSources": [
    {
      "input": "src/**/*.ts",
      "output": ".knowhow/embeddings/code.json",
      "remoteType": "github",
      "remote": "github-owner/github-repo"
    }
  ]
}
```

> Note: in the provided `knowhow upload` implementation, S3 and Knowhow-cloud uploads are explicit; GitHub/LFS upload behavior may be handled by other integrations in your setup.

---

### C) Upload to Knowhow Cloud KB: `remoteType: "knowhow"`
This is the integration path for storing embeddings into Knowhow’s hosted knowledge base.

From `knowhow upload`:
- requires `remoteId`
- uses a presigned upload URL
- then syncs embedding metadata back to the backend DB

Example:

```json
{
  "embedSources": [
    {
      "input": ".knowhow/docs/**/*.mdx",
      "output": ".knowhow/embeddings/docs.json",
      "remoteType": "knowhow",
      "remoteId": "kb_1234567890abcdef"
    }
  ]
}
```

---

## 6) `knowhow upload` (upload embeddings to remote)

Command:

```bash
knowhow upload
```

For each `embedSources` entry:

- if `remoteType` is missing → it skips that source
- if `remoteType === "s3"` → uploads via S3Service
- if `remoteType === "knowhow"` → uploads via Knowhow presigned URLs and syncs metadata

Example: upload both docs and code embeddings

```json
{
  "embedSources": [
    {
      "input": ".knowhow/docs/**/*.mdx",
      "output": ".knowhow/embeddings/docs.json",
      "remoteType": "s3",
      "remote": "my-knowhow-embeddings"
    },
    {
      "input": "src/**/*.ts",
      "output": ".knowhow/embeddings/code.json",
      "remoteType": "knowhow",
      "remoteId": "kb_1234567890abcdef"
    }
  ]
}
```

Run:

```bash
knowhow upload
```

---

## 7) `knowhow download` (download embeddings from remote)

Command:

```bash
knowhow download
```

It will read each configured `embedSources[].remoteType` and download the corresponding embeddings JSON into `embedSources[].output`.

Supported remote types in the provided code:
- `s3`
- `github`
- `knowhow` (requires `remoteId`)

Example:

```json
{
  "embedSources": [
    {
      "output": ".knowhow/embeddings/docs.json",
      "remoteType": "s3",
      "remote": "my-knowhow-embeddings"
    }
  ]
}
```

Run:

```bash
knowhow download
```

---

## 8) Uploading to knowhow.tyvm.ai (Cloud KB)

To upload embeddings to the Knowhow cloud knowledge base:

### Step 1: Get a KB ID
You need the `KB ID` (stored as `remoteId`) from **knowhow.tyvm.ai**.

### Step 2: Configure your local `embedSources`
Set:

- `remoteType: "knowhow"`
- `remoteId: "<your KB ID>"`

Example:

```json
{
  "embedSources": [
    {
      "input": ".knowhow/docs/**/*.mdx",
      "output": ".knowhow/embeddings/docs.json",
      "remoteType": "knowhow",
      "remoteId": "kb_1234567890abcdef",
      "chunkSize": 2000
    }
  ]
}
```

### Step 3: Generate + upload
1) Generate embeddings:

```bash
knowhow embed
```

2) Upload them:

```bash
knowhow upload
```

Knowhow Cloud upload also syncs metadata back (glob, output path, chunk size, remoteType).

---

## 9) Using embeddings in chat

Knowhow’s chat tooling includes an **embeddings plugin** (enabled by default in the template config). The plugin:

- embeds the user query
- computes similarity between the query vector and stored embedding vectors
- automatically selects the most relevant chunks
- injects them into the model context as supporting material

So, once your embeddings are generated and (optionally) uploaded/downloaded, you typically don’t manually reference the embedding files—**semantic retrieval happens automatically** by the chat/embeddings integration.

---

## 10) Special input kinds (YouTube, Asana, web pages, etc.)

`embedSources[].kind` can be more than `"file"`/`"text"`. The embedding pipeline checks:

- if `Plugins.isPlugin(kind)` is true → it delegates embedding to that plugin:
  ```ts
  return Plugins.embed(kind, input);
  ```

Your default config template enables many plugins (including `asana`, `github`, `download`, `url`, etc.), which commonly correspond to special `kind` values.

### Pattern for plugin-based kinds
Use:

- `kind`: plugin name
- `input`: plugin-specific selector or identifier
- `output`: local embeddings JSON file
- optional: `prompt`, `chunkSize`, `minLength`

#### Example: embed Asana tasks (plugin-based kind)
```json
{
  "embedSources": [
    {
      "kind": "asana",
      "input": "workspace-or-project-id-or-filter",
      "output": ".knowhow/embeddings/asana.json",
      "chunkSize": 2000
    }
  ]
}
```

#### Example: embed web pages (URL plugin)
```json
{
  "embedSources": [
    {
      "kind": "url",
      "input": "https://example.com/docs/index.html",
      "output": ".knowhow/embeddings/web.json",
      "chunkSize": 2000
    }
  ]
}
```

#### Example: embed YouTube videos
```json
{
  "embedSources": [
    {
      "kind": "youtube",
      "input": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "output": ".knowhow/embeddings/youtube.json",
      "chunkSize": 2000,
      "prompt": "BasicEmbeddingExplainer"
    }
  ]
}
```

#### Example: embed GitHub content (plugin-based kind)
```json
{
  "embedSources": [
    {
      "kind": "github",
      "input": "owner/repo",
      "output": ".knowhow/embeddings/github.json",
      "chunkSize": 2000
    }
  ]
}
```

> If a `kind` doesn’t correspond to an enabled embedding plugin, Knowhow may not know how to fetch/convert that input. Ensure the plugin is installed/enabled in your Knowhow setup.

---

## Practical recipes

### 1) Embed docs + upload to S3
```json
{
  "embeddingModel": "text-embedding-3-small",
  "embedSources": [
    {
      "input": ".knowhow/docs/**/*.mdx",
      "output": ".knowhow/embeddings/docs.json",
      "prompt": "BasicEmbeddingExplainer",
      "chunkSize": 2000,
      "remoteType": "s3",
      "remote": "my-knowhow-embeddings"
    }
  ]
}
```

```bash
knowhow embed
knowhow upload
```

### 2) Embed code + upload to Knowhow cloud KB
```json
{
  "embedSources": [
    {
      "input": "src/**/*.ts",
      "output": ".knowhow/embeddings/code.json",
      "chunkSize": 2000,
      "remoteType": "knowhow",
      "remoteId": "kb_1234567890abcdef"
    }
  ]
}
```

```bash
knowhow embed
knowhow upload
```

---

If you share your current `.knowhow/knowhow.json`, I can tailor an embeddings configuration (chunking, prompts, and remote storage) to your exact project structure and retrieval goals.