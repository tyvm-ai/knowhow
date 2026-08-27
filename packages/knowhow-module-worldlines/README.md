# @tyvm/knowhow-module-worldlines

A generic, evidence-backed state transition journal for Knowhow. Worldlines remembers what actually happened; domain automations define state/action semantics, and planners may separately infer unobserved behavior.

```ts
const world = sdk.worldlines.open<GameState, GameAction, VisionObservation>({
  namespace: "my-game",
  environment: { task: "maze", level: 4, buildFingerprint },
  stateSchema: "maze-state@2",
  actionSchema: "maze-action@1",
  observationSchema: "maze-vision@3",
});

const logged = await watcher.logTransition("move-right", {
  frame: afterFrame,
  worldline: world,
  transition: {
    from: beforeState,
    action: { type: "move", direction: "right" },
    to: afterState,
    parentWorldlineHash,
    provenance: "observed",
  },
});
```

Data is stored under `.knowhow/worldlines/<namespace>/<scope-hash>/`. The environment and schemas form the scope hash, states/actions are canonicalized and content-addressed, and every transition observation is append-only. Different histories can converge on a state hash while `worldlineHash` preserves exact history.

## Core API

- **`registry.open(options)`** — opens a scoped state-transition graph.
- **`world.recordTransition(input)`** — records an observed or explicitly inferred edge.
- **`world.lookup(state, action)`** — returns every recorded outcome; never silently picks one.
- **`world.replay(initialState, actions)`** — replays observed evidence only by default and returns `complete`, `partial`, or `conflicted`.
- **`world.outgoing(state)`**, **`states()`**, and **`conflicts()`** — inspect the graph.
- **`world.loadEvidence(id)`** — retrieves immutable/captured evidence blobs or paths.
- **`world.addProjection(evidenceId, { schema, parsed })`** — attaches a versioned parse without overwriting older parses.

## Search & Experience Store API

### `world.findStates(criterion)`

Search all recorded states. Returns an array of `{ hash, state, schema }` ordered deterministically.

`criterion` may be:

- **A predicate function** `(state: State) => boolean` — called for every stored state.
- **A partial-match object** — every provided key must deep-equal the corresponding key in the state.

```ts
// Predicate
const energyStates = world.findStates((s) => s.energy > 3);

// Partial match (all keys must match)
const atOrigin = world.findStates({ x: 0, y: 0 });
```

### `world.findWorldlines(options?)`

Find distinct worldlines (by `worldlineHash`) that satisfy the given criteria. Scans the on-disk transition graph without requiring a separate index.

Options:

| Option | Type | Description |
|---|---|---|
| `containsState` | `State \| string` | State value or hash that must appear in the worldline |
| `lastAction` | `Action` | At least one transition must use this action |
| `worldlineHashPrefix` | `string` | Hash prefix filter (useful for debugging) |
| `provenance` | `"observed" \| "inferred"` | At least one transition must have this provenance |
| `limit` | `number` | Maximum worldlines to return |

Returns `WorldlineInfo[]`:
```ts
interface WorldlineInfo<Action> {
  worldlineHash: string;
  parentWorldlineHash: string;
  lastTransition: TransitionRecord<Action>;
  transitionCount: number;  // repeated observations of same edge
}
```

```ts
// Find all worldlines that passed through a known checkpoint state
const branches = world.findWorldlines({ containsState: checkpointState });

// Partial objects and predicates search every state in each complete history.
const greenAtGoal = world.findWorldlines({
  matchesState: { player: { column: 8, row: 3 }, hud: { hue: "green" } },
});

// Find the 10 most recently branching observed worldlines
const recent = world.findWorldlines({ provenance: "observed", limit: 10 });
```

### `world.actionHistory(worldlineHash)`

Reconstruct the ordered sequence of transitions that form the history of a specific worldline by following `parentWorldlineHash` pointers back to the root.

Returns `ActionHistoryEntry[]`:
```ts
interface ActionHistoryEntry<Action> {
  transition: TransitionRecord<Action>;
  fromStateHash: string;
  action: Action;
  actionHash: string;
  toStateHash: string;
}
```

```ts
const history = world.actionHistory(someWorldlineHash);
// history[0] = first action, history[N-1] = most recent
for (const entry of history) {
  console.log(entry.action, entry.fromStateHash, "->", entry.toStateHash);
}
```

### `world.simulate(initialState, actions, options?)`

Like `replay()` but enriches each step with fully-hydrated artifact records (blob paths, MIME types, roles, metadata). Preserves `complete` / `partial` / `conflicted` semantics exactly.

Returns `SimulateResult`:
```ts
interface SimulateStep<State, Action> {
  index: number;
  fromStateHash: string;
  fromState: State;          // the state entering this action
  action: Action;
  actionHash: string;
  toStateHash: string;
  toState: State;            // the state after this action
  provenance: TransitionProvenance;
  artifacts: SimulateArtifact[];
  transition: TransitionRecord<Action>;
}

interface SimulateArtifact {
  evidenceId: string;
  kind: string;
  role?: string;             // e.g. "before-frame", "after-frame"
  mimeType?: string;
  artifactPath?: string;     // resolved blob/file path if present on disk
  metadata?: JsonObject;
}
```

```ts
const sim = world.simulate(startState, actionSequence);
if (sim.status === "complete") {
  for (const step of sim.steps) {
    console.log(step.action, "→", step.toState);
    const screenshot = step.artifacts.find((a) => a.role === "after-frame");
    if (screenshot?.artifactPath) showImage(screenshot.artifactPath);
  }
}
```

## Role-Aware Evidence Attachment

`EvidenceInput` now accepts an optional `role` field that is persisted on the `EvidenceRecord` and exposed by `simulate()` without requiring metadata parsing:

```ts
world.recordTransition({
  from: beforeState,
  action: { move: "right" },
  to: {
    state: afterState,
    evidence: [
      { kind: "screen", data: beforePng, mimeType: "image/png", role: "before-frame" },
      { kind: "screen", data: afterPng,  mimeType: "image/png", role: "after-frame" },
    ],
  },
});

const ev = world.loadEvidence(transitionRecord.evidence[0]);
console.log(ev.record.role); // "before-frame"
```

Role is backward-compatible: existing evidence records without a role continue to work, and `role` on `EvidenceRecord` will be `undefined`.

## State Schema Fields

State should be semantic and include all transition-relevant hidden variables known to the automation (for example energy, lives, shape, hue, and animation phase), not raw screenshot bytes. If perception is incomplete, mark the state as partial and include a history discriminator to avoid unsafe convergence.

`ScreenWatcher.logTransition()` is the computer-use adapter. It persists the same action-aligned frame used by `logAction()` and adds that artifact as evidence. During dry-runs it may retain the requested screenshot, but deliberately returns `transition: null` and never records an observed edge.
