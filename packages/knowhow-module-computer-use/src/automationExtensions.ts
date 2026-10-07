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

import { AutomationSDK } from "./automation";

// ── Extension type constant ──────────────────────────────────────────────────

export const AUTOMATION_SDK_EXTENSION = "computer-use.automation-sdk" as const;

// ── Context handed to each extension's create() ─────────────────────────────

export interface AutomationExtensionContext {
  /** The automation name (from spec.name). */
  automationName: string;
  /** True when the run is in dry-run mode (no real mouse/keyboard actions). */
  dryRun: boolean;
  /** Aborted when the run stops for any reason (duration / manual / error). */
  signal: AbortSignal;
  /** Returns true when the window-focus gate has paused the automation. */
  isPaused(): boolean;
  /** Same as sdk.log — append a structured log entry to the run telemetry. */
  log(data: unknown): void;
  /**
   * Register a cleanup callback. All onDispose callbacks are called (in
   * registration order) in the runner's finally block, after streamDisposers
   * and before returning the result.
   */
  onDispose(fn: () => void | Promise<void>): void;
  /** The live AutomationSDK — for extensions that need to move the mouse etc. */
  sdk: AutomationSDK;
}

// ── Extension definition ─────────────────────────────────────────────────────

export interface AutomationSdkExtension {
  /** Must equal AUTOMATION_SDK_EXTENSION. */
  type: "computer-use.automation-sdk";
  /**
   * Identifier for the extension. Must be a valid JS identifier.
   * Exposed to scripts as sdk.ext[name].
   * Pattern: /^[A-Za-z_$][\w$]*$/
   */
  name: string;
  /** One-paragraph description shown to agents and in sdk.extensions(). */
  description: string;
  /**
   * Optional TypeScript declaration of the returned API surface. Shown to
   * agents via computerUseListAutomationExtensions and in generated docs.
   */
  typings?: string;
  /**
   * Factory called once per run before the script starts. Should be cheap
   * (no network until the first method call). Result is cached for the run.
   */
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
