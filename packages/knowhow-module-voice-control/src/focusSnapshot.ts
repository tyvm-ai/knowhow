/**
 * Focus snapshot / restore.
 *
 * agenttype hands work to a computer-use agent that may switch apps, Chrome
 * tabs or tmux panes while it researches. Before it starts we record where
 * the user's input was going (app, window, Chrome window + tab, tmux pane)
 * and put all of that back before the preview / typing.
 */

import { execFile } from "child_process";
import { runJxa } from "./actions/osa";

export interface FocusSnapshot {
  app?: string;
  windowTitle?: string;
  chrome?: { app: string; windowId: number | string; tabId: number | string; url?: string; title?: string };
  tmux?: { client: string; session: string; windowId: string; paneId: string };
  takenAt: number;
}

export interface FocusDeps {
  frontmostApp?(): Promise<string | undefined>;
  activateApp?(app: string): Promise<boolean>;
  jxa?(script: string, timeoutMs?: number): Promise<string>;
  tmux?(args: string[]): Promise<string>;
}

const BROWSERS: Array<[RegExp, string]> = [
  [/chrome/i, "Google Chrome"],
  [/brave/i, "Brave Browser"],
  [/edge/i, "Microsoft Edge"],
  [/chromium/i, "Chromium"],
];

function browserName(app: string | undefined): string | undefined {
  if (!app) return undefined;
  for (const [re, name] of BROWSERS) if (re.test(app)) return name;
  return undefined;
}

const TERMINALS = /ghostty|terminal|iterm|kitty|wezterm|alacritty|hyper|tabby|^rio$/i;

function run(cmd: string, args: string[], timeout = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

const defaultJxa = (script: string, timeoutMs = 1500) => runJxa(script, { timeoutMs });
const defaultTmux = (args: string[]) => run("tmux", args, 800);

function q(s: string): string {
  return JSON.stringify(s);
}

/** Record where the user's input is currently going. Never throws. */
export async function captureFocus(deps: FocusDeps = {}): Promise<FocusSnapshot> {
  const jxa = deps.jxa ?? (process.platform === "darwin" ? defaultJxa : undefined);
  const tmux = deps.tmux ?? defaultTmux;
  const snap: FocusSnapshot = { takenAt: Date.now() };
  snap.app = await deps.frontmostApp?.().catch(() => undefined);

  const tasks: Promise<void>[] = [];
  if (jxa && snap.app) {
    tasks.push((async () => {
      try {
        const title = (await jxa(`
          const p = Application("System Events").applicationProcesses.whose({ name: ${q(snap.app!)} });
          let t = "";
          if (p.length > 0) { const w = p[0].windows(); if (w.length) { try { t = w[0].name() || ""; } catch (e) {} } }
          t;`)).trim();
        if (title) snap.windowTitle = title;
      } catch { /* optional */ }
    })());
    const browser = browserName(snap.app);
    if (browser) {
      tasks.push((async () => {
        try {
          const out = (await jxa(`
            const c = Application(${q(browser)});
            const w = c.windows[0];
            const t = w.activeTab;
            JSON.stringify({ windowId: w.id(), tabId: t.id(), url: t.url(), title: t.title() });`)).trim();
          const parsed = JSON.parse(out);
          if (parsed && parsed.windowId != null && parsed.tabId != null) snap.chrome = { app: browser, ...parsed };
        } catch { /* optional */ }
      })());
    }
  }
  if (snap.app && TERMINALS.test(snap.app)) {
    tasks.push((async () => {
      try {
        const clients = (await tmux(["list-clients", "-F", "#{client_activity}\t#{client_name}\t#{client_session}"]))
          .split("\n").map((l) => l.split("\t")).filter((p) => p.length >= 3 && p[1])
          .sort((a, b) => (Number(b[0]) || 0) - (Number(a[0]) || 0));
        const best = clients[0];
        if (!best) return;
        const info = (await tmux(["display-message", "-p", "-c", best[1], "#{window_id}\t#{pane_id}"])).trim();
        const [windowId, paneId] = info.split("\t");
        if (windowId && paneId) snap.tmux = { client: best[1], session: best[2], windowId, paneId };
      } catch { /* tmux optional */ }
    })());
  }
  await Promise.all(tasks);
  return snap;
}

export function describeFocus(s: FocusSnapshot | undefined): string {
  if (!s?.app) return "unknown";
  const parts = [s.app];
  if (s.chrome) parts.push(`tab "${(s.chrome.title || s.chrome.url || "").slice(0, 60)}"`);
  else if (s.windowTitle) parts.push(`"${s.windowTitle.slice(0, 60)}"`);
  if (s.tmux) parts.push(`tmux ${s.tmux.session} ${s.tmux.paneId}`);
  return parts.join(" — ");
}

/**
 * Put focus back where the snapshot says. Returns a list of problems
 * (empty when everything was restored). Never throws.
 */
export async function restoreFocus(snap: FocusSnapshot | undefined, deps: FocusDeps = {}): Promise<string[]> {
  const problems: string[] = [];
  if (!snap?.app) return ["no focus snapshot"];
  const jxa = deps.jxa ?? (process.platform === "darwin" ? defaultJxa : undefined);
  const tmux = deps.tmux ?? defaultTmux;

  // 1) Chrome: re-select the original tab in the original window, raise that window.
  if (snap.chrome && jxa) {
    try {
      const out = (await jxa(`
        const c = Application(${q(snap.chrome.app)});
        let res = "missing";
        const wins = c.windows();
        const find = (pred) => {
          for (const w of wins) { const tabs = w.tabs(); for (let i = 0; i < tabs.length; i++) { if (pred(tabs[i])) return [w, i]; } }
          return null;
        };
        let hit = find((t) => String(t.id()) === ${q(String(snap.chrome.tabId))});
        if (!hit && ${q(snap.chrome.url ?? "")}) { hit = find((t) => t.url() === ${q(snap.chrome.url ?? "")}); if (hit) res = "url"; }
        if (hit) { hit[0].activeTabIndex = hit[1] + 1; hit[0].index = 1; if (res === "missing") res = "ok"; }
        res;`, 2500)).trim();
      if (out === "missing") problems.push(`original ${snap.chrome.app} tab is gone (${snap.chrome.url ?? snap.chrome.tabId})`);
    } catch (e) {
      problems.push(`could not restore ${snap.chrome.app} tab: ${String(e).slice(0, 120)}`);
    }
  }

  // 2) tmux: back to the original session / window / pane.
  if (snap.tmux) {
    const t = snap.tmux;
    try {
      await tmux(["switch-client", "-c", t.client, "-t", t.session]).catch(() => "");
      await tmux(["select-window", "-t", t.windowId]);
      await tmux(["select-pane", "-t", t.paneId]);
    } catch (e) {
      problems.push(`could not restore tmux pane ${t.paneId}: ${String(e).slice(0, 120)}`);
    }
  }

  // 3) Bring the app forward, then raise the original window by title.
  if (deps.activateApp) {
    try { await deps.activateApp(snap.app); } catch { /* checked below */ }
  }
  if (jxa && snap.windowTitle && !snap.chrome) {
    try {
      await jxa(`
        const p = Application("System Events").applicationProcesses.whose({ name: ${q(snap.app)} });
        if (p.length > 0) { const w = p[0].windows.whose({ name: ${q(snap.windowTitle)} }); if (w.length) w[0].actions.byName("AXRaise").perform(); }
        "";`);
    } catch { /* best effort: title may have changed */ }
  }

  // 4) Verify.
  if (deps.frontmostApp) {
    let front: string | undefined;
    for (let i = 0; i < 6; i++) {
      front = await deps.frontmostApp().catch(() => undefined);
      if (front && front.toLowerCase() === snap.app.toLowerCase()) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!front || front.toLowerCase() !== snap.app.toLowerCase()) {
      problems.push(`${snap.app} is not in front (front: ${front ?? "unknown"})`);
    }
  }
  return problems;
}
