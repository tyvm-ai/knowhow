/**
 * Automation SDK Extension primitive for @tyvm/knowhow-module-computer-use.
 *
 * Extension type: "computer-use.automation-sdk"
 *
 * Modules contribute extensions by registering with the process-local
 * ExtensionsService (from @tyvm/knowhow). The AutomationRunner resolves all
 * registered extensions before the script starts, caches the created APIs,
 * and exposes them as `sdk.ext.<name>`. Scripts discover available extensions
 * via `sdk.extensions()`.
 *
 * Declaration merging: downstream packages augment `AutomationExtensions` to
 * get editor type-checking for their extension API:
 *
 *   declare module "@tyvm/knowhow-module-computer-use" {
 *     interface AutomationExtensions {
 *       gaze: GazeExtensionApi;
 *       voice: VoiceExtensionApi;
 *     }
 *   }
 */

import type { ModuleExtension } from "@tyvm/knowhow/sdk";
import type { AutomationSDK } from "./automation";

// ── Contract: the "computer-use.automation-sdk" extension point ─────────────
//
// Owned by this module. Contributors (e.g. voice-control's `sdk.ext.gaze`)
// import these with `import type` from "@tyvm/knowhow-module-computer-use", so
// there is no runtime dependency on this module.

/** Extension `type` string for automation SDK extensions. */
export const AUTOMATION_SDK_EXTENSION = "computer-use.automation-sdk" as const;

/** Context handed to each extension's `create()` once per automation run. */
export interface AutomationExtensionContext {
  /** The automation name (from spec.name). */
  automationName: string;
  /** True when the run is in dry-run mode (no real mouse/keyboard actions). */
  dryRun: boolean;
  /** Aborted when the run stops for any reason (duration / manual / error). */
  signal: AbortSignal;
  /** Returns true when the window-focus gate has paused the automation. */
  isPaused(): boolean;
  /** Append a structured log entry to the run telemetry (same as sdk.log). */
  log(data: unknown): void;
  /**
   * Register a cleanup callback. All callbacks run (in registration order) in
   * the runner's finally block.
   */
  onDispose(fn: () => void | Promise<void>): void;
  /** The live AutomationSDK — for extensions that need to move the mouse etc. */
  sdk: AutomationSDK;
}

/** An extension contributed to `sdk.ext.<name>` inside automations. */
export interface AutomationSdkExtension extends ModuleExtension {
  /** Must equal AUTOMATION_SDK_EXTENSION. */
  type: typeof AUTOMATION_SDK_EXTENSION;
  /** Valid JS identifier (/^[A-Za-z_$][\w$]*$/); exposed as sdk.ext[name]. */
  name: string;
  /** One-paragraph description shown to agents and in sdk.extensions(). */
  description: string;
  /** Optional TypeScript declaration of the returned API surface. */
  typings?: string;
  /** Factory called once per run before the script starts; result is cached. */
  create(ctx: AutomationExtensionContext): unknown | Promise<unknown>;
}

// ── Augmentable interface for editor support ─────────────────────────────────

/**
 * Augment this interface to add type-checked properties to `sdk.ext`:
 *
 *   declare module "@tyvm/knowhow-module-computer-use" {
 *     interface AutomationExtensions {
 *       gaze: { current(): Promise<GazeSample | null>; };
 *     }
 *   }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface AutomationExtensions {}

// ── Runtime ext proxy ───────────────────────────────────────────────────────

/**
 * Build the `sdk.ext` object from a pre-resolved map of extension APIs.
 * Accessing an unknown name throws a helpful error listing available names.
 */
export function buildExtProxy(
  apis: Map<string, unknown>
): AutomationExtensions & Record<string, any> {
  return new Proxy({} as any, {
    get(_target, prop: string) {
      if (prop === "then" || prop === "toJSON") return undefined; // not a Promise
      if (!apis.has(prop)) {
        const available = [...apis.keys()];
        throw new Error(
          `sdk.ext.${prop} is not registered. Available extensions: ${
            available.length ? available.join(", ") : "(none)"
          }. Register an extension with ExtensionsService.register(owner, { type: "${AUTOMATION_SDK_EXTENSION}", name: "${prop}", ... }).`
        );
      }
      return apis.get(prop);
    },
    has(_target, prop: string) {
      return apis.has(prop as string);
    },
    ownKeys() {
      return [...apis.keys()];
    },
    getOwnPropertyDescriptor(_target, prop: string) {
      if (apis.has(prop)) {
        return { configurable: true, enumerable: true, value: apis.get(prop) };
      }
      return undefined;
    },
  });
}

/**
 * Resolve all registered automation-sdk extensions from the ExtensionsService,
 * call their create() factories with the provided context, and return a Map of
 * name → API. Errors in individual create() calls are logged and skipped so
 * one broken extension can't kill the whole run.
 */
export async function resolveExtensions(
  extensionsService: { list(type: string): readonly unknown[] } | null | undefined,
  ctx: AutomationExtensionContext
): Promise<Map<string, unknown>> {
  const apis = new Map<string, unknown>();
  if (!extensionsService) return apis;

  const registered = extensionsService.list(AUTOMATION_SDK_EXTENSION) as readonly AutomationSdkExtension[];
  for (const ext of registered) {
    if (!ext.name || !/^[A-Za-z_$][\w$]*$/.test(ext.name)) {
      ctx.log({ extensionError: `Extension has invalid name "${ext.name}", skipping.` });
      continue;
    }
    try {
      const api = await ext.create(ctx);
      apis.set(ext.name, api);
    } catch (err: any) {
      ctx.log({
        extensionError: `Failed to create extension "${ext.name}": ${err?.message ?? err}`,
      });
    }
  }
  return apis;
}
