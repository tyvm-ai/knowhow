# `knowhow generate` Guide

`knowhow generate` is the Knowhow CLI command that turns your input files into generated documentation (and other artifacts) by running an AI prompt over the selected sources and writing the results to your configured outputs.

It is driven entirely by your local **`.knowhow/knowhow.json`** config—specifically the **`sources`** array.

---

## What `knowhow generate` does

When you run:

```bash
knowhow generate
```

the CLI:

1. Loads your Knowhow config from **`.knowhow/knowhow.json`**
2. For each entry in **`config.sources`**:
   - Expands `source.input` into a list of matching files
   - Resolves `source.prompt` into an MDX prompt template or prompt string
   - Uses the selected `model`/`agent` to summarize/generate content
   - Writes output to either:
     - a single output file, or
     - multiple output files inside an output directory
3. Skips work when inputs and prompt haven’t changed (hash-based caching)

---

## `sources` configuration structure

`sources` is an array of objects in `.knowhow/knowhow.json`.

At runtime, each source object may be handled in one of two ways:

- **File generation mode** (default): when `kind` is `"file"` or missing/empty
- **Plugin/“special kind” mode**: when `kind` is set and is not `"file"` (see `kind` below)

### Common fields

```jsonc
{
  "input": "src/**/*.ts",
  "output": ".knowhow/docs/",
  "prompt": "MyPrompt",
  "kind": "file",
  "agent": "Developer",
  "model": "gpt-4o-mini",
  "outputExt": "mdx",
  "outputName": "README"
}
```

All fields described below are part of `GenerationSource` usage in the generator.

---

## Field reference

### `input` (required)
Defines which files to read. Supported formats are:

- **Single file**
  ```json
  { "input": "src/index.ts" }
  ```
- **Glob**
  ```json
  { "input": "src/**/*.ts" }
  ```
- **Comma-separated list**
  ```json
  { "input": "src/a.ts,src/b.ts,src/c.ts" }
  ```
  Comma-separated values are auto-normalized into brace expansion internally.
- **Brace expansion**
  ```json
  { "input": "{src/a.ts,src/b.ts}" }
  ```

**Normalization behavior (important):**
- If `input` contains `{`, `*`, or `?`, it is used as-is.
- If `input` contains commas and no glob/braces, commas are converted into `{a,b,c}`.
- Otherwise, it’s treated as a glob/pattern directly.

---

### `output` (required)
Defines where generated content is written.

Two output modes exist:

#### 1) Directory mode (multi-output)
If `output` **ends with `/`**, each input file becomes its own output file:

```json
{
  "input": "src/**/*.ts",
  "output": ".knowhow/docs/",
  "outputExt": "mdx"
}
```

- Output file name defaults to the input file’s base name
- You can override the output name (see `outputName`)
- You can override the output extension (see `outputExt`)

#### 2) Single file mode (single-output)
If `output` **does not end with `/`**, all matched input files are combined into **one** output file.

```json
{
  "input": "src/**/*.ts",
  "output": ".knowhow/docs/ALL.md"
}
```

---

### `prompt` (required or optional depending on your desired behavior)
Controls the AI instruction template.

You can supply `prompt` in any of these ways:

1. **Prompt name** (looked up in `promptsDir`)
   ```json
   { "prompt": "BasicCodeDocumenter" }
   ```
   The generator looks for:
   - `<promptsDir>/<promptName>.mdx`
   - Default `promptsDir` is: **`.knowhow/prompts`**

2. **Direct prompt file path**
   ```json
   { "prompt": "prompts/MyPrompt.mdx" }
   ```
   If that file exists, it is read as prompt content.

3. **Inline prompt string**
   ```json
   { "prompt": "Summarize the following file as a short doc for newcomers.\n\n{text}" }
   ```

#### `{text}` placeholder requirement
If the prompt template does **not** include `{text}`, Knowhow automatically appends:

```mdx
{text}
```

so the input is included when rendering.

---

### `kind` (optional)
Controls whether generation is treated as “file generation” or a “special processing kind”.

- If `kind` is `"file"` **or missing**, Knowhow performs the normal file summarization flow.
- Otherwise, Knowhow checks whether `kind` matches a registered plugin:
  - If it is a plugin, the plugin is executed and its returned data is written to `output` (and directory output is rejected for plugin-only output).
  - Then Knowhow still proceeds with file generation for that same source.

> In other words: non-`file` kinds can run a plugin and then also run the file-based generation pipeline.

---

### `agent` (optional)
Selects which agent to use.

- Default agent (as noted in your config requirements): **`Developer`**
- This value is passed through to summarization functions.

---

### `model` (optional)
Overrides the AI model for this source.

- If omitted, the summarization functions will use Knowhow’s configured default model/provider logic (outside the code shown here).
- If provided, the source-specific `model` is used when calling `summarizeFile` / `summarizeFiles`.

---

### `outputExt` (optional; multi-output mode only)
Overrides the extension used for generated files when `output` ends with `/`.

Default: **`"mdx"`**

Example:

```json
{
  "input": "src/**/*.ts",
  "output": ".knowhow/docs/",
  "outputExt": "md"
}
```

---

### `outputName` (optional; multi-output mode only)
Overrides the generated output file’s base name (instead of using the input file’s name).

Example:

```json
{
  "input": "src/**/*.ts",
  "output": ".knowhow/docs/",
  "outputName": "REFERENCE",
  "outputExt": "mdx"
}
```

Each file would still map into the directory (including nested folders), but each output filename would be `REFERENCE.<outputExt>`.

---

## Prompt resolution (how Knowhow finds your prompt)

Knowhow resolves `source.prompt` using the following order (from `loadPrompt()`):

1. **Look in `promptsDir`**
   - Default `promptsDir`: **`.knowhow/prompts`**
   - It checks for:  
     `path.join(promptsDir, promptName + ".mdx")`

2. **Try `prompt` as a direct file path**
   - If `fs.existsSync(promptName)` succeeds, it reads that file.

3. **Treat `prompt` itself as the prompt content**
   - If neither file exists, the value is used as an inline prompt string.

Finally, it ensures `{text}` exists (appends it if missing).

---

## Input → output mapping (output modes)

### A) Directory output (`output` ends with `/`)
For each input file:

- Knowhow computes a nested output folder based on the prefix before `**`.

Given:

```json
"input": "src/**/*.ts",
"output": ".knowhow/docs/"
```

- `inputPath` becomes `"src/"` (everything before the `**`)
- Each input file’s directory is transformed into an equivalent subfolder under the output directory

Then each file is written as:

- `output/<nestedFolder>/<outputFileName>.<outputExt>`

Where:
- `outputFileName` = `outputName` if provided, otherwise the input file’s base name
- `outputExt` defaults to `mdx` unless overridden

---

### B) Single file output (`output` does NOT end with `/`)
All matched files are combined and written into the one `output` path.

---

## Hashing / caching behavior (skips unchanged files)

Knowhow uses a persistent hash file:

- **`.knowhow/.hashes.json`**

For each generation operation, it computes:

- `promptHash` = `md5(promptString)`
- `fileHash` = `md5(convertToText(file))` (input content)
- For directory mode, it checks both:
  - the input file, and
  - the output file

If `checkNoFilesChanged()` decides nothing has changed, Knowhow prints a “Skipping…” message and does not regenerate.

This means:
- Changing the prompt will invalidate cache for those files
- Changing input file content will invalidate cache for those files

---

## Writing good prompt templates (`.mdx`)

Prompt files are typically stored under:

- **`.knowhow/prompts/YourPromptName.mdx`**

### Minimum guidance

- Include a **`{text}`** placeholder somewhere in the prompt.
- If you forget it, Knowhow will append it automatically at the end—but you should still place it where it makes sense.

#### Example: basic prompt file

**`.knowhow/prompts/BasicCodeDocumenter.mdx`**
```mdx
# Document this file

Write a clear developer-focused documentation page.

Requirements:
- 1–2 paragraph summary
- list of key exported functions/classes
- notable pitfalls or usage notes

Input:
{text}
```

Then reference it in `knowhow.json`:

```json
{
  "input": "src/**/*.ts",
  "output": ".knowhow/docs/",
  "prompt": "BasicCodeDocumenter"
}
```

---

## Practical examples

### 1) Generate docs for every source file (directory mode)

```json
{
  "sources": [
    {
      "input": "src/**/*.ts",
      "output": ".knowhow/docs/",
      "prompt": "BasicCodeDocumenter",
      "outputExt": "mdx",
      "agent": "Developer"
    }
  ]
}
```

Result:
- `.knowhow/docs/<same-folder-structure-as-src>/<filename>.mdx`

---

### 2) Generate one “project overview” doc from many inputs (single file mode)

```json
{
  "sources": [
    {
      "input": "src/**/*.ts",
      "output": ".knowhow/docs/OVERVIEW.mdx",
      "prompt": "BasicProjectDocumenter"
    }
  ]
}
```

Result:
- One file: `.knowhow/docs/OVERVIEW.mdx`

---

### 3) Use comma-separated input (combined behavior)

Comma-separated inputs are treated as brace-expanded patterns, but functionally they still match multiple files.

```json
{
  "sources": [
    {
      "input": "src/a.ts,src/b.ts,src/c.ts",
      "output": ".knowhow/docs/SUBSET.mdx",
      "prompt": "BasicCodeDocumenter"
    }
  ]
}
```

Because `output` does not end with `/`, all matched inputs are combined into **one** output.

---

### 4) Use brace expansion directly

```json
{
  "sources": [
    {
      "input": "{src/controllers/*.ts,src/services/*.ts}",
      "output": ".knowhow/docs/",
      "prompt": "BasicCodeDocumenter"
    }
  ]
}
```

Directory mode: each input file becomes its own output file.

---

### 5) Inline prompt (no prompt file)

```json
{
  "sources": [
    {
      "input": "src/index.ts",
      "output": ".knowhow/docs/index.mdx",
      "prompt": "Explain what this module does in plain English.\n\n{text}"
    }
  ]
}
```

---

## Pipeline example: generate → embed

A common workflow is:

1. **Generate documentation files**
2. **Embed the generated docs** for search/RAG

Your config already supports embedding in a separate `embedSources` array. A typical setup:

```jsonc
{
  "sources": [
    {
      "input": "src/**/*.ts",
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
  ]
}
```

Then run:

```bash
knowhow generate
knowhow embed
```

---

## Running for specific sources

There is **no built-in CLI flag** in the shown `knowhow generate` command to select only one `sources[]` entry.

To target a specific source you typically have two options:

- **Temporarily edit** `.knowhow/knowhow.json` to comment out other `sources`
- **Create a separate config** and adjust your workflow (the current CLI wiring shown does not expose a `--config` argument for `generate`)

---

If you want, paste your current `.knowhow/knowhow.json` `sources` array and tell me whether you want **single-file** or **directory-per-input** outputs—I can help you rewrite it for the behavior you want.