# Voice-control architecture

How the module is put together. Everything below lives in `src/`; the shipped behaviour is described in the
[README](../README.md).

```
heard text ──► normalise ──► match ──► (matched-stage check) ──► run command
                 │             │                │                    │
          pack normalisers   grammar        recoverers          pack command
                                  └── no match ──► recoverers (unmatched stage) ──► rewrite / ask / latch
```

`src/pipeline.ts` is that flow. `VoiceSession` uses it live, `voice-control parse` / `replay` and the replay
corpus test use `resolveUtterance` — so they cannot disagree.

## Layout

| Path | What |
|---|---|
| `VoiceSession.ts`, `commandMode.ts` | the session: transcript → mode router → command / agent; lifecycle |
| `pipeline.ts`, `replay.ts` | normalise → match → recover as one function; replay corpus + decision-log exporter |
| `grammar/` | tokeniser, normaliser (`registerNormaliser`), pattern compiler, slot types, chains, dictation |
| `commands/` | `defineCommand`, registry (conflict detection, `overrides`, synonyms) |
| `packs/` | command packs (`defineVoicePack`): meta, gaze-mouse, text, keys, windows, system, tmux, browser, smart-type, app-name |
| `hints/` | the hints pack and everything under it (see below) |
| `services/` | `VoiceServices` container: platform, gaze, pointer, pending, typing, learned, latch, config, store, clock, logger |
| `config/` | config schema + the one resolver (`env > knowhow.json > default`) |
| `recovery/` | `IntentRecoverer` extension point, `RecoveryEngine` (the one policy), learned store, latch |
| `targeting/`, `adapters/` | `TargetResolver` (where click lands) and `AppAdapter`s (Spotify, Chrome DOM) |
| `audio/` | continuous capture: sox backend, VAD / noise floor, WAV, recogniser, preflight |
| `contributions.ts` | third-party extension points (`voice-control.app-adapter`, `voice-control.pack`) |
| `static/`, `../python/` | eye-tracking page assets and the Python worker (copied to `ts_build` by `npm run compile`) |

### `hints/`

Pure (no I/O): `types`, `roles`, `geometry`, `ranking`, `labels` (stabilise / dedupe / reading order), `refs`
(`parseHintRef`, `resolveHintRef`), `density`. I/O: `perception/{ax,collect,visual}` (accessibility + OCR scans; the
DOM provider is the Chrome adapter), `overlay`, `map` (MapWatcher + map memory), `activate`, `smartMouse`,
`hintMode`, `show`, `act`, and `commands` (the pack). `hints/index.ts` is the public surface.

## Packs

A pack is a named bundle of commands with per-session state, settings, slot types, synonyms, normaliser rules,
recoverers and lifecycle hooks:

```ts
export const COUNTER_CONFIG = {
  start: configField({ default: 0, env: "KNOWHOW_COUNTER_START", parse: numberAtLeast(0), description: "First number" }),
};

export const COUNTER_PACK = defineVoicePack<{ count: number }, typeof COUNTER_CONFIG>({
  name: "counter",
  prefix: "voice-control.counter.",
  config: COUNTER_CONFIG,
  createState: () => ({ count: 0 }),
  commands: ({ command }) => [
    command({
      name: "bump",
      patterns: ["bump counter"],
      description: "Increment the counter",
      run: (ctx) => { ctx.state.count++; ctx.services.log.child("counter").info(`${ctx.config.start + ctx.state.count}`); },
    }),
  ],
});
```

Shipped packs are listed once, in `packs/index.ts` (`allPacks()`); add yours there. Commands get
`ctx.services` (the container), `ctx.state` (the pack's state) and `ctx.config` (its settings).

### Third-party contributions

A module can contribute through core's extension registry (`defineExtensionPoint`, validated at registration and again
when a session starts):

- `voice-control.command` — one command
- `voice-control.pack` — a whole pack: `{ type: VOICE_PACK_EXTENSION, ...defineVoicePack({...}) }` or `packExtension(pack)`
- `voice-control.app-adapter` — an `AppAdapter`: `adapterExtension({ name, app: /regex/, ... })` (name + app regex required, unique name)

`VoiceSession` registers contributed adapters on `services.adapters`, runs contributed packs' lifecycle, adds their
recoverers to the engine and registers their slots / normaliser rules.

## Services

`createVoiceServices(overrides)` builds the container (one per session). Tests pass fakes
(`tests/helpers/services.ts`) instead of calling `set*()` hooks. Timers go through `services.clock`, logs through
`services.log` (`[tag] msg`, levels, `log.child("hints")`); helper code without a services handle uses
`taggedLogger(tag, sink?)`. Long lists in log lines are trimmed by `formatList` ("first 60 … +N more").

## Recoverers

"Whisper heard something close to a command": a pack contributes `recoverers` (tmux mishears, app names, …). The
`RecoveryEngine` applies one policy — run on high confidence / trusted app / learned, otherwise ask "did you mean …?",
learn on "yes". Learned data is `{ [recoverer]: string[] }` in `~/.knowhow/voice/learned.json`.

## Adapters and targeting

`TargetResolver` decides where click / double-click / right-click act (hint, pointer memory, gaze, gaze-follow, per
policy). Everything app-specific is an `AppAdapter` (`activate`, `labelFor`, `extraElements`, `candidateFilter`,
`playTarget`) consulted by front app.

## Configuration

Every setting is declared with a default, an optional env override and a parser; one resolver (`config/resolver.ts`)
applies `env > knowhow.json > default` **when the value is used**, so changes apply mid-session. Nothing else reads
`process.env.KNOWHOW_*`.

```json
{
  "voiceControl": {
    "packs": { "hints": { "density": "few", "mapRefreshMs": 0 }, "browser": { "backend": "applescript" } },
    "services": { "gaze": { "url": "http://127.0.0.1:7465" }, "log": { "level": "debug" } }
  }
}
```

`knowhow voice-control config [--json]` prints every effective value, its source and the env var that overrides it.
(The older `voiceControl.smartType` / `voiceControl.agentType` / `voiceControl.eyeTracking.python` keys still work.)

Runtime state (learned intents, app aliases) lives under `~/.knowhow/voice/` behind `services.store`
(`VoiceStore`: `file`, `readJson` / `writeJson`, in-session `memory()` such as the per-app map memory).

## Replay corpus

`tests/fixtures/utterances/*.jsonl`: one row per line, `{ heard, alternatives?, frontApp?, runningApps?, previous?,
expected: { command?, slots?, recovered?, rejected? } }`. `tests/replayCorpus.test.ts` runs every row through the
pipeline. Append a row to turn a live bug into a regression test.

```
knowhow voice-control parse "too much love." --app Ghostty     # the live pipeline, one utterance
knowhow voice-control replay corpus.jsonl [--json]             # corpus rows, or a commands.jsonl decision log
knowhow voice-control replay ~/.cache/knowhow/voice/commands.jsonl --export > new-rows.jsonl
```

## Development

```
npx tsc --noEmit -p . && npx jest        # tests are parallel-safe (no module-level state)
npm run compile                          # tsc + copy static/ and python/ to ts_build
```
