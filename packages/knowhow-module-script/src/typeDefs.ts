import { Tool } from "@tyvm/knowhow/ts_build/src/clients";

/**
 * Converts a JSON Schema property definition to a TypeScript type string.
 * Mirrors the knowhow-web tool-script intellisense generator so scripts run in
 * the CLI sandbox get the SAME typing/autocomplete story as the web editor.
 */
function schemaTypeToTs(schema: any, indent = 0): string {
  if (!schema) return "any";
  const pad = "  ".repeat(indent);

  if (schema.type === "object" || schema.properties) {
    const props = schema.properties || {};
    const required: string[] = schema.required || [];
    const lines = Object.entries(props).map(([key, val]) => {
      const optional = required.includes(key) ? "" : "?";
      return `${pad}  /** ${
        (val as any).description || key
      } */\n${pad}  ${key}${optional}: ${schemaTypeToTs(val, indent + 1)};`;
    });
    return lines.length > 0
      ? `{\n${lines.join("\n")}\n${pad}}`
      : "Record<string, any>";
  }

  switch (schema.type) {
    case "string":
      return schema.enum
        ? schema.enum.map((v: string) => `"${v}"`).join(" | ")
        : "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array": {
      const itemType = schema.items ? schemaTypeToTs(schema.items, indent) : "any";
      return `${itemType}[]`;
    }
    case "null":
      return "null";
    default:
      if (schema.anyOf || schema.oneOf) {
        const variants = (schema.anyOf || schema.oneOf).map((s: any) =>
          schemaTypeToTs(s, indent)
        );
        return variants.join(" | ");
      }
      return "any";
  }
}

/** Strip the mcp_N_ prefix from a tool name to get just the suffix. */
function stripMcpPrefix(name: string): string {
  return name.replace(/^mcp_\d+_/, "");
}

/** Turn a tool name into a valid JS identifier for interface/global names. */
function toolNameToJsId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_$]/g, "_");
}

/** Whether a name is a valid bare JS identifier (so it can be a global fn). */
function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

// Globals the sandbox reserves — never generate a tool global that shadows them.
const RESERVED_GLOBALS = new Set([
  "callTool",
  "llm",
  "agent",
  "sleep",
  "createArtifact",
  "getQuotaUsage",
  "console",
  "globalThis",
  "executeScript",
]);

/**
 * Generate a TypeScript declaration string for the executeScript sandbox.
 *
 * Provides:
 *  - a `KnowhowTools` namespace with a typed `<Tool>Args` interface per tool
 *  - `callTool` overloads (typed args by literal tool name) + a fallback
 *  - a top-level typed global function per tool (the generic function resolver:
 *    `textSearch({...})` === `callTool('textSearch', {...})`)
 *  - the built-in sandbox globals: llm, agent, sleep, createArtifact,
 *    getQuotaUsage, console
 */
export function generateScriptTypeDefs(tools: Tool[]): string {
  const lines: string[] = [];

  lines.push("// Auto-generated KnowHow executeScript sandbox declarations.");
  lines.push("// These globals are injected by the runtime — do NOT import them.");
  lines.push("");
  lines.push("export {};");
  lines.push("");
  lines.push("declare global {");
  lines.push("namespace KnowhowTools {");

  const seenIface = new Set<string>();
  for (const tool of tools) {
    const fn = tool.function;
    if (!fn?.name) continue;
    const shortName = stripMcpPrefix(fn.name);
    const ifaceName = toolNameToJsId(shortName);
    if (seenIface.has(ifaceName)) continue;
    seenIface.add(ifaceName);

    const params: any = fn.parameters;
    if (
      params?.type === "object" &&
      params.properties &&
      Object.keys(params.properties).length > 0
    ) {
      const required: string[] = params.required || [];
      lines.push(`  /** ${fn.description || shortName} */`);
      lines.push(`  interface ${ifaceName}Args {`);
      for (const [propName, propSchema] of Object.entries(
        params.properties as Record<string, any>
      )) {
        const optional = required.includes(propName) ? "" : "?";
        if (propSchema.description) {
          lines.push(`    /** ${propSchema.description} */`);
        }
        lines.push(`    ${propName}${optional}: ${schemaTypeToTs(propSchema, 2)};`);
      }
      lines.push(`  }`);
    } else {
      lines.push(`  /** ${fn.description || shortName} */`);
      lines.push(`  type ${ifaceName}Args = Record<string, any>;`);
    }
  }

  lines.push("}");
  lines.push("");

  // callTool overloads
  const seenOverloads = new Set<string>();
  for (const tool of tools) {
    const fn = tool.function;
    if (!fn?.name) continue;
    const rawName = fn.name;
    const shortName = stripMcpPrefix(rawName);
    const ifaceName = toolNameToJsId(shortName);

    if (!seenOverloads.has(shortName)) {
      seenOverloads.add(shortName);
      if (fn.description) lines.push(`/** ${fn.description} */`);
      lines.push(
        `function callTool(toolName: "${shortName}", args?: KnowhowTools.${ifaceName}Args): Promise<any>;`
      );
    }
    if (rawName !== shortName && !seenOverloads.has(rawName)) {
      seenOverloads.add(rawName);
      lines.push(
        `function callTool(toolName: "${rawName}", args?: KnowhowTools.${ifaceName}Args): Promise<any>;`
      );
    }
  }
  lines.push("/** Call any tool by name with arbitrary arguments. */");
  lines.push(
    "function callTool(toolName: string, args?: Record<string, any>): Promise<any>;"
  );
  lines.push("");

  // Per-tool top-level global (generic function resolver). e.g. textSearch({...})
  const seenGlobals = new Set<string>();
  for (const tool of tools) {
    const fn = tool.function;
    if (!fn?.name) continue;
    const shortName = stripMcpPrefix(fn.name);
    if (!isValidIdentifier(shortName)) continue;
    if (RESERVED_GLOBALS.has(shortName)) continue;
    if (seenGlobals.has(shortName)) continue;
    seenGlobals.add(shortName);
    const ifaceName = toolNameToJsId(shortName);
    if (fn.description) lines.push(`/** ${fn.description} */`);
    lines.push(
      `function ${shortName}(args?: KnowhowTools.${ifaceName}Args): Promise<any>;`
    );
  }
  lines.push("");

  // Built-in sandbox globals
  lines.push("interface LlmMessage { role: string; content: string; }");
  lines.push("interface LlmOptions { model?: string; maxTokens?: number; temperature?: number; }");
  lines.push("/** Run a single stateless LLM completion. */");
  lines.push(
    "function llm(messages: LlmMessage[], options?: LlmOptions): Promise<any>;"
  );
  lines.push(
    "/** Run another registered agent as a node and get its final answer string. */"
  );
  lines.push("function agent(agentName: string, query: string): Promise<string>;");
  lines.push("/** Pause execution (max 2000ms). */");
  lines.push("function sleep(ms: number): Promise<void>;");
  lines.push(
    '/** Create a downloadable artifact. */'
  );
  lines.push(
    'function createArtifact(name: string, content: string, type?: "text" | "json" | "csv" | "html" | "markdown"): Promise<any>;'
  );
  lines.push("/** Get current resource quota usage. */");
  lines.push("function getQuotaUsage(): any;");
  lines.push("const console: {");
  lines.push("  log(...args: any[]): void;");
  lines.push("  info(...args: any[]): void;");
  lines.push("  warn(...args: any[]): void;");
  lines.push("  error(...args: any[]): void;");
  lines.push("};");
  lines.push("}"); // end declare global
  lines.push("");

  return lines.join("\n");
}
