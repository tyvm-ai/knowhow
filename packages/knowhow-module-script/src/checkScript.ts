import { Tool } from "@tyvm/knowhow/ts_build/src/clients";
import { generateScriptTypeDefs } from "./typeDefs";

export interface ScriptDiagnostic {
  line: number;
  column: number;
  code: number;
  category: "error" | "warning" | "message";
  message: string;
}

export interface CheckScriptResult {
  ok: boolean;
  diagnostics: ScriptDiagnostic[];
  /** The generated .d.ts (returned so callers can write it out / inspect it). */
  typeDefs: string;
}

/**
 * Type-check a sandbox script against the generated tool declarations WITHOUT
 * running it — fast feedback on what isn't set up right (unknown tools, wrong
 * argument shapes, typos, missing awaits, etc.). Uses the TypeScript compiler
 * API in-memory (no files written).
 *
 * The script is wrapped in the same `async function` the executor uses so
 * top-level `await` and a trailing bare expression are valid.
 */
export function checkScript(
  script: string,
  tools: Tool[]
): CheckScriptResult {
  const typeDefs = generateScriptTypeDefs(tools);

  let ts: any;
  try {
    // Lazy require — typescript is a dev/CLI-time dependency, not needed at
    // sandbox runtime. Degrade gracefully if it isn't installed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ts = require("typescript");
  } catch {
    return {
      ok: true,
      diagnostics: [
        {
          line: 0,
          column: 0,
          code: 0,
          category: "message",
          message:
            "typescript is not installed; skipping compile check (types generated only).",
        },
      ],
      typeDefs,
    };
  }

  const LIB = "knowhow-script-globals.d.ts";
  const SCRIPT = "script.ts";

  // Wrap the script exactly like the executor does so top-level await works and
  // an implicit trailing return is legal.
  const wrapped = `async function __run() {\n${script}\n}\n__run();\n`;

  const files: Record<string, string> = {
    [LIB]: typeDefs,
    [SCRIPT]: wrapped,
  };

  const compilerOptions = {
    target: ts.ScriptTarget.ES2020,
    // CommonJS (not ESNext) is required so that `declare global {}` augmentation
    // in the lib file is correctly resolved for the script file.
    // ESNext module mode breaks global augmentation from companion .d.ts files.
    module: ts.ModuleKind.CommonJS,
    // Include dom for console, and es2020 for Promise/async etc.
    lib: ["lib.es2020.d.ts", "lib.dom.d.ts"],
    noEmit: true,
    strict: false,
    noImplicitAny: false,
    skipLibCheck: true,
    // The script is JS-flavored; allow permissive checking but still catch
    // structural / call-signature mistakes.
    allowJs: true,
    checkJs: false,
    types: [],
  };

  const defaultHost = ts.createCompilerHost(compilerOptions);
  const host = {
    ...defaultHost,
    getSourceFile: (
      fileName: string,
      languageVersion: any,
      onError?: (m: string) => void
    ) => {
      if (files[fileName] !== undefined) {
        return ts.createSourceFile(
          fileName,
          files[fileName],
          languageVersion,
          true
        );
      }
      return defaultHost.getSourceFile(fileName, languageVersion, onError);
    },
    fileExists: (fileName: string) =>
      files[fileName] !== undefined || defaultHost.fileExists(fileName),
    readFile: (fileName: string) =>
      files[fileName] !== undefined
        ? files[fileName]
        : defaultHost.readFile(fileName),
    writeFile: () => {},
  };

  const program = ts.createProgram(
    [LIB, SCRIPT],
    compilerOptions,
    host as any
  );

  const scriptSource = program.getSourceFile(SCRIPT);
  const raw = [
    ...program.getSyntacticDiagnostics(scriptSource),
    ...program.getSemanticDiagnostics(scriptSource),
  ];

  const diagnostics: ScriptDiagnostic[] = raw.map((d: any) => {
    let line = 0;
    let column = 0;
    if (d.file && typeof d.start === "number") {
      const pos = d.file.getLineAndCharacterOfPosition(d.start);
      // Subtract 1 for the wrapper's `async function __run() {` line so line
      // numbers map back to the user's script.
      line = Math.max(1, pos.line);
      column = pos.character + 1;
    }
    const category =
      d.category === ts.DiagnosticCategory.Error
        ? "error"
        : d.category === ts.DiagnosticCategory.Warning
        ? "warning"
        : "message";
    return {
      line,
      column,
      code: d.code,
      category,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    };
  });

  const ok = !diagnostics.some((d) => d.category === "error");
  return { ok, diagnostics, typeDefs };
}

/** Format diagnostics for human-friendly CLI output. */
export function formatDiagnostics(result: CheckScriptResult): string {
  if (result.ok && result.diagnostics.length === 0) {
    return "✓ Script type-check passed. No issues found.";
  }
  const lines: string[] = [];
  for (const d of result.diagnostics) {
    const loc = d.line ? `:${d.line}:${d.column}` : "";
    const tag =
      d.category === "error" ? "✗ error" : d.category === "warning" ? "⚠ warn" : "ℹ";
    lines.push(`${tag} (TS${d.code})${loc} — ${d.message}`);
  }
  const errorCount = result.diagnostics.filter(
    (d) => d.category === "error"
  ).length;
  lines.push("");
  lines.push(
    result.ok
      ? "✓ Type-check passed (no errors)."
      : `✗ Type-check failed with ${errorCount} error(s).`
  );
  return lines.join("\n");
}
