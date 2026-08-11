import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";

export type TransitionProvenance = "observed" | "inferred";
export type JsonObject = Record<string, unknown>;

export interface WorldlineEnvironment extends JsonObject {}

export interface OpenWorldlineOptions<State, Action, Observation = unknown> {
  namespace: string;
  environment: WorldlineEnvironment;
  stateSchema: string;
  actionSchema: string;
  observationSchema?: string;
  canonicalizeState?: (state: State) => unknown;
  canonicalizeAction?: (action: Action) => unknown;
}


/** Recursively match supplied object keys; arrays remain exact values. */
function partialMatch(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected) || expected === null || typeof expected !== "object") {
    return deepEqual(expected, actual);
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  const source = expected as Record<string, unknown>;
  const target = actual as Record<string, unknown>;
  return Object.keys(source).every((key) =>
    Object.prototype.hasOwnProperty.call(target, key) && partialMatch(source[key], target[key]));
}
export interface EvidenceInput {
  /** Adapter/domain name, for example computer-use/screen-frame. */
  kind: string;
  /** Existing immutable artifact path. Relative paths resolve from cwd. */
  path?: string;
  /** Optional data to copy into the content-addressed evidence store. */
  data?: Buffer | string;
  mimeType?: string;
  metadata?: JsonObject;
  /**
   * Role of this evidence relative to the transition, for example
   * "before-frame", "after-frame", "action-screenshot".  When present the
   * value is stored in the EvidenceRecord and can be used by search/filter
   * helpers without parsing metadata.
   */
  role?: string;
}

export interface EvidenceRecord {
  id: string;
  kind: string;
  path?: string;
  blobPath?: string;
  mimeType?: string;
  metadata?: JsonObject;
  createdAt: string;
  /** Optional semantic role attached at record-time (from EvidenceInput.role). */
  role?: string;
}

export interface StateObservation<Observation> {
  evidence?: EvidenceInput | EvidenceInput[];
  parsed?: Observation;
}

export interface TransitionInput<State, Action, Observation = unknown> {
  from: State | ({ state: State } & StateObservation<Observation>);
  action: Action;
  to: State | ({ state: State } & StateObservation<Observation>);
  provenance?: TransitionProvenance;
  /** Preserve exact history when continuing a known worldline. */
  parentWorldlineHash?: string;
  metadata?: JsonObject;
  evidence?: EvidenceInput | EvidenceInput[];
}

export interface TransitionRecord<Action = unknown> {
  id: string;
  namespace: string;
  scopeHash: string;
  fromStateHash: string;
  actionHash: string;
  action: Action;
  toStateHash: string;
  parentWorldlineHash: string;
  worldlineHash: string;
  provenance: TransitionProvenance;
  evidence: string[];
  fromProjection?: string;
  toProjection?: string;
  metadata?: JsonObject;
  createdAt: string;
}

export interface ProjectionRecord<Observation = unknown> {
  id: string;
  evidenceId: string;
  schema: string;
  parsed: Observation;
  createdAt: string;
}

export interface ReplayStep<State, Action> {
  index: number;
  source: TransitionProvenance;
  fromStateHash: string;
  action: Action;
  actionHash: string;
  toStateHash: string;
  state: State;
  transition: TransitionRecord<Action>;
}

export interface ReplayFrontier<State, Action> {
  index: number;
  stateHash: string;
  state: State;
  action: Action;
  reason: "unobserved-transition" | "conflicting-outcomes";
  outcomes?: TransitionRecord<Action>[];
}

export interface ReplayResult<State, Action> {
  status: "complete" | "partial" | "conflicted";
  initialStateHash: string;
  finalKnownStateHash: string;
  finalKnownState: State;
  steps: ReplayStep<State, Action>[];
  frontier?: ReplayFrontier<State, Action>;
}

// ---------------------------------------------------------------------------
// Search & experience-store types
// ---------------------------------------------------------------------------

export type StatePredicate<State> = (state: State) => boolean;

/** A partial match spec: every provided key/value must deep-equal the state. */
export type StatePartialMatch<State> = State extends readonly unknown[] ? State
  : State extends Record<string, unknown>
    ? { [Key in keyof State]?: StatePartialMatch<State[Key]> }
    : State;

/** Criterion for findStates – either a predicate or a partial-match object. */
export type StateCriterion<State> =
  | StatePredicate<State>
  | StatePartialMatch<State>;

export interface StateSearchResult<State> {
  hash: string;
  state: State;
  schema: string;
}

// ---------------------------------------------------------------------------
// Worldline search types
// ---------------------------------------------------------------------------

export interface WorldlineSearchOptions<State, Action> {
  /** Only include worldlines that pass through this state (value or hash). */
  containsState?: State | string;
  /** Only include worldlines containing a state matching this partial/predicate query. */
  matchesState?: StateCriterion<State>;
  /** Only include worldlines whose last action matches. */
  lastAction?: Action;
  /** Only include worldlines with the given worldlineHash prefix/exact. */
  worldlineHashPrefix?: string;
  /** Filter transitions by provenance. */
  provenance?: TransitionProvenance;
  /** Maximum number of worldline roots to return. */
  limit?: number;
}

export interface WorldlineInfo<Action> {
  worldlineHash: string;
  parentWorldlineHash: string;
  /** The final transition recorded for this worldline hash. */
  lastTransition: TransitionRecord<Action>;
  /** Number of transitions with this worldlineHash. */
  transitionCount: number;
}

// ---------------------------------------------------------------------------
// Action history types
// ---------------------------------------------------------------------------

export interface ActionHistoryEntry<Action> {
  /** Transition record for this step. */
  transition: TransitionRecord<Action>;
  fromStateHash: string;
  action: Action;
  actionHash: string;
  toStateHash: string;
}

// ---------------------------------------------------------------------------
// Simulate types
// ---------------------------------------------------------------------------

export interface SimulateArtifact {
  evidenceId: string;
  kind: string;
  role?: string;
  mimeType?: string;
  /** Absolute path to blob or source file if available. */
  artifactPath?: string;
  metadata?: JsonObject;
}

export interface SimulateStep<State, Action> {
  index: number;
  fromStateHash: string;
  fromState: State;
  action: Action;
  actionHash: string;
  toStateHash: string;
  toState: State;
  provenance: TransitionProvenance;
  artifacts: SimulateArtifact[];
  transition: TransitionRecord<Action>;
}

export interface SimulateResult<State, Action> {
  status: "complete" | "partial" | "conflicted";
  initialStateHash: string;
  finalKnownStateHash: string;
  finalKnownState: State;
  steps: SimulateStep<State, Action>[];
  frontier?: ReplayFrontier<State, Action>;
}

interface Manifest {
  namespace: string;
  scopeHash: string;
  environment: WorldlineEnvironment;
  stateSchema: string;
  actionSchema: string;
  observationSchema?: string;
  createdAt: string;
}

/** Stable JSON used for hashes and append-only records. Rejects lossy values. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (input: any): any => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new Error("Worldline values must contain finite numbers");
      return Object.is(input, -0) ? 0 : input;
    }
    if (typeof input === "bigint") return { $bigint: input.toString() };
    if (Buffer.isBuffer(input)) return { $buffer: input.toString("base64") };
    if (input instanceof Date) return { $date: input.toISOString() };
    if (Array.isArray(input)) {
      if (seen.has(input)) throw new Error("Worldline values cannot contain cycles");
      seen.add(input);
      const result = input.map((item) => {
        if (item === undefined || typeof item === "function" || typeof item === "symbol") {
          throw new Error("Worldline arrays cannot contain undefined, functions, or symbols");
        }
        return normalize(item);
      });
      seen.delete(input);
      return result;
    }
    if (typeof input === "object") {
      if (seen.has(input)) throw new Error("Worldline values cannot contain cycles");
      seen.add(input);
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) {
        const item = input[key];
        if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
        result[key] = normalize(item);
      }
      seen.delete(input);
      return result;
    }
    throw new Error(`Unsupported worldline value: ${typeof input}`);
  };
  return JSON.stringify(normalize(value));
}

export function contentHash(value: unknown): string {
  const bytes = typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(bytes).digest("hex");
}

function safeName(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "_");
  if (!safe) throw new Error("Worldline namespace must be non-empty");
  return safe;
}

function writeImmutableJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const serialized = `${canonicalJson(value)}\n`;
  try {
    fs.writeFileSync(file, serialized, { flag: "wx" });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    if (fs.readFileSync(file, "utf8") !== serialized) {
      throw new Error(`Content-address collision at ${file}`);
    }
  }
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function asSnapshot<State, Observation>(value: TransitionInput<State, unknown, Observation>["from"]): {
  state: State;
  evidence: EvidenceInput[];
  parsed?: Observation;
} {
  if (value && typeof value === "object" && "state" in (value as any)) {
    const snapshot = value as { state: State } & StateObservation<Observation>;
    return { state: snapshot.state, evidence: arrayOf(snapshot.evidence), parsed: snapshot.parsed };
  }
  return { state: value as State, evidence: [] };
}

function arrayOf<T>(value?: T | T[]): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/**
 * Deep-equals two JSON-serializable values (structural equality, not reference).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, (b as unknown[])[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao).sort();
  const bKeys = Object.keys(bo).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k, i) => bKeys[i] === k && deepEqual(ao[k], bo[k]));
}

/**
 * Returns true if `state` satisfies `criterion`:
 *   - function predicate: called directly
 *   - plain object: every key in the criterion must deep-equal the same key in state
 */
function matchesCriterion<State>(state: State, criterion: StateCriterion<State>): boolean {
  if (typeof criterion === "function") {
    return (criterion as StatePredicate<State>)(state);
  }
  if (criterion !== null && typeof criterion === "object") {
    const partial = criterion as Record<string, unknown>;
    const s = state as Record<string, unknown>;
    return partialMatch(partial, s);
  }
  return false;
}


export class Worldline<State, Action, Observation = unknown> {
  readonly directory: string;
  readonly scopeHash: string;
  private readonly manifest: Manifest;

  constructor(
    rootDirectory: string,
    readonly options: OpenWorldlineOptions<State, Action, Observation>
  ) {
    if (!options.namespace?.trim()) throw new Error("Worldline namespace is required");
    if (!options.stateSchema?.trim() || !options.actionSchema?.trim()) {
      throw new Error("Worldline stateSchema and actionSchema are required");
    }
    this.scopeHash = contentHash({
      namespace: options.namespace,
      environment: options.environment,
      stateSchema: options.stateSchema,
      actionSchema: options.actionSchema,
      observationSchema: options.observationSchema,
    });
    this.directory = path.resolve(rootDirectory, safeName(options.namespace), this.scopeHash);
    this.manifest = {
      namespace: options.namespace,
      scopeHash: this.scopeHash,
      environment: options.environment,
      stateSchema: options.stateSchema,
      actionSchema: options.actionSchema,
      observationSchema: options.observationSchema,
      createdAt: new Date().toISOString(),
    };
    const manifestPath = path.join(this.directory, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      const existing = readJson<Manifest>(manifestPath);
      const identity = (m: Manifest) => ({
        namespace: m.namespace, scopeHash: m.scopeHash, environment: m.environment,
        stateSchema: m.stateSchema, actionSchema: m.actionSchema,
        observationSchema: m.observationSchema,
      });
      if (canonicalJson(identity(existing)) !== canonicalJson(identity(this.manifest))) {
        throw new Error(`Worldline manifest does not match requested scope: ${manifestPath}`);
      }
    } else {
      fs.mkdirSync(this.directory, { recursive: true });
      fs.writeFileSync(manifestPath, `${canonicalJson(this.manifest)}\n`, { flag: "wx" });
    }
  }

  stateHash(state: State): string {
    return contentHash({ scopeHash: this.scopeHash, schema: this.options.stateSchema,
      state: this.options.canonicalizeState?.(state) ?? state });
  }

  actionHash(action: Action): string {
    return contentHash({ scopeHash: this.scopeHash, schema: this.options.actionSchema,
      action: this.options.canonicalizeAction?.(action) ?? action });
  }

  private stateFile(hash: string): string {
    return path.join(this.directory, "states", `${hash}.json`);
  }

  private transitionDirectory(fromHash: string, actionHash: string): string {
    return path.join(this.directory, "transitions", fromHash, actionHash);
  }

  private saveState(state: State): string {
    const hash = this.stateHash(state);
    writeImmutableJson(this.stateFile(hash), {
      hash, schema: this.options.stateSchema,
      state: this.options.canonicalizeState?.(state) ?? state,
    });
    return hash;
  }

  getState(hash: string): State | undefined {
    const file = this.stateFile(hash);
    return fs.existsSync(file) ? readJson<{ state: State }>(file).state : undefined;
  }

  private saveEvidence(input: EvidenceInput): EvidenceRecord {
    if (!input?.kind?.trim()) throw new Error("Evidence kind is required");
    let blobPath: string | undefined;
    let blobHash: string | undefined;
    if (input.data !== undefined) {
      const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
      blobHash = createHash("sha256").update(data).digest("hex");
      const extension = input.mimeType === "image/png" ? ".png"
        : input.mimeType === "image/jpeg" ? ".jpg" : ".bin";
      blobPath = path.join(this.directory, "blobs", `${blobHash}${extension}`);
      fs.mkdirSync(path.dirname(blobPath), { recursive: true });
      try { fs.writeFileSync(blobPath, data, { flag: "wx" }); }
      catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        const existingHash = createHash("sha256").update(fs.readFileSync(blobPath)).digest("hex");
        if (existingHash !== blobHash) throw new Error(`Evidence blob collision at ${blobPath}`);
      }
    }
    const sourcePath = input.path ? path.resolve(input.path) : undefined;
    const identity = {
      kind: input.kind, path: sourcePath, blobHash, mimeType: input.mimeType,
      metadata: input.metadata,
    };
    const id = contentHash(identity);
    const record: EvidenceRecord = {
      id, kind: input.kind, path: sourcePath, blobPath,
      mimeType: input.mimeType, metadata: input.metadata, role: input.role,
      createdAt: new Date().toISOString(),
    };
    const file = path.join(this.directory, "evidence", `${id}.json`);
    if (!fs.existsSync(file)) writeImmutableJson(file, record);
    return fs.existsSync(file) ? readJson<EvidenceRecord>(file) : record;
  }

  loadEvidence(id: string): { record: EvidenceRecord; data?: Buffer } | undefined {
    const file = path.join(this.directory, "evidence", `${id}.json`);
    if (!fs.existsSync(file)) return undefined;
    const record = readJson<EvidenceRecord>(file);
    const source = record.blobPath ?? record.path;
    return { record, data: source && fs.existsSync(source) ? fs.readFileSync(source) : undefined };
  }

  addProjection<T = Observation>(evidenceId: string, input: { schema: string; parsed: T }): ProjectionRecord<T> {
    if (!this.loadEvidence(evidenceId)) throw new Error(`Unknown evidence: ${evidenceId}`);
    if (!input.schema?.trim()) throw new Error("Projection schema is required");
    const id = contentHash({ evidenceId, schema: input.schema, parsed: input.parsed });
    const record: ProjectionRecord<T> = {
      id, evidenceId, schema: input.schema, parsed: input.parsed,
      createdAt: new Date().toISOString(),
    };
    const file = path.join(this.directory, "projections", evidenceId, `${id}.json`);
    if (!fs.existsSync(file)) writeImmutableJson(file, record);
    return fs.existsSync(file) ? readJson<ProjectionRecord<T>>(file) : record;
  }

  projections(evidenceId: string): ProjectionRecord[] {
    const dir = path.join(this.directory, "projections", evidenceId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
      .sort().map((name) => readJson<ProjectionRecord>(path.join(dir, name)));
  }


  recordTransition(input: TransitionInput<State, Action, Observation>): TransitionRecord<Action> {
    const from = asSnapshot<State, Observation>(input.from);
    const to = asSnapshot<State, Observation>(input.to);
    const fromStateHash = this.saveState(from.state);
    const toStateHash = this.saveState(to.state);
    const action = (this.options.canonicalizeAction?.(input.action) ?? input.action) as Action;
    const actionHash = this.actionHash(input.action);
    const rootWorldlineHash = contentHash({ scopeHash: this.scopeHash, startStateHash: fromStateHash });
    const parentWorldlineHash = input.parentWorldlineHash ?? rootWorldlineHash;
    const worldlineHash = contentHash({ parentWorldlineHash, actionHash, toStateHash });
    const evidence = [...from.evidence, ...arrayOf(input.evidence), ...to.evidence]
      .map((item) => this.saveEvidence(item));
    const fromEvidenceCount = from.evidence.length;
    const middleEvidenceCount = arrayOf(input.evidence).length;
    const fromEvidence = evidence.slice(0, fromEvidenceCount);
    const toEvidence = evidence.slice(fromEvidenceCount + middleEvidenceCount);
    const schema = this.options.observationSchema;
    const fromProjection = from.parsed !== undefined && fromEvidence[0]
      ? this.addProjection(fromEvidence[0].id, { schema: schema ?? "observation@unversioned", parsed: from.parsed }).id
      : undefined;
    const toProjection = to.parsed !== undefined && toEvidence[0]
      ? this.addProjection(toEvidence[0].id, { schema: schema ?? "observation@unversioned", parsed: to.parsed }).id
      : undefined;
    const createdAt = new Date().toISOString();
    // Each observation is an append-only event. The nonce permits repeated live
    // observations of the same edge while state/action hashes still converge.
    const id = contentHash({ fromStateHash, actionHash, toStateHash, createdAt,
      nonce: randomBytes(8).toString("hex") });
    const record: TransitionRecord<Action> = {
      id, namespace: this.options.namespace, scopeHash: this.scopeHash,
      fromStateHash, actionHash, action, toStateHash,
      parentWorldlineHash, worldlineHash,
      provenance: input.provenance ?? "observed",
      evidence: evidence.map((item) => item.id),
      fromProjection, toProjection, metadata: input.metadata, createdAt,
    };
    writeImmutableJson(path.join(this.transitionDirectory(fromStateHash, actionHash), `${id}.json`), record);
    return record;
  }

  lookup(stateOrHash: State | string, action: Action): TransitionRecord<Action>[] {
    const stateHash = typeof stateOrHash === "string" && /^[a-f0-9]{64}$/.test(stateOrHash)
      ? stateOrHash : this.stateHash(stateOrHash as State);
    const dir = this.transitionDirectory(stateHash, this.actionHash(action));
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort()
      .map((name) => readJson<TransitionRecord<Action>>(path.join(dir, name)));
  }

  outgoing(stateOrHash: State | string): TransitionRecord<Action>[] {
    const stateHash = typeof stateOrHash === "string" && /^[a-f0-9]{64}$/.test(stateOrHash)
      ? stateOrHash : this.stateHash(stateOrHash as State);
    const dir = path.join(this.directory, "transitions", stateHash);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort().flatMap((actionHash) => {
      const actionDir = path.join(dir, actionHash);
      if (!fs.statSync(actionDir).isDirectory()) return [];
      return fs.readdirSync(actionDir).filter((name) => name.endsWith(".json")).sort()
        .map((name) => readJson<TransitionRecord<Action>>(path.join(actionDir, name)));
    });
  }

  states(): Array<{ hash: string; state: State }> {
    const dir = path.join(this.directory, "states");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => {
      const value = readJson<{ hash: string; state: State }>(path.join(dir, name));
      return { hash: value.hash, state: value.state };
    });
  }

  conflicts(options: { evidence?: "observed-only" | "include-inferred" } = {}): Array<{
    fromStateHash: string;
    actionHash: string;
    outcomes: TransitionRecord<Action>[];
  }> {
    const result: Array<{ fromStateHash: string; actionHash: string; outcomes: TransitionRecord<Action>[] }> = [];
    for (const { hash } of this.states()) {
      const grouped = new Map<string, TransitionRecord<Action>[]>();
      for (const edge of this.outgoing(hash)) {
        if (options.evidence !== "include-inferred" && edge.provenance !== "observed") continue;
        const entries = grouped.get(edge.actionHash) ?? [];
        entries.push(edge); grouped.set(edge.actionHash, entries);
      }
      for (const [actionHash, outcomes] of grouped) {
        if (new Set(outcomes.map((edge) => edge.toStateHash)).size > 1) {
          result.push({ fromStateHash: hash, actionHash, outcomes });
        }
      }
    }
    return result;
  }

  replay(initialState: State, actions: Action[], options: { evidence?: "observed-only" | "include-inferred" } = {}): ReplayResult<State, Action> {
    const initialStateHash = this.stateHash(initialState);
    let state = initialState;
    let stateHash = initialStateHash;
    const steps: ReplayStep<State, Action>[] = [];
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index];
      const candidates = this.lookup(stateHash, action).filter((edge) =>
        options.evidence === "include-inferred" || edge.provenance === "observed");
      if (!candidates.length) {
        return { status: "partial", initialStateHash, finalKnownStateHash: stateHash,
          finalKnownState: state, steps, frontier: { index, stateHash, state, action,
            reason: "unobserved-transition" } };
      }
      const outcomeHashes = [...new Set(candidates.map((edge) => edge.toStateHash))];
      if (outcomeHashes.length !== 1) {
        return { status: "conflicted", initialStateHash, finalKnownStateHash: stateHash,
          finalKnownState: state, steps, frontier: { index, stateHash, state, action,
            reason: "conflicting-outcomes", outcomes: candidates } };
      }
      // Repeated observations of the same outcome are not a conflict. Prefer an
      // observed record and preserve its evidence in the replay result.
      const transition = candidates.find((edge) => edge.provenance === "observed") ?? candidates[0];
      const next = this.getState(transition.toStateHash);
      if (next === undefined) throw new Error(`Missing state ${transition.toStateHash}`);
      steps.push({ index, source: transition.provenance, fromStateHash: stateHash,
        action, actionHash: transition.actionHash, toStateHash: transition.toStateHash,
        state: next, transition });
      state = next; stateHash = transition.toStateHash;
    }
    return { status: "complete", initialStateHash, finalKnownStateHash: stateHash,
      finalKnownState: state, steps };
  }

  findFrontier(initialState: State, actions: Action[]): ReplayResult<State, Action>["frontier"] {
    return this.replay(initialState, actions).frontier;
  }

  // ---------------------------------------------------------------------------
  // findStates – recursive partial/predicate search
  // ---------------------------------------------------------------------------

  /**
   * Search all recorded states.  `criterion` may be:
   *   - a function predicate `(state) => boolean`
   *   - a partial object whose top-level keys must deep-equal the state's keys
   *
   * Returns an array of `{ hash, state, schema }` records ordered by hash
   * (deterministic, file-system order).
   */
  findStates(criterion: StateCriterion<State>): StateSearchResult<State>[] {
    const dir = path.join(this.directory, "states");
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
    const results: StateSearchResult<State>[] = [];
    const schema = this.options.stateSchema;
    for (const name of files) {
      const record = readJson<{ hash: string; state: State; schema: string }>(path.join(dir, name));
      if (matchesCriterion(record.state, criterion)) {
        results.push({ hash: record.hash, state: record.state, schema: record.schema ?? schema });
      }
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // findWorldlines – search the transition graph for worldline summaries
  // ---------------------------------------------------------------------------

  /**
   * Find distinct worldlines (identified by `worldlineHash`) that satisfy the
   * given options.  Uses only the existing on-disk transition index; no
   * additional indexing structures are required (though the scan is O(n) in
   * the number of transitions).
   */
  findWorldlines(options: WorldlineSearchOptions<State, Action> = {}): WorldlineInfo<Action>[] {
    const { containsState, matchesState, lastAction, worldlineHashPrefix, provenance, limit } = options;

    // Resolve the target state hash once if provided.
    let targetStateHash: string | undefined;
    if (containsState !== undefined) {
      targetStateHash = typeof containsState === "string" && /^[a-f0-9]{64}$/.test(containsState)
        ? containsState
        : this.stateHash(containsState as State);
    }

    // Resolve the target action hash once if provided.
    let targetActionHash: string | undefined;
    if (lastAction !== undefined) {
      targetActionHash = this.actionHash(lastAction);
    }

    // Collect every transition, grouped by worldlineHash.
    const byWorldline = new Map<string, TransitionRecord<Action>[]>();
    const transitionsRoot = path.join(this.directory, "transitions");
    if (!fs.existsSync(transitionsRoot)) return [];

    for (const fromHash of fs.readdirSync(transitionsRoot).sort()) {
      const fromDir = path.join(transitionsRoot, fromHash);
      if (!fs.statSync(fromDir).isDirectory()) continue;
      for (const aHash of fs.readdirSync(fromDir).sort()) {
        const aDir = path.join(fromDir, aHash);
        if (!fs.statSync(aDir).isDirectory()) continue;
        for (const fname of fs.readdirSync(aDir).filter((n) => n.endsWith(".json")).sort()) {
          const t = readJson<TransitionRecord<Action>>(path.join(aDir, fname));
          const entries = byWorldline.get(t.worldlineHash) ?? [];
          entries.push(t);
          byWorldline.set(t.worldlineHash, entries);
        }
      }
    }

    const results: WorldlineInfo<Action>[] = [];
    for (const [worldlineHash, transitions] of byWorldline) {
      // Apply worldlineHashPrefix filter.
      if (worldlineHashPrefix && !worldlineHash.startsWith(worldlineHashPrefix)) continue;

      // Apply provenance filter.
      if (provenance && !transitions.some((t) => t.provenance === provenance)) continue;
      // Search the complete parent chain, not only this worldline head's edge.
      if (targetStateHash || matchesState) {
        const history = this.actionHistory(worldlineHash);
        const stateHashes = new Set(history.flatMap((entry) =>
          [entry.fromStateHash, entry.toStateHash]));
        if (targetStateHash && !stateHashes.has(targetStateHash)) continue;
        if (matchesState) {
          const matched = [...stateHashes].some((hash) => {
            const state = this.getState(hash);
            return state !== undefined && matchesCriterion(state, matchesState);
          });
          if (!matched) continue;
        }
      }

      // Apply lastAction filter: at least one transition must use the target action.
      if (targetActionHash) {
        if (!transitions.some((t) => t.actionHash === targetActionHash)) continue;
      }

      // Use the most recently created transition as the "last" one.
      const sorted = [...transitions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const lastTransition = sorted[sorted.length - 1];

      results.push({
        worldlineHash,
        parentWorldlineHash: lastTransition.parentWorldlineHash,
        lastTransition,
        transitionCount: transitions.length,
      });

      if (limit !== undefined && results.length >= limit) break;
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // actionHistory – ordered action steps leading to a state
  // ---------------------------------------------------------------------------

  /**
   * Return the ordered list of transitions that form the action history for a
   * given worldline hash (a chain of parent → child worldline hashes back to
   * the root).  Because each `worldlineHash` is deterministically derived from
   * `{ parentWorldlineHash, actionHash, toStateHash }`, we can reconstruct the
   * chain without a separate index by scanning all transitions and following
   * the parent pointers.
   *
   * Returns an empty array when the worldlineHash is unknown.
   */
  actionHistory(worldlineHash: string): ActionHistoryEntry<Action>[] {
    // Build a map: worldlineHash → representative transition record.
    const byWorldline = new Map<string, TransitionRecord<Action>>();
    const transitionsRoot = path.join(this.directory, "transitions");
    if (!fs.existsSync(transitionsRoot)) return [];

    for (const fromHash of fs.readdirSync(transitionsRoot).sort()) {
      const fromDir = path.join(transitionsRoot, fromHash);
      if (!fs.statSync(fromDir).isDirectory()) continue;
      for (const aHash of fs.readdirSync(fromDir).sort()) {
        const aDir = path.join(fromDir, aHash);
        if (!fs.statSync(aDir).isDirectory()) continue;
        for (const fname of fs.readdirSync(aDir).filter((n) => n.endsWith(".json")).sort()) {
          const t = readJson<TransitionRecord<Action>>(path.join(aDir, fname));
          // Keep the earliest (first) observed transition per worldlineHash.
          if (!byWorldline.has(t.worldlineHash)) byWorldline.set(t.worldlineHash, t);
        }
      }
    }

    if (!byWorldline.has(worldlineHash)) return [];

    // Walk the parent chain from the target worldlineHash back to the root.
    const chain: TransitionRecord<Action>[] = [];
    let current: string | undefined = worldlineHash;
    const visited = new Set<string>();
    while (current && byWorldline.has(current)) {
      if (visited.has(current)) break; // cycle guard
      visited.add(current);
      const t: TransitionRecord<Action> = byWorldline.get(current)!;
      chain.push(t);
      const parent: string = t.parentWorldlineHash;
      // The root worldlineHash is derived from scopeHash + startStateHash and
      // will not appear as a child worldlineHash, so the walk terminates.
      current = parent === current ? undefined : (byWorldline.has(parent) ? parent : undefined);
    }

    // The chain was built backwards (leaf → root); reverse for chronological order.
    chain.reverse();

    return chain.map((t) => ({
      transition: t,
      fromStateHash: t.fromStateHash,
      action: t.action,
      actionHash: t.actionHash,
      toStateHash: t.toStateHash,
    }));
  }

  // ---------------------------------------------------------------------------
  // simulate – replay wrapper with full artifact hydration
  // ---------------------------------------------------------------------------

  /**
   * Like `replay()` but enriches each step with the full artifact list from
   * evidence records (blobs, file paths, mime types, roles).  Preserves
   * `complete` / `partial` / `conflicted` semantics exactly as `replay()`.
   */
  simulate(
    initialState: State,
    actions: Action[],
    options: { evidence?: "observed-only" | "include-inferred" } = {}
  ): SimulateResult<State, Action> {
    const replayResult = this.replay(initialState, actions, options);
    const fromState = initialState;
    const steps: SimulateStep<State, Action>[] = replayResult.steps.map((step, i) => {
      const prevState = i === 0 ? fromState : replayResult.steps[i - 1].state;
      const artifacts: SimulateArtifact[] = step.transition.evidence.flatMap((evId) => {
        const loaded = this.loadEvidence(evId);
        if (!loaded) return [];
        const { record } = loaded;
        const artifactPath = record.blobPath ?? record.path;
        return [{
          evidenceId: evId,
          kind: record.kind,
          role: record.role,
          mimeType: record.mimeType,
          artifactPath: artifactPath && fs.existsSync(artifactPath) ? artifactPath : undefined,
          metadata: record.metadata,
        }];
      });
      return {
        index: step.index,
        fromStateHash: step.fromStateHash,
        fromState: prevState,
        action: step.action,
        actionHash: step.actionHash,
        toStateHash: step.toStateHash,
        toState: step.state,
        provenance: step.transition.provenance,
        artifacts,
        transition: step.transition,
      };
    });
    return {
      status: replayResult.status,
      initialStateHash: replayResult.initialStateHash,
      finalKnownStateHash: replayResult.finalKnownStateHash,
      finalKnownState: replayResult.finalKnownState,
      steps,
      frontier: replayResult.frontier,
    };
  }
}

export class WorldlineRegistry {
  constructor(readonly rootDirectory = path.join(process.cwd(), ".knowhow", "worldlines")) {}

  open<State, Action, Observation = unknown>(
    options: OpenWorldlineOptions<State, Action, Observation>
  ): Worldline<State, Action, Observation> {
    return new Worldline(this.rootDirectory, options);
  }
}
