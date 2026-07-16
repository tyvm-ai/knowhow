import { summarizeFiles, summarizeFile } from "./ai";
import type { AgentOptions } from "./ai";
import {
  saveAllFileHashes,
  getHashes,
  checkNoFilesChanged,
} from "./hashes";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { globSync } from "glob";

import { GenerationSource } from "./types";
import { readFile, writeFile } from "./utils";
import { getConfig, loadPrompt } from "./config";
import { services } from "./services/";
import { convertToText } from "./conversion";

// ---------------------------------------------------------------------------
// Input pattern normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes an input pattern to a valid glob pattern.
 * Supports:
 *   - Standard glob patterns (e.g. "src/**\/*.ts")
 *   - Brace expansion (e.g. "{src/a.ts,src/b.ts}")
 *   - Comma-separated file paths (e.g. "src/a.ts,src/b.ts") — auto-converted to brace expansion
 *   - Mixed comma-separated list with globs (e.g. "src/a.ts,src/commands/**\/*.ts")
 */
export function normalizeInputPattern(input: string): string {
  if (input.includes("{")) return input;
  if (input.includes(",")) {
    const parts = input.split(",").map((p) => p.trim());
    return `{${parts.join(",")}}`;
  }
  return input;
}

// ---------------------------------------------------------------------------
// GenerateOptions
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  /** Only run sources whose `name` matches exactly this value */
  name?: string;
  /** Only run sources whose name/input/output contains this substring */
  filter?: string;
  /**
   * When true, agent-driven sources create .knowhow/processes/agents/<taskId>/
   * so they appear in `knowhow agents list`. Overrides the per-source syncFs flag.
   */
  syncFs?: boolean;
  /** When true, skip hash checks and regenerate all matching sources regardless of changes */
  force?: boolean;
  /**
   * Maximum number of generation sources to run in parallel within a single
   * dependency wave. Defaults to 3. Set to 1 for fully sequential execution.
   */
  concurrency?: number;
}

// ---------------------------------------------------------------------------
// Filter helper
// ---------------------------------------------------------------------------

/**
 * Returns true when a source should run given the provided filter options.
 */
function sourceMatchesFilter(
  source: GenerationSource,
  options: GenerateOptions
): boolean {
  if (options.name) return source.name === options.name;
  if (options.filter) {
    const needle = options.filter.toLowerCase();
    return [source.name, source.input, source.output]
      .filter(Boolean)
      .some((v) => v!.toLowerCase().includes(needle));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Dependency / concurrency helpers
// ---------------------------------------------------------------------------

/**
 * Detects whether sourceB's input references sourceA's output directory or file.
 *
 * Heuristic: if sourceA produces an output path and sourceB reads from that
 * same path (or a sub-path of it) then B depends on A.
 */
function ioOverlaps(sourceA: GenerationSource, sourceB: GenerationSource): boolean {
  const aOut = sourceA.output;
  if (!aOut) return false;

  const bInputPattern = normalizeInputPattern(sourceB.input || "");

  // Strip brace expansion to individual paths for comparison
  const bPaths = bInputPattern.startsWith("{")
    ? bInputPattern.slice(1, -1).split(",").map((p) => p.trim())
    : [bInputPattern];

  for (const bPath of bPaths) {
    // If aOut is a directory (ends with /) check if bPath starts with it
    if (aOut.endsWith("/") && bPath.startsWith(aOut)) return true;
    // If aOut is a file, check if bPath starts with aOut's directory
    const aDir = aOut.endsWith("/") ? aOut : path.dirname(aOut) + "/";
    if (bPath.startsWith(aDir)) return true;
    // Direct prefix/glob match: e.g. aOut = "autodoc/" bPath = "autodoc/**/*.md"
    if (bPath.startsWith(aOut.replace(/\/$/, ""))) return true;
  }
  return false;
}

/**
 * Builds a topological dependency graph and returns sources grouped into
 * sequential "waves". All sources within a wave have no un-satisfied
 * dependencies and can run concurrently. Each subsequent wave waits for
 * the previous wave to complete.
 *
 * Dependency resolution:
 *  1. Explicit `dependsOn: string[]` — names listed there must finish first.
 *  2. Automatic I/O overlap detection — if A writes to a path that B reads,
 *     B is automatically placed after A.
 */
export function buildWaves(sources: GenerationSource[]): GenerationSource[][] {
  const nameIndex = new Map<string, GenerationSource>();
  for (const s of sources) {
    if (s.name) nameIndex.set(s.name, s);
  }

  // Build adjacency: deps[i] = set of indices that source[i] depends on
  const n = sources.length;
  const deps: Set<number>[] = Array.from({ length: n }, () => new Set());

  for (let i = 0; i < n; i++) {
    const b = sources[i];

    // Explicit dependsOn
    for (const depName of b.dependsOn ?? []) {
      const depIdx = sources.findIndex((s) => s.name === depName);
      if (depIdx !== -1 && depIdx !== i) deps[i].add(depIdx);
    }

    // Auto I/O overlap
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (ioOverlaps(sources[j], b)) deps[i].add(j);
    }
  }

  // Kahn's algorithm to produce waves
  const waves: GenerationSource[][] = [];
  const completed = new Set<number>();

  while (completed.size < n) {
    const wave: number[] = [];
    for (let i = 0; i < n; i++) {
      if (completed.has(i)) continue;
      const remaining = [...deps[i]].filter((d) => !completed.has(d));
      if (remaining.length === 0) wave.push(i);
    }

    if (wave.length === 0) {
      // Cycle detected — fall back to running everything remaining sequentially
      console.warn(
        "⚠️  Dependency cycle detected in generation sources — running remaining sources sequentially."
      );
      for (let i = 0; i < n; i++) {
        if (!completed.has(i)) wave.push(i);
      }
    }

    waves.push(wave.map((i) => sources[i]));
    for (const i of wave) completed.add(i);
  }

  return waves;
}

/**
 * Runs up to `limit` async tasks concurrently, preserving order of
 * completion relative to input order.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  // Use a simple semaphore-style approach: keep up to `limit` promises running
  // at the same time. As each finishes, the next item is started immediately.
  const entries = [...items.entries()]; // [[0, item0], [1, item1], ...]
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < entries.length) {
      const [index, item] = entries[cursor++];
      await fn(item, index);
    }
  }

  // Spawn exactly `limit` workers (or fewer if there aren't enough items).
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, entries.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/**
 * Appends an instruction telling an assigned agent exactly which file to write
 * its generated output to.
 */
export function withOutputTarget(prompt: string, outputFile: string): string {
  return `${prompt}\n\n---\nGENERATION OUTPUT TARGET: Write your finished result to the file at \`${outputFile}\` using your file-writing tools (e.g. writeFileChunk). Create any parent directories as needed. Once the file is written with the complete, final content, call finalAnswer with a brief summary. Do NOT write to any other path.`;
}

/**
 * For agent-driven generation: if the agent already wrote the output file
 * itself, keep it. Otherwise, fall back to writing the returned content.
 */
export async function writeAgentOrSummaryOutput(
  outputFile: string,
  summary: string,
  agent?: string
): Promise<void> {
  const outputDir = path.dirname(outputFile);
  if (outputDir && !fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  if (agent && fs.existsSync(outputFile)) {
    console.log(
      `Agent wrote output file directly: ${outputFile} (skipping summary write)`
    );
    return;
  }

  console.log("Writing summary to", outputFile);
  await writeFile(outputFile, summary ?? "");
}

// ---------------------------------------------------------------------------
// Multi-output generation
// ---------------------------------------------------------------------------

export async function handleMultiOutputGeneration(
  model: string,
  inputPattern: string,
  files: string[],
  prompt: string,
  output: string,
  outputExt = "mdx",
  outputName?: string,
  kind?: string,
  agent?: string,
  agentOpts?: AgentOptions,
  force?: boolean
) {
  const promptHash = crypto.createHash("md5").update(prompt).digest("hex");
  const hashes = await getHashes();

  const inputPath = inputPattern.includes("**")
    ? inputPattern.split("**")[0]
    : "";

  for (const file of files) {
    const fileContent = await convertToText(file);
    const fileHash = crypto.createHash("md5").update(fileContent).digest("hex");

    if (!hashes[file]) {
      hashes[file] = { promptHash: "", fileHash: "" };
    }

    const { name, ext, dir } = path.parse(file);
    const nestedFolder = inputPath ? (dir + "/").replace(inputPath, "") : "";
    const outputFolder = path.join(output, nestedFolder);

    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder, { recursive: true });
    }

    const outputFileName = outputName || name;
    const outputFile = path.join(outputFolder, outputFileName + "." + outputExt);
    console.log({ dir, inputPath, nestedFolder, outputFile });

    const toCheck = [file, outputFile];
    const noChanges = await checkNoFilesChanged(toCheck, promptHash, hashes);
    if (noChanges && !force) {
      console.log("Skipping file", file, "because it hasn't changed");
      continue;
    }

    console.log("Summarizing", file);
    const effectivePrompt =
      prompt && agent ? withOutputTarget(prompt, outputFile) : prompt;
    const summary = prompt
      ? await summarizeFile(file, effectivePrompt, model, agent, agentOpts)
      : fileContent;

    await writeAgentOrSummaryOutput(outputFile, summary, agent);
    await saveAllFileHashes(toCheck, promptHash);
  }
}

// ---------------------------------------------------------------------------
// Single-output generation
// ---------------------------------------------------------------------------

export async function handleSingleOutputGeneration(
  model: string,
  files: string[],
  prompt: string,
  outputFile: string,
  kind?: string,
  agent?: string,
  agentOpts?: AgentOptions,
  force?: boolean
) {
  const hashes = await getHashes();
  const promptHash = crypto.createHash("md5").update(prompt).digest("hex");

  const filesToCheck = [outputFile, ...files];
  const noChanges = await checkNoFilesChanged(filesToCheck, promptHash, hashes);
  if (noChanges && !force) {
    console.log(`Skipping ${files.length} files because they haven't changed`);
    return;
  }

  console.log("Summarizing", files.length, "files");
  const outputDir = path.dirname(outputFile);
  if (outputDir && !fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const effectivePrompt =
    prompt && agent ? withOutputTarget(prompt, outputFile) : prompt;

  const summary = prompt
    ? await summarizeFiles(files, effectivePrompt, model, agent, agentOpts)
    : (await Promise.all(files.map(convertToText))).join("\n\n");

  await writeAgentOrSummaryOutput(outputFile, summary, agent);
  await saveAllFileHashes(filesToCheck, promptHash);
}

// ---------------------------------------------------------------------------
// All-kinds generation (plugin + file fallback)
// ---------------------------------------------------------------------------

async function handleAllKindsGeneration(source: GenerationSource) {
  const { Plugins } = services();
  const { kind, input } = source;
  if (Plugins.isPlugin(kind)) {
    const data = await Plugins.call(kind, input);
    if (source.output.endsWith("/")) {
      throw new Error(`Plugin ${kind} can only output to a single file`);
    }
    const pluginOutputDir = path.dirname(source.output);
    if (pluginOutputDir && !fs.existsSync(pluginOutputDir)) {
      fs.mkdirSync(pluginOutputDir, { recursive: true });
    }
    await writeFile(source.output, data);
  }
  return handleFileKindGeneration(source);
}

async function handleFileKindGeneration(
  source: GenerationSource,
  agentOpts?: AgentOptions
) {
  const prompt = await loadPrompt(source.prompt);
  const files = globSync(normalizeInputPattern(source.input));
  console.log("Analyzing files: ", files);

  if (source.output.endsWith("/")) {
    await handleMultiOutputGeneration(
      source.model,
      source.input,
      files,
      prompt,
      source.output,
      source.outputExt,
      source.outputName,
      source.kind,
      source.agent,
      agentOpts
    );
  } else {
    await handleSingleOutputGeneration(
      source.model,
      files,
      prompt,
      source.output,
      source.kind,
      source.agent,
      agentOpts
    );
  }
}

// ---------------------------------------------------------------------------
// Run a single source
// ---------------------------------------------------------------------------

async function runSource(
  source: GenerationSource,
  options: GenerateOptions
): Promise<void> {
  console.log("Generating", source.input, "to", source.output);

  const effectiveSyncFs = options.syncFs ?? source.syncFs;
  const agentOpts: AgentOptions | undefined = source.agent
    ? {
        syncFs: effectiveSyncFs,
        taskId:
          source.taskId ??
          (effectiveSyncFs
            ? `generate:${source.output.replace(/[^a-zA-Z0-9_.-]/g, "_")}`
            : undefined),
        maxTimeLimit: source.maxTimeLimit,
        maxSpendLimit: source.maxSpendLimit,
      }
    : undefined;

  if (source.kind === "file" || !source.kind) {
    const files = globSync(normalizeInputPattern(source.input));
    const prompt = await loadPrompt(source.prompt);

    if (source.output.endsWith("/")) {
      await handleMultiOutputGeneration(
        source.model,
        source.input,
        files,
        prompt,
        source.output,
        source.outputExt,
        source.outputName,
        source.kind,
        source.agent,
        agentOpts,
        options.force
      );
    } else {
      await handleSingleOutputGeneration(
        source.model,
        files,
        prompt,
        source.output,
        source.kind,
        source.agent,
        agentOpts,
        options.force
      );
    }
  } else {
    await handleAllKindsGeneration(source);
  }
}

// ---------------------------------------------------------------------------
// Main generate entry point
// ---------------------------------------------------------------------------

export async function generate(options: GenerateOptions = {}): Promise<void> {
  const config = await getConfig();
  const allSources = config.sources ?? [];
  const sources = allSources.filter((s) => sourceMatchesFilter(s, options));

  if ((options.name || options.filter) && sources.length === 0) {
    console.warn(
      `No generation sources matched ${
        options.name ? `name="${options.name}"` : `filter="${options.filter}"`
      }. Available names: ${allSources
        .map((s) => s.name)
        .filter(Boolean)
        .join(", ") || "(none defined)"}`
    );
    return;
  }

  const concurrency = options.concurrency ?? 3;
  const waves = buildWaves(sources);

  for (let wi = 0; wi < waves.length; wi++) {
    const wave = waves[wi];
    if (waves.length > 1) {
      console.log(
        `\n[Wave ${wi + 1}/${waves.length}] Running ${wave.length} source${wave.length !== 1 ? "s" : ""} (concurrency: ${concurrency})...`
      );
    }

    await runWithConcurrency(wave, concurrency, (source) =>
      runSource(source, options)
    );
  }

  if (waves.length > 1) {
    console.log(`\n✅ Generation complete (${waves.length} wave${waves.length !== 1 ? "s" : ""}, ${sources.length} sources).`);
  }
}
