/**
 * ChatHistoryIndex — an embedding index over past chat interactions.
 *
 * Every terminal chat task leaves two artifacts behind: the user's input in
 * `.knowhow/chats/history.json` and the full agent run in
 * `.knowhow/chats/sessions/<taskId>.json` (which contains the finalAnswer).
 * This index joins them into one entry per task — prompt, final answer and
 * where to find the full transcript — plus an embedding vector, so a new chat
 * interaction can be seeded with:
 *   - the last few interactions (recency window), and
 *   - the most relevant older interactions (cosine similarity),
 * instead of the whole in-process history, and the agent can search the rest
 * on demand (searchChatHistory tool).
 */
import fs from "fs";
import path from "path";
import { Clients } from "../clients";
import { cosineSimilarity } from "../utils";
import { DEFAULT_API_URL } from "../remotes";
import { ChatInteraction } from "../types";

export interface ChatHistoryMetadata {
  taskId: string;
  /** Session transcript, relative to the project root. */
  sessionFile?: string;
  agentName?: string;
  model?: string;
  startTime?: number;
  endTime?: number;
  totalCost?: number;
  /** "chat" = typed by the user in the terminal chat; "agent" = spawned by an agent / CLI. */
  source: "chat" | "agent";
  /** Remote (knowhow-web) task id when the task was synced. */
  knowhowTaskId?: string;
  /** API url of the remote — only recorded when it is not production. */
  apiUrl?: string;
}

export interface ChatHistoryEntry {
  id: string;
  input: string;
  output: string;
  vector?: number[];
  embeddingModel?: string;
  metadata: ChatHistoryMetadata;
}

export interface ChatHistorySearchResult extends ChatHistoryEntry {
  similarity: number;
}

export interface ChatHistoryOptions {
  /** false = legacy behaviour (JSON of every interaction in this process). */
  enabled: boolean;
  /** How many of the most recent interactions to include in full. */
  recent: number;
  /** Ignore "recent" interactions older than this (0 = no limit). */
  recentMaxAgeHours: number;
  /** How many relevant older interactions to include (by similarity). */
  relevant: number;
  /** Minimum cosine similarity for a relevant interaction. */
  minSimilarity: number;
  /** Max chars of each recent answer. */
  recentOutputChars: number;
  /** Max chars of each relevant (older) prompt / answer. */
  relevantInputChars: number;
  relevantOutputChars: number;
  /** Also index tasks that weren't typed in the chat (sub-agents, `knowhow agent`). */
  includeAgentTasks: boolean;
}

export const DEFAULT_CHAT_HISTORY_OPTIONS: ChatHistoryOptions = {
  enabled: true,
  recent: 4,
  recentMaxAgeHours: 24,
  relevant: 10,
  minSimilarity: 0.4,
  recentOutputChars: 3000,
  relevantInputChars: 300,
  relevantOutputChars: 400,
  includeAgentTasks: false,
};

export const DEFAULT_HISTORY_EMBEDDING_MODEL = "text-embedding-3-small";

interface IndexFile {
  version: 1;
  entries: ChatHistoryEntry[];
  /** session file name -> mtimeMs when it was processed (skips re-reading). */
  seen: Record<string, number>;
}

export type EmbedFn = (text: string) => Promise<number[]>;

export interface ChatHistoryIndexOptions {
  /** Project root containing `.knowhow`. Default: cwd. */
  root?: string;
  sessionsDir?: string;
  historyFile?: string;
  indexFile?: string;
  embeddingModel?: string;
  /** Override the embedding call (tests). */
  embed?: EmbedFn;
  includeAgentTasks?: boolean;
  /** Active remote API url; recorded on remote tasks when it isn't prod. */
  apiUrl?: string;
}

/** Characters fed to the embedding model per entry (≈1.5k tokens). */
const EMBED_TEXT_CHARS = 6000;
/** Session heads are read to find initialInput without parsing 100s of KB. */
const HEAD_BYTES = 64 * 1024;

export function truncate(text: string, max: number): string {
  if (!text) return "";
  if (max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}… [+${text.length - max} chars]`;
}

/** The answer of the last finalAnswer call in a session's threads. */
export function extractFinalAnswer(threads: any[][] | undefined): string {
  if (!Array.isArray(threads)) return "";
  for (let t = threads.length - 1; t >= 0; t--) {
    const thread = threads[t];
    if (!Array.isArray(thread)) continue;
    for (let i = thread.length - 1; i >= 0; i--) {
      const msg = thread[i];
      if (!msg) continue;
      if (
        msg.role === "tool" &&
        typeof msg.name === "string" &&
        msg.name.endsWith("finalAnswer") &&
        typeof msg.content === "string"
      ) {
        return msg.content;
      }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const call = msg.tool_calls.find((c: any) =>
          String(c?.function?.name ?? "").endsWith("finalAnswer")
        );
        if (call) {
          try {
            const args = JSON.parse(call.function.arguments || "{}");
            if (typeof args.answer === "string") return args.answer;
          } catch {
            // fall through
          }
        }
      }
    }
  }
  return "";
}

/** Read `initialInput` from the first bytes of a session file. */
export function readSessionInitialInput(filePath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const bytes = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const head = buffer.toString("utf8", 0, bytes);
    const match = head.match(/"initialInput"\s*:\s*("(?:[^"\\]|\\.)*")/);
    if (match) return JSON.parse(match[1]);
    if (!head.includes('"initialInput"')) return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  // initialInput longer than the head: parse the whole file.
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")).initialInput;
  } catch {
    return undefined;
  }
}

/** Only backend task UUIDs are remote ids (old sessions stored local slugs). */
export function remoteTaskIdForMetadata(value?: string): string | undefined {
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

export function remoteApiUrlForMetadata(apiUrl?: string): string | undefined {
  if (!apiUrl) return undefined;
  const normalized = apiUrl.replace(/\/+$/, "");
  return normalized === DEFAULT_API_URL ? undefined : normalized;
}

function embeddingText(entry: Pick<ChatHistoryEntry, "input" | "output">) {
  return `User: ${entry.input}\n\nAssistant: ${entry.output}`.slice(
    0,
    EMBED_TEXT_CHARS
  );
}

function roundVector(vector: number[]): number[] {
  // 6 significant decimals keeps cosine similarity exact to ~1e-6 and
  // halves the index size.
  return vector.map((v) => Math.round(v * 1e6) / 1e6);
}

export class ChatHistoryIndex {
  readonly root: string;
  readonly sessionsDir: string;
  readonly historyFile: string;
  readonly indexFile: string;
  readonly embeddingModel: string;
  private includeAgentTasks: boolean;
  private apiUrl?: string;
  private embedFn?: EmbedFn;
  private data?: IndexFile;
  private syncing?: Promise<void>;

  constructor(options: ChatHistoryIndexOptions = {}) {
    this.root = options.root ?? process.cwd();
    this.sessionsDir =
      options.sessionsDir ?? path.join(this.root, ".knowhow/chats/sessions");
    this.historyFile =
      options.historyFile ?? path.join(this.root, ".knowhow/chats/history.json");
    this.indexFile =
      options.indexFile ??
      path.join(this.root, ".knowhow/chats/history-index.json");
    this.embeddingModel =
      options.embeddingModel || DEFAULT_HISTORY_EMBEDDING_MODEL;
    this.includeAgentTasks = !!options.includeAgentTasks;
    this.embedFn = options.embed;
    this.apiUrl = options.apiUrl;
  }

  // ─── persistence ──────────────────────────────────────────────────────────

  private load(): IndexFile {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, "utf8"));
      if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
        this.data = { version: 1, entries: parsed.entries, seen: parsed.seen || {} };
        return this.data;
      }
    } catch {
      // missing / corrupt: rebuild
    }
    this.data = { version: 1, entries: [], seen: {} };
    return this.data;
  }

  save(): void {
    const data = this.load();
    fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
    const tmp = `${this.indexFile}.${process.pid}.tmp`;
    // One entry per line keeps the file diffable/greppable.
    const body =
      `{"version":1,"seen":${JSON.stringify(data.seen)},"entries":[\n` +
      data.entries.map((e) => JSON.stringify(e)).join(",\n") +
      "\n]}\n";
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, this.indexFile);
  }

  entries(): ChatHistoryEntry[] {
    return this.load().entries;
  }

  get(taskId: string): ChatHistoryEntry | undefined {
    return this.entries().find((e) => e.id === taskId);
  }

  // ─── embedding ────────────────────────────────────────────────────────────

  async embed(text: string): Promise<number[]> {
    if (this.embedFn) return this.embedFn(text);
    // Providers register asynchronously at startup; a call made in the first
    // moments of a process can race them.
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await Clients.createEmbedding("", {
          model: this.embeddingModel,
          input: text,
        });
        return response.data[0].embedding;
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        if (attempt >= 4 || !/not registered|does not have/.test(message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }

  /** Embed every entry that has no vector (or one from another model). */
  async embedMissing(concurrency = 8): Promise<number> {
    const pending = this.entries().filter(
      (e) => !e.vector?.length || e.embeddingModel !== this.embeddingModel
    );
    let done = 0;
    for (let i = 0; i < pending.length; i += concurrency) {
      const batch = pending.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (entry) => {
          try {
            entry.vector = roundVector(await this.embed(embeddingText(entry)));
            entry.embeddingModel = this.embeddingModel;
            done++;
          } catch (error) {
            // leave unembedded; retried on the next sync
          }
        })
      );
    }
    if (done) this.save();
    return done;
  }

  // ─── building entries ─────────────────────────────────────────────────────

  private chatInputs(): Set<string> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.historyFile, "utf8"));
      return new Set<string>((parsed.inputs || []).map((s: string) => s.trim()));
    } catch {
      return new Set();
    }
  }

  /**
   * Scan session files and add completed tasks that aren't indexed yet.
   * Files are only read once per modification (tracked in `seen`).
   */
  async sync(options: { embed?: boolean } = {}): Promise<{ added: number; embedded: number }> {
    const data = this.load();
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.sessionsDir).filter((f) => f.endsWith(".json"));
    } catch {
      return { added: 0, embedded: 0 };
    }
    const chatInputs = this.chatInputs();
    const indexed = new Set(data.entries.map((e) => e.id));
    let added = 0;
    let changed = false;

    for (const file of files) {
      const fullPath = path.join(this.sessionsDir, file);
      let mtimeMs = 0;
      try {
        mtimeMs = Math.floor(fs.statSync(fullPath).mtimeMs);
      } catch {
        continue;
      }
      if (data.seen[file] === mtimeMs) continue;

      const taskId = file.replace(/\.json$/, "");
      if (indexed.has(taskId)) {
        data.seen[file] = mtimeMs;
        changed = true;
        continue;
      }

      const initialInput = readSessionInitialInput(fullPath);
      if (!initialInput) {
        data.seen[file] = mtimeMs;
        changed = true;
        continue;
      }
      const source = chatInputs.has(initialInput.trim()) ? "chat" : "agent";
      if (source === "agent" && !this.includeAgentTasks) {
        data.seen[file] = mtimeMs;
        changed = true;
        continue;
      }

      let session: any;
      try {
        session = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      } catch {
        continue; // being written; retry next sync
      }
      const output = extractFinalAnswer(session.threads);
      if (!output) {
        // Running tasks may still answer: only skip finished ones for good.
        if (session.status !== "running") {
          data.seen[file] = mtimeMs;
          changed = true;
        }
        continue;
      }

      data.entries.push({
        id: session.taskId || taskId,
        input: session.initialInput || initialInput,
        output,
        metadata: {
          taskId: session.taskId || taskId,
          sessionFile: path.relative(this.root, fullPath),
          agentName: session.agentName,
          model: session.model,
          startTime: session.startTime,
          endTime: session.endTime || session.lastUpdated,
          totalCost: session.totalCost,
          source,
          ...(remoteTaskIdForMetadata(session.knowhowTaskId) && {
            knowhowTaskId: session.knowhowTaskId,
          }),
          ...(remoteTaskIdForMetadata(session.knowhowTaskId) &&
            remoteApiUrlForMetadata(session.apiUrl || this.apiUrl) && {
              apiUrl: remoteApiUrlForMetadata(session.apiUrl || this.apiUrl),
            }),
        },
      });
      indexed.add(taskId);
      data.seen[file] = mtimeMs;
      added++;
      changed = true;
    }

    if (changed) this.save();
    const embedded = options.embed === false ? 0 : await this.embedMissing();
    return { added, embedded };
  }

  /** Background-safe sync: concurrent callers share one run. */
  syncOnce(): Promise<void> {
    if (!this.syncing) {
      this.syncing = this.sync()
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          this.syncing = undefined;
        });
    }
    return this.syncing;
  }

  /** Add or replace one entry (e.g. when a chat task finishes) and embed it. */
  async upsert(entry: Omit<ChatHistoryEntry, "vector" | "embeddingModel">) {
    const data = this.load();
    const existing = data.entries.findIndex((e) => e.id === entry.id);
    const record: ChatHistoryEntry = { ...entry };
    if (existing >= 0) data.entries[existing] = record;
    else data.entries.push(record);
    if (entry.metadata.sessionFile) {
      const file = path.basename(entry.metadata.sessionFile);
      // Let the next sync re-check the file only if it changes again.
      try {
        data.seen[file] = Math.floor(
          fs.statSync(path.join(this.sessionsDir, file)).mtimeMs
        );
      } catch {
        // ignore
      }
    }
    try {
      record.vector = roundVector(await this.embed(embeddingText(record)));
      record.embeddingModel = this.embeddingModel;
    } catch {
      // stored without a vector; embedded on the next sync
    }
    this.save();
    return record;
  }

  // ─── querying ─────────────────────────────────────────────────────────────

  /** Most recent entries first. */
  recent(limit: number, maxAgeHours = 0, now = Date.now()): ChatHistoryEntry[] {
    const cutoff = maxAgeHours > 0 ? now - maxAgeHours * 3600_000 : 0;
    return [...this.entries()]
      .filter((e) => (e.metadata.endTime ?? e.metadata.startTime ?? 0) >= cutoff)
      .sort(
        (a, b) =>
          (b.metadata.endTime ?? b.metadata.startTime ?? 0) -
          (a.metadata.endTime ?? a.metadata.startTime ?? 0)
      )
      .slice(0, limit);
  }

  /** Rank entries by similarity to a query vector. */
  rank(
    queryVector: number[],
    options: { exclude?: Set<string>; limit?: number; minSimilarity?: number; before?: number } = {}
  ): ChatHistorySearchResult[] {
    const { exclude, limit = 10, minSimilarity = 0, before } = options;
    return this.entries()
      .filter((e) => e.vector?.length && !exclude?.has(e.id))
      .filter((e) => !before || (e.metadata.endTime ?? e.metadata.startTime ?? 0) < before)
      .map((e) => ({ ...e, similarity: cosineSimilarity(e.vector, queryVector) }))
      .filter((e) => e.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  async search(
    query: string,
    options: { exclude?: Set<string>; limit?: number; minSimilarity?: number } = {}
  ): Promise<ChatHistorySearchResult[]> {
    const vector = await this.embed(query.slice(0, EMBED_TEXT_CHARS));
    return this.rank(vector, options);
  }
}

// ─── prompt context ───────────────────────────────────────────────────────────

export interface ChatHistoryContext {
  text: string;
  recentIds: string[];
  relevant: { id: string; similarity: number }[];
}

function entryTime(e: ChatHistoryEntry): number {
  return e.metadata.endTime ?? e.metadata.startTime ?? 0;
}

function formatDate(ms?: number): string {
  if (!ms) return "unknown date";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function locationOf(e: ChatHistoryEntry): string {
  const parts = [`task ${e.id}`];
  if (e.metadata.knowhowTaskId) {
    parts.push(`remote task ${e.metadata.knowhowTaskId}`);
    if (e.metadata.apiUrl) parts.push(`api ${e.metadata.apiUrl}`);
  }
  return parts.join(", ");
}

/**
 * Build the history block for a new chat interaction: the last N
 * interactions plus the most relevant older ones, truncated so the block
 * stays roughly constant in size instead of growing with every task.
 */
export async function buildChatHistoryContext(params: {
  index: ChatHistoryIndex;
  input: string;
  /** Interactions from the running chat process (may not be indexed yet). */
  inProcess?: ChatInteraction[];
  options?: Partial<ChatHistoryOptions>;
  now?: number;
  /** Only use history that existed at this time (experiments / replays). */
  asOf?: number;
  /** Precomputed embedding of `input` (experiments). */
  queryVector?: number[];
}): Promise<ChatHistoryContext> {
  const options = { ...DEFAULT_CHAT_HISTORY_OPTIONS, ...(params.options || {}) };
  const now = params.now ?? Date.now();
  const asOf = params.asOf;
  const indexed = params.index
    .entries()
    .filter((e) => !asOf || entryTime(e) < asOf);

  // Recent window: index + this process's interactions (newest wins).
  const byId = new Map<string, ChatHistoryEntry>();
  for (const e of indexed) byId.set(e.id, e);
  for (const item of params.inProcess || []) {
    if (!item?.input) continue;
    const id = item.taskId || `inprocess-${byId.size}`;
    const existing = byId.get(id);
    if (existing && existing.output) continue;
    byId.set(id, {
      id,
      input: item.input,
      output: item.output || existing?.output || "",
      metadata: {
        ...(existing?.metadata || { taskId: id, source: "chat" }),
        endTime: existing?.metadata.endTime ?? now,
      },
    });
  }
  const cutoff =
    options.recentMaxAgeHours > 0 ? (asOf ?? now) - options.recentMaxAgeHours * 3600_000 : 0;
  const recent = [...byId.values()]
    .filter((e) => entryTime(e) >= cutoff)
    .sort((a, b) => entryTime(b) - entryTime(a))
    .slice(0, Math.max(0, options.recent))
    .reverse(); // oldest first, newest next to the current task

  let relevant: ChatHistorySearchResult[] = [];
  if (options.relevant > 0 && indexed.some((e) => e.vector?.length)) {
    try {
      const vector =
        params.queryVector ?? (await params.index.embed(params.input.slice(0, EMBED_TEXT_CHARS)));
      relevant = params.index.rank(vector, {
        exclude: new Set(recent.map((e) => e.id)),
        limit: options.relevant,
        minSimilarity: options.minSimilarity,
        before: asOf,
      });
    } catch {
      relevant = []; // no embedding provider: recency only
    }
  }

  if (!recent.length && !relevant.length) {
    return { text: "", recentIds: [], relevant: [] };
  }

  const lines: string[] = [
    "<ChatHistory>",
    "Earlier interactions from this project's terminal chat. They are context only and may not relate to the current task.",
    "Search older interactions with the searchChatHistory tool (enable it with enableTools if it is not enabled). Each entry's task id points to its full transcript in .knowhow/chats/sessions/<taskId>.json.",
  ];
  if (recent.length) {
    lines.push("", "## Most recent interactions (oldest first)");
    for (const e of recent) {
      lines.push(
        "",
        `### ${formatDate(entryTime(e))} — ${locationOf(e)}`,
        `User: ${e.input}`,
        `Assistant: ${e.output ? truncate(e.output, options.recentOutputChars) : "(still running, no answer yet)"}`
      );
    }
  }
  if (relevant.length) {
    lines.push("", "## Older interactions that may be relevant (most similar first, truncated)");
    for (const e of relevant) {
      lines.push(
        "",
        `### ${formatDate(entryTime(e))} — ${locationOf(e)} — similarity ${e.similarity.toFixed(2)}`,
        `User: ${truncate(e.input, options.relevantInputChars)}`,
        `Assistant: ${truncate(e.output, options.relevantOutputChars)}`
      );
    }
  }
  lines.push("</ChatHistory>");

  return {
    text: lines.join("\n"),
    recentIds: recent.map((e) => e.id),
    relevant: relevant.map((e) => ({ id: e.id, similarity: e.similarity })),
  };
}
