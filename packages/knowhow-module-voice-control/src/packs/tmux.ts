/**
 * tmux pack: drive tmux through the `tmux` CLI (not keystrokes), targeting the
 * pane/session of the most recently active tmux client — i.e. the terminal you
 * are actually using, not the pane the voice agent runs in.
 *
 *   tmux left/right/up/down   vim-tmux-navigator semantics (C-h/j/k/l): if the
 *                             active pane runs vim, send C-h… to vim, else select-pane
 *   tmux zoom                 resize-pane -Z (toggle)
 *   tmux tab next/previous/last, tmux tab <n>   windows (the status-bar tabs)
 *   tmux pane <n>, tmux last pane
 *   tmux split right/down, tmux new tab, tmux resize <dir> [n]
 *   tmux copy mode, tmux interrupt
 *   tmux pane tab next/previous/new/close       tmux-pane-tabs plugin (prefix N/P/T/X)
 */

import { execFile as nodeExecFile } from "child_process";
import { promisify } from "util";
import type { VoiceCommandExtension } from "../voiceCommands";
import { pack } from "../commands/define";

const execFileP = promisify(nodeExecFile);

/** Runs `tmux <args>` and returns stdout. Injectable for tests. */
export type TmuxRunner = (args: string[]) => Promise<string>;
/** Runs a shell command line (used for plugin key bindings). Injectable for tests. */
export type ShellRunner = (command: string) => Promise<void>;

const defaultTmux: TmuxRunner = async (args) => {
  const { stdout } = await execFileP("tmux", args, { timeout: 3000 });
  return stdout;
};
const defaultShell: ShellRunner = async (command) => {
  await execFileP("/bin/sh", ["-c", command], { timeout: 5000 });
};

let tmux: TmuxRunner = defaultTmux;
let shell: ShellRunner = defaultShell;

/** Test hook. Pass undefined to restore the real runners. */
export function setTmuxRunners(t?: TmuxRunner, s?: ShellRunner): void {
  tmux = t ?? defaultTmux;
  shell = s ?? defaultShell;
}

export interface TmuxTarget {
  client: string;
  session: string;
  paneId: string;
  command: string;
}

/** The pane of the most recently active attached client. */
export async function resolveTmuxTarget(): Promise<TmuxTarget | undefined> {
  const clients = (await tmux(["list-clients", "-F", "#{client_activity}\t#{client_name}\t#{client_session}"]))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [activity, client, session] = l.split("\t");
      return { activity: Number(activity) || 0, client, session };
    })
    .filter((c) => c.client && c.session)
    .sort((a, b) => b.activity - a.activity);
  const best = clients[0];
  if (!best) return undefined;
  const info = (await tmux(["display-message", "-p", "-c", best.client, "#{pane_id}\t#{pane_current_command}"])).trim();
  const [paneId, command = ""] = info.split("\t");
  if (!paneId) return undefined;
  return { client: best.client, session: best.session, paneId, command };
}

/** Same test as the is_vim check in ~/.tmux.conf / vim-tmux-navigator. */
export function isVimCommand(command: string): boolean {
  return /^g?(view|n?vim?x?)(diff)?$/i.test(command.trim().split("/").pop() ?? "");
}

type Dir = "left" | "right" | "up" | "down";
const DIR_FLAG: Record<Dir, string> = { left: "-L", right: "-R", up: "-U", down: "-D" };
const DIR_KEY: Record<Dir, string> = { left: "C-h", right: "C-l", up: "C-k", down: "C-j" };

async function withTarget(ctx: { log(msg: string): void }, fn: (t: TmuxTarget) => Promise<void>): Promise<void> {
  let target: TmuxTarget | undefined;
  try {
    target = await resolveTmuxTarget();
  } catch (e) {
    ctx.log(`tmux: not available (${(e as Error).message.split("\n")[0]})`);
    return;
  }
  if (!target) {
    ctx.log("tmux: no attached tmux client");
    return;
  }
  await fn(target);
}

function num(ctx: { slots: Record<string, unknown>; text: string }, fallback?: number): number | undefined {
  const n = ctx.slots?.n;
  if (typeof n === "number" && Number.isFinite(n)) return n;
  const m = ctx.text.match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : fallback;
}

/**
 * Run the command bound to a key in the prefix table (used for tmux-pane-tabs,
 * whose bindings are `run-shell "<script> next '#{pane_id}'"`).
 */
export async function runPrefixBinding(key: string, target: TmuxTarget): Promise<boolean> {
  const line = (await tmux(["list-keys", "-T", "prefix", key])).split("\n").find((l) => l.trim());
  if (!line) return false;
  const m =
    line.match(/\brun-shell\s+(?:-b\s+)?"((?:[^"\\]|\\.)*)"\s*$/) ??
    line.match(/\brun-shell\s+(?:-b\s+)?'([^']*)'\s*$/);
  if (!m) return false;
  const command = m[1]
    .replace(/\\(["\\$])/g, "$1")
    .replace(/#\{pane_id\}/g, target.paneId)
    .replace(/#\{session_name\}/g, target.session);
  await shell(command);
  return true;
}

const command = pack({ prefix: "voice-control.tmux.", defaults: { repeatable: false } });

function navigate(dir: Dir): VoiceCommandExtension {
  return command({
    name: `pane-${dir}`,
    phrase: `tmux ${dir}`,
    description: `Move to the tmux pane ${dir} (vim-aware, like Ctrl-${DIR_KEY[dir].slice(2)})`,
    run: (ctx) =>
      withTarget(ctx, async (t) => {
        if (isVimCommand(t.command)) await tmux(["send-keys", "-t", t.paneId, DIR_KEY[dir]]);
        else await tmux(["select-pane", "-t", t.paneId, DIR_FLAG[dir]]);
      }),
    aliases: [`tmux pane ${dir}`, `tmux ${dir} pane`, `pane ${dir}`, `tmux go ${dir}`],
  });
}

function resize(dir: Dir): VoiceCommandExtension {
  return command({
    name: `resize-${dir}`,
    phrase: `tmux resize ${dir}`,
    description: `Resize the tmux pane ${dir} by 5 cells × n`,
    run: (ctx) =>
      withTarget(ctx, async (t) => {
        const n = Math.min(num(ctx, 1) ?? 1, 20);
        await tmux(["resize-pane", "-t", t.paneId, DIR_FLAG[dir], String(5 * n)]);
      }),
    patterns: [`tmux resize ${dir} [{n:number}]`, `tmux grow ${dir} [{n:number}]`],
  });
}

function paneTab(name: string, key: string, words: string[], description: string): VoiceCommandExtension {
  return command({
    name: `pane-tab-${name}`,
    phrase: `tmux pane tab ${words[0]}`,
    description: description,
    run: (ctx) =>
      withTarget(ctx, async (t) => {
        const ok = await runPrefixBinding(key, t);
        if (!ok) ctx.log(`tmux: no run-shell binding on prefix ${key} (is tmux-pane-tabs loaded?)`);
      }),
    aliases: words.flatMap((w) => [`tmux pane tab ${w}`, `tmux ${w} pane tab`]).slice(1),
  });
}

export const TMUX_PACK: VoiceCommandExtension[] = [
  navigate("left"),
  navigate("right"),
  navigate("up"),
  navigate("down"),

  command({
    name: "zoom",
    phrase: "tmux zoom",
    description: "Toggle zoom on the active tmux pane (resize-pane -Z)",
    run: (ctx) =>
      withTarget(ctx, async (t) => {
        await tmux(["resize-pane", "-Z", "-t", t.paneId]);
      }),
    aliases: ["tmux zoom pane", "tmux unzoom", "tmux zoom in", "tmux zoom out", "zoom pane", "unzoom pane"],
  }),

  // Windows = the tabs in the tmux status bar.
  command({
    name: "tab-next",
    phrase: "tmux tab next",
    description: "Next tmux window (status-bar tab)",
    run: (ctx) =>
      withTarget(ctx, async (t) => {
        await tmux(["next-window", "-t", t.session]);
      }),
    aliases: ["tmux next tab", "tmux next window", "tmux window next", "tmux tab right"],
  }),
  command({
    name: "tab-previous",
    phrase: "tmux tab previous",
    description: "Previous tmux window (status-bar tab)",
    run: (ctx) =>
      withTarget(ctx, async (t) => {
        await tmux(["previous-window", "-t", t.session]);
      }),
    aliases: [
      "tmux previous tab",
      "tmux prev tab",
      "tmux tab back",
      "tmux previous window",
      "tmux window previous",
      "tmux tab left",
    ],
  }),
  command({
    name: "tab-last",
    phrase: "tmux last tab",
    description: "Last-used tmux window",
    run: (ctx) =>
      withTarget(ctx, async (t) => {
        await tmux(["last-window", "-t", t.session]);
      }),
    aliases: ["tmux tab last", "tmux last window"],
  }),
  command({
    name: "tab-n",
    phrase: "tmux tab {n:number}",
    description: "Jump to tmux window N",
    run: (ctx) =>
      withTarget(ctx, async (t) => {
        const n = num(ctx);
        if (n === undefined) return ctx.log("tmux tab: which number?");
        await tmux(["select-window", "-t", `${t.session}:${n}`]);
      }),
    patterns: ["tmux tab {n:number}", "tmux window {n:number}", "tmux tab number {n:number}"],
  }),
  command({
    name: "new-tab",
    phrase: "tmux new tab",
    description: "Open a new tmux window in the current pane's directory",
    run: (ctx) =>
      withTarget(ctx, async (t) => {
        const cwd = (await tmux(["display-message", "-p", "-t", t.paneId, "#{pane_current_path}"])).trim();
        await tmux(["new-window", "-t", `${t.session}:`, ...(cwd ? ["-c", cwd] : [])]);
      }),
    aliases: ["tmux new window"],
  }),

  command({
    name: "pane-n",
    phrase: "tmux pane {n:number}",
    description: "Select tmux pane N in the current window",
    run: (ctx) =>
      withTarget(ctx, async (t) => {
        const n = num(ctx);
        if (n === undefined) return ctx.log("tmux pane: which number?");
        const win = (await tmux(["display-message", "-p", "-t", t.paneId, "#{session_name}:#{window_index}"])).trim();
        await tmux(["select-pane", "-t", `${win}.${n}`]);
      }),
    patterns: ["tmux pane {n:number}", "pane {n:number}"],
  }),
  command({
    name: "last-pane",
    phrase: "tmux last pane",
    description: "Go back to the previously active tmux pane",
    run: (ctx) =>
      withTarget(ctx, async (t) => {
        await tmux(["last-pane", "-t", t.paneId]);
      }),
    aliases: ["tmux pane last", "tmux previous pane"],
  }),

  command({
    name: "split-right",
    phrase: "tmux split right",
    description: "Split the tmux pane side by side (prefix v)",
    run: (ctx) =>
      withTarget(ctx, async (t) => {
        const cwd = (await tmux(["display-message", "-p", "-t", t.paneId, "#{pane_current_path}"])).trim();
        await tmux(["split-window", "-h", "-t", t.paneId, ...(cwd ? ["-c", cwd] : [])]);
      }),
    aliases: ["tmux split vertical", "tmux vertical split", "tmux split"],
  }),
  command({
    name: "split-down",
    phrase: "tmux split down",
    description: "Split the tmux pane top/bottom (prefix s)",
    run: (ctx) =>
      withTarget(ctx, async (t) => {
        const cwd = (await tmux(["display-message", "-p", "-t", t.paneId, "#{pane_current_path}"])).trim();
        await tmux(["split-window", "-v", "-t", t.paneId, ...(cwd ? ["-c", cwd] : [])]);
      }),
    aliases: ["tmux split horizontal", "tmux horizontal split"],
  }),

  resize("left"),
  resize("right"),
  resize("up"),
  resize("down"),

  command({
    name: "copy-mode",
    phrase: "tmux copy mode",
    description: "Enter tmux copy mode (scrollback)",
    run: (ctx) =>
      withTarget(ctx, async (t) => {
        await tmux(["copy-mode", "-t", t.paneId]);
      }),
    aliases: ["tmux scroll mode", "tmux scroll back"],
  }),
  command({
    name: "interrupt",
    phrase: "tmux interrupt",
    description: "Send Ctrl-C to the active tmux pane",
    run: (ctx) =>
      withTarget(ctx, async (t) => {
        await tmux(["send-keys", "-t", t.paneId, "C-c"]);
      }),
    aliases: ["tmux control c", "tmux cancel"],
  }),

  // tmux-pane-tabs plugin (~/dev/tmux-pane-tabs): prefix N / P / T / X.
  paneTab("next", "N", ["next"], "Next pane tab (tmux-pane-tabs, prefix N)"),
  paneTab("previous", "P", ["previous", "prev", "back"], "Previous pane tab (tmux-pane-tabs, prefix P)"),
  paneTab("new", "T", ["new"], "New pane tab (tmux-pane-tabs, prefix T)"),
  paneTab("close", "X", ["close"], "Close the current pane tab (tmux-pane-tabs, prefix X)"),
];

export default TMUX_PACK;
