# `knowhow generate` Guide

`knowhow generate` is Knowhow’s “code-to-documents” generator. It reads your `sources` from `.knowhow/knowhow.json`, resolves prompts, runs AI summarization (or plugin handlers), and writes output files (or sets of files) to your configured `output` paths.

---

## 1) What `knowhow generate` does

At a high level, for each entry in `config.sources`, it:

1. **Finds input files** using `source.input` (glob / comma list / brace expansion).
2. **Loads the prompt** via `source.prompt`.
3. **Chooses output mode** based on `source.output`:
   - If `source.output` ends with `/` → **multi-output mode** (one output per input file).
   - Otherwise → **single-output mode** (one combined output file).
4. **Skips work using caching** (`.knowhow/.hashes.json`):
   - It computes an **MD5 hash of the prompt** and an **MD5 hash of each input file’s converted text**.
   - If the prompt+file hashes match what was last generated, the output is skipped.
5. **Writes generated documents** to disk.

### Output mode behavior (from the code)

#### A) Multi-output mode (directory output)
If `source.output` ends with `/`:

- For each matched input file:
  - Compute an output folder that preserves subpaths **under the base prefix before `**`**.
    - Example: with `input: "src/**/*.ts"`, the base prefix is `"src/"`.
    - A file like `src/cli/index.ts` becomes an output at:
      - `<output>/<nestedFolder>/<outputName>.<outputExt>`
  - Default `outputExt` is `"mdx"` unless overridden by `outputExt`.

#### B) Single-output mode (single file output)
If `source.output` does **not** end with `/`:

- It writes **one** `source.output` file that contains combined results for **all** matched inputs.

---

## 2) `sources` configuration structure

Your `sources` array lives in `.knowhow/knowhow.json` under `sources`.

Each source entry is a `GenerationSource` with these commonly used fields:

### `input`
Controls which files are processed. Supported formats (as implemented):

- **Single file**
  ```json
  "input": "src/index.ts"
  ```
- **Glob**
  ```json
  "input": "src/**/*.ts"
  ```
- **Comma-separated list**
  ```json
  "input": "src/a.ts,src/b.ts,src/c.ts"
  ```
  Comma lists are normalized into brace expansion internally.
- **Brace expansion**
  ```json
  "input": "{src/a.ts,src/b.ts}"
  ```

> Implementation note: Knowhow normalizes comma-separated lists into `{a,b,c}` form (so it can pass it to the glob library).

---

### `output`
Controls where results are written:

- **Directory output** (multi-output mode)
  - Must end with `/`:
  ```json
  "output": ".knowhow/docs/"
  ```
- **Single file output** (single-output mode)
  ```json
  "output": ".knowhow/docs/README.mdx"
  ```

Knowhow creates directories automatically in multi-output mode.

---

### `prompt`
Controls the prompt to use for AI generation.

Knowhow resolves `prompt` in this order:

1. **Prompt name in `promptsDir`**  
   If `prompt` is a name like `"BasicCodeDocumenter"`, it will try:
   - `<promptsDir>/<prompt>.mdx`  
   Example: `.knowhow/prompts/BasicCodeDocumenter.mdx`

2. **Direct prompt file path**
   - If `prompt` points to an existing file, it reads that file.

3. **Inline prompt string**
   - If neither a known prompt file nor a direct path exists, Knowhow treats the `prompt` value itself as the prompt text.

> Also: Knowhow ensures your prompt contains a `{text}` placeholder. If it’s missing, it automatically appends:
> `\n\n{text}`

---

### `kind`
Special processing kind.

From the code:

- If `kind` is `"file"` **or missing** → **standard file summarization** pipeline runs.
- Otherwise → Knowhow attempts a **plugin-based handler**:
  - It checks `Plugins.isPlugin(kind)`.
  - If it is a plugin:
    - It runs `Plugins.call(kind, input)` and writes the result to `source.output` (but **plugin output must be a single file**; directory outputs are rejected for plugins).
  - After the plugin step (or if the kind is not a plugin), Knowhow still proceeds to the normal file summarization generation for that source.

**Practical takeaway:**  
Use `kind` for plugin integrations; otherwise default file generation happens.

---

### `agent`
Selects which agent to use when calling the AI summarizer.

- If omitted, a default is used (the docs mention default agent: **Developer**).

---

### `model`
Overrides the model for this source.

- The value is passed to `summarizeFile(...)` / `summarizeFiles(...)`.

> If you don’t set `model`, Knowhow will use whatever default model the summarization layer chooses (not shown in the provided code).

---

### `outputExt`
Overrides the extension used for multi-output mode outputs.

- Default in multi-output handler: `"mdx"`
- Only applied when `output` ends with `/` (directory mode).

---

### `outputName`
Overrides the filename portion used for multi-output mode.

- Only applied when `output` ends with `/`.
- For each input file, output filename becomes:
  - `<outputFolder>/<outputName>.<outputExt>` (instead of using the input’s basename)

---

## 3) Prompt resolution (where your prompt comes from)

Knowhow loads prompts with `loadPrompt(promptName)` and supports:

### A) Prompt file in `promptsDir`
- Default `promptsDir`: `.knowhow/prompts`
- Example prompt file:
  - `.knowhow/prompts/MyPrompt.mdx`

Config:
```json
"prompt": "MyPrompt"
```

Knowhow reads:
- `.knowhow/prompts/MyPrompt.mdx`

### B) Direct prompt file path
Config:
```json
"prompt": "./prompts/MyPrompt.mdx"
```

Knowhow reads that file if it exists.

### C) Inline prompt string
Config:
```json
"prompt": "Summarize the following code and output markdown with sections..."
```

### `{text}` placeholder requirement
Knowhow requires/ensures the prompt contains `{text}`.

- If your prompt doesn’t include it, Knowhow appends it automatically.
- `{text}` is where Knowhow inserts the content it’s summarizing (the code/text extracted from each input file).

---

## 4) Input patterns: examples

### Single file
```json
{
  "input": "src/index.ts",
  "output": ".knowhow/out/index.mdx",
  "prompt": "BasicCodeDocumenter"
}
```

### Glob (multiple files → combined single output)
```json
{
  "input": "src/**/*.ts",
  "output": ".knowhow/docs/SDK.md",
  "prompt": "BasicCodeDocumenter"
}
```

### Glob (multiple files → one output per file)
```json
{
  "input": "src/**/*.ts",
  "output": ".knowhow/docs/",
  "prompt": "BasicCodeDocumenter",
  "outputExt": "mdx"
}
```

### Comma-separated inputs (combined single output)
```json
{
  "input": "src/a.ts,src/b.ts,src/c.ts",
  "output": ".knowhow/docs/selected.md",
  "prompt": "BasicCodeDocumenter"
}
```

### Brace expansion
```json
{
  "input": "{src/a.ts,src/b.ts}",
  "output": ".knowhow/docs/selected.md",
  "prompt": "BasicCodeDocumenter"
}
```

---

## 5) Output modes: directory vs single file

### Directory output (`output` ends with `/`)
Produces **N output files** (one per input file matched).

Each output file is placed under your output directory while preserving nested folders relative to the prefix before `**`.

---

### Single-file output (`output` is a file path)
Produces **one output file** that combines all matched inputs into a single document.

---

## 6) Hashing / caching: when outputs are skipped

Knowhow uses `.knowhow/.hashes.json` and stores hashes keyed by the input file path (and the prompt hash).

In both output modes:

- It computes:
  - `promptHash = md5(prompt)`
  - `fileHash = md5(convertToText(file))`
- It calls `checkNoFilesChanged(...)` for the “to check” set:
  - **Multi-output mode** checks: `[file, outputFile]`
  - **Single-output mode** checks: `[outputFile, ...files]`
- If nothing changed, Knowhow logs a skip and moves on.

**Important:** If the input or output file is missing on disk, regeneration will happen.

---

## 7) Writing good `.mdx` prompt files

Knowhow expects prompt files to be **MDX** templates (e.g. `.knowhow/prompts/MyPrompt.mdx`).

### Minimum requirement
Your prompt must include a `{text}` placeholder (Knowhow will add it if you forget).

### Recommended structure
A solid prompt usually asks for:

- Clear sections (e.g. Overview / API / Usage / Notes)
- Output format (markdown headings, lists)
- Constraints (brevity, accuracy)
- Interpretation rules (assume code is partial, etc.)

### Example prompt file: `.knowhow/prompts/BasicCodeDocumenter.mdx`

```mdx
# File documentation

You are a technical writer.

Given this code, produce documentation with:
1. **Purpose** (1-3 sentences)
2. **Key exported items** (functions/classes/types)
3. **How it works** (step-by-step at a high level)
4. **Important caveats** (edge cases, assumptions)
5. **Examples** (if obvious)

Return valid Markdown.

Source content:
```text
{text}
```
```

### About “file: src/cli.ts”
Many Knowhow prompt templates also include a filename header (often formatted like `file: src/cli.ts`) above the `{text}` block. In your own prompts, follow the same pattern you see in the built-in prompts under `.knowhow/prompts/`.

---

## 8) Pipeline examples (transcribe → summarize → embed)

`knowhow generate` performs “summarize / document from inputs” steps. Embeddings are handled by a separate command (`knowhow embed`), but you can model a pipeline with multiple config sections.

### Example: Transcribe audio → generate summaries → embed them

1. **Transcribe step**  
   Use `sources` with an appropriate `kind` if you have a transcription plugin installed (or you can generate from already-transcribed text).

2. **Summarize step**  
   Use `knowhow generate` to turn transcripts into markdown documents.

3. **Embed step**  
   Use `embedSources` for chunking and embedding.

Example config outline:

```json
{
  "sources": [
    {
      "input": "audio/**/*.txt",
      "output": ".knowhow/transcripts/",
      "prompt": "TranscriptSummarizer",
      "outputExt": "mdx"
    },
    {
      "input": ".knowhow/transcripts/**/*.mdx",
      "output": ".knowhow/docs/AllSummaries.mdx",
      "prompt": "ProjectSummary"
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

Run sequence:
- `knowhow generate`
- `knowhow embed`

---

## 9) Running for specific sources

From the provided code, `generate()` loops through **all** entries in `config.sources`:

```ts
for (const source of config.sources) {
  ...
}
```

So, there isn’t an obvious built-in “select by name” mechanism shown here.

### Practical approaches
- **Temporarily edit** `.knowhow/knowhow.json` to include only the sources you want to regenerate.
- Split sources into multiple config files/directories and swap configs (if your workflow supports it).
- Rely on caching: if your inputs and prompts haven’t changed, Knowhow will skip work automatically.

---

## 10) Practical `sources` config examples

### Example A: Generate one file per component (directory output)
```json
{
  "sources": [
    {
      "kind": "file",
      "input": "src/components/**/*.ts",
      "output": ".knowhow/docs/components/",
      "prompt": "BasicCodeDocumenter",
      "outputExt": "mdx",
      "agent": "Developer",
      "model": "gpt-5.4-nano"
    }
  ]
}
```

### Example B: Generate a single README from multiple files (single-file output)
```json
{
  "sources": [
    {
      "input": "src/**/*.ts",
      "output": ".knowhow/docs/README.mdx",
      "prompt": "BasicProjectDocumenter"
    }
  ]
}
```

### Example C: Combine a custom set of files using comma-separated input
```json
{
  "sources": [
    {
      "input": "src/cli.ts,src/config.ts,src/index.ts",
      "output": ".knowhow/docs/CLI-Notes.mdx",
      "prompt": "BasicCodeDocumenter"
    }
  ]
}
```

---

If you want, paste your current `.knowhow/knowhow.json` `sources` section and the prompt(s) you’re using, and I’ll help you validate the config (including output folder structure expectations and caching behavior).