/**
 * smarttype / agenttype voice command pack.
 *
 * Commands:
 *   1. "smart type {text}" — LLM cleans up or generates text, then prompts for confirm
 *   2. "agent type {text}" — Full knowhow agent researches and generates text
 *
 * Both share the confirm/cancel/redo flow via pendingAction.
 */

import { exec, execFile } from "child_process";
import { runAppleScript, spawnOsa } from "../actions/osa";
import type { VoiceCommandExtension } from "../voiceCommands";
import type { PendingAction } from "../services";
import { resolveTmuxTarget } from "./tmux";
import { distanceToRect } from "../hints/ranking";
import type { AXElement } from "../hints/types";
import { captureFocus, restoreFocus, describeFocus } from "../focusSnapshot";
import type { FocusSnapshot, FocusDeps } from "../focusSnapshot";
import { configField, nonEmpty } from "../config/schema";
import { defineVoicePack } from "./define";
import type { PackCommandContext } from "./define";

// ─── Terminal app detection ────────────────────────────────────────────────────

const TERMINAL_APPS = new Set([
  "ghostty",
  "terminal",
  "iterm",
  "iterm2",
  "kitty",
  "wezterm",
  "alacritty",
  "hyper",
  "tabby",
  "rio",
]);

function isTerminalApp(app: string | undefined): boolean {
  if (!app) return false;
  return TERMINAL_APPS.has(app.toLowerCase().replace(/\s+/g, ""));
}

/** Collapse newlines for terminal output (never press Enter). */
function collapseForTerminal(text: string): string {
  // Remove trailing newline, join internal newlines with space
  return text.trimEnd().replace(/\n+/g, " ");
}

// ─── Screen context ─────────────────────────────────────────────────────────

export interface ScreenContext {
  app?: string;
  windowTitle?: string;
  gaze?: { x: number; y: number };
  focusedElement?: { role?: string; value?: string; placeholder?: string; title?: string };
  nearbyText?: string[];
  browserUrl?: string;
  cwd?: string;
  command?: string;
  terminalScreen?: string;
}

export interface ScreenContextDeps {
  frontmostApp?(): Promise<string | undefined>;
  frontWindow?(app?: string): Promise<{ title?: string } | undefined>;
  gazePoint?(): { x: number; y: number } | undefined;
  getNearbyElements?(gaze: { x: number; y: number }): Promise<string[]>;
  getFocusedElement?(): Promise<{ role?: string; value?: string; placeholder?: string; title?: string } | undefined>;
  getBrowserUrl?(): Promise<string | undefined>;
  execTmux?(cmd: string): Promise<string>;
}

/** Per-session smarttype state (was module-level `let`s + `set*` test hooks). */
export interface SmartTypeState {
  /** Live AX / browser / tmux context providers. Tests turn them off (no real osascript/tmux). */
  liveScreenProviders: boolean;
  /** Preview UI (macOS dialog). Undefined = voice confirmation only. */
  previewDialog: PreviewDialog | undefined;
  /** One agenttype at a time. */
  agentTypeRunning: boolean;
}

export function createSmartTypeState(overrides: Partial<SmartTypeState> = {}): SmartTypeState {
  return { liveScreenProviders: true, previewDialog: macPreviewDialog, agentTypeRunning: false, ...overrides };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise.catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

/**
 * Build a ScreenContext from injected deps (each with 600ms timeout, failure-tolerant).
 */
export async function buildScreenContext(deps: ScreenContextDeps = {}): Promise<ScreenContext> {
  const ctx: ScreenContext = {};
  const TIMEOUT = 600;

  // App and window title
  const [app, win] = await Promise.all([
    withTimeout(deps.frontmostApp?.() ?? Promise.resolve(undefined), TIMEOUT),
    withTimeout(deps.frontWindow?.() ?? Promise.resolve(undefined), TIMEOUT),
  ]);
  if (app) ctx.app = app;
  if (win?.title) ctx.windowTitle = win.title;

  // Gaze — sync fn, wrap in try/catch
  let gaze: { x: number; y: number } | undefined;
  try {
    gaze = deps.gazePoint?.();
  } catch {
    gaze = undefined;
  }
  if (gaze) ctx.gaze = gaze;

  // Nearby elements and focused element
  const [nearby, focused] = await Promise.all([
    gaze ? withTimeout(deps.getNearbyElements?.(gaze) ?? Promise.resolve(undefined), 1500) : Promise.resolve(undefined),
    withTimeout(deps.getFocusedElement?.() ?? Promise.resolve(undefined), TIMEOUT),
  ]);
  if (nearby?.length) ctx.nearbyText = nearby.slice(0, 40);
  if (focused) ctx.focusedElement = focused;

  // Browser URL
  const browserUrl = await withTimeout(deps.getBrowserUrl?.() ?? Promise.resolve(undefined), TIMEOUT);
  if (browserUrl) ctx.browserUrl = browserUrl;

  // Terminal special case: capture tmux context
  if (isTerminalApp(ctx.app) && !deps.execTmux) {
    const t = await withTimeout(resolveTmuxTarget(), TIMEOUT);
    if (t) {
      const [info, screen] = await Promise.all([
        withTimeout(
          execFileText("tmux", [
            "display-message",
            "-p",
            "-t",
            t.paneId,
            "#{pane_current_path}\t#{pane_current_command}",
          ]),
          TIMEOUT
        ),
        withTimeout(execFileText("tmux", ["capture-pane", "-p", "-t", t.paneId, "-S", "-40"]), TIMEOUT),
      ]);
      if (info?.trim()) {
        const [cwd, command] = info.trim().split("\t");
        ctx.cwd = cwd;
        if (command) ctx.command = command;
      }
      if (screen?.trim()) ctx.terminalScreen = screen.trimEnd().split("\n").slice(-40).join("\n");
    }
  } else if (isTerminalApp(ctx.app)) {
    try {
      // Find the most recently active tmux client session
      const listClientsOutput = await withTimeout(
        deps.execTmux?.("list-clients -F '#{client_activity} #{session_name}'") ??
          execTmuxCmd("list-clients -F '#{client_activity} #{session_name}'"),
        TIMEOUT
      );
      if (listClientsOutput?.trim()) {
        const lines = listClientsOutput.trim().split("\n").filter(Boolean);
        // Sort by activity (first field), highest first
        const sorted = lines
          .map((l) => {
            const m = l.match(/^(\d+)\s+(.+)$/);
            return m ? { activity: parseInt(m[1], 10), session: m[2].trim() } : null;
          })
          .filter(Boolean)
          .sort((a, b) => b!.activity - a!.activity);
        const topSession = sorted[0]?.session;
        if (topSession) {
          const target = `${topSession}:`;
          const [paneInfo, paneScreen] = await Promise.all([
            withTimeout(
              deps.execTmux?.(`display -p -t '${target}' '#{pane_current_path} #{pane_current_command}'`) ??
                execTmuxCmd(`display -p -t '${target}' '#{pane_current_path} #{pane_current_command}'`),
              TIMEOUT
            ),
            withTimeout(
              deps.execTmux?.(`capture-pane -p -t '${target}' -S -40`) ??
                execTmuxCmd(`capture-pane -p -t '${target}' -S -40`),
              TIMEOUT
            ),
          ]);
          if (paneInfo?.trim()) {
            const parts = paneInfo.trim().split(" ");
            ctx.cwd = parts[0];
            ctx.command = parts.slice(1).join(" ");
          }
          if (paneScreen?.trim()) {
            ctx.terminalScreen = paneScreen.trim().split("\n").slice(-40).join("\n");
          }
        }
      }
    } catch {
      // tmux not running or not available
    }
  }

  return ctx;
}

async function execTmuxCmd(args: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`tmux ${args}`, { timeout: 500 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function contextToPrompt(ctx: ScreenContext): string {
  const parts: string[] = [];
  if (ctx.app) parts.push(`app: ${ctx.app}`);
  if (ctx.windowTitle) parts.push(`window: ${ctx.windowTitle}`);
  if (ctx.browserUrl) parts.push(`url: ${ctx.browserUrl}`);
  if (ctx.gaze) parts.push(`gaze: ${Math.round(ctx.gaze.x)},${Math.round(ctx.gaze.y)}`);
  if (ctx.cwd) parts.push(`cwd: ${ctx.cwd}`);
  if (ctx.command) parts.push(`shell: ${ctx.command}`);
  if (ctx.focusedElement) {
    const fe = ctx.focusedElement;
    const feStr = [fe.role, fe.title ?? fe.placeholder, fe.value ? `"${fe.value.slice(0, 200)}"` : undefined]
      .filter(Boolean)
      .join(", ");
    if (feStr) parts.push(`focused: ${feStr}`);
  }
  if (ctx.nearbyText?.length) {
    parts.push(`nearby: ${ctx.nearbyText.slice(0, 20).join(" | ").slice(0, 3000)}`);
  }
  if (ctx.terminalScreen) {
    parts.push(`terminal:\n${ctx.terminalScreen.slice(-3000)}`);
  }
  return parts.length ? `\n\nContext:\n${parts.join("\n")}` : "";
}

function execFileText(cmd: string, args: string[], timeout = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** Labels/values of accessibility elements of the front window near the gaze point. */
async function nearbyAccessibilityText(
  cu: { accessibilityElements?: (o: object) => Promise<AXElement[]> } | undefined,
  gaze: { x: number; y: number }
): Promise<string[]> {
  if (!cu?.accessibilityElements) return [];
  const elements = await cu.accessibilityElements({ maxDepth: 10, maxElements: 400, interactiveOnly: false });
  const seen = new Set<string>();
  return elements
    .filter((e) => e.bounds && e.bounds.width > 0 && e.bounds.height > 0)
    .map((e) => ({ e, d: distanceToRect(gaze.x, gaze.y, e.bounds!) }))
    .filter(({ d }) => d < 450)
    .sort((a, b) => a.d - b.d)
    .map(({ e }) =>
      [e.title, e.description, e.value]
        .filter((v) => typeof v === "string" && v.trim())
        .join(" — ")
        .replace(/\s+/g, " ")
        .slice(0, 300)
    )
    .filter((t) => t && !seen.has(t) && (seen.add(t), true))
    .slice(0, 40);
}

async function chromeActiveUrl(app: string | undefined): Promise<string | undefined> {
  if (process.platform !== "darwin" || !app || !/chrome|brave|arc|edge/i.test(app)) return undefined;
  const name = /chrome/i.test(app) ? "Google Chrome" : app;
  const out = await runAppleScript(
    `tell application "${name.replace(/"/g, "")}" to get URL of active tab of front window`,
    { timeoutMs: 800 }
  ).catch(() => "");
  return out.trim() || undefined;
}

// ─── System prompts ──────────────────────────────────────────────────────────

const SMART_TYPE_SYSTEM = `Output ONLY the exact text to type into the focused field. No explanation, no preamble, no trailing newline.
If the user dictated literal text, fix transcription errors, punctuation, and casing.
If the user described what they want (a command, code, a message), produce it.
For terminals output a single shell command line with no prompt, no backticks, no explanation.
Use the Context block (frontmost app, window title, URL, text near where the user is looking, terminal cwd and recent output) to resolve references like "this", "here", "that error" and to match the app's conventions. Never repeat the context itself.`;

const AGENT_TYPE_SYSTEM = `[agenttype] Your finalAnswer will be TYPED VERBATIM as keystrokes into the app the user was in when they spoke (see Context). It is not shown to them as a chat reply.
- Use your tools as needed to research or gather information (codebase, browser, screen), but do NOT type, paste, or edit anything into the user's app yourself and do NOT do the visual-verification step — voice control types your answer for you after the user confirms it in a preview.
- Your finalAnswer must contain ONLY the text that should be typed, exactly as it should appear. No explanation, no preamble ("Here is…"), no summary of what you did, no quotes, no markdown code fences.
- Example: "a command that would install docker" in a terminal → finalAnswer is just: brew install --cask docker
- If the target is a terminal or shell, output a single command line and never include a prompt symbol. Otherwise match the app's conventions (plain text, or markdown only where the app renders it).
- The user keeps working while you run. Disturb their screen as little as possible: prefer tools that work in the background (browser MCP browser_evaluate / reading pages, file and codebase tools) over clicking or switching apps. Never close, navigate away from, or type into the user's input target tab/window/pane; if you need another page, open a new tab. Voice control records the user's app, window, browser tab and tmux pane before you start and restores them when you finish, so you do not need to switch back yourself.
- The Context block describes the user's screen (frontmost app, window, URL, text near their gaze, terminal cwd/output); use it to resolve "this", "here", "that error".`;

function focusToPrompt(f: FocusSnapshot): string {
  if (!f.app) return "";
  const lines = [`\n\nUser's input target (restored automatically when you finish): app "${f.app}"`];
  if (f.windowTitle) lines.push(`window "${f.windowTitle}"`);
  if (f.chrome) lines.push(`${f.chrome.app} tab "${f.chrome.title ?? ""}" ${f.chrome.url ?? ""}`);
  if (f.tmux) lines.push(`tmux pane ${f.tmux.paneId} (session ${f.tmux.session})`);
  return lines.join(", ") + ".";
}

// ─── Command helpers ─────────────────────────────────────────────────────────

type SmartTypeContext = PackCommandContext<SmartTypeState>;

async function runSmartType(ctx: SmartTypeContext, rawText: string, mode: "smart" | "agent"): Promise<void> {
  if (mode === "agent" && ctx.state.agentTypeRunning) {
    ctx.log("[voice] agenttype: already running — please wait");
    return;
  }

  const actions = ctx.services.platform;
  const { liveScreenProviders } = ctx.state;
  const ai = ctx.services.ai?.ai;
  if (!ai) {
    ctx.log("[voice] smarttype: AI service not available (setupServices not called?)");
    return;
  }

  const computer = ctx.services.computer;
  // Record where input is going (app, window, browser tab, tmux pane) so it
  // can be put back after the agent / preview dialog moves focus around.
  const focusDeps: FocusDeps = {
    frontmostApp: actions?.frontmostApp ? () => actions.frontmostApp() : undefined,
    activateApp: actions?.activateApp ? (a) => actions.activateApp(a) : undefined,
    ...(liveScreenProviders ? {} : { jxa: async () => "", tmux: async () => "" }),
  };
  const focus = await captureFocus(focusDeps).catch((): FocusSnapshot => ({ takenAt: Date.now() }));
  const originalApp = focus.app;
  const isTerminal = isTerminalApp(originalApp);

  ctx.log(`[voice] ${mode === "smart" ? "smarttype" : "agenttype"}: "${rawText.slice(0, 80)}…" — gathering context…`);

  // Build screen context in parallel with nothing else blocking
  let screenCtx: ScreenContext = {};
  try {
    const gaze = ctx.target?.() ?? ctx.gaze;
    screenCtx = await buildScreenContext({
      frontmostApp: actions?.frontmostApp?.bind(actions),
      frontWindow: actions?.frontWindow?.bind(actions),
      gazePoint: () => gaze,
      ...(liveScreenProviders
        ? {
            getNearbyElements: (g) => nearbyAccessibilityText(computer, g),
            getBrowserUrl: () => chromeActiveUrl(originalApp),
          }
        : { execTmux: async () => "" }),
    });
  } catch {
    // context optional
  }

  const contextStr = contextToPrompt(screenCtx);
  const userMsg = `${rawText}${contextStr}`;

  if (mode === "agent") {
    ctx.state.agentTypeRunning = true;
    ctx.log(`[voice] agenttype: working… (will return to ${describeFocus(focus)})`);

    // Run agent asynchronously — don't block voice loop
    void (async () => {
      try {
        const prompt = `${AGENT_TYPE_SYSTEM}${focusToPrompt(focus)}\n\nWhat to type: ${userMsg}`;
        let result: string | undefined;
        try {
          result = await ai.runAgent(prompt, {
            onTool: (name) => ctx.log(`[voice] agenttype tool: ${name}`),
          });
        } finally {
          // The agent may have switched apps / tabs / panes: put them back.
          const problems = await restoreFocus(focus, focusDeps);
          if (problems.length) ctx.log(`[voice] agenttype: focus restore incomplete — ${problems.join("; ")}`);
          else ctx.log(`[voice] agenttype: restored focus to ${describeFocus(focus)}`);
        }
        if (!result) {
          ctx.log("[voice] agenttype: agent returned empty result");
          return;
        }
        const typed = isTerminal ? collapseForTerminal(result) : result;
        showPreviewAndConfirm(ctx, typed, originalApp, isTerminal, "agenttype", focus, focusDeps, async () => {
          // redo — run again
          runSmartType(ctx, rawText, "agent");
        });
      } catch (e) {
        ctx.log(`[voice] agenttype: error — ${e}`);
      } finally {
        ctx.state.agentTypeRunning = false;
      }
    })();
  } else {
    // smart type — synchronous LLM call
    let result: string;
    try {
      result = await ai.complete(SMART_TYPE_SYSTEM, userMsg);
    } catch (e) {
      ctx.log(`[voice] smarttype: LLM error — ${e}`);
      return;
    }
    if (!result) {
      ctx.log("[voice] smarttype: LLM returned empty result");
      return;
    }
    const typed = isTerminal ? collapseForTerminal(result) : result;
    showPreviewAndConfirm(ctx, typed, originalApp, isTerminal, "smarttype", focus, focusDeps, async () => {
      // redo — run again
      runSmartType(ctx, rawText, "smart");
    });
  }
}

function showPreviewAndConfirm(
  ctx: SmartTypeContext,
  text: string,
  originalApp: string | undefined,
  isTerminal: boolean,
  label: string,
  focus: FocusSnapshot,
  focusDeps: FocusDeps,
  onRedo: () => void
): void {
  const actions = ctx.services.platform;

  const doType = async () => {
    // Restore the original app / window / tab / pane (the preview dialog and
    // anything that happened while it was open take focus).
    if (originalApp) {
      const problems = await restoreFocus(focus, focusDeps);
      if (problems.length) ctx.log(`[voice] ${label}: focus restore incomplete — ${problems.join("; ")}`);
      await ctx.services.clock.sleep(150);
    }
    let toType = text;
    // For terminal: strip trailing newline (don't execute)
    if (isTerminal) toType = toType.replace(/\n+$/, "");
    ctx.log(`[voice] ${label}: typing "${toType.slice(0, 80)}"`);
    if (actions?.typeText) {
      await actions.typeText(toType, { app: originalApp });
    }
    ctx.services.typing.noteTyped(toType);
  };

  ctx.log(`[voice] ${label} preview (say "confirm" or "cancel", or "redo"): ${text}`);

  // Preview UI (macOS dialog). Whichever resolves first — dialog button or
  // voice — wins; the other is torn down.
  const dialog = ctx.state.previewDialog?.(text, label, originalApp);

  const pending: PendingAction = {
    describe: `${label}: "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`,
    accept: async () => {
      dialog?.close();
      await doType();
    },
    reject: () => {
      dialog?.close();
      ctx.log(`[voice] ${label}: cancelled`);
    },
    redo: () => {
      dialog?.close();
      onRedo();
    },
  };
  ctx.services.pending.set(pending);

  if (dialog) {
    void dialog.result
      .then((choice) => {
        if (ctx.services.pending.peek() !== pending) return; // already resolved by voice / superseded
        ctx.services.pending.take();
        if (choice === "type") void doType().catch((e) => ctx.log(`[voice] ${label}: type error — ${e}`));
        else if (choice === "redo") onRedo();
        else if (choice === "cancel") ctx.log(`[voice] ${label}: cancelled via dialog`);
        // "closed" (killed / timed out / failed): leave voice confirmation possible only
        // if it was not timed out; a timeout drops it.
      })
      .catch(() => undefined);
  }
}

export type PreviewChoice = "type" | "cancel" | "redo" | "closed";
export interface PreviewDialogHandle {
  result: Promise<PreviewChoice>;
  close(): void;
}
export type PreviewDialog = (text: string, label: string, app?: string) => PreviewDialogHandle | undefined;

/** macOS dialog: [Cancel] [Redo] [Type]. Text is passed as an argv value, never through a shell. */
export const macPreviewDialog: PreviewDialog = (text, label, app) => {
  if (process.platform !== "darwin") return undefined;
  const preview = text.length > 1500 ? text.slice(0, 1497) + "…" : text;
  const script = `
function run(argv) {
  const sa = Application.currentApplication();
  sa.includeStandardAdditions = true;
  sa.activate();
  try {
    const r = sa.displayDialog(argv[0], {
      buttons: ["Cancel", "Redo", "Type"], defaultButton: "Type", cancelButton: "Cancel",
      givingUpAfter: 120, withTitle: argv[1],
    });
    if (r.gaveUp) return "closed";
    return r.buttonReturned === "Type" ? "type" : r.buttonReturned === "Redo" ? "redo" : "cancel";
  } catch (e) { return "cancel"; }
}`;
  const title = `knowhow ${label}${app ? ` → ${app}` : ""}  (or say "confirm" / "cancel")`;
  let child: ReturnType<typeof spawnOsa> | undefined;
  const result = new Promise<PreviewChoice>((resolve) => {
    child = spawnOsa("jxa", script, { args: [preview, title], timeoutMs: 125_000 }, (err, stdout) => {
      if (err) return resolve("closed");
      const out = stdout.trim();
      resolve(out === "type" || out === "redo" || out === "cancel" ? out : "closed");
    });
  });
  return {
    result,
    close: () => {
      try {
        child?.kill();
      } catch {
        /* ignore */
      }
    },
  };
};

// ─── Pack definition ─────────────────────────────────────────────────────────

/** Settings of the smart-type / agent-type pack (`knowhow.json → voiceControl.packs.smart-type.<key>`; the old `voiceControl.smartType` / `voiceControl.agentType` keys still work). */
export const SMART_TYPE_CONFIG = {
  provider: configField<string>({
    default: "anthropic",
    env: "KNOWHOW_SMARTTYPE_PROVIDER",
    legacyJson: ["voiceControl.smartType.provider"],
    parse: nonEmpty,
    description: "AI provider used to write smart-type text",
  }),
  model: configField<string>({
    default: "claude-sonnet-4-6",
    env: "KNOWHOW_SMARTTYPE_MODEL",
    legacyJson: ["voiceControl.smartType.model"],
    parse: nonEmpty,
    description: "Model used to write smart-type text",
  }),
  agent: configField<string | undefined>({
    default: undefined,
    legacyJson: ["voiceControl.agentType.agent"],
    parse: nonEmpty,
    description: "Agent that runs \"agent type\" (unset = the agent \"hey knowhow\" talks to)",
  }),
};

export const SMART_TYPE_PACK = defineVoicePack<SmartTypeState, typeof SMART_TYPE_CONFIG>({
  config: SMART_TYPE_CONFIG,
  name: "smart-type",
  description: "smart type / agent type: LLM-generated text typed after a spoken or dialog confirmation",
  prefix: "voice-control.smarttype.",
  createState: () => createSmartTypeState(),
  onSessionStop: ({ state }) => {
    state.previewDialog = undefined;
  },
  commands: ({ command }) => [
    command({
      name: "smart-type",
      phrase: "smart type",
      description: "Use AI to clean up or generate text, then type it after confirmation",
      run: async (ctx) => {
        const raw =
          (ctx.slots?.text as string) ??
          extractAfterVerbs(ctx.text, ["smarttype ", "smart type ", "smart-type ", "smart tight "]);
        if (!raw) return;
        await runSmartType(ctx, raw, "smart");
      },
      pattern: "smart type {text:text}",
      aliases: ["smarttype", "smart-type", "smart tight"],
    }),

    command({
      name: "agent-type",
      phrase: "agent type",
      description: "Use a knowhow agent to research and generate text, then type it after confirmation",
      run: async (ctx) => {
        const raw =
          (ctx.slots?.text as string) ?? extractAfterVerbs(ctx.text, ["agenttype ", "agent type ", "agent-type "]);
        if (!raw) return;
        await runSmartType(ctx, raw, "agent");
      },
      pattern: "agent type {text:text}",
      aliases: ["agenttype", "agent-type"],
    }),
  ],
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractAfterVerbs(text: string, verbs: string[]): string {
  const lower = text.toLowerCase();
  for (const verb of verbs) {
    const idx = lower.indexOf(verb);
    if (idx !== -1) {
      return text.slice(idx + verb.length).trim();
    }
  }
  return text;
}

export default SMART_TYPE_PACK;
