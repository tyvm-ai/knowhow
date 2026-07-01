import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { services } from "../services";
import { ModulesService } from "../services/modules";
import { getConfig } from "../config";
import { Modality, ConvertOptions } from "../services/conversion/types";

/**
 * Load modules from config so that external converters (e.g. pdf-to-img) get
 * registered into ConversionService before we run a conversion.
 */
async function setupConversionServices() {
  const config = await getConfig();
  const { Conversion } = services();

  const allModulePaths = [
    ...(config.modules || []),
  ];

  if (allModulePaths.length) {
    const modulesService = new ModulesService();
    await modulesService.loadModulesFrom(
      { ...config, modules: allModulePaths },
      {
        Conversion,
        Agents: services().Agents,
        Embeddings: services().Embeddings,
        Plugins: services().Plugins,
        Clients: services().Clients,
        Tools: services().Tools,
        Events: services().Events,
        MediaProcessor: services().MediaProcessor,
      }
    );
  }

  return { Conversion };
}

/**
 * Modality short aliases accepted on the CLI.
 * img, txt, vid, aud are short forms; full names also accepted.
 */
const MODALITY_ALIASES: Record<string, Modality> = {
  img: "image",
  image: "image",
  txt: "text",
  text: "text",
  vid: "video",
  video: "video",
  aud: "audio",
  audio: "audio",
  html: "html",
};

/**
 * Parse a comma-separated modality chain like "img,txt" or "image,text".
 * Returns { via: Modality[], target: Modality }.
 * Single value (e.g. "text") → { via: [], target: "text" }.
 *
 * Examples:
 *   "text"      → via=[], target="text"
 *   "img,txt"   → via=["image"], target="text"
 *   "image,text"→ via=["image"], target="text"
 */
function parseModalityChain(raw: string): { via: Modality[]; target: Modality } {
  const parts = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const modalities: Modality[] = parts.map((p) => {
    const m = MODALITY_ALIASES[p];
    if (!m) {
      throw new Error(
        `Unknown modality "${p}". Valid values: text/txt, image/img, audio/aud, video/vid, html`
      );
    }
    return m;
  });
  if (modalities.length === 0) throw new Error("--to requires at least one modality");
  const target = modalities[modalities.length - 1];
  const via = modalities.slice(0, -1);
  return { via, target };
}

export function addConvertCommand(program: Command): void {
  program
    .command("convert")
    .description("Convert a file between modalities (pdf, image, audio, video, text)")
    .option("-i, --input <path>", "Source file path (required unless --list)")
    .option("-o, --output <path>", "Output file or directory (optional; defaults to stdout for text)")
    .option(
      "--to <chain>",
      "Target modality or explicit chain. Single: text|txt|image|img|audio|aud|video|vid|html. Chain (comma-separated): img,txt forces pdf→image→text path.",
      "text"
    )
    .option("--from <modality>", "Override inferred input modality")
    .option("--prefer <names>", "Comma-separated list of preferred converter names (used when --to is a single modality)")
    .option("--force", "Ignore cache and re-run converters")
    .option("--model <name>", "Model to use (injected into converterOptions for all converters, e.g. tts-1, dall-e-3, gpt-4o)")
    .option("--start-page <n>", "First page (documents)", parseInt)
    .option("--end-page <n>", "Last page (documents)", parseInt)
    .option("--start-line <n>", "First line (text output)", parseInt)
    .option("--end-line <n>", "Last line (text output)", parseInt)
    .option("--start-time <n>", "Start time in seconds (audio/video)", parseFloat)
    .option("--end-time <n>", "End time in seconds (audio/video)", parseFloat)
    .option("--opt <spec>", "Per-converter option in format name.key=value (repeatable)", collect, [])
    .option("--list", "List all registered converters and exit")
    .option("--json", "Emit machine-readable JSON result")
    .action(async (opts) => {
      try {
        const { Conversion } = await setupConversionServices();

        // --list mode: print registered converters
        if (opts.list) {
          const converters = Conversion.list();
          if (opts.json) {
            console.log(JSON.stringify(converters.map(c => ({
              name: c.name,
              inputExts: c.inputExts,
              inputModality: c.inputModality,
              outputType: c.outputType,
              cache: c.cache ?? false,
            })), null, 2));
          } else {
            console.log("\n📦 Registered converters:\n");
            for (const c of converters) {
              const input = c.inputExts
                ? c.inputExts.join(", ")
                : c.inputModality ?? "?";
              console.log(`  • ${c.name.padEnd(24)} ${input} → ${c.outputType}${c.cache ? " (cached)" : ""}`);
            }
            console.log();
          }
          return;
        }

        // Validate --input
        if (!opts.input) {
          console.error("Error: --input <path> is required (use --list to see converters)");
          process.exit(1);
        }

        const inputPath = path.resolve(opts.input);
        if (!fs.existsSync(inputPath)) {
          console.error(`Error: input file not found: ${inputPath}`);
          process.exit(1);
        }

        // Parse --to chain (e.g. "img,txt" → via=["image"], target="text")
        let targetModality: Modality;
        let viaModalities: Modality[] = [];
        try {
          const parsed = parseModalityChain(opts.to || "text");
          targetModality = parsed.target;
          viaModalities = parsed.via;
        } catch (e: any) {
          console.error(`Error: ${e.message}`);
          process.exit(1);
        }

        // Parse --opt flags into converterOptions
        const converterOptions: Record<string, Record<string, any>> = {};
        for (const spec of (opts.opt as string[])) {
          // format: converterName.key=value
          const dotIdx = spec.indexOf(".");
          const eqIdx = spec.indexOf("=");
          if (dotIdx < 0 || eqIdx < 0 || eqIdx < dotIdx) {
            console.error(`Error: --opt must be in format "converterName.key=value", got: ${spec}`);
            process.exit(1);
          }
          const converterName = spec.slice(0, dotIdx);
          const key = spec.slice(dotIdx + 1, eqIdx);
          const rawValue = spec.slice(eqIdx + 1);
          // Try to coerce to number/boolean, else keep as string
          let value: any = rawValue;
          if (rawValue === "true") value = true;
          else if (rawValue === "false") value = false;
          else if (!isNaN(Number(rawValue)) && rawValue !== "") value = Number(rawValue);

          if (!converterOptions[converterName]) converterOptions[converterName] = {};
          converterOptions[converterName][key] = value;
        }

        // --model injects model into all converter option scopes
        // It can be overridden by a more specific --opt converterName.model=xxx
        if (opts.model) {
          const modelInjectedNames = [
            "whisper", "ffmpeg-whisper",
            "image-to-text",
            "text-to-audio", "text-to-image", "text-to-video",
            "image-to-video",
          ];
          for (const name of modelInjectedNames) {
            if (!converterOptions[name]) converterOptions[name] = {};
            if (!converterOptions[name].model) {
              converterOptions[name].model = opts.model;
            }
          }
        }

        const preferredConverters = opts.prefer
          ? opts.prefer.split(",").map((s: string) => s.trim()).filter(Boolean)
          : [];

        const chainDisplay = [...viaModalities, targetModality].join(" → ");
        console.error(`🔄 Converting ${inputPath} → ${chainDisplay}...`);

        const convertOpts: ConvertOptions = {
          force: opts.force ?? false,
          preferredConverters,
          startPage: opts.startPage,
          endPage: opts.endPage,
          startLine: opts.startLine,
          endLine: opts.endLine,
          startTime: opts.startTime,
          endTime: opts.endTime,
          converterOptions,
          onProgress: (stage, fraction) => {
            const pct = Math.round(fraction * 100);
            process.stderr.write(`\r  [${pct.toString().padStart(3)}%] ${stage}   `);
          },
          ...(viaModalities.length > 0 ? { via: viaModalities } : {}),
        };

        const result = await Conversion.convert(inputPath, targetModality, convertOpts);
        process.stderr.write("\n");

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        // Text / HTML output
        if (result.outputType === "text" || result.outputType === "html") {
          if (opts.output) {
            fs.writeFileSync(path.resolve(opts.output), result.text ?? "");
            console.error(`✅ Written to ${opts.output}`);
          } else {
            process.stdout.write(result.text ?? "");
            process.stdout.write("\n");
          }
          if (result.usd_cost) {
            console.error(`💰 Cost: $${result.usd_cost.toFixed(6)}`);
          }
          return;
        }

        // File output (image, audio, video)
        const files = result.files ?? [];
        if (files.length === 0) {
          console.error("⚠  Conversion produced no output files.");
          return;
        }

        if (opts.output) {
          const outPath = path.resolve(opts.output);
          if (files.length === 1) {
            fs.copyFileSync(files[0], outPath);
            console.error(`✅ Written to ${outPath}`);
          } else {
            // Multiple files → write to directory
            fs.mkdirSync(outPath, { recursive: true });
            for (const f of files) {
              const dest = path.join(outPath, path.basename(f));
              fs.copyFileSync(f, dest);
              console.log(dest);
            }
            console.error(`✅ ${files.length} files written to ${outPath}`);
          }
        } else {
          // Print file paths to stdout
          for (const f of files) {
            console.log(f);
          }
        }

        if (result.usd_cost) {
          console.error(`💰 Cost: $${result.usd_cost.toFixed(6)}`);
        }
      } catch (err: any) {
        console.error(`❌ Conversion failed: ${err.message}`);
        if (process.env.DEBUG) console.error(err);
        process.exit(1);
      }
    });
}

/** Commander helper: collect repeated option values into an array */
function collect(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}
