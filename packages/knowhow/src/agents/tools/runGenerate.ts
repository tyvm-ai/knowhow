import { Tool } from "../../clients/types";
import { GenerationSource } from "../../types";
import { generate, GenerateOptions, buildWaves } from "../../generate";

export interface RunGenerateParams {
  /**
   * In-memory generation sources defining the pipeline. When provided, these
   * are used INSTEAD of the sources in .knowhow/knowhow.json. Each source can
   * declare `dependsOn` for explicit ordering, an `agent` for agent-driven
   * generation, and input/output/prompt for the work itself.
   */
  sources?: GenerationSource[];
  /** Only run sources whose `name` matches exactly this value (config mode). */
  name?: string;
  /** Only run sources whose name/input/output contains this substring. */
  filter?: string;
  /** Skip hash checks and regenerate all matching sources regardless of changes. */
  force?: boolean;
  /** Max sources to run in parallel within a dependency wave. Default: 3. */
  concurrency?: number;
  /**
   * When true, agent-driven sources create .knowhow/processes/agents/<taskId>/
   * so they appear in `knowhow agents list`.
   */
  syncFs?: boolean;
  /**
   * When true, agent-driven sources push their work to a remote Knowhow task
   * (identified by the source's taskId).
   */
  syncRemote?: boolean;
  /** When true, only compute and return the execution plan (waves) without running. */
  planOnly?: boolean;
  /** Per-call context injected by ToolsService.callTool. */
  _ctx?: { caller?: any; taskId?: string; [key: string]: any };
}

/**
 * runGenerate — expose `knowhow generate` as an agent tool.
 *
 * This lets an agent orchestrate complex, multi-step pipelines at runtime
 * without needing them defined in the config. It supports:
 *   - `dependsOn` for explicit ordering (topological waves)
 *   - automatic I/O overlap detection (source B reading source A's output runs after A)
 *   - per-source `agent` for agent-driven generation (map/reduce fan-out)
 *   - concurrency control within each dependency wave
 *   - plain summarization/analysis sources (no agent)
 *
 * With `planOnly: true`, it returns the computed wave plan so the agent can
 * inspect ordering/parallelism before committing to a run.
 */
export async function runGenerate(params: RunGenerateParams): Promise<string> {
  const {
    sources,
    name,
    filter,
    force,
    concurrency,
    syncFs,
    syncRemote,
    planOnly,
  } = params ?? {};

  // Default filesystem sync ON for agent-driven sources so they show up in
  // `knowhow agents list` and can be attached/tailed. Pass syncFs: false to opt out.
  const effectiveSyncFs = syncFs !== false;

  const options: GenerateOptions = {
    sources,
    name,
    filter,
    force,
    concurrency,
    syncFs: effectiveSyncFs,
    syncRemote,
  };

  // Resolve the source set for planning output.
  const effectiveSources = sources ?? [];

  if (planOnly) {
    if (effectiveSources.length === 0) {
      return (
        "planOnly requires in-memory `sources` to build a plan. " +
        "Provide sources to see how they'd be grouped into dependency waves."
      );
    }
    const filtered = effectiveSources.filter((s) => {
      if (name) return s.name === name;
      if (filter) {
        const needle = filter.toLowerCase();
        return [s.name, s.input, s.output]
          .filter(Boolean)
          .some((v) => v!.toLowerCase().includes(needle));
      }
      return true;
    });
    const waves = buildWaves(filtered);
    const lines: string[] = [];
    lines.push(
      `📋 Generation Plan (concurrency: ${concurrency ?? 3}, ${filtered.length} sources, ${waves.length} wave${waves.length !== 1 ? "s" : ""})`
    );
    waves.forEach((wave, i) => {
      lines.push(`\n┌─ Wave ${i + 1}/${waves.length} (${wave.length} in parallel)`);
      for (const s of wave) {
        const label = s.name || "(unnamed)";
        const io = `${s.input || "-"} → ${s.output || "-"}`;
        const agentPart = s.agent ? `  [agent: ${s.agent}]` : "";
        lines.push(`│  • ${label}  ${io}${agentPart}`);
      }
      lines.push("└────────────────────────────────────────────────");
    });
    return lines.join("\n");
  }

  try {
    await generate(options);
  } catch (e: any) {
    return `Generation failed: ${e?.message ?? String(e)}`;
  }

  const count = effectiveSources.length;
  const mode = count > 0 ? `${count} in-memory source(s)` : "config sources";
  return (
    `Generation complete for ${mode}` +
    (name ? ` (name="${name}")` : filter ? ` (filter="${filter}")` : "") +
    `. Outputs written to their configured paths. ` +
    `If agent-driven sources used syncFs, inspect them with \`knowhow agents list\`.`
  );
}

export const runGenerateDefinition: Tool = {
  type: "function",
  function: {
    name: "runGenerate",
    description:
      "Run the `knowhow generate` pipeline. Accepts in-memory `sources` so you can define arbitrary " +
      "task orchestration at runtime WITHOUT editing the config file. Supports dependency ordering via " +
      "`dependsOn`, automatic I/O overlap detection (a source reading another's output runs after it), " +
      "per-source `agent` for agent-driven generation (map/reduce fan-out — one agent per input), " +
      "concurrency control within each dependency wave, and plain summarization/analysis sources. " +
      "Use `planOnly: true` to preview how sources group into concurrent dependency waves before running. " +
      "When `sources` is omitted, it runs the sources defined in .knowhow/knowhow.json (optionally scoped by name/filter).",
    parameters: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          description:
            "In-memory generation sources. Each item: { name?, input, output, prompt, agent?, model?, " +
            "kind?, outputExt?, outputName?, dependsOn?: string[], syncFs?, maxTimeLimit?, maxSpendLimit? }. " +
            "`input` is a glob or comma-separated file list; `output` is the target file/dir; `prompt` is the " +
            "generation instruction; `agent` (optional) runs an agent per input instead of a summarization call; " +
            "`dependsOn` lists names of sources that must finish first.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              input: { type: "string" },
              output: { type: "string" },
              prompt: { type: "string" },
              agent: { type: "string" },
              model: { type: "string" },
              kind: { type: "string" },
              outputExt: { type: "string" },
              outputName: { type: "string" },
              dependsOn: { type: "array", items: { type: "string" } },
              syncFs: { type: "boolean" },
              maxTimeLimit: { type: "number" },
              maxSpendLimit: { type: "number" },
            },
          },
        },
        name: {
          type: "string",
          description: "Only run sources whose `name` matches exactly (config mode).",
        },
        filter: {
          type: "string",
          description: "Only run sources whose name/input/output contains this substring.",
        },
        force: {
          type: "boolean",
          description: "Skip hash checks and regenerate all matching sources.",
        },
        concurrency: {
          type: "number",
          description: "Max sources to run in parallel within a dependency wave. Default: 3.",
        },
        syncFs: {
          type: "boolean",
          description:
            "For agent-driven sources, create .knowhow/processes/agents/<taskId>/ so they appear in `knowhow agents list`. " +
            "Defaults to true (enabled). Pass false to opt out.",
        },
        syncRemote: {
          type: "boolean",
          description:
            "For agent-driven sources, push their work to a remote Knowhow task (identified by the source's taskId), " +
            "in addition to fs sync.",
        },
        planOnly: {
          type: "boolean",
          description: "Return the wave execution plan without running anything (requires `sources`).",
        },
      },
      required: [],
    },
  },
};
