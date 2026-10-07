/**
 * tmux pack: routing of spoken phrases + the tmux CLI calls they make.
 */

import { ModeRouter } from "../src/commandMode";
import { collectVoiceCommands, BUILTIN_VOICE_COMMANDS, VoiceCommandContext } from "../src/voiceCommands";
import { WINDOWS_PACK } from "../src/packs/windows";
import TEXT_PACK from "../src/packs/text";
import KEYS_PACK from "../src/packs/keys";
import META_PACK from "../src/packs/meta";
import GAZE_MOUSE_PACK from "../src/packs/gazeMouse";
import { SYSTEM_PACK } from "../src/packs/system";
import { TMUX_PACK, setTmuxRunners, isVimCommand } from "../src/packs/tmux";

let tmuxCalls: string[][] = [];
let shellCalls: string[] = [];
let paneCommand = "bash";

function fakeTmux(args: string[]): Promise<string> {
  tmuxCalls.push(args);
  const [sub] = args;
  if (sub === "list-clients") {
    return Promise.resolve("100\t/dev/ttys001\told\n200\t/dev/ttys002\tknowhow\n");
  }
  if (sub === "display-message") {
    const fmt = args[args.length - 1];
    if (fmt.includes("pane_current_command")) return Promise.resolve(`%13\t${paneCommand}\n`);
    if (fmt.includes("pane_current_path")) return Promise.resolve("/Users/micah/dev/knowhow\n");
    if (fmt.includes("window_index")) return Promise.resolve("knowhow:4\n");
  }
  if (sub === "list-keys") {
    return Promise.resolve(`bind-key -T prefix N run-shell "/Users/micah/dev/tmux-pane-tabs/pane-tabs.sh next '#{pane_id}'"\n`);
  }
  return Promise.resolve("");
}

function makeRouter() {
  const commands = collectVoiceCommands({
    builtins: [
      ...BUILTIN_VOICE_COMMANDS, ...META_PACK, ...GAZE_MOUSE_PACK, ...TEXT_PACK,
      ...KEYS_PACK, ...WINDOWS_PACK, ...SYSTEM_PACK, ...TMUX_PACK,
    ],
  });
  const dispatched: string[] = [];
  const router = new ModeRouter({
    commands,
    onRegisteredCommand: async (command, invocation) => {
      dispatched.push(command.name);
      const ctx: VoiceCommandContext = {
        phrase: command.phrase, text: invocation.text, spokenAt: 0, recognizedAt: 0,
        target: () => undefined, setMode: () => undefined, log: () => undefined,
        slots: invocation.slots ?? {}, repeat: invocation.repeat ?? 1, history: [],
      };
      await command.run(ctx);
    },
    onBuiltinCommand: async () => undefined,
    onUnmatched: () => undefined,
  } as any);
  return { router, dispatched };
}

async function say(text: string) {
  const { router, dispatched } = makeRouter();
  tmuxCalls = [];
  shellCalls = [];
  await router.routeCommandModeUtterance(text, "u", Date.now(), undefined, { recognizedAt: Date.now() });
  // The last call is the action (earlier ones resolve the target).
  const action = tmuxCalls.filter((c) => !["list-clients", "display-message", "list-keys"].includes(c[0]));
  return { name: dispatched[0], action, shell: shellCalls };
}

beforeEach(() => {
  paneCommand = "bash";
  setTmuxRunners(fakeTmux, async (c) => { shellCalls.push(c); });
});
afterAll(() => setTmuxRunners());

describe("tmux pack", () => {
  test.each([
    ["tmux left", ["select-pane", "-t", "%13", "-L"]],
    ["Tmux right.", ["select-pane", "-t", "%13", "-R"]],
    ["tmux up", ["select-pane", "-t", "%13", "-U"]],
    ["tea mux down", ["select-pane", "-t", "%13", "-D"]],
    // Real whisper mishears of "tmux left/right" from the command log.
    ["too much left.", ["select-pane", "-t", "%13", "-L"]],
    ["teammates left.", ["select-pane", "-t", "%13", "-L"]],
    ["two mouse left.", ["select-pane", "-t", "%13", "-L"]],
    ["two mouse right.", ["select-pane", "-t", "%13", "-R"]],
    ["two months left.", ["select-pane", "-t", "%13", "-L"]],
    ["two mux up.", ["select-pane", "-t", "%13", "-U"]],
    ["tea much right.", ["select-pane", "-t", "%13", "-R"]],
    ["tmux write.", ["select-pane", "-t", "%13", "-R"]],
    ["too much zoom", ["resize-pane", "-Z", "-t", "%13"]],
    ["pane left", ["select-pane", "-t", "%13", "-L"]],
    ["tmux zoom", ["resize-pane", "-Z", "-t", "%13"]],
    ["zoom pane", ["resize-pane", "-Z", "-t", "%13"]],
    ["tmux tab next", ["next-window", "-t", "knowhow"]],
    ["tmux next tab", ["next-window", "-t", "knowhow"]],
    ["tmux previous tab", ["previous-window", "-t", "knowhow"]],
    ["tmux tab 9", ["select-window", "-t", "knowhow:9"]],
    ["tmux tab nine", ["select-window", "-t", "knowhow:9"]],
    ["tmux tap 3", ["select-window", "-t", "knowhow:3"]],
    ["tmux pane 2", ["select-pane", "-t", "knowhow:4.2"]],
    ["tmux resize left 3", ["resize-pane", "-t", "%13", "-L", "15"]],
    ["tmux split right", ["split-window", "-h", "-t", "%13", "-c", "/Users/micah/dev/knowhow"]],
    ["tmux interrupt", ["send-keys", "-t", "%13", "C-c"]],
  ])("%s", async (text, expected) => {
    const r = await say(text);
    expect(r.name).toMatch(/^voice-control\.tmux\./);
    expect(r.action).toEqual([expected]);
  });

  test("targets the most recently active client", async () => {
    await say("tmux zoom");
    expect(tmuxCalls[1]).toEqual(["display-message", "-p", "-c", "/dev/ttys002", "#{pane_id}\t#{pane_current_command}"]);
  });

  test("directional moves go to vim when vim is focused (vim-tmux-navigator)", async () => {
    paneCommand = "nvim";
    const r = await say("tmux left");
    expect(r.action).toEqual([["send-keys", "-t", "%13", "C-h"]]);
  });

  test("pane tabs run the tmux-pane-tabs binding with the real pane id", async () => {
    const r = await say("tmux pane tab next");
    expect(r.name).toBe("voice-control.tmux.pane-tab-next");
    expect(r.shell).toEqual(["/Users/micah/dev/tmux-pane-tabs/pane-tabs.sh next '%13'"]);
  });

  test("plain 'tab 3' still presses Tab / switches app tabs, not tmux", async () => {
    const r = await say("tab 3");
    expect(r.name).not.toMatch(/tmux/);
  });

  test("isVimCommand", () => {
    expect(isVimCommand("nvim")).toBe(true);
    expect(isVimCommand("vim")).toBe(true);
    expect(isVimCommand("bash")).toBe(false);
    expect(isVimCommand("node")).toBe(false);
  });
});
