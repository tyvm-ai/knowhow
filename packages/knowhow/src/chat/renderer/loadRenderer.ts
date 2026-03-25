/**
 * Renderer Loader - Dynamically loads a custom renderer from an npm package or local file.
 *
 * Supports:
 *  - built-in names:  "basic" | "fancy" | "compact"
 *  - npm packages:   "@scope/package" or "my-renderer-package"
 *  - local JS files: "./my-renderer.js" or "/absolute/path/renderer.js"
 *  - local TS files: "./my-renderer.ts" (compiled on-the-fly via tsx/ts-node if available)
 */

import path from "path";
import fs from "fs";
import { AgentRenderer } from "./types";
import { ConsoleRenderer } from "./ConsoleRenderer";
import { FancyRenderer } from "./FancyRenderer";
import { CompactRenderer } from "./CompactRenderer";

/** Built-in renderer names that ship with knowhow */
const BUILTIN_RENDERERS: Record<string, () => AgentRenderer> = {
  basic: () => new ConsoleRenderer(),
  fancy: () => new FancyRenderer(),
  compact: () => new CompactRenderer(),
};

/**
 * Attempt to transpile + load a TypeScript file as a module.
 * Falls back gracefully if tsx / ts-node are unavailable.
 */
async function loadTsFile(filePath: string): Promise<any> {
  // Try using jiti (another popular TS loader)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const jiti = require("jiti");
    const loader = typeof jiti === "function" ? jiti : jiti.default;
    return loader(filePath, { interopDefault: true })(filePath);
  } catch (_) {}

  // Try ts-node
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("ts-node/register");
    return require(filePath); // eslint-disable-line @typescript-eslint/no-var-requires
  } catch (_) {}

  // Last resort: try esbuild-register
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { register } = require("esbuild-register/dist/node");
    const { unregister } = register();
    const mod = require(filePath);
    unregister();
    return mod;
  } catch (_) {}

  throw new Error(
    `Cannot load TypeScript file "${filePath}". Install tsx, jiti, ts-node, or esbuild-register:\n` +
      `  npm install -g tsx\n  or  npm install -g ts-node`
  );
}

/**
 * Load a renderer from a specifier string.
 *
 * The loaded module must export either:
 *   - A default export that is an AgentRenderer instance, OR
 *   - A named export `createRenderer` function that returns an AgentRenderer, OR
 *   - A named export `renderer` that is an AgentRenderer instance
 *
 * @param specifier - npm package name or file path (relative paths resolved from cwd)
 * @returns An AgentRenderer instance
 */
export async function loadRenderer(specifier: string): Promise<AgentRenderer> {
  // Check for built-in renderer names first
  const builtin = BUILTIN_RENDERERS[specifier.toLowerCase()];
  if (builtin) {
    return builtin();
  }

  let mod: any;

  const isLocalPath =
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/");

  if (isLocalPath) {
    const resolved = path.resolve(process.cwd(), specifier);

    if (!fs.existsSync(resolved)) {
      throw new Error(`Renderer file not found: ${resolved}`);
    }

    if (resolved.endsWith(".ts")) {
      mod = await loadTsFile(resolved);
    } else {
      // JS or JSON
      mod = await import(resolved);
    }
  } else {
    // npm package
    try {
      mod = await import(specifier);
    } catch (err: any) {
      throw new Error(
        `Failed to load renderer package "${specifier}": ${err.message}\n` +
          `Make sure it is installed: npm install -g ${specifier}`
      );
    }
  }

  // Resolve the renderer from the module exports
  if (mod?.default && typeof mod.default.render === "function") {
    return mod.default as AgentRenderer;
  }

  if (typeof mod?.createRenderer === "function") {
    return mod.createRenderer() as AgentRenderer;
  }

  if (mod?.renderer && typeof mod.renderer.render === "function") {
    return mod.renderer as AgentRenderer;
  }

  // Check the default export might be a class
  if (mod?.default && typeof mod.default === "function") {
    try {
      const instance = new mod.default();
      if (typeof instance.render === "function") {
        return instance as AgentRenderer;
      }
    } catch (_) {}
  }

  // Check named exports for a class with "Renderer" in name
  for (const key of Object.keys(mod || {})) {
    if (key.toLowerCase().includes("renderer") && typeof mod[key] === "function") {
      try {
        const instance = new mod[key]();
        if (typeof instance.render === "function") {
          return instance as AgentRenderer;
        }
      } catch (_) {}
    }
  }

  throw new Error(
    `Renderer module "${specifier}" does not export a valid AgentRenderer.\n` +
      `Expected one of:\n` +
      `  - default export: AgentRenderer instance\n` +
      `  - default export: AgentRenderer class\n` +
      `  - named export "createRenderer": () => AgentRenderer\n` +
      `  - named export "renderer": AgentRenderer instance\n` +
      `  - named export "SomethingRenderer": AgentRenderer class`
  );
}

/**
 * Load a root chat module from a specifier string.
 *
 * The module must export either:
 *   - A default export that is a ChatModule class or instance
 *   - A named export "createModule" function
 *   - A named export with "Module" in the name
 */
export async function loadRootModule(specifier: string): Promise<any> {
  let mod: any;

  const isLocalPath =
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/");

  if (isLocalPath) {
    const resolved = path.resolve(process.cwd(), specifier);

    if (!fs.existsSync(resolved)) {
      throw new Error(`Root module file not found: ${resolved}`);
    }

    if (resolved.endsWith(".ts")) {
      mod = await loadTsFile(resolved);
    } else {
      mod = await import(resolved);
    }
  } else {
    try {
      mod = await import(specifier);
    } catch (err: any) {
      throw new Error(
        `Failed to load root module package "${specifier}": ${err.message}`
      );
    }
  }

  // Try default export as instance
  if (mod?.default && typeof mod.default.initialize === "function") {
    return mod.default;
  }

  // Try default export as class
  if (mod?.default && typeof mod.default === "function") {
    try {
      const instance = new mod.default();
      if (typeof instance.initialize === "function") {
        return instance;
      }
    } catch (_) {}
  }

  // Try createModule factory
  if (typeof mod?.createModule === "function") {
    return mod.createModule();
  }

  // Try named exports with "Module" in name
  for (const key of Object.keys(mod || {})) {
    if (key.toLowerCase().includes("module") && typeof mod[key] === "function") {
      try {
        const instance = new mod[key]();
        if (typeof instance.initialize === "function") {
          return instance;
        }
      } catch (_) {}
    }
  }

  throw new Error(
    `Root module "${specifier}" does not export a valid ChatModule.\n` +
      `Expected a class or instance with an "initialize(chatService)" method.`
  );
}

/**
 * Load an additional chat module (not the root module) from a specifier string.
 *
 * The module must export either:
 *   - A default export that is a ChatModule class or instance
 *   - A named export "createModule" function that returns a ChatModule
 *   - A named export with "Module" in the name (class or instance)
 *
 * @param specifier - npm package name or file path (relative paths resolved from cwd)
 * @returns An instantiated ChatModule (not yet initialized)
 */
export async function loadChatModule(specifier: string): Promise<any> {
  let mod: any;

  const isLocalPath =
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/");

  if (isLocalPath) {
    const resolved = path.resolve(process.cwd(), specifier);

    if (!fs.existsSync(resolved)) {
      throw new Error(`Chat module file not found: ${resolved}`);
    }

    if (resolved.endsWith(".ts")) {
      mod = await loadTsFile(resolved);
    } else {
      mod = await import(resolved);
    }
  } else {
    try {
      mod = await import(specifier);
    } catch (err: any) {
      throw new Error(
        `Failed to load chat module package "${specifier}": ${err.message}`
      );
    }
  }

  // Try default export as instance (already has initialize)
  if (mod?.default && typeof mod.default.initialize === "function") {
    return mod.default;
  }

  // Try default export as class
  if (mod?.default && typeof mod.default === "function") {
    try {
      const instance = new mod.default();
      if (typeof instance.initialize === "function") {
        return instance;
      }
    } catch (_) {}
  }

  // Try createModule factory
  if (typeof mod?.createModule === "function") {
    return mod.createModule();
  }

  // Try named exports with "Module" in name
  for (const key of Object.keys(mod || {})) {
    if (key.toLowerCase().includes("module") && typeof mod[key] === "function") {
      try {
        const instance = new mod[key]();
        if (typeof instance.initialize === "function") {
          return instance;
        }
      } catch (_) {}
    }
  }

  throw new Error(
    `Chat module "${specifier}" does not export a valid ChatModule.\n` +
      `Expected a class or instance with an "initialize(chatService)" method.\n` +
      `Supported export patterns:\n` +
      `  - default export: ChatModule instance or class\n` +
      `  - named export "createModule": () => ChatModule\n` +
      `  - named export "SomethingModule": ChatModule class`
  );
}
