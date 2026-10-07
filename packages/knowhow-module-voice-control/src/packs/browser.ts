/**
 * Browser pack: Chrome tab commands by name, driven through the browser MCP
 * server (Playwright MCP over CDP: `browser_tabs` list/select/new/close), with
 * an AppleScript fallback when the MCP server is not configured, not
 * reachable, or still waiting on Chrome's "allow remote debugging" prompt.
 *
 *   switch tab gmail / go to tab hacker news / chrome tab github
 *       → focus the best-matching open tab (opens it if nothing matches)
 *   open tab gmail / open chrome tab gmail
 *       → focus it if it's already open, otherwise open it in a new tab
 *   open new tab gmail / new chrome tab hacker news
 *       → always open a new tab
 *   close chrome tab youtube
 *   list tabs
 *
 * MCP methods are called by bare name ("browser_tabs") and resolved by suffix
 * through knowhow's shared ToolsService, so any connected MCP server exposing
 * `browser_tabs` works regardless of its configured name or order.
 *
 * Env:
 *   KNOWHOW_VOICE_BROWSER              auto (default) | mcp | applescript
 *   KNOWHOW_VOICE_BROWSER_MCP_TIMEOUT_MS  per-call timeout (default 4000)
 */

import { defaultOsaRunner } from "../actions/osa";
import type { OsaRunner } from "../actions/osa";
import type { VoiceCommandExtension } from "../voiceCommands";
import { pack } from "../commands/define";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BrowserTab {
  /** Backend-specific id: MCP tab index, or "window:tab" for AppleScript. */
  id: string;
  title: string;
  url: string;
  current?: boolean;
}

export interface BrowserBackend {
  name: string;
  list(): Promise<BrowserTab[]>;
  select(tab: BrowserTab): Promise<void>;
  open(url: string): Promise<void>;
  close(tab: BrowserTab): Promise<void>;
}

// ─── Query → site / URL ───────────────────────────────────────────────────────

interface Site {
  url: string;
  hosts: string[];
}

/** Spoken site names → URL + hosts used to recognise an open tab. */
export const SITE_ALIASES: Record<string, Site> = {
  gmail: { url: "https://mail.google.com/", hosts: ["mail.google.com"] },
  "g mail": { url: "https://mail.google.com/", hosts: ["mail.google.com"] },
  "google mail": { url: "https://mail.google.com/", hosts: ["mail.google.com"] },
  email: { url: "https://mail.google.com/", hosts: ["mail.google.com"] },
  mail: { url: "https://mail.google.com/", hosts: ["mail.google.com"] },
  inbox: { url: "https://mail.google.com/", hosts: ["mail.google.com"] },
  calendar: { url: "https://calendar.google.com/", hosts: ["calendar.google.com"] },
  "google calendar": { url: "https://calendar.google.com/", hosts: ["calendar.google.com"] },
  drive: { url: "https://drive.google.com/", hosts: ["drive.google.com"] },
  "google drive": { url: "https://drive.google.com/", hosts: ["drive.google.com"] },
  docs: { url: "https://docs.google.com/", hosts: ["docs.google.com"] },
  "google docs": { url: "https://docs.google.com/", hosts: ["docs.google.com"] },
  sheets: { url: "https://sheets.google.com/", hosts: ["docs.google.com/spreadsheets", "sheets.google.com"] },
  maps: { url: "https://maps.google.com/", hosts: ["maps.google.com", "google.com/maps"] },
  google: { url: "https://www.google.com/", hosts: ["www.google.com", "google.com"] },
  "hacker news": { url: "https://news.ycombinator.com/", hosts: ["news.ycombinator.com"] },
  hackernews: { url: "https://news.ycombinator.com/", hosts: ["news.ycombinator.com"] },
  hn: { url: "https://news.ycombinator.com/", hosts: ["news.ycombinator.com"] },
  youtube: { url: "https://www.youtube.com/", hosts: ["youtube.com"] },
  "you tube": { url: "https://www.youtube.com/", hosts: ["youtube.com"] },
  github: { url: "https://github.com/", hosts: ["github.com"] },
  "git hub": { url: "https://github.com/", hosts: ["github.com"] },
  reddit: { url: "https://www.reddit.com/", hosts: ["reddit.com"] },
  twitter: { url: "https://x.com/", hosts: ["x.com", "twitter.com"] },
  x: { url: "https://x.com/", hosts: ["x.com", "twitter.com"] },
  spotify: { url: "https://open.spotify.com/", hosts: ["open.spotify.com"] },
  amazon: { url: "https://www.amazon.com/", hosts: ["amazon.com"] },
  chatgpt: { url: "https://chatgpt.com/", hosts: ["chatgpt.com", "chat.openai.com"] },
  "chat gpt": { url: "https://chatgpt.com/", hosts: ["chatgpt.com", "chat.openai.com"] },
  claude: { url: "https://claude.ai/", hosts: ["claude.ai"] },
  slack: { url: "https://app.slack.com/", hosts: ["slack.com"] },
  linear: { url: "https://linear.app/", hosts: ["linear.app"] },
  notion: { url: "https://www.notion.so/", hosts: ["notion.so"] },
  "stack overflow": { url: "https://stackoverflow.com/", hosts: ["stackoverflow.com"] },
  wikipedia: { url: "https://en.wikipedia.org/", hosts: ["wikipedia.org"] },
  netflix: { url: "https://www.netflix.com/", hosts: ["netflix.com"] },
  knowhow: { url: "https://knowhow.tyvm.ai/", hosts: ["knowhow.tyvm.ai"] },
};

/** Lowercase, strip punctuation and filler ("to", "the", trailing "tab"). */
export function normaliseTabQuery(text: string): string {
  let q = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.:/ -]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  q = q.replace(/[.]+$/, "").trim();
  q = q.replace(/^(?:to|the|my|on|in|at)\s+/, "").replace(/^(?:the|my)\s+/, "");
  q = q.replace(/\s+(?:tab|page|website|site|please)$/, "");
  return q.trim();
}

const compact = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** "example dot com" / "example.com" / "localhost 3000" → URL, else undefined. */
export function spokenUrl(query: string): string | undefined {
  let q = query
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+colon\s+/g, ":")
    .replace(/\s+slash\s+/g, "/");
  const local = q.match(/^localhost(?:[: ]+(\d{2,5}))?$/);
  if (local) return `http://localhost${local[1] ? `:${local[1]}` : ""}/`;
  if (/^https?:\/\//.test(q)) return q;
  q = q.replace(/\s+/g, "");
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(q)) return `https://${q}`;
  return undefined;
}

export function siteFor(query: string): Site | undefined {
  return SITE_ALIASES[query] ?? SITE_ALIASES[compact(query)];
}

/** URL to open for a spoken query: known site, spoken domain, or a Google search. */
export function resolveTabUrl(query: string): string {
  const site = siteFor(query);
  if (site) return site.url;
  const url = spokenUrl(query);
  if (url) return url;
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** 0..100 match score for a tab against a normalised query. */
export function scoreTab(tab: BrowserTab, query: string): number {
  if (!query) return 0;
  const url = tab.url.toLowerCase();
  const host = hostOf(tab.url);
  const title = tab.title.toLowerCase();
  const site = siteFor(query);
  if (
    site &&
    site.hosts.some(
      (h) =>
        url.replace(/^https?:\/\/(www\.)?/, "").startsWith(h.replace(/^www\./, "")) ||
        host === h ||
        host.endsWith(`.${h}`)
    )
  ) {
    return 100;
  }
  const domain = spokenUrl(query);
  if (domain && host && host === hostOf(domain)) return 95;

  const cq = compact(query);
  if (cq.length >= 2 && compact(title) === cq) return 90;
  if (cq.length >= 3 && compact(title).includes(cq)) return 80;
  if (cq.length >= 3 && compact(host).includes(cq)) return 75;

  const words = query.split(" ").filter((w) => w.length >= 2);
  if (!words.length) return 0;
  const hay = `${title} ${url}`;
  const hits = words.filter((w) => hay.includes(w)).length;
  if (hits === words.length) return 60;
  return Math.round((hits / words.length) * 40);
}

/** Best tab for a query, or undefined when nothing scores ≥ 50. */
export function findTab(tabs: BrowserTab[], query: string): BrowserTab | undefined {
  let best: BrowserTab | undefined;
  let bestScore = 0;
  for (const tab of tabs) {
    const s = scoreTab(tab, query);
    if (s > bestScore) {
      best = tab;
      bestScore = s;
    }
  }
  return bestScore >= 50 ? best : undefined;
}

// ─── MCP backend ──────────────────────────────────────────────────────────────

/** Parse Playwright MCP `browser_tabs` markdown: "- 0: (current) [Title] (url)". */
export function parseMcpTabList(text: string): BrowserTab[] {
  const tabs: BrowserTab[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*-\s*(\d+):\s*(\(current\))?\s*\[(.*)\]\s*\(([^()\s]*)\)\s*$/);
    if (!m) continue;
    tabs.push({ id: m[1], current: !!m[2], title: m[3], url: m[4] });
  }
  return tabs;
}

/**
 * Calls an MCP tool by its bare method name (e.g. "browser_tabs") and returns
 * its text content. Resolution goes through knowhow's shared ToolsService, the
 * same way scripts' `sdk.callTool` does: registered MCP tools are namespaced
 * `mcp_<index>_<server>_<tool>`, and ToolsService picks the one whose name ends
 * with the requested method — so the server's name and position in
 * knowhow.json don't matter.
 */
export type McpToolCaller = (tool: string, args: Record<string, unknown>) => Promise<string>;

function mcpTimeoutMs(): number {
  return Number(process.env.KNOWHOW_VOICE_BROWSER_MCP_TIMEOUT_MS) || 4000;
}

/** Minimal slice of knowhow's ToolsService used here. */
export interface ToolsLike {
  getFunction(name: string): ((args: Record<string, unknown>) => unknown) | undefined;
}

function sharedTools(): ToolsLike {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const { services } = require("@tyvm/knowhow/ts_build/src/services");
  return services().Tools;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** Build a caller that resolves MCP methods by suffix on the given ToolsService. */
export function toolsMcpCaller(getTools: () => ToolsLike = sharedTools): McpToolCaller {
  return async (tool, args) => {
    const fn = getTools().getFunction(tool);
    if (!fn) throw new Error(`no MCP tool matching "${tool}" is loaded`);
    const timeout = mcpTimeoutMs();
    const result = await withTimeout<any>(Promise.resolve(fn(args)), timeout, tool);
    if (typeof result === "string") return result;
    const text = (result?.content || [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    if (result?.isError)
      throw new Error(text.split("\n").filter((l: string) => l && !l.startsWith("###"))[0] || `${tool} failed`);
    return text;
  };
}

const defaultMcpCaller: McpToolCaller = toolsMcpCaller();

export function mcpBackend(call: McpToolCaller): BrowserBackend {
  return {
    name: "mcp",
    async list() {
      return parseMcpTabList(await call("browser_tabs", { action: "list" }));
    },
    async select(tab) {
      await call("browser_tabs", { action: "select", index: Number(tab.id) });
    },
    async open(url) {
      await call("browser_tabs", { action: "new", url });
    },
    async close(tab) {
      await call("browser_tabs", { action: "close", index: Number(tab.id) });
    },
  };
}

// ─── AppleScript backend ──────────────────────────────────────────────────────

/** Runs an AppleScript and returns stdout. Injectable for tests (type shared from actions/osa). */
export type { OsaRunner };

const defaultOsa: OsaRunner = defaultOsaRunner(5000);

const CHROME = "Google Chrome";
const asString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function appleScriptBackend(osa: OsaRunner): BrowserBackend {
  return {
    name: "applescript",
    async list() {
      const out = await osa(`tell application ${asString(CHROME)}
  set sep to (ASCII character 9)
  set out to ""
  set wi to 0
  repeat with w in windows
    set wi to wi + 1
    set ai to active tab index of w
    set ti to 0
    repeat with t in tabs of w
      set ti to ti + 1
      set cur to "0"
      if wi is 1 and ti is ai then set cur to "1"
      set out to out & wi & ":" & ti & sep & cur & sep & (URL of t) & sep & (title of t) & linefeed
    end repeat
  end repeat
  return out
end tell`);
      return out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [id, cur, url = "", ...title] = line.split("\t");
          return { id, current: cur === "1", url, title: title.join("\t") };
        });
    },
    async select(tab) {
      const [w, t] = tab.id.split(":").map(Number);
      await osa(`tell application ${asString(CHROME)}
  set active tab index of window ${w} to ${t}
  set index of window ${w} to 1
  activate
end tell`);
    },
    async open(url) {
      await osa(`tell application ${asString(CHROME)}
  if (count of windows) is 0 then
    make new window
    set URL of active tab of window 1 to ${asString(url)}
  else
    tell window 1 to make new tab with properties {URL:${asString(url)}}
  end if
  activate
end tell`);
    },
    async close(tab) {
      const [w, t] = tab.id.split(":").map(Number);
      await osa(`tell application ${asString(CHROME)} to close tab ${t} of window ${w}`);
    },
  };
}

// ─── Backend selection ────────────────────────────────────────────────────────

let mcpCaller: McpToolCaller = defaultMcpCaller;
let osaRunner: OsaRunner = defaultOsa;
/** After an MCP failure, skip MCP until this time (ms epoch). */
let mcpDownUntil = 0;
const MCP_COOLDOWN_MS = 60_000;

/** Test hook. Pass undefined to restore the real runners. */
export function setBrowserRunners(mcp?: McpToolCaller, osa?: OsaRunner): void {
  mcpCaller = mcp ?? defaultMcpCaller;
  osaRunner = osa ?? defaultOsa;
  mcpDownUntil = 0;
}

type Log = { log(msg: string): void };

/**
 * Run `fn` against the MCP backend, falling back to AppleScript (macOS) when
 * MCP fails. A failing MCP is skipped for a minute so voice stays snappy.
 */
async function withBackend<T>(ctx: Log, fn: (b: BrowserBackend) => Promise<T>): Promise<T> {
  const mode = (process.env.KNOWHOW_VOICE_BROWSER || "auto").toLowerCase();
  const canOsa = process.platform === "darwin" || osaRunner !== defaultOsa;
  if (mode !== "applescript" && (mode === "mcp" || Date.now() >= mcpDownUntil)) {
    try {
      return await fn(mcpBackend(mcpCaller));
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      if (mode === "mcp" || !canOsa) throw e;
      mcpDownUntil = Date.now() + MCP_COOLDOWN_MS;
      ctx.log(`browser: MCP unavailable (${msg}); using AppleScript for the next minute`);
    }
  }
  return fn(appleScriptBackend(osaRunner));
}

async function activateChrome(): Promise<void> {
  try {
    await osaRunner(`tell application ${asString(CHROME)} to activate`);
  } catch {
    /* ignore */
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

function queryOf(ctx: { slots: Record<string, unknown>; text: string }): string {
  return normaliseTabQuery(String(ctx.slots?.query ?? ""));
}

const describe = (t: BrowserTab) => `"${t.title || t.url}"`;

/** Focus the best-matching tab; open one if `openIfMissing` and none matches. */
export async function switchToTab(
  ctx: Log & { slots: Record<string, unknown>; text: string },
  openIfMissing: boolean
): Promise<void> {
  const query = queryOf(ctx);
  if (!query) return ctx.log("browser: which tab?");
  await withBackend(ctx, async (b) => {
    const tab = findTab(await b.list(), query);
    if (tab) {
      await b.select(tab);
      ctx.log(`browser: switched to ${describe(tab)} (${b.name})`);
    } else if (openIfMissing) {
      const url = resolveTabUrl(query);
      await b.open(url);
      ctx.log(`browser: no tab matching "${query}" — opened ${url} (${b.name})`);
    } else {
      ctx.log(`browser: no tab matching "${query}"`);
      return;
    }
    if (b.name === "mcp") await activateChrome();
  });
}

export async function openNewTab(ctx: Log & { slots: Record<string, unknown>; text: string }): Promise<void> {
  const query = queryOf(ctx);
  if (!query) return ctx.log("browser: open what?");
  const url = resolveTabUrl(query);
  await withBackend(ctx, async (b) => {
    await b.open(url);
    ctx.log(`browser: opened ${url} (${b.name})`);
    if (b.name === "mcp") await activateChrome();
  });
}

export async function closeTab(ctx: Log & { slots: Record<string, unknown>; text: string }): Promise<void> {
  const query = queryOf(ctx);
  if (!query) return ctx.log("browser: close which tab?");
  await withBackend(ctx, async (b) => {
    const tab = findTab(await b.list(), query);
    if (!tab) return ctx.log(`browser: no tab matching "${query}"`);
    await b.close(tab);
    ctx.log(`browser: closed ${describe(tab)} (${b.name})`);
  });
}

export async function listTabs(ctx: Log): Promise<void> {
  await withBackend(ctx, async (b) => {
    const tabs = await b.list();
    ctx.log(`browser: ${tabs.length} tab(s) via ${b.name}`);
    for (const t of tabs) ctx.log(`  ${t.current ? "*" : " "} ${t.id}  ${t.title}  ${t.url}`);
  });
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const B = "[chrome|browser|google chrome]";

const command = pack({ prefix: "voice-control.browser.", defaults: { repeatable: false } });

export const BROWSER_PACK: VoiceCommandExtension[] = [
  command({
    name: "switch-tab",
    phrase: "switch tab {query:text}",
    patterns: [
      `switch [to] ${B} tab {query:text}`,
      `go to ${B} tab {query:text}`,
      `(chrome|browser) tab {query:text}`,
      `find tab {query:text}`,
    ],
    description:
      "Focus the Chrome tab matching a name (title, site or URL) via the browser MCP; opens it if none matches",
    run: (ctx) => switchToTab(ctx, true),
  }),
  command({
    name: "open-tab",
    phrase: "open tab {query:text}",
    patterns: [`open ${B} tab {query:text}`],
    description: "Focus the Chrome tab for a site if it's open, otherwise open it in a new tab",
    run: (ctx) => switchToTab(ctx, true),
  }),
  command({
    name: "new-tab-named",
    phrase: "open new tab {query:text}",
    patterns: [`open [a] new ${B} tab {query:text}`, `open ${B} new tab {query:text}`, `new ${B} tab {query:text}`],
    description: "Open a site / URL / search in a new Chrome tab via the browser MCP",
    run: (ctx) => openNewTab(ctx),
  }),
  command({
    name: "close-tab-named",
    phrase: "close chrome tab {query:text}",
    patterns: [`close (chrome|browser) tab {query:text}`, `close tab named {query:text}`],
    description: "Close the Chrome tab matching a name",
    run: (ctx) => closeTab(ctx),
  }),
  command({
    name: "list-tabs",
    phrase: "list tabs",
    patterns: [`(list|show) ${B} tabs`],
    description: "Log the open Chrome tabs (via the browser MCP)",
    run: (ctx) => listTabs(ctx),
  }),
];

export default BROWSER_PACK;
