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

import type { AutomationSDK } from "./automation";
import type {
  AutomationExtensionContext as CoreAutomationExtensionContext,
  AutomationSdkExtension as CoreAutomationSdkExtension,
} from "@tyvm/knowhow/sdk";

// ── Contract types (owned by core: @tyvm/knowhow/sdk) ───────────────────────
//
// Re-exported here, narrowed to this module's live AutomationSDK, for
// backwards compatibility with existing imports from computer-use.

/** Extension type constant: "computer-use.automation-sdk". */
// (Kept as a local literal — identical to core's AUTOMATION_SDK_EXTENSION — so
// this module has no runtime import of the sdk; only the types come from core.)
export const AUTOMATION_SDK_EXTENSION = "computer-use.automation-sdk" as const;

/** Context handed to each extension's create() (with `sdk` = the live AutomationSDK). */
export type AutomationExtensionContext = CoreAutomationExtensionContext<AutomationSDK>;

/** An extension exposed to scripts as `sdk.ext.<name>`. */
export type AutomationSdkExtension = CoreAutomationSdkExtension<AutomationSDK>;

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
