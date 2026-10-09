/**
 * Browser pack: routing of "switch tab gmail" style phrases, tab matching,
 * and the MCP → AppleScript fallback.
 */

import { ModeRouter } from "../src/commandMode";
import { collectVoiceCommands, BUILTIN_VOICE_COMMANDS, VoiceCommandContext } from "../src/voiceCommands";
import { WINDOWS_PACK } from "../src/packs/windows";
import TEXT_PACK from "../src/packs/text";
import KEYS_PACK from "../src/packs/keys";
import META_PACK from "../src/packs/meta";
import GAZE_MOUSE_PACK from "../src/packs/gazeMouse";
import { SYSTEM_PACK } from "../src/packs/system";
import { HINTS_PACK } from "../src/hints/commands";
import { TMUX_PACK } from "../src/packs/tmux";
import {
  BROWSER_PACK, BrowserTab, findTab, normaliseTabQuery, parseMcpTabList,
  resolveTabUrl, createBrowserState, mcpCallerFrom,
} from "../src/packs/browser";
import { ToolsService } from "@tyvm/knowhow/sdk";
import { createTestServices } from "./helpers/services";
import type { VoiceServices } from "../src/services";

const MCP_LIST = `### Open tabs
- 0: [Hacker News] (https://news.ycombinator.com/)
- 1: (current) [Google] (https://www.google.com/)
- 2: [New device login detected — confirm it's you - micah@gmail.com - Gmail] (https://mail.google.com/mail/u/0/#inbox/abc)
- 3: [Machines | Knowhow] (https://knowhow.tyvm.ai/dashboard/machines)
`;

let mcpCalls: Array<[string, Record<string, unknown>]> = [];
let osaCalls: string[] = [];
let mcpFails = false;
let logs: string[] = [];
let services: VoiceServices;

async function fakeMcp(tool: string, args: Record<string, unknown>): Promise<string> {
  mcpCalls.push([tool, args]);
  if (mcpFails) throw new Error("initializeServer: Timeout");
  if (tool === "browser_tabs" && args.action === "list") return MCP_LIST;
  return "";
}

async function fakeOsa(script: string): Promise<string> {
  osaCalls.push(script);
  if (script.includes("repeat with w in windows")) {
    return "1:1\t0\thttps://news.ycombinator.com/\tHacker News\n1:2\t1\thttps://mail.google.com/mail/u/0/\tInbox (3)\n";
  }
  return "";
}

function makeRouter() {
  const commands = collectVoiceCommands({
    builtins: [
      ...BUILTIN_VOICE_COMMANDS, ...META_PACK.extensions, ...GAZE_MOUSE_PACK.extensions, ...TEXT_PACK.extensions,
      ...KEYS_PACK.extensions, ...WINDOWS_PACK.extensions, ...SYSTEM_PACK.extensions, ...HINTS_PACK.extensions, ...TMUX_PACK.extensions, ...BROWSER_PACK.extensions,
    ],
  });
  const dispatched: string[] = [];
  const router = new ModeRouter({
    commands,
    onRegisteredCommand: async (command, invocation) => {
      dispatched.push(command.name);
      const ctx: VoiceCommandContext = {
        phrase: command.phrase, text: invocation.text, spokenAt: 0, recognizedAt: 0,
        target: () => undefined, setMode: () => undefined, log: (m) => { logs.push(m); },
        slots: invocation.slots ?? {}, repeat: invocation.repeat ?? 1, history: [], services,
      };
      // Don't run unrelated commands (they'd press real keys).
      if (command.name.startsWith("voice-control.browser.")) await command.run(ctx);
    },
    onBuiltinCommand: async () => undefined,
    onUnmatched: () => undefined,
  } as any);
  return { router, dispatched };
}

async function say(text: string) {
  const { router, dispatched } = makeRouter();
  mcpCalls = [];
  osaCalls = [];
  logs = [];
  await router.routeCommandModeUtterance(text, "u", Date.now(), undefined, { recognizedAt: Date.now() });
  const actions = mcpCalls.filter(([, a]) => a.action !== "list");
  return { name: dispatched[0], actions };
}

beforeEach(() => {
  mcpFails = false;
  services = createTestServices({}, { state: { browser: createBrowserState({ mcp: fakeMcp, osa: fakeOsa }) } });
});

describe("browser pack routing", () => {
  test.each([
    ["switch tab gmail", "switch-tab", { action: "select", index: 2 }],
    ["Switch tab, Gmail.", "switch-tab", { action: "select", index: 2 }],
    ["switch to tab hacker news", "switch-tab", { action: "select", index: 0 }],
    ["switch tab hacker news", "switch-tab", { action: "select", index: 0 }],
    ["go to tab knowhow", "switch-tab", { action: "select", index: 3 }],
    ["chrome tab gmail", "switch-tab", { action: "select", index: 2 }],
    ["switch chrome tab machines", "switch-tab", { action: "select", index: 3 }],
    ["open chrome tab gmail", "open-tab", { action: "select", index: 2 }],
    ["open tab gmail", "open-tab", { action: "select", index: 2 }],
    ["open tab youtube", "open-tab", { action: "new", url: "https://www.youtube.com/" }],
    ["open new chrome tab gmail", "new-tab-named", { action: "new", url: "https://mail.google.com/" }],
    ["open new tab hacker news", "new-tab-named", { action: "new", url: "https://news.ycombinator.com/" }],
    ["new tab example dot com", "new-tab-named", { action: "new", url: "https://example.com" }],
    ["close chrome tab hacker news", "close-tab-named", { action: "close", index: 0 }],
  ])("%s", async (text, name, action) => {
    const r = await say(text);
    expect(r.name).toBe(`voice-control.browser.${name}`);
    expect(r.actions).toEqual([["browser_tabs", action]]);
  });

  test("existing tab commands still win without a name", async () => {
    expect((await say("new tab")).name).toBe("windows.new-tab");
    expect((await say("next tab")).name).toBe("windows.next-tab");
    expect((await say("open chrome")).name).toBe("windows.focus-app");
  });

  test("falls back to AppleScript when MCP fails, then skips MCP", async () => {
    mcpFails = true;
    const r = await say("switch tab gmail");
    expect(r.name).toBe("voice-control.browser.switch-tab");
    expect(logs.join("\n")).toMatch(/MCP unavailable/);
    expect(osaCalls.some((s) => s.includes("set active tab index of window 1 to 2"))).toBe(true);

    // Within the cooldown, MCP isn't tried again.
    await say("switch tab hacker news");
    expect(mcpCalls).toEqual([]);
    expect(osaCalls.some((s) => s.includes("set active tab index of window 1 to 1"))).toBe(true);
  });
});

describe("tab matching", () => {
  const tabs: BrowserTab[] = parseMcpTabList(MCP_LIST);

  test("parses Playwright MCP tab list", () => {
    expect(tabs).toHaveLength(4);
    expect(tabs[1]).toEqual({ id: "1", current: true, title: "Google", url: "https://www.google.com/" });
  });

  test.each([
    ["gmail", "2"],
    ["hacker news", "0"],
    ["hackernews", "0"],
    ["machines", "3"],
    ["knowhow", "3"],
    ["google", "1"],
  ])("%s → tab %s", (q, id) => {
    expect(findTab(tabs, normaliseTabQuery(q))?.id).toBe(id);
  });

  test("no match for unrelated query", () => {
    expect(findTab(tabs, "spotify")).toBeUndefined();
  });

  test("url resolution", () => {
    expect(resolveTabUrl("gmail")).toBe("https://mail.google.com/");
    expect(resolveTabUrl("localhost 3000")).toBe("http://localhost:3000/");
    expect(resolveTabUrl("news.ycombinator.com")).toBe("https://news.ycombinator.com");
    expect(resolveTabUrl("weather in denver")).toBe("https://www.google.com/search?q=weather%20in%20denver");
  });

  test("normalises filler", () => {
    expect(normaliseTabQuery("to the Gmail tab.")).toBe("gmail");
  });
});


describe("mcpCallerFrom (ToolsService.getFunction: resolve MCP method by suffix)", () => {
  function toolsWith(name: string, fn: (args: any) => unknown): ToolsService {
    const tools = new ToolsService();
    tools.defineTools(
      [{ type: "function", function: { name, description: "", parameters: { type: "object", properties: {} } } } as any],
      { [name]: fn },
    );
    return tools;
  }

  test("calls browser_tabs whatever the server's name/index", async () => {
    const calls: any[] = [];
    const tools = toolsWith("mcp_2_my-chrome_browser_tabs", (args) => {
      calls.push(args);
      return { content: [{ type: "text", text: "- 0: (current) [Inbox] (https://mail.google.com/)" }] };
    });
    const call = mcpCallerFrom(tools);
    const text = await call("browser_tabs", { action: "list" });
    expect(calls).toEqual([{ action: "list" }]);
    expect(parseMcpTabList(text)[0].url).toBe("https://mail.google.com/");
  });

  test("throws when no tool ends with the method (so AppleScript takes over)", async () => {
    const tools = toolsWith("mcp_0_other_something_else", () => "x");
    await expect(mcpCallerFrom(tools)("browser_tabs", {})).rejects.toThrow(/browser_tabs/);
  });

  test("surfaces MCP isError results as errors", async () => {
    const tools = toolsWith("mcp_0_browser_browser_tabs", () => ({
      isError: true, content: [{ type: "text", text: "### Error\nTab 9 not found" }],
    }));
    await expect(mcpCallerFrom(tools)("browser_tabs", {})).rejects.toThrow("Tab 9 not found");
  });
});
