import { execFile } from "child_process";

/**
 * M0 fallback dialogs for `sdk.ui.alert/confirm/prompt`.
 *
 * TODO(M2): replace with the native host dialogs (NSAlert / TaskDialogIndirect /
 * GtkAlertDialog). Until then: macOS uses `osascript`, Windows uses PowerShell's
 * `[System.Windows.Forms.MessageBox]` / `Microsoft.VisualBasic.Interaction`.
 * Other platforms degrade gracefully (alert = no-op, confirm = false, prompt = null).
 *
 * User text is always passed as an argument or environment variable, never
 * interpolated into script source, so it can't inject commands.
 */

export type DialogRunner = (
  cmd: string,
  args: string[],
  env?: Record<string, string>
) => Promise<{ code: number; stdout: string }>;

export const defaultDialogRunner: DialogRunner = (cmd, args, env) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { env: { ...process.env, ...(env || {}) }, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const code = error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? "") });
      }
    );
  });

export interface DialogOptions {
  title?: string;
  platform?: NodeJS.Platform;
  runner?: DialogRunner;
}

const DEFAULT_TITLE = "knowhow";

const OSA_ALERT = `on run argv
  display dialog (item 1 of argv) with title (item 2 of argv) buttons {"OK"} default button 1
end run`;
const OSA_CONFIRM = `on run argv
  display dialog (item 1 of argv) with title (item 2 of argv) buttons {"Cancel", "OK"} default button "OK" cancel button "Cancel"
end run`;
const OSA_PROMPT = `on run argv
  text returned of (display dialog (item 1 of argv) with title (item 2 of argv) default answer (item 3 of argv) buttons {"Cancel", "OK"} default button "OK" cancel button "Cancel")
end run`;

const PS_PREFIX = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName Microsoft.VisualBasic;";
const PS_ALERT = `${PS_PREFIX} [void][System.Windows.Forms.MessageBox]::Show($env:KH_MSG, $env:KH_TITLE)`;
const PS_CONFIRM = `${PS_PREFIX} $r=[System.Windows.Forms.MessageBox]::Show($env:KH_MSG, $env:KH_TITLE, 'YesNo'); Write-Output $r`;
const PS_PROMPT = `${PS_PREFIX} [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $r=[Microsoft.VisualBasic.Interaction]::InputBox($env:KH_MSG, $env:KH_TITLE, $env:KH_DEFAULT); Write-Output $r`;

function ps(script: string, env: Record<string, string>, runner: DialogRunner) {
  return runner("powershell", ["-NoProfile", "-Command", script], env);
}

export async function uiAlert(message: string, opts: DialogOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const runner = opts.runner ?? defaultDialogRunner;
  const title = opts.title ?? DEFAULT_TITLE;
  if (platform === "darwin") {
    await runner("osascript", ["-e", OSA_ALERT, String(message), title]);
  } else if (platform === "win32") {
    await ps(PS_ALERT, { KH_MSG: String(message), KH_TITLE: title }, runner);
  }
}

export async function uiConfirm(message: string, opts: DialogOptions = {}): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  const runner = opts.runner ?? defaultDialogRunner;
  const title = opts.title ?? DEFAULT_TITLE;
  if (platform === "darwin") {
    const r = await runner("osascript", ["-e", OSA_CONFIRM, String(message), title]);
    return r.code === 0;
  }
  if (platform === "win32") {
    const r = await ps(PS_CONFIRM, { KH_MSG: String(message), KH_TITLE: title }, runner);
    return r.code === 0 && /^yes/i.test(r.stdout.trim());
  }
  return false;
}

/** Returns the entered text, or null if cancelled/unsupported. */
export async function uiPrompt(
  message: string,
  defaultValue = "",
  opts: DialogOptions = {}
): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  const runner = opts.runner ?? defaultDialogRunner;
  const title = opts.title ?? DEFAULT_TITLE;
  if (platform === "darwin") {
    const r = await runner("osascript", ["-e", OSA_PROMPT, String(message), title, defaultValue]);
    return r.code === 0 ? r.stdout.replace(/\r?\n$/, "") : null;
  }
  if (platform === "win32") {
    const r = await ps(
      PS_PROMPT,
      { KH_MSG: String(message), KH_TITLE: title, KH_DEFAULT: defaultValue },
      runner
    );
    // InputBox returns "" on Cancel as well as on empty OK; treat "" as cancel.
    const text = r.stdout.replace(/\r?\n$/, "");
    return r.code === 0 && text !== "" ? text : null;
  }
  return null;
}
