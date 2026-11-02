/**
 * Helpers for `knowhow replay` that deal with worker-routed tool calls.
 *
 * When a backend agent runs with workers attached (a `knowhow worker`, the
 * browser client worker, or the Chrome extension), their tools are exposed to
 * the agent as `worker_<index>_<tool>`. The backend writes the worker list
 * into the system prompt (`worker_<index>:\n{...worker json...}`), so the
 * recorded threads tell us which worker each index pointed at.
 */

export interface RecordedWorker {
  index: number;
  id: string;
  clientKind?: string | null;
  userAgent?: string;
  ephemeral?: boolean;
  userId?: string;
}

export interface ConnectedWorkerLike {
  id: string;
  userId?: string;
  connected?: boolean;
  clientKind?: string | null;
  userAgent?: string;
  lastConnected?: string;
}

export interface ResolvedWorker {
  index: number;
  id: string;
  /** Human-readable note about how this id was chosen. */
  note: string;
}

/** Tools that only manage the agent's own state; replaying them is noise. */
export const META_TOOLS = new Set([
  "listAvailableTools",
  "enableTools",
  "disableTools",
  "finalAnswer",
]);

export function isMetaTool(name: string): boolean {
  return META_TOOLS.has(name);
}

/** `worker_0_canvas_get` → `{ index: 0, tool: "canvas_get" }` */
export function parseWorkerToolName(
  name: string
): { index: number; tool: string } | null {
  const m = name.match(/^worker_(\d+)_(.+)$/);
  if (!m) return null;
  return { index: parseInt(m[1], 10), tool: m[2] };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && typeof (b as any).text === "string"
          ? (b as any).text
          : ""
      )
      .join("\n");
  }
  return "";
}

/** Extract the `worker_<i>: {...}` entries the backend wrote into the system prompt. */
export function extractWorkersFromThreads(threads: any[][]): RecordedWorker[] {
  const byIndex = new Map<number, RecordedWorker>();
  const re = /worker_(\d+):\s*(\{[^\n]*\})/g;
  for (const thread of threads || []) {
    for (const msg of thread || []) {
      if (!msg || msg.role !== "system") continue;
      const text = messageText(msg.content);
      if (!text.includes("worker_")) continue;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const index = parseInt(m[1], 10);
        if (byIndex.has(index)) continue;
        try {
          const w = JSON.parse(m[2]);
          if (w && typeof w.id === "string") {
            byIndex.set(index, {
              index,
              id: w.id,
              clientKind: w.clientKind ?? null,
              userAgent: w.userAgent,
              ephemeral: w.ephemeral,
              userId: w.userId,
            });
          }
        } catch {
          /* not JSON — ignore */
        }
      }
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/**
 * Parse `--workers`. Accepts a positional list (`idA,idB` → index 0, 1) or
 * explicit mappings (`0=idA,1=idB`), which can be mixed.
 */
export function parseWorkersOption(value: string | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!value) return out;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let position = 0;
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq > 0 && /^\d+$/.test(p.slice(0, eq))) {
      out.set(parseInt(p.slice(0, eq), 10), p.slice(eq + 1));
    } else {
      out.set(position, p);
    }
    position++;
  }
  return out;
}

/**
 * Decide which worker id each `worker_<i>` index routes to.
 *
 * Priority: explicit `--workers` override → the recorded worker if it is still
 * connected → (for ephemeral client workers, whose id changes on every
 * connection) the most recently connected worker of the same clientKind and
 * user → the recorded id as-is (the call will fail with a clear error).
 */
export function resolveWorkers(
  recorded: RecordedWorker[],
  overrides: Map<number, string>,
  connected: ConnectedWorkerLike[] | null
): ResolvedWorker[] {
  const indices = new Set<number>([
    ...recorded.map((w) => w.index),
    ...overrides.keys(),
  ]);
  const result: ResolvedWorker[] = [];
  const used = new Set<string>();

  for (const index of [...indices].sort((a, b) => a - b)) {
    const override = overrides.get(index);
    const recordedEntry = recorded.find((w) => w.index === index);
    const overrideIsLive =
      !!override &&
      (!connected || connected.some((c) => c.id === override && c.connected !== false));
    // An explicit id wins, unless it's a gone client worker the recorded task
    // can describe: the generated replay command pins the recorded id, but
    // browser/extension workers get a new id on every connection.
    if (override && (overrideIsLive || !recordedEntry?.clientKind)) {
      result.push({
        index,
        id: override,
        note: overrideIsLive ? "from --workers" : "from --workers, NOT connected",
      });
      used.add(override);
      continue;
    }
    const rec: RecordedWorker = override
      ? { ...recordedEntry!, id: override }
      : recordedEntry!;
    if (!connected) {
      result.push({ index, id: rec.id, note: "recorded (connection not checked)" });
      continue;
    }
    const live = connected.find((c) => c.id === rec.id && c.connected !== false);
    if (live) {
      result.push({ index, id: rec.id, note: "recorded, connected" });
      used.add(rec.id);
      continue;
    }
    if (rec.clientKind) {
      const candidates = connected
        .filter(
          (c) =>
            c.connected !== false &&
            c.clientKind === rec.clientKind &&
            (!rec.userId || !c.userId || c.userId === rec.userId) &&
            !used.has(c.id)
        )
        .sort((a, b) =>
          String(b.lastConnected || "").localeCompare(String(a.lastConnected || ""))
        );
      if (candidates[0]) {
        result.push({
          index,
          id: candidates[0].id,
          note: `recorded ${rec.clientKind} worker ${rec.id} is gone; using the connected ${rec.clientKind} worker`,
        });
        used.add(candidates[0].id);
        continue;
      }
    }
    result.push({ index, id: rec.id, note: "recorded, NOT connected" });
  }
  return result;
}
