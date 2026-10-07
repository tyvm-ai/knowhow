import { convertDictation } from "../grammar/dictation";
import { defineVoicePack } from "../packs/define";
import { findAndAct } from "./act";
import { activateElement } from "./activate";
import { getAdapter, getErrorRadius, getFrontmostAppName, getWindowKey, resolveGazePoint } from "./context";
import { HINTS_CONFIG } from "./config";
import { density, stepDensity } from "./packState";
import { HintModeController, isHintModeRunning, stopHintMode } from "./hintMode";
import { refreshMap, stopMapWatch } from "./map";
import { HintsState, createHintsState } from "./packState";
import { collectCandidates } from "./perception/collect";
import { area } from "./geometry";
import { HintRef } from "./refs";
import { showHintsNear } from "./show";
import { SmartMouseController } from "./smartMouse";

// ─── Get hint ref from slots (slot value is a HintRef from grammar) ───────────

function hintRefFromSlots(slots: Record<string, unknown>): HintRef {
  const h = slots.hint;
  if (h && typeof h === "object") return h as HintRef;
  return {};
}

// ─── Command factory ──────────────────────────────────────────────────────────

/**
 * Vocabulary for this pack: "map" is accepted wherever a phrase says "hints"
 * ("hide map", "map all", "more map", "map off" …). Declared once here and
 * expanded when the patterns are compiled (see grammar/compile.ts).
 */
export const HINTS_SYNONYMS: Record<string, string[]> = { hints: ["map"] };

// ─── Pack definition ──────────────────────────────────────────────────────────

export const HINTS_PACK = defineVoicePack<HintsState, typeof HINTS_CONFIG>({
  name: "hints",
  config: HINTS_CONFIG,
  description: "Gaze + accessibility hints: label elements, click / hover / type by number or name",
  defaults: { repeatable: false, synonyms: HINTS_SYNONYMS },
  createState: (services) => createHintsState(services),
  // Timers and watchers stop with the session (hint mode, map watcher, smart mouse, overlay clear).
  onSessionStop: async ({ state }) => {
    state.mapWatch?.stop();
    state.mapWatch = null;
    state.stopSmartMouse();
    await stopHintMode(state);
    state.selector.dispose();
  },
  commands: ({ command }) => [
    // ── Show hints ──────────────────────────────────────────────────────────────
    command({
      name: "hints.show",
      phrase: "hints",
      patterns: ["hints", "show hints", "hints here", "show hint", "map it", "map this", "map page"],
      description:
        "Label every actionable element in the front window (full parse by default; 'fewer hints' for just the ones near your gaze). 'map' is a synonym",
      repeatable: false,
      run: async (ctx) => showHintsNear(ctx, false),
    }),

    command({
      name: "hints.show-all",
      phrase: "hints all",
      patterns: ["hints all", "show all hints", "hints window", "full hints", "reset hints"],
      description: "Label every actionable element in the window and make that the default again",
      repeatable: false,
      run: async (ctx) => {
        ctx.state.density = "all";
        await showHintsNear(ctx, true);
      },
    }),

    command({
      name: "hints.more",
      phrase: "more hints",
      patterns: ["more hints", "show more hints", "hints more", "more labels"],
      description: "Show more hints around your gaze (wider area, more labels); sticky for later 'hints'",
      repeatable: false,
      run: async (ctx) => showHintsNear(ctx, stepDensity(ctx.state, 1, ctx.config.density)),
    }),

    command({
      name: "hints.fewer",
      phrase: "fewer hints",
      patterns: [
        "fewer hints",
        "less hints",
        "hints less",
        "hints fewer",
        "show fewer hints",
        "show less hints",
        "few hints",
        "smaller hints",
      ],
      description: "Show only the few hints closest to your gaze; sticky for later 'hints'",
      repeatable: false,
      run: async (ctx) => showHintsNear(ctx, stepDensity(ctx.state, -1, ctx.config.density)),
    }),

    command({
      name: "hints.normal",
      phrase: "normal hints",
      patterns: ["normal hints", "hints normal"],
      description: "Switch to gaze-centred hints (about 15 labels near where you look)",
      repeatable: false,
      run: async (ctx) => {
        ctx.state.density = "normal";
        await showHintsNear(ctx, "normal");
      },
    }),

    command({
      name: "hints.refresh",
      phrase: "refresh map",
      patterns: ["refresh map", "refresh hints", "update hints", "reload hints", "remap"],
      description: "Re-parse the window and redraw the map now (numbers of unchanged elements stay the same)",
      repeatable: false,
      run: async (ctx) => refreshMap(ctx),
    }),

    command({
      name: "hints.hide",
      phrase: "hide hints",
      patterns: ["hide hints", "clear hints", "no hints", "hints off", "close hints"],
      description: "Remove the hint labels",
      repeatable: false,
      run: async (ctx) => {
        if (isHintModeRunning(ctx.state)) {
          await stopHintMode(ctx.state);
          ctx.log("[hints] Hint mode OFF");
        }
        stopMapWatch(ctx.state);
        ctx.state.selector.clearHintState();
        await getAdapter(ctx)
          ?.clearOverlay()
          .catch(() => undefined);
      },
    }),

    command({
      name: "hints.mode",
      phrase: "hint mode",
      patterns: ["hint mode", "hints mode", "hint mode on", "hints on", "follow hints", "live hints"],
      description:
        "Keep hint labels on near wherever you look (they refresh as your gaze settles somewhere new); 'hide hints' or 'hint mode off' to stop",
      repeatable: false,
      run: (ctx) => {
        if (isHintModeRunning(ctx.state)) {
          ctx.log("[hints] Hint mode already ON");
          return;
        }
        stopMapWatch(ctx.state);
        ctx.state.hintMode = new HintModeController(ctx);
        ctx.state.hintMode.start();
        ctx.log(
          "[hints] Hint mode ON — labels follow your gaze; say 'click <text>', 'mouse over text 3', 'hint mode off'"
        );
      },
    }),

    command({
      name: "hints.mode-off",
      phrase: "hint mode off",
      patterns: ["hint mode off", "hints mode off", "stop hint mode", "exit hint mode"],
      description: "Stop hint mode and remove the labels",
      repeatable: false,
      run: async (ctx) => {
        await stopHintMode(ctx.state);
        stopMapWatch(ctx.state);
        ctx.state.selector.clearHintState();
        await getAdapter(ctx)
          ?.clearOverlay()
          .catch(() => undefined);
        ctx.log("[hints] Hint mode OFF");
      },
    }),

    // ── Click — plain gaze click (no hint) ─────────────────────────────────────
    // "click" alone stays a gaze click. "click {hint}" routes to the hint click below.
    // NOTE: This command is defined in the gazeMouse pack. We do NOT redefine it here.
    // The hints.click-hint below handles "click <hint>" via grammar pattern.

    // ── Click with hint ─────────────────────────────────────────────────────────
    command({
      name: "hints.click-hint",
      phrase: "click hint",
      patterns: ["click {hint:hintphrase}", "click on {hint:hintphrase}"],
      description: "Click a specific element by hint: 'click button 2', 'click save', 'click link 3'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        await findAndAct(ctx, ref, "click");
      },
      maxAudioMs: 10000,
    }),

    // ── Move the mouse to a hint (no click) ─────────────────────────────────────
    command({
      name: "hints.hover-hint",
      phrase: "hover hint",
      patterns: [
        "hover over {hint:hintphrase}",
        "hover {hint:hintphrase}",
        "mouse over {hint:hintphrase}",
        "mouse to {hint:hintphrase}",
        "move mouse to {hint:hintphrase}",
        "move the mouse to {hint:hintphrase}",
        "move cursor to {hint:hintphrase}",
        "move to {hint:hint}",
        "point at {hint:hintphrase}",
      ],
      description:
        "Move the mouse onto an element without clicking: 'hover button 2', 'mouse to text 3', 'move to save'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        await findAndAct(ctx, ref, "hover");
      },
      maxAudioMs: 10000,
    }),

    // ── Select / focus ──────────────────────────────────────────────────────────
    command({
      name: "hints.select-hint",
      phrase: "select hint",
      patterns: ["select {hint:hint}", "focus {hint:hint}"],
      description: "Focus/select a specific element: 'select input 2', 'select field', 'focus button'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        await findAndAct(ctx, ref, "focus");
      },
    }),

    // ── Type in a specific field (role+number or name) ──────────────────────────
    command({
      name: "hints.type-in",
      phrase: "type in hint",
      patterns: ["type in {hint:hint} {text:text}", "type {hint:hint} {text:text}"],
      description: "Type text into a specific field: 'type in input 2 hello world', 'type message hello'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        const text = (ctx.slots.text as string | undefined) ?? "";

        if (!ref.roleName && !ref.name && !ref.index) {
          // Shouldn't happen with grammar routing, but guard it
          ctx.log("[hints] Usage: type in <field> <text>");
          return;
        }

        // If ref has a name, try to find a matching input field near gaze.
        // If no field found with that name, fall back to typing the whole text
        // (treating the name as part of the text was a plain "type" command).
        if (ref.name && !ref.roleName && !ref.index) {
          const adapter = getAdapter(ctx);
          if (adapter) {
            const gaze = ctx.gaze ?? ctx.target?.();
            if (gaze) {
              const errorRadius = getErrorRadius();
              const windowKey = getWindowKey(ctx);
              const candidates = await collectCandidates(
                ctx.state.selector,
                adapter,
                { x: gaze.x, y: gaze.y },
                errorRadius,
                windowKey,
                {
                  query: ref.name.split(/\s+/),
                  source: ctx.config.source,
                }
              );
              const inputCandidates = candidates.filter(
                (c) =>
                  ["input", "select"].includes(c.roleName) &&
                  ((c.element.title ?? "").toLowerCase().includes(ref.name!.toLowerCase()) ||
                    (c.element.description ?? "").toLowerCase().includes(ref.name!.toLowerCase()) ||
                    (c.displayName ?? "").toLowerCase().includes(ref.name!.toLowerCase()))
              );
              if (inputCandidates.length) {
                // Found a field — focus it and type the text
                await findAndAct(ctx, ref, "focus", { typeText: text });
                return;
              }
            }
          }
          // No field found — fall back: type the full original text (name + text combined)
          // This handles: "type message hello" when no "message" field exists → types "message hello"
          // Apply the same dictation conversion as the plain `type` command so
          // spoken punctuation ("new line", "comma", …) works here too.
          const joined = [ref.name, text]
            .filter(Boolean)
            .join(" ")
            .replace(/^["\u201C](.+?)["\u201D]$/, "$1")
            .replace(/\.$/, "")
            .trim();
          const fullText = convertDictation(joined);
          ctx.log(`[hints] No field named "${ref.name}" near gaze — typing full text: "${fullText}"`);
          if (ctx.actions) {
            await ctx.actions.typeText(fullText);
          } else if (ctx.mouse) {
            // Best effort: use typeText via platform
            ctx.log(`[hints] No platform actions available to type text`);
          }
          return;
        }

        // Role or index reference — go straight to findAndAct
        await findAndAct(ctx, ref, "focus", { typeText: text });
      },
    }),

    // ── Bare hint (role+number only, to avoid stealing plain words) ─────────────
    // "button 2", "input 3", "link 1" alone — role MUST be present, number is required
    // to prevent single role words ("button") stealing unrelated commands.
    command({
      name: "hints.bare-hint",
      phrase: "hint",
      patterns: ["{hint:hintref}"],
      description: "Act on a hint by role+number alone: 'button 2', 'input 1', 'link 3'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        // For bare hint, require either a number or a name (not just a bare role word)
        // to avoid false triggers on single role words that might appear in other speech.
        if (!ref.index && !ref.name) {
          // Just a bare role word — show hints and wait
          await showHintsNear(ctx, false, ref.roleName ? [ref.roleName] : []);
          return;
        }
        await findAndAct(ctx, ref, "click");
      },
    }),

    // ── Links ───────────────────────────────────────────────────────────────────
    command({
      name: "hints.open-link",
      phrase: "open link hint",
      patterns: [
        "open {hint:hint} in new tab",
        "open link {hint:hint} in new tab",
        "open {hint:hint}",
        "open link {hint:hint}",
        "link {hint:hint}",
      ],
      description: "Open a link: 'link 3', 'open link 3', 'open link 3 in new tab'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        // Force role to "link" if not set
        const linkRef: HintRef = { ...ref, roleName: ref.roleName ?? "link" };
        const newTab = /\bin\s+new\s+tab\b/i.test(ctx.text);
        await findAndAct(ctx, linkRef, "click", { newTab });
      },
    }),

    // ── Checkbox ────────────────────────────────────────────────────────────────
    command({
      name: "hints.check",
      phrase: "check hint",
      patterns: ["check {hint:hint}", "toggle {hint:hint}"],
      aliases: ["check box", "check checkbox", "toggle check"],
      description: "Toggle a checkbox near gaze: 'check box 1', 'check 2'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        const checkRef: HintRef = { ...ref, roleName: ref.roleName ?? "check" };
        await findAndAct(ctx, checkRef, "check");
      },
    }),

    // ── Right click ─────────────────────────────────────────────────────────────
    command({
      name: "hints.right-click",
      phrase: "right click hint",
      patterns: ["right click {hint:hintphrase}"],
      description: "Right-click a hint reference: 'right click button 2', 'right click save'",
      run: async (ctx) => {
        const ref = hintRefFromSlots(ctx.slots);
        await findAndAct(ctx, ref, "rightClick");
      },
    }),

    // ── Navigation ──────────────────────────────────────────────────────────────
    command({
      name: "hints.next",
      phrase: "next hint",
      patterns: ["next hint", "next"],
      aliases: ["next hint"],
      description: "Move selection to the next hint candidate",
      repeatable: false,
      run: (ctx) => {
        const state = ctx.state.selector.getHintState();
        if (!state || !state.candidates.length) {
          ctx.log("[hints] No hints active");
          return;
        }
        state.selectedIndex = (state.selectedIndex + 1) % state.candidates.length;
        ctx.log(`[hints] Selected: ${state.candidates[state.selectedIndex].label}`);
      },
    }),

    command({
      name: "hints.previous",
      phrase: "previous hint",
      patterns: ["previous hint", "previous", "prev hint", "prev"],
      aliases: ["prev", "previous hint", "prev hint"],
      description: "Move selection to the previous hint candidate",
      repeatable: false,
      run: (ctx) => {
        const state = ctx.state.selector.getHintState();
        if (!state || !state.candidates.length) {
          ctx.log("[hints] No hints active");
          return;
        }
        state.selectedIndex = (state.selectedIndex - 1 + state.candidates.length) % state.candidates.length;
        ctx.log(`[hints] Selected: ${state.candidates[state.selectedIndex].label}`);
      },
    }),

    // ── Smart mouse ─────────────────────────────────────────────────────────────
    command({
      name: "hints.smart-mouse",
      phrase: "smart mouse",
      patterns: ["smart mouse", "magnetic cursor", "snap mouse"],
      description: "Start gaze-following mode that snaps the cursor to the nearest element",
      repeatable: false,
      run: async (ctx) => {
        if (ctx.state.smartMouse?.isRunning()) {
          ctx.log("[hints] Smart mouse already running");
          return;
        }
        const adapter = getAdapter(ctx);
        if (!adapter) {
          ctx.log("[hints] No computer-use adapter available for smart mouse");
          return;
        }
        ctx.state.selector.invalidateAXCache();
        ctx.state.smartMouse = new SmartMouseController(adapter, () => getWindowKey(ctx), {
          errorRadius: getErrorRadius(),
          clock: ctx.services.clock,
          selector: ctx.state.selector,
          source: () => ctx.config.source,
        });
        ctx.state.smartMouse.start();
        ctx.log("[hints] Smart mouse started — say 'stop mouse' to stop");
      },
    }),

    command({
      name: "hints.stop-smart-mouse",
      phrase: "stop smart mouse",
      patterns: ["stop smart mouse"],
      description: "Stop the smart mouse gaze-follow controller",
      repeatable: false,
      run: (ctx) => {
        if (ctx.state.smartMouse?.isRunning()) {
          ctx.state.smartMouse.stop();
          ctx.state.smartMouse = null;
          ctx.log("[hints] Smart mouse stopped");
        } else {
          ctx.log("[hints] Smart mouse was not running");
          ctx.gazeFollow?.stop();
        }
      },
    }),

    // ── play <song> — AXPress the "Play <song> by …" button ─────────────────────
    // "play a real hero", "play rubber head", "click play a real hero"
    // Bare "play" and "pause" are media keys (handled elsewhere); this command
    // only fires when at least one song-name word follows "play".
    command({
      name: "hints.play-song",
      phrase: "play song",
      patterns: ["play {song:songphrase}", "click play {song:songphrase}"],
      description:
        "Play a track by name: 'play a real hero', 'click play rubber head'. The front app's adapter finds the play button and it is AXPressed.",
      run: async (ctx) => {
        const adapter = getAdapter(ctx);
        if (!adapter) {
          ctx.log("[hints] No computer-use adapter available");
          return;
        }
        const gaze = await resolveGazePoint(ctx, adapter);
        // Extract song name from slot or from text
        const songSlot = ctx.slots.song;
        let songQuery: string[];
        if (songSlot && typeof songSlot === "object" && "name" in (songSlot as any)) {
          const ref = songSlot as { name?: string; roleName?: string };
          songQuery = (ref.name ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        } else if (typeof songSlot === "string") {
          songQuery = (songSlot as string).toLowerCase().split(/\s+/).filter(Boolean);
        } else {
          // Parse song name from raw text: strip leading "play " or "click play "
          const raw = ctx.text
            .toLowerCase()
            .replace(/^click\s+/, "")
            .replace(/^play\s+/, "")
            .trim();
          songQuery = raw.split(/\s+/).filter(Boolean);
        }
        if (!songQuery.length) {
          ctx.log("[hints] No song name provided");
          return;
        }
        ctx.log(`[hints] Looking for play button for: "${songQuery.join(" ")}"`);
        // The front app's adapter knows how to find "play <name>" (media apps); any adapter that can will do.
        const app = await getFrontmostAppName(ctx);
        const playAdapter =
          ctx.services.adapters.find(app, "playTarget") ??
          ctx.services.adapters.list().find((a) => a.playTarget);
        const candidate = await playAdapter?.playTarget?.(songQuery, gaze ?? { x: 960, y: 540 }, ctx.services);
        if (!candidate) {
          ctx.log(`[hints] No play button found for "${songQuery.join(" ")}"`);
          return;
        }
        ctx.log(`[hints] Pressing play: ${candidate.displayName ?? candidate.label}`);
        await activateElement(adapter, candidate, "click", {
          pointer: ctx.services.pointer,
          clock: ctx.services.clock,
        });
        ctx.state.hintMode?.refreshSoon();
      },
      maxAudioMs: 12000,
    }),

    // "click that" / "double click that" live in voiceCommands.ts (click-that,
    // double-click); the latter keeps the remembered-element behaviour.
  ],
});
