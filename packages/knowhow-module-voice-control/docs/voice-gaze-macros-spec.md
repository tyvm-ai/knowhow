# Voice + Gaze Macros — Design Spec

Goal: say **"slice"** and the fruit you are *looking at* in the Fruit Ninja benchmark gets slashed.
More generally: voice "quick hooks" (command mode) that trigger instant actions using live gaze, and
automations (written by the ComputerUseAgent) that can read gaze and subscribe to spoken commands.

Work is split into three workstreams (A, B, C). A and B are independent and run in parallel against
the contracts below; C integrates both.

---------------------------------------------------------------------------------------------------
## Existing pieces (read these first)

- `packages/knowhow/src/services/ExtensionsService.ts` — generic, process-local registry:
  `register(owner, {type, ...})`, `list(type)`. Modules contribute via `KnowhowModule.extensions`
  (loaded in `packages/knowhow/src/services/modules/index.ts`). Only consumer today: `"chat"` in
  `CliChatService`. **This is the extension primitive we build on.**
- `packages/knowhow-module-computer-use/src/automation.ts` — `AutomationSDK`, `AutomationRunner`
  (builds `sdk`, runs scripts via `AsyncFunction`, `streamDisposers` cleanup, `RunOptions.toolsService`).
  Runner constructed in `src/tools/index.ts` (~L1247, ~L1271) and `src/cli.ts` (~L641).
- `packages/knowhow-module-voice-control/src/` — `audio/` (was `continuous.ts`: VAD + wake gating, emits
  `TranscriptEvent`s), `VoiceSession.ts` (routes finals to the agent), `command.ts`
  (`knowhow voice-agent` CLI), `eyeTracking.ts` (local server on 127.0.0.1:7465, `/api/gaze` GET/POST,
  `/api/correct`), `GazePlugin.ts`.
- `packages/knowhow-benchmarks/exercises/computer-use/fruit-ninja/` (server.js port 7434, index.html,
  prompt.md) and `.knowhow/automations/fruitNinjaFull.ts` (visual player using `sdk.trackObjects`).

---------------------------------------------------------------------------------------------------
## Contract 1 — Automation SDK extensions (owned by A, consumed by B and C)

Extension type string: **`"computer-use.automation-sdk"`**.

```ts
// exported from @tyvm/knowhow-module-computer-use (src/automationExtensions.ts)
export const AUTOMATION_SDK_EXTENSION = "computer-use.automation-sdk";

export interface AutomationExtensionContext {
  automationName: string;
  dryRun: boolean;
  signal: AbortSignal;                 // aborted when the run stops (any reason)
  isPaused(): boolean;                 // window-gate pause state
  log(data: unknown): void;            // same as sdk.log
  onDispose(fn: () => void | Promise<void>): void; // called when the run ends
  sdk: AutomationSDK;                  // the core sdk (for extensions that act, e.g. moveMouse)
}

export interface AutomationSdkExtension {
  type: "computer-use.automation-sdk";
  name: string;            // identifier; exposed as sdk.ext[name]. /^[A-Za-z_$][\w$]*$/
  description: string;     // one paragraph, shown to the agent
  typings?: string;        // TS declaration of the returned API, shown to the agent / docs
  create(ctx: AutomationExtensionContext): unknown | Promise<unknown>;
}
```

Runner behaviour:
- `RunOptions.extensions?: ExtensionsService` (or a resolver). tools/index.ts and cli.ts pass the
  services' `Extensions` (tools: from the ToolsService context / `services()`; fall back gracefully).
- `sdk.ext[name]` returns the extension API. Because `create()` may be async, either resolve all
  registered extensions eagerly-but-lazily (create on first access, return a Promise-aware proxy) or
  — simpler and preferred — pre-create every registered extension before the script starts, but make
  `create()` cheap by contract (no network until first method call). Results cached per run.
  Unknown name → throw a helpful error listing available extensions. Add
  `sdk.extensions(): {name, description}[]`.
- `onDispose` callbacks + `signal.abort()` run in the runner's `finally` alongside streamDisposers.
- Type for editors: `AutomationSDK.ext: AutomationExtensions & Record<string, any>` with an exported,
  empty, augmentable `interface AutomationExtensions {}` (declaration merging).
- Agent discoverability: automation docs/tool descriptions and ComputerUseAgent prompt mention
  `sdk.ext.*`; add a tool `computerUseListAutomationExtensions` (returns name, description, typings).
- Tests in `knowhow-module-computer-use/tests/` (creation, disposal, unknown-name error).

---------------------------------------------------------------------------------------------------
## Contract 2 — Gaze + voice hub on the eye-tracking server (owned by B)

The eye-tracking server (`knowhow eye-tracking`, 127.0.0.1:7465) is the cross-process hub, because the
voice session, the automation, and the gaze worker may be in different processes.

- `GET /api/gaze/history?sinceMs=<epoch ms>` → `{ samples: GazeSample[] }` from a ring buffer
  (keep ≥ 5 s of live samples). Only live samples are buffered.
- `POST /api/voice/command` (from voice-agent) body `VoiceCommandEvent` → broadcast.
- `POST /api/voice/register` body `{ phrases: VoiceCommandSpec[], owner: string, ttlMs?: number }` —
  automations announce phrases they handle (heartbeat re-post; expire after ttl, default 10 s). Lets
  the voice router know "slice" is live and bias STT with it. `POST /api/voice/unregister {owner}`.
- `GET /api/voice/commands` → currently registered phrases (voice-agent polls ~1 s).
- `GET /api/voice/events` → Server-Sent Events stream of `VoiceCommandEvent` and mode changes.
- Must stay cheap (no blocking work in handlers); keep `/api/health` fast.

```ts
export interface VoiceCommandSpec { phrase: string; aliases?: string[]; description?: string }
export interface VoiceCommandEvent {
  type: "voice.command";
  id: string;              // utterance id
  phrase: string;          // canonical matched phrase, e.g. "slice"
  text: string;            // full recognized text
  spokenAt: number;        // epoch ms of SPEECH ONSET (VAD) — the moment to read gaze at
  recognizedAt: number;    // epoch ms STT finished
  gaze?: GazeSample;       // gaze sample nearest spokenAt (filled by voice-agent from history)
}
```

## Contract 3 — Extensions contributed by voice-control (owned by B)

`voiceControlModule.extensions` registers two `computer-use.automation-sdk` extensions (define the
shape locally; do not take a hard dependency on computer-use):

`sdk.ext.gaze`
```ts
current(opts?: { maxAgeMs?: number }): Promise<GazeSample | null>; // fresh live sample or null
at(epochMs: number): Promise<GazeSample | null>;   // nearest buffered sample (history endpoint)
history(sinceMs: number): Promise<GazeSample[]>;
errorRadius(): { x: number; y: number };            // expected error px (config; default 200x260)
correct(target: {x: number; y: number}): Promise<void>; // POST /api/correct (confirmed target)
```
`sdk.ext.voice`
```ts
onCommand(spec: string | VoiceCommandSpec | Array<string|VoiceCommandSpec>,
          handler: (e: VoiceCommandEvent) => void | Promise<void>): () => void; // auto-registers
nextCommand(spec, opts?: { timeoutMs?: number }): Promise<VoiceCommandEvent | null>;
```
Implementation: SSE subscription to `/api/voice/events` + heartbeat `/api/voice/register` while
subscribed; everything torn down via `ctx.onDispose`/`ctx.signal`. Handlers are serialized per
subscription; errors are logged, not fatal. Ignore events older than 3 s. Hub URL from
`KNOWHOW_EYE_URL` env or config, default `http://127.0.0.1:7465`.

## Contract 4 — Voice modes and quick hooks (owned by B)

Modes: **command** and **agent**.
- Session starts in **command mode** (no agent running).
- Wake phrase ("hey knowhow …") → **agent mode**; remainder (if any) goes to the agent as today.
- In agent mode, all utterances go to the agent, EXCEPT exact mode/sleep commands:
  "command mode" → switch to command mode (agent keeps running but stops receiving speech);
  existing sleep commands keep working (and return to command mode).
- "agent mode" in command mode → agent mode.
- In command mode, utterances do **not** need the wake phrase and **are not sent to the agent**.
  They are matched against the command table; unmatched utterances are dropped (emit an event).
  Wake phrase is still detected in command mode to switch to agent mode.
- Matching: normalized lowercase, punctuation stripped, tolerant of Whisper variants
  ("eye control mouse" / "eyecontrol mouse" / "i control mouse"; "slice." "slice!") — alias list +
  small edit-distance tolerance for short phrases. Single-word commands must be allowed in command
  mode (bypass `minCommandWords`).
- Built-in quick hooks (implemented in voice-control using the in-process `context.ComputerUse`
  service; voice-agent already loads services):
  - "eye control mouse" / "gaze mouse" / "follow my eyes": start gaze-follow (poll `/api/gaze`
    ~30 Hz, smooth with EMA + dead-zone, moveMouse). "stop mouse" / "stop eye control": stop.
  - "click", "double click", "right click": click at current cursor if following, else at the gaze
    sample nearest `spokenAt`.
  - "command mode", "agent mode".
- Dynamic hooks: phrases registered on the hub by automations (poll `/api/voice/commands`). When one
  matches, POST a `VoiceCommandEvent` (with `gaze` looked up at `spokenAt`). Automation-registered
  phrases win over built-ins with the same phrase.
- Latency: add `--command-silence-ms` (default 350) used for endpointing while in command mode, and
  include registered + built-in phrases in the STT prompt. Record `spokenAt` from VAD onset.
- New session events: `mode.changed`, `command.matched`, `command.unmatched`. Show mode in the CLI.
- Tests for routing (fake transcript source), matching, and hub endpoints.

---------------------------------------------------------------------------------------------------
## Workstream C — "slice the fruit I'm looking at" eval (after A and B)

1. **Fruit Ninja gaze mode** (`fruit-ninja/server.js` + `index.html`): option `mode=gaze` with
   slower, configurable physics (`speed` multiplier, default 0.5, larger hang-time, fewer simultaneous
   fruit) so ~1 s voice latency is playable. `/api/slash` accepts optional
   `{ intendedFruitId, gaze:{x,y}, spokenAt, source }`; results report per-slash: hit?, hit the fruit
   nearest the gaze at spokenAt?, speech-onset→slash latency, gaze-to-fruit distance; summary:
   hits, misses, **intent accuracy**, median latency. Default (non-gaze) mode must be unchanged.
2. **Automation** `.knowhow/automations/fruitNinjaGazeSlice.ts`: reuse arena resolution + `trackObjects`
   from `fruitNinjaFull.ts`; keep a short per-track position history; `sdk.ext.voice.onCommand("slice")`
   → take `e.gaze` (or `sdk.ext.gaze.at(e.spokenAt)`), find the track whose position *at spokenAt* is
   nearest the gaze (anisotropic distance using `errorRadius()`, gate ~2.5σ), slash a long line through
   its predicted *current* position; if none, slash through the gaze point.
   Overlay: gaze dot + chosen fruit. Never auto-slash without a command. Log decisions.
3. **Synthetic harness** (CI-able, no human): a script that starts fruit-ninja gaze mode, runs the
   targeting, and simulates the user: live gaze samples near a chosen fruit (+ Gaussian noise
   matching measured error ~150–250 px) and `slice` commands with realistic `spokenAt` lag.
   Reports intent accuracy vs noise level. Add a benchmark exercise `fruit-ninja-gaze` with prompt.md
   describing both the live (human) protocol and the synthetic one.
4. Live protocol doc: start `knowhow eye-tracking`, Recenter, start `knowhow voice-agent`, run the
   automation, open the game in gaze mode, say "slice" while looking at fruit; results at `/api/results`.
