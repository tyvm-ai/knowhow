# Knowhow voice control

Voice control is a transport around an existing interactive Knowhow agent. It owns microphone capture, local voice activity detection (VAD), final-utterance transcription, speech playback, and barge-in; the selected agent continues to own reasoning, models, tools, and computer use.

## Architecture

Packs, services, recoverers, app adapters, configuration and the replay corpus are described in [docs/architecture.md](docs/architecture.md).
`knowhow voice-control config` prints every setting and where its value came from; `knowhow voice-control replay <file>` replays recorded utterances.

## Configure and build

Register the module in the project configuration at `./.knowhow/knowhow.json`, or in the global configuration at `~/.knowhow/knowhow.json`:

```json
{
  "modules": ["@tyvm/knowhow-module-voice-control"]
}
```

For reproducible harnesses and model comparisons, the one-shot and live commands
accept explicit reasoning-model overrides without changing project config:

```bash
knowhow voice-control --once "Look at this game and beat all 10 rounds" \
  --agent ComputerUseAgent --model gpt-5.6-luna --provider openai
```


When developing from this repository, build core before the module:

```bash
npm run compile -w @tyvm/knowhow
npm run compile -w @tyvm/knowhow-module-voice-control
```

The module registers both `knowhow voice-control` and its equivalent alias, `knowhow voice-agent`, during the module registration phase before CLI parsing. Module `init()` has no command-registration side effects.

## Webcam eye tracking

Run `knowhow eye-tracking`. Without a trained model it opens the local training
page; with one, the native tracker starts directly (open the printed URL to train
more — this stops the worker so the browser can use the camera).

### Training (per monitor, combined into one desktop model)

1. The page lists every monitor (via the Window Management / `getScreenDetails`
   permission) as **Monitor 1..N**, with its label, resolution, desktop position,
   and whether it is trained. Click **Train Monitor N**; the page goes fullscreen on
   exactly that monitor and the banner reads `TRAINING MONITOR N of M · <label>`.
2. First visit: a 9-dot quick calibration builds the initial model.
3. Then continuous training: dots appear at random positions. Just look at each
   one — no clicking. Before learning from a dot, the page measures how far the
   prediction was off, then adds the samples and refits. The HUD shows the per-dot
   error, the recent average versus the first average, and the cross-validated
   error, so you can see accuracy improving. Space pauses; Enter/Esc saves and
   finishes. Progress autosaves every 8 dots, and "Keep training" resumes later.
4. Repeat for each monitor, then click **Done – hand off to desktop tracker**.

Training targets are stored in desktop pixels, and one model is fit over all
monitors' samples, so gaze can move between monitors. When gaze lands on a
different monitor than the page, the box sits at the edge reading `→ Monitor N`.

Model (format v4): 13 features per camera (each iris relative to its own eye
corners, lid metrics, head yaw/pitch/roll, face position and scale) plus a few
quadratic terms, fit with weighted ridge regression; lambda is chosen by
leave-one-dot-out cross-validation over every dot. Per-dot outliers and blinks are
discarded.

**Two cameras** (Camera A / Camera B selectors; best with one camera centred on
each monitor): every frame stores both cameras' features. Model variants are fit
for A+B, A only and B only, so if one camera loses your face the other keeps
tracking. The HUD, monitor list and accuracy test show the error per variant.
The desktop worker matches cameras to OpenCV indices by name (via
`ffmpeg -f avfoundation -list_devices`), because the browser and OpenCV list
cameras in different orders.

Files in `~/.cache/knowhow/eye-tracking/`:
- `calibration.json`: per-monitor samples, camera labels and the model. Older formats need retraining.
- `sessions.jsonl`: one event per training dot, accuracy test and reset. Each event records per-camera quality (resolution, fps, eye width, iris size, brightness, iris jitter, head pose), the target, the error before learning, and whether gaze registered.
- `accuracy.jsonl`: no-learning accuracy tests, including left/centre/right error and per-camera error.
- `archive/`: training is moved here on **Forget all training**, not deleted.
- `epoch`: changes on every reset. Saves from a page loaded before the reset get a 409, so a stale tab cannot bring the old training back.

If the server stops while you are training, a red banner appears and the samples are kept in browser storage. They upload when you reload the page with the server running. Video never leaves the browser.

**Drift correction.** Posture changes within and between sessions (leaning back,
sinking in the chair, tired eyelids) shift every estimate by a roughly constant
offset — mostly downward. The model therefore ignores roll, face position and
face size, and each monitor stores a drift correction:

- **Recenter** (per monitor, 7 dots, ~15 s, no retraining) measures today's offset.
  Do it at the start of each session, then press **Done**.
- After **Test accuracy**, press **A** to apply the offset the test measured.
  The summary reports `offset` and `medianWithoutOffset`, so you can see how much
  of the error is offset and how much is shape.
- `POST /api/correct {"x":…,"y":…}` with a desktop point the user was certainly
  looking at, such as a confirmed click target, nudges a live per-monitor offset
  for the desktop tracker. Large residuals are ignored. `GET /api/correct` shows
  the offsets and `{"reset":true}` clears them.

Saved training that overlaps a connected monitor under a different geometry (a
bogus window size) is ignored and listed as **Stale training** with a **Remove**
button (`POST /api/calibration/forget`). Training for a monitor that is simply
missing from the screen list is kept, because Chrome sometimes reports an
incomplete list right after a reload.

**Adaptive training and the coverage map.** Training divides the monitor into
4×3 regions and shows a faint grid with each region's recent error *before
learning*, with this session's constant offset removed (Recenter fixes that part,
more dots don't). Regions start from the saved training's leave-one-dot-out
errors. Each new dot goes to the weakest region that isn't covered yet. A region
counts as covered after 3+ dots within the **Region target** (default 200 px).
The banner turns green with **ENOUGH DATA** once all regions are covered, or
**PLATEAU** when the last 15 dots were no better than the 15 before. Press **H**
to hide the grid. The HUD also shows the session's offset ("reads low/high").

**Kernel correction layer.** On top of each ridge variant, an RBF kernel ridge is
fit to the per-dot mean residuals: one centre per training dot, in standardized
feature space, with lambda picked by closed-form leave-one-dot-out. It's kept
only when it beats the ridge CV. It's skipped while training (refits run after
every dot) and added in the full refit after the save. Models carry
`fit: 2`; pages refit older saved models on load. The Python worker applies the
same correction.

The native Python worker (OpenCV + MediaPipe, same `.task` model and identical
features) applies the saved model and posts desktop gaze to `/api/gaze`. It uses
adaptive smoothing: fast on saccades, damped during fixations.

```bash
python3.12 -m venv ~/.cache/knowhow/eye-tracking/venv
~/.cache/knowhow/eye-tracking/venv/bin/pip install -r python/requirements-eye.txt
knowhow eye-tracking            # camera index defaults to the one saved at training
curl http://127.0.0.1:7465/api/gaze
```

By default the computer-use native overlay renders the latest coordinate as a
click-through green box over any application. It is cleared on shutdown; use
`--no-native-overlay` to disable it. The `gaze` plugin also consumes `/api/gaze`.
Gaze is approximate context and never authorizes clicks. Keep the camera and
your seating position consistent with training. Changing the camera discards
existing training.

## Requirements and preflight

macOS is the supported live-capture target. Install SoX:

```bash
brew install sox
```

Allow the terminal application that launches Knowhow to use the microphone in **System Settings → Privacy & Security → Microphone**.

Run the non-invasive checks with:

```bash
knowhow voice-control --preflight
```

Preflight reports errors and remedies. It does not open the microphone and does not call `setupServices()` or initialize MCP/model services, so it cannot prove microphone permission or provider credentials.

## Continuous voice

With the computer-use module loaded, the default live command is simply:

```bash
knowhow voice-control --speak
```

Continuous capture, the `hey knowhow` wake phrase, and `ComputerUseAgent` are defaults. The command reuses the microphone saved by `/voice`; if none is saved, it opens the same microphone picker and remembers the selection. Startup diagnostics report the selected input device and transcription backend. Each completed STT candidate is printed as `heard: ...` before wake-word filtering so recognition issues are visible.

When the standard cached whisper.cpp model and Homebrew binary are available, they are discovered automatically. Otherwise, completed utterances use the configured Knowhow OpenAI client with `whisper-1`.

The reasoning agent is model-agnostic: select any registered agent with `--agent <name>`, including a configured Luna agent or an LM Studio-backed agent. LM Studio may provide the reasoning model, but it is **not** assumed to provide audio transcription. Computer-use and other tools come from the selected agent's existing configuration; this package does not duplicate them.

Use `--device <name>` to override the saved CoreAudio input. Capture uses SoX's `sox -t coreaudio <name>` input syntax.

## Wake phrase and privacy

To override the wake phrase or agent explicitly:

```bash
knowhow voice-control \
  --wake-word "hello computer" \
  --agent Developer \
  --speak
```

Continuous capture is the default; `--continuous` remains accepted for compatibility. When local Whisper is unavailable, every completed candidate utterance—including inactive background and wake utterances—is sent to OpenAI so the phrase can be recognized. Non-wake speech is displayed as `heard:` but suppressed before it reaches the agent. Accepted input is displayed separately as `you:`.

A wake match opens a conversational window. It returns to sleep 30 seconds
after the latest task completes; override this with `--wake-window-ms`. Say
`bye knowhow`, `stop knowhow`, `hey knowhow that's enough`, `okay we're done`,
`that's all for now`, `go back to sleep`, or `stop listening` to return to
wake-word gating immediately without sending that phrase to the model.

Single-word recognitions are shown as `heard:` for diagnostics but do not start
agent tasks. While TTS is playing, recognized text that closely matches the
assistant's own output is treated as loudspeaker echo rather than barge-in.

The wake phrase is automatically supplied to both local whisper.cpp and remote
OpenAI Whisper as a vocabulary prompt. This biases spelling toward `Knowhow`
instead of `know how`. Close start-of-utterance renderings such as `hey no how`
and `hey now how` are also accepted by the wake detector without rewriting the
rest of the transcript. Use `--stt-prompt "..."` to add your own names, product
terms, or command vocabulary (and include the wake phrase in a custom prompt).

For privacy-preserving local wake recognition, use whisper.cpp:

```bash
brew install whisper-cpp
mkdir -p ~/.cache/knowhow/whisper
curl -fL \
  -o ~/.cache/knowhow/whisper/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin

knowhow voice-control \
  --speak
```

For a better interactive speed/accuracy balance, the Hugging Face CLI can
install the English small model directly into the same cache:

```bash
brew install huggingface-cli
hf download ggerganov/whisper.cpp ggml-small.en.bin \
  --local-dir ~/.cache/knowhow/whisper
```

Knowhow discovers these cached models automatically. It also discovers Homebrew's
`whisper-cli` in `/opt/homebrew/bin` or `/usr/local/bin`. When both are available,
local Whisper is preferred automatically. Model discovery prefers
`ggml-small.en.bin`, then `ggml-large-v3-turbo.bin`, `ggml-base.en.bin`, and
`ggml-base.bin`. The small English model is the default interactive choice. The
base model is faster but less reliable for names and spoken key combinations such
as “control A.” To favor accuracy over latency, download and explicitly select
large-v3-turbo:

```bash
hf download ggerganov/whisper.cpp ggml-large-v3-turbo.bin \
  --local-dir ~/.cache/knowhow/whisper
knowhow voice-control --local-stt-model \
  ~/.cache/knowhow/whisper/ggml-large-v3-turbo.bin
```

Explicit `--local-stt-command` and `--local-stt-model` values override discovery.

## Agent and computer-use configuration

The computer-use module registers `ComputerUseAgent`, which defaults to `openai` and `gpt-5.6-luna` and retains access to its lazily enabled computer-use tools. Existing `computerUse.agent.provider` and `computerUse.agent.model` settings override those defaults. Another agent can be selected with `--agent`, or a local reasoning agent can be added to `.knowhow/knowhow.json`:

```json
{
  "agents": [{
    "name": "VoiceLocal",
    "provider": "lms",
    "model": "qwen3-1.7b-mlx",
    "instructions": "You are a concise voice-controlled computer-use agent."
  }]
}
```
## Local Kokoro speech with MLX-Audio

System speech remains the zero-setup default. On Apple Silicon, install
MLX-Audio into Knowhow's isolated environment to use Kokoro instead:

```bash
brew install python@3.11 espeak-ng
python3.11 -m venv ~/.cache/knowhow/mlx-audio
~/.cache/knowhow/mlx-audio/bin/pip install mlx-audio 'misaki[en]'
```

Python 3.11 or 3.12 is recommended; some Misaki dependencies do not yet provide Python 3.13 wheels.

Knowhow automatically discovers both that Python environment and LM Studio's
download of `mlx-community/Kokoro-82M-bf16`, then synthesizes locally and plays
the resulting WAV with `afplay`:

```bash
knowhow voice-control --speak --tts mlx
```

To make it the normal `--speak` voice, add this to `.knowhow/knowhow.json`:

```json
{
  "voiceControl": {
    "tts": {
      "provider": "mlx",
      "model": "/Users/you/.lmstudio/models/mlx-community/Kokoro-82M-bf16",
      "voice": "af_heart",
      "speed": 1
    }
  }
}
```

The model field may also be the Hugging Face id
`mlx-community/Kokoro-82M-bf16`; MLX-Audio will download it into the Hugging
Face cache. CLI options override configuration:

```bash
knowhow voice-control --speak --tts mlx \
  --tts-voice af_bella --tts-speed 1.1
```

Use `--tts-python` for a different environment and `--tts-model` for another
compatible model or local path. `knowhow voice-control --speak --tts mlx
--preflight` verifies the Python import and reports the selected model before
starting services. Barge-in stops either active synthesis or `afplay`, and
temporary WAV files are removed after playback.


Then use `--agent VoiceLocal`; a larger downloaded Qwen model can provide stronger tool use at higher latency. To use computer-control tools on macOS, grant the launching terminal **Accessibility** and **Screen Recording** access in **System Settings → Privacy & Security**. The selected agent sees the same lazily enabled computer-use tools it receives outside voice mode.

## Input and output options

Useful continuous options include:

- `--vad-threshold <rms>`: local speech threshold in the range `0..1` (default `0.012`).
- `--vad-silence-ms <ms>`: silence that ends an utterance (default `1000`).
- `--max-task-cost-usd <usd>`: stop an agent task after it reaches this cost.
- `--wake-window-ms <ms>`: non-negative wake-free follow-up window.
- `--device <name>`: named CoreAudio source.
- `--speak`: play completed agent output.
- `--tts <system|mlx>`: choose system speech or local MLX-Audio.
- `--tts-model`, `--tts-voice`, `--tts-python`, and `--tts-speed`: override
  MLX-Audio settings.
- `--json`: emit versioned JSON Lines session events.

Fallbacks:

```bash
# Typed transport; no microphone
knowhow voice-control --text --agent Developer

# One request; no microphone
knowhow voice-control --once "Summarize this repository" --agent Developer
```

## Behavior and limitations

- Local VAD emits `speech.started` before STT finishes. During active playback this stops TTS immediately; the final transcript then interrupts the active interactive agent handle.
- STT is final-utterance recognition, not streaming partial transcription.
- Endpoint recognition is currently serialized with frame consumption. OS pipe buffering covers short requests, but slow STT can backpressure microphone capture; this is not true concurrent/full-duplex streaming.
- There is no acoustic echo cancellation (AEC), so speakers can feed back into the microphone.
- Provider-level abort may not cancel a remote transcription already submitted to OpenAI.
- Playback progress reports elapsed child-process time, not an exact claim about which words were heard.
- Wake recognition is local when local Whisper is discovered or explicitly configured. Otherwise candidate wake audio is remote.
- The underlying agent handle remains task-scoped. After a handle completes, continuity uses bounded transcript forwarding (at most 12 entries, 4,000 characters per entry, and approximately 12,000 characters total), not a permanent long-lived agent thread.
- Continuous live capture currently supports macOS. Typed and one-shot transports remain available elsewhere.



---

## Voice + Gaze hub (Workstream B — Contracts 2, 3, 4)

### Cross-process voice/gaze hub (Contract 2)

The `knowhow eye-tracking` server (`127.0.0.1:7465`) now doubles as a voice/gaze hub so the voice session, automations, and the gaze tracker can run in different processes.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/gaze/history` | GET | Ring buffer of live gaze samples (≥5 s). Query: `?sinceMs=<epoch ms>`. Returns `{ samples: GazeSample[] }`. |
| `/api/voice/command` | POST | Broadcast a `VoiceCommandEvent` to all SSE clients. |
| `/api/voice/register` | POST | Register command phrases: `{ phrases, owner, ttlMs? }`. Automations heartbeat-post to keep registration alive (default TTL 10 s). |
| `/api/voice/unregister` | POST | Remove a registration: `{ owner }`. |
| `/api/voice/commands` | GET | Returns currently registered phrases: `{ specs: VoiceCommandSpec[] }`. |
| `/api/voice/events` | GET | Server-Sent Events stream of `VoiceCommandEvent` and mode-change events. |

### Automation-SDK extensions (Contract 3)

The voice-control module contributes two extensions to `voiceControlModule.extensions`:

#### `sdk.ext.gaze`

```ts
// Access live eye-tracking data from within an automation
const g = await sdk.ext.gaze.current();          // latest sample or null
const g2 = await sdk.ext.gaze.at(spokenAt);       // nearest buffered sample
const hist = await sdk.ext.gaze.history(sinceMs); // window of samples
const r = sdk.ext.gaze.errorRadius();             // { x: 200, y: 260 } px
await sdk.ext.gaze.correct({ x, y });             // confirmed target for drift correction
```

#### `sdk.ext.voice`

```ts
// Subscribe to voice commands in an automation
const dispose = sdk.ext.voice.onCommand("slice", async (e) => {
  console.log("slice at gaze", e.gaze, "spoken at", e.spokenAt);
});

// One-shot await
const event = await sdk.ext.voice.nextCommand("slice", { timeoutMs: 30_000 });
```

`onCommand` automatically registers the phrase with the hub (with heartbeat) while the subscription is active. The subscription is torn down when the automation ends via `ctx.onDispose`.

Each `VoiceCommandEvent` includes:
- `phrase` — canonical matched phrase (e.g. `"slice"`)
- `text` — full recognized utterance
- `spokenAt` — epoch ms of VAD speech onset (use this to look up gaze at the moment the word was spoken)
- `gaze` — gaze sample nearest `spokenAt` (filled by voice-agent)

Hub URL is the `gaze.url` service setting: `KNOWHOW_EYE_HUB_URL` (older aliases `KNOWHOW_EYE_URL`, `KNOWHOW_GAZE_URL`), else `voiceControl.services.gaze.url` in knowhow.json, else `http://127.0.0.1:7465`.

### Command mode and voice quick hooks (Contract 4)

The voice session now starts in **agent mode** by default (same as before). The CLI (`knowhow voice-agent`) starts in **command mode**:

- **Command mode**: utterances are matched against built-in and dynamic hooks. They are NOT sent to the agent. No wake phrase needed.
- **Agent mode**: utterances go to the agent (existing behavior).

#### Mode switching

| Phrase | Effect |
|--------|--------|
| `"hey knowhow …"` (wake phrase) | command → agent mode |
| `"agent mode"` | command → agent mode |
| `"command mode"` | agent → command mode (or sleep) |
| Sleep phrases (bye, stop listening…) | any → command mode |

#### Built-in quick hooks (command mode)

| Phrase / aliases | Action |
|-----------------|--------|
| `"eye control mouse"` / `"gaze mouse"` / `"follow my eyes"` | Start gaze-follow (30 Hz, EMA smoothing) |
| `"stop mouse"` / `"stop eye control"` | Stop gaze-follow |
| `"click"` | Click at current gaze position |
| `"double click"` / `"doubleclick"` | Double-click at gaze |
| `"right click"` / `"rightclick"` | Right-click at gaze |

Click commands use the current gaze-follow position if following is active, or the gaze sample nearest the VAD onset time otherwise.

#### Dynamic commands

Automations register phrases via `sdk.ext.voice.onCommand("slice", handler)`. The voice-agent polls the hub every ~1 s and includes registered phrases in the STT vocabulary prompt. When matched, it posts a `VoiceCommandEvent` to the hub (the hub attaches gaze from its history at `spokenAt`) for automations to receive over SSE.

#### New CLI options

- `--command-silence-ms <ms>` (default 350): endpointing silence in command mode (shorter than agent mode for lower latency).
- `--speech-threshold <rms>`, `--stt-backend <cli|server>`, `--vad-debug`, `--no-latency-log` — see [Voice latency](#voice-latency).

#### New session events

- `mode.changed` — mode changed to `"command"` or `"agent"`.
- `command.matched` — a command mode utterance matched a phrase.
- `command.unmatched` — a command mode utterance matched nothing (dropped).
- `command.dispatched` — a dynamic command was posted to the hub.
- `command.latency` — per-command latency breakdown (`timing`).

#### Phrase matching

Matching is fuzzy: punctuation stripped, Levenshtein tolerance of `max(1, floor(len * 0.2))`, alias expansion, and run-together Whisper variants (`"eyecontrol mouse"` → `"eye control mouse"`).

### Custom voice commands

List everything the voice-agent will recognise (built-ins, modules, knowhow.json, and live automation phrases from the hub):

```bash
knowhow voice-control commands          # table: PHRASE  ALIASES  MODES  SOURCE  DESCRIPTION
knowhow voice-control commands --json
```

Match priority in command mode: live automation (hub) phrases first, then registered commands in the order knowhow.json → module extensions → built-ins (deduped by `name`, first wins). All phrases and aliases are added to the STT prompt hints.

#### 1. Module extension (`voice-control.command`)

Any knowhow module can contribute commands through its `extensions` array — the built-ins above are registered exactly this way. Handlers run inside the voice-agent process.

```ts
import type { KnowhowModule } from "@tyvm/knowhow/ts_build/src/services/modules/types";
import { VOICE_COMMAND_EXTENSION, VoiceCommandExtension } from "@tyvm/knowhow-module-voice-control";

const zoomIn: VoiceCommandExtension = {
  type: VOICE_COMMAND_EXTENSION,          // "voice-control.command"
  name: "my-module.zoom-in",              // unique id (dedupe key)
  phrase: "zoom in",
  aliases: ["bigger"],
  description: "Zoom the focused app",   // shown by `knowhow voice-control commands`
  modes: ["command"],                     // default; add "agent" to also fire in agent mode
  async run(ctx) {
    // ctx: { phrase, text, spokenAt, recognizedAt, gaze?, mouse?, gazeFollow?,
    //        target(), setMode(mode), log(msg) }
    const at = ctx.target();              // gaze-follow position, else gaze at speech onset
    if (at && ctx.mouse) await ctx.mouse.clickAt(at.x, at.y, "left");
  },
};

const myModule: KnowhowModule = { extensions: [zoomIn], /* tools, agents, ... */ } as any;
export default myModule;
```

At voice-agent start the session collects every `voice-control.command` extension from the core `ExtensionsService` (all loaded modules).

#### 2. `.knowhow/knowhow.json`

```json
{
  "voiceControl": {
    "commands": [
      { "phrase": "screenshot", "aliases": ["snap"], "description": "Screenshot to /tmp", "shell": "screencapture -x /tmp/voice.png" },
      { "phrase": "slice", "automation": "fruit-ninja-slice" }
    ]
  }
}
```

- `shell` runs via `/bin/sh -c`, detached, with `KNOWHOW_PHRASE`, `KNOWHOW_TEXT`, `KNOWHOW_SPOKEN_AT` and (when gaze is available) `KNOWHOW_GAZE_X` / `KNOWHOW_GAZE_Y`.
- `automation` runs `knowhow computer run-automation <name>` detached (names restricted to `[\w.-/]`).
- Exactly one of `shell` / `automation` is required; invalid entries are skipped with a warning. Optional `modes` as above.

#### 3. Automations (`sdk.ext.voice.onCommand`)

```ts
sdk.ext.voice.onCommand({ phrase: "slice", description: "Slash at gaze" }, async (e) => {
  // e.gaze is attached by the hub from its own gaze history (nearest e.spokenAt)
  // e.timing carries the latency breakdown
});
```

These are live: they exist only while the automation runs, and show up as `automation (live from hub)`.

### tmux commands

The `tmux` pack drives tmux through the `tmux` CLI and targets the pane of the
most recently active tmux client (the terminal you are using, not the voice
agent's own pane).

| Say | Does |
|---|---|
| `tmux left/right/up/down` (`pane left` …) | Same as Ctrl-h/l/k/j (vim-tmux-navigator): sends the key to vim if vim is focused, else `select-pane` |
| `tmux zoom` (`zoom pane`, `tmux unzoom`) | `resize-pane -Z` |
| `tmux tab next` / `tmux tab previous` / `tmux last tab` | next / previous / last window (status-bar tabs) |
| `tmux tab 9` (`tmux window 9`) | `select-window -t <session>:9` |
| `tmux new tab` | new window in the current pane's directory |
| `tmux pane 2`, `tmux last pane` | select pane by index / previous pane |
| `tmux split right` / `tmux split down` | `split-window -h` / `-v` in the pane's directory |
| `tmux resize left 3` | `resize-pane -L 15` (5 cells × n) |
| `tmux copy mode`, `tmux interrupt` | copy mode / Ctrl-C |
| `tmux pane tab next/previous/new/close` | runs the tmux-pane-tabs plugin binding (prefix N/P/T/X) |

### smarttype / agenttype — AI-powered text generation

Two built-in commands generate text via AI and type it for you after confirmation.

#### `smart type {text}` (aliases: `smarttype`, `smart-type`, `smart tight`)

Uses a one-shot LLM call to either fix up dictated text or generate something from a description:

```
smart type hello comma this is micah     → "Hello, this is Micah."
smart type the command to list human readable sizes for all folders
                                         → "du -sh */"
smart type a polite decline for this email
                                         → "Thank you for reaching out. Unfortunately, I'm unable to..."
```

If the focused app is a terminal (Ghostty, iTerm, WezTerm, etc.), newlines are collapsed to spaces so the command is never accidentally executed.

#### `agent type {text}` (aliases: `agenttype`, `agent-type`)

Runs a full Knowhow agent (with tools: codebase search, files, web) to research and produce the text:

```
agent type the pricing table for the current openai models based on what we have in our codebase
```

The agent runs in the background (the voice loop is not blocked). Say "confirm" / "cancel" / "redo" when the preview appears.

#### Confirmation flow (shared)

Both commands show a preview before typing:
- **Terminal**: `[voice] smarttype preview (say "confirm" or "cancel"): <text>`
- **macOS**: an `osascript` dialog with **Type** / **Cancel** buttons (focus is restored to the original app before typing)
- **Voice**: say `confirm` / `type it` / `yes` / `do it` → types; `cancel` / `no` / `reject` / `never mind` → discards; `redo` / `try again` → regenerates

Whichever resolves first (dialog or voice) wins.

After typing, `lastTyped` is set so `scratch that` works.

#### Configuration

```json
{
  "voiceControl": {
    "smartType": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6"
    },
    "agentType": {
      "agent": "Developer"
    }
  }
}
```

Environment overrides: `KNOWHOW_SMARTTYPE_PROVIDER`, `KNOWHOW_SMARTTYPE_MODEL`. These are the `provider` / `model` / `agent` settings of the `smart-type` pack and can also be written as `voiceControl.packs.smart-type.<key>`; `knowhow voice-control config` shows the effective values.

The default model is `claude-sonnet-4-6` (Anthropic). Any provider/model registered in knowhow can be used.

### Voice latency

Each matched command prints one line and appends a JSON record to `~/.cache/knowhow/voice/latency.jsonl` (disable with `--no-latency-log`):

```
[voice] latency slice: speech 410ms + endpoint 352ms + queue 0ms + stt 88ms + dispatch 9ms = 859ms (onset→dispatched) [whisper-server, silence 350ms, audio 540ms]
```

- **speech** onset → last voiced frame; **endpoint** last voiced frame → trailing-silence endpoint (`--command-silence-ms`, 350 ms default in command mode); **queue** waiting behind an earlier recognition; **stt** recognizer; **dispatch** hub POST / handler.
- `transcript.final` events carry `timing` (`spokenAt`, `speechEndAt`, `finalizedAt`, `sttStartAt`, `sttEndAt`, `audioMs`, `voicedMs`, `silenceMs`, `mode`, `sttBackend`), as do hub `VoiceCommandEvent`s (`+ dispatchedAt`, `hubReceivedAt`).
- Gaze is not awaited before dispatching hub commands: the hub attaches the sample nearest `spokenAt`. In-process commands look it up with a 150 ms timeout (`gazeMs` in the log).
- **STT backend**: by default a persistent `whisper-server` is started once with the same model on a free localhost port (≈85 ms per short command vs ≈350 ms for spawning `whisper-cli`, which reloads the model each time). It falls back to `whisper-cli` if the server isn't installed, fails to start, or a request fails. Override with `--stt-backend cli|server`.
- **Capture**: SoX is run with `--buffer 1024` (≈32 ms chunks instead of the default 256 ms bursts) and frames are back-dated within a chunk, so endpointing isn't quantised to 256 ms.
- **Noise**: command-mode utterances longer than 2.5 s are logged as likely ambient noise (they delay later commands). `--vad-debug` logs the ambient RMS noise floor every 10 s; raise `--speech-threshold <rms>` (alias of `--vad-threshold`) if keyboard noise keeps the VAD open.

### Types exported

```ts
// From src/voiceHub.ts
export interface VoiceCommandSpec { phrase: string; aliases?: string[]; description?: string }
export interface VoiceCommandEvent { type: "voice.command"; id, phrase, text, spokenAt, recognizedAt, gaze? }

// From src/commandMode.ts
export type VoiceMode = "command" | "agent";
export { ModeRouter, matchPhrase, normalisePhrase, BUILTIN_COMMAND_SPECS }

// From src/extensions.ts
export { gazeExtension, voiceExtension, AUTOMATION_SDK_EXTENSION }
```

---

## Fruit Ninja Gaze — Live Demo & Benchmark

The `fruitNinjaGazeSlice` automation demonstrates the full gaze + voice pipeline:
say "slice" while looking at a fruit and the automation slashes it. It tests
real-world latency, gaze accuracy, and target-selection quality.

### Quick start (live human run)

```bash
# 1. Eye-tracking server (keep running; uses port 7465)
knowhow eye-tracking

# 2. Game server in gaze mode (port 7434)
BENCH_PORT=7434 GAME_MODE=gaze \
  node packages/knowhow-benchmarks/exercises/computer-use/fruit-ninja/server.js

# 3. Open game in Chrome — auto-starts in gaze mode, shows GAZE MODE badge
open http://localhost:7434/?mode=gaze

# 4. Voice agent (command mode)
knowhow voice-agent

# 5. Run the automation (real mouse movement)
knowhow computer run-automation fruitNinjaGazeSlice

# Dry-run (perception only, no mouse movement):
knowhow computer test-automation fruitNinjaGazeSlice

# 6. Say "slice" while looking at a fruit. Results:
curl http://localhost:7434/api/results?session=<sessionId>
```

### CI synthetic harness (no human required)

```bash
# From repo root — runs ≥20 slashes per noise level, prints intent accuracy table
node packages/knowhow-benchmarks/exercises/computer-use/fruit-ninja-gaze/harness.js

# Options:
#   --port 7435            game server port (avoids conflict with live 7434)
#   --hub-port 7466        hub stub port (avoids conflict with live 7465)
#   --slashes-per-sigma 20 slashes per σ level (default 20)
```

Actual measured output (synthetic run, 20 slashes per sigma):

```
  Scenario           | Slashes | Intent Accuracy | Median Latency
  -------------------|---------|-----------------|---------------
  σ=0px              | 20      | 100%            | 714ms
  σ=100px            | 20      | 100%            | 603ms
  σ=200px            | 20      | 100%            | 612ms
  σ=300px            | 20      | 90%             | 664ms
  close-pair(σ=50)   | 20      | 100%            | 633ms
```

Note: σ=0px noise still shows non-zero "noise" in the log (up to ~600px) because at
spokenAt (300–900ms before the slash), the fruit has moved from its gaze-sampled position.
The selectTarget function correctly uses the fruit's position *at spokenAt* for matching,
not its current position — so intent accuracy remains high even with large motion.

### Architecture

- `fruitNinjaGazeSlice.ts` — main automation; imports `selectTarget`/`positionAt` from `gazeTargeting.ts`
- `.knowhow/automations/gazeTargeting.ts` — shared target-selection logic (used by automation + harness)
- `fruit-ninja/server.js` — game backend with `gazeSummary` + optional hub SSE subscription (`HUB_URL` env)
- `fruit-ninja/index.html` — game UI; `?mode=gaze` auto-starts in gaze mode, shows intent accuracy in results
- `fruit-ninja-gaze/harness.js` — synthetic CI harness; loads gazeTargeting.ts via TypeScript transpilation

### Hub integration (server.js)

The game server can subscribe to the eye-tracking hub's SSE stream so it enriches
slash POST requests that lack explicit `gaze`/`spokenAt` metadata:

```bash
# Point game server at a running hub (default: http://127.0.0.1:7465)
HUB_URL=http://127.0.0.1:7465 BENCH_PORT=7434 GAME_MODE=gaze \
  node packages/knowhow-benchmarks/exercises/computer-use/fruit-ninja/server.js
```

The page also POSTs its canvas screen coordinates to `/api/canvas-info` on game
start so hub gaze (desktop pixels) is correctly mapped to arena coords (0–1200 × 0–700).
