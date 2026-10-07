/**
 * Cross-module contract: the "computer-use.automation-sdk" extension point.
 *
 * Owned by core so that computer-use (the host) and any module contributing an
 * automation SDK extension (e.g. voice-control's `sdk.ext.gaze`) can share the
 * same types without depending on each other.
 *
 * `TSdk` is the host's live automation SDK type. It defaults to `unknown` so
 * contributors don't need a dependency on computer-use; the host narrows it
 * (`AutomationSdkExtension<AutomationSDK>`).
 */

import type { ModuleExtension } from "../ExtensionsService";

/** Extension `type` string for automation SDK extensions. */
export const AUTOMATION_SDK_EXTENSION = "computer-use.automation-sdk" as const;

/** Context handed to each extension's `create()` once per automation run. */
export interface AutomationExtensionContext<TSdk = unknown> {
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
  sdk: TSdk;
}

/** An extension contributed to `sdk.ext.<name>` inside automations. */
export interface AutomationSdkExtension<TSdk = unknown> extends ModuleExtension {
  /** Must equal AUTOMATION_SDK_EXTENSION. */
  type: "computer-use.automation-sdk";
  /** Valid JS identifier (/^[A-Za-z_$][\w$]*$/); exposed as sdk.ext[name]. */
  name: string;
  /** One-paragraph description shown to agents and in sdk.extensions(). */
  description: string;
  /** Optional TypeScript declaration of the returned API surface. */
  typings?: string;
  /** Factory called once per run before the script starts; result is cached. */
  create(ctx: AutomationExtensionContext<TSdk>): unknown | Promise<unknown>;
}
