/**
 * Type preview / confirmation UI.
 *
 * Shows what will be typed before typing it.
 * - Prints to terminal
 * - On macOS: shows an osascript dialog (non-blocking, killable)
 * - Voice confirmation via pendingAction registry
 *
 * Whichever resolves first (dialog button or voice) wins; the other is torn down.
 */

import type { ChildProcess } from "child_process";
import { spawnOsa } from "./actions/osa";

export interface TypePreviewOptions {
  /** The text to preview. */
  text: string;
  /** Original frontmost app (to re-activate after dialog). */
  originalApp?: string;
  /** Log function. */
  log?: (msg: string) => void;
  /** Platform actions for typing and activating apps. */
  actions?: {
    typeText(text: string, opts?: { app?: string }): Promise<void>;
    activateApp(app: string, opts?: { launch?: boolean }): Promise<boolean>;
    frontmostApp(): Promise<string | undefined>;
  };
  /** Called on confirm, with the text to type and the app to type into. */
  onConfirm(text: string, app: string | undefined): Promise<void>;
  /** Called on cancel. */
  onCancel(): void;
  /** Called on redo. */
  onRedo?(): void;
}

export interface PreviewHandle {
  /** Dismiss the dialog and tear down. */
  dismiss(): void;
}

/**
 * Show a type preview dialog. Registers a pendingAction.
 * Returns a handle to dismiss programmatically.
 */
export function showTypePreview(opts: TypePreviewOptions): PreviewHandle {
  const { text, originalApp, log, actions, onConfirm, onCancel, onRedo } = opts;

  log?.(`[voice] smarttype preview (say "confirm" or "cancel"): ${text}`);

  let dialogProc: ChildProcess | undefined;
  let resolved = false;

  const resolve = (action: "confirm" | "cancel" | "redo") => {
    if (resolved) return;
    resolved = true;
    // Kill dialog if running
    if (dialogProc && !dialogProc.killed) {
      try { dialogProc.kill(); } catch { /* ignore */ }
    }
    if (action === "confirm") {
      void (async () => {
        // Re-activate original app before typing
        if (originalApp && actions?.activateApp) {
          try { await actions.activateApp(originalApp); } catch { /* ignore */ }
          // Small delay for app activation
          await new Promise((r) => setTimeout(r, 150));
        }
        await onConfirm(text, originalApp);
      })();
    } else if (action === "cancel") {
      onCancel();
    } else if (action === "redo") {
      onRedo?.();
    }
  };

  // Register pending action for voice confirmation
  const { setPending } = require("./pendingAction") as typeof import("./pendingAction");
  setPending({
    describe: `smarttype: "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`,
    accept: () => resolve("confirm"),
    reject: () => resolve("cancel"),
    redo: onRedo ? () => resolve("redo") : undefined,
  });

  // Launch osascript dialog on macOS (non-blocking)
  if (process.platform === "darwin") {
    const script = [
      `const app = Application.currentApplication();`,
      `app.includeStandardAdditions = true;`,
      `const result = app.displayDialog(${JSON.stringify(text)}, {`,
      `  buttons: ["Cancel", "Type"],`,
      `  defaultButton: "Type",`,
      `  givingUpAfter: 60,`,
      `  withTitle: "knowhow smarttype"`,
      `});`,
      `result.buttonReturned`,
    ].join("\n");

    // osascript unavailable / errors fall back to voice-only (the callback
    // then reports an empty answer, which only resolves "cancel" if not already resolved).
    dialogProc = spawnOsa("jxa", script, { timeoutMs: 125_000 }, (err, stdout) => {
      if (resolved) return;
      if (err && !stdout) return; // couldn't show the dialog: stay voice-only
      // "Type" confirms; Cancel or gave up cancels.
      resolve(stdout.trim() === "Type" ? "confirm" : "cancel");
    });
  }

  return {
    dismiss: () => resolve("cancel"),
  };
}
