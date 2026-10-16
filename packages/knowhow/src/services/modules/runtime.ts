/**
 * `createModuleRuntime` — startup/shutdown helper for long-running module
 * processes (e.g. a voice agent) that need the service graph, the config and a
 * place to hang cleanup callbacks.
 *
 * Everything is resolved lazily so importing this file has no side effects.
 *
 * Prefer `params.context` (handed to `register`/`init`) over `services()` when
 * you're inside a module hook; use this for processes you start yourself
 * (CLI subcommands) where there is no hook context.
 */

import type { Config } from "../../types";

export interface ModuleRuntime {
  /** The process-wide service singletons (`services()`). */
  readonly services: ReturnType<typeof import("../index").services>;
  /** Process-local extension registry (`services().Extensions`). */
  readonly extensions: ReturnType<typeof import("../index").services>["Extensions"];
  /** Resolved (local + global merged) config, loaded at creation. */
  readonly config: Config;
  /**
   * Run the full CLI service setup (agents registered, tools defined, MCP
   * attached) — same as `setupServices()`. Memoised: safe to call repeatedly.
   */
  setup(): Promise<Awaited<ReturnType<typeof import("../../commands/services").setupServices>>>;
  /** Register a cleanup callback (run in reverse order by `dispose`). */
  onDispose(fn: () => void | Promise<void>): void;
  /** Run all cleanup callbacks once. Errors are collected, not thrown midway. */
  dispose(): Promise<void>;
  readonly disposed: boolean;
}

export async function createModuleRuntime(): Promise<ModuleRuntime> {
  const { services } = await import("../index");
  const { getConfig } = await import("../../config");
  const config = await getConfig();
  const svc = services();

  const disposers: Array<() => void | Promise<void>> = [];
  let setupPromise: ModuleRuntime["setup"] extends () => infer R ? R | undefined : never;
  let disposed = false;

  return {
    services: svc,
    extensions: svc.Extensions,
    config,
    setup() {
      if (!setupPromise) {
        setupPromise = import("../../commands/services").then((m) => m.setupServices());
      }
      return setupPromise as ReturnType<ModuleRuntime["setup"]>;
    },
    onDispose(fn) {
      disposers.push(fn);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const errors: unknown[] = [];
      for (const fn of disposers.splice(0).reverse()) {
        try {
          await fn();
        } catch (err) {
          errors.push(err);
        }
      }
      if (errors.length) {
        throw new Error(
          `module runtime dispose: ${errors.length} cleanup callback(s) failed: ` +
            errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")
        );
      }
    },
    get disposed() {
      return disposed;
    },
  };
}
