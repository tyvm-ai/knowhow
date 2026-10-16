import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { BaseControl, InputItem } from "../types";
import type { Channel, ChannelContext } from "./Channel";

/**
 * The file input-stream protocol (design §3a), used for agent `input.txt`.
 *
 *  1. Writers only APPEND, one `O_APPEND` write per record (`appendInput`).
 *  2. Framing: one JSON line per item. Raw text lines (echo >> input.txt,
 *     editors) are still accepted: consecutive raw lines form ONE message; a
 *     raw line starting with "/" is its own item (so a `/poke` never swallows
 *     the messages around it).
 *  3. Reading starts at a saved cursor `{inode, offset}` and stops at the last
 *     complete newline; a half-written trailing line waits (it is delivered
 *     after `partialSettleMs` of no growth, for writers that omit the final
 *     newline).
 *  4. The cursor is stored in state by `consume()` in the same version as the
 *     item's effect.
 *  5. Trimming happens only after that version is persisted: rename
 *     `input.txt` -> `input.txt.consuming`, drain what was appended meanwhile,
 *     delete it, reset the cursor. The file is never truncated.
 *
 * A cursor whose inode differs from the file's means the file was replaced
 * (rotated by us, or rewritten by an editor): reading restarts at offset 0.
 */

export interface FileCursor {
  inode: number;
  offset: number;
}

export type RawInputItem = Omit<InputItem, "source">;

export interface AppendInputRecord {
  id?: string;
  kind?: string;
  text?: string;
  payload?: unknown;
  from?: string;
  at?: string;
}

/** Append one JSON line with a single O_APPEND write. Safe for concurrent writers. */
export function appendInput(filePath: string, item: AppendInputRecord): InputItemRecord {
  const record: InputItemRecord = {
    id: item.id ?? randomUUID(),
    kind: item.kind ?? "message",
    from: item.from,
    at: item.at ?? new Date().toISOString(),
    text: item.text,
    payload: item.payload,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buf = Buffer.from(JSON.stringify(record) + "\n", "utf8");
  const fd = fs.openSync(filePath, "a");
  try {
    let written = 0;
    while (written < buf.length) {
      written += fs.writeSync(fd, buf, written, buf.length - written);
    }
  } finally {
    fs.closeSync(fd);
  }
  return record;
}

export interface InputItemRecord {
  id: string;
  kind: string;
  from?: string;
  at: string;
  text?: string;
  payload?: unknown;
}

function parseLines(
  lines: Array<{ text: string; offset: number }>,
  inode: number
): RawInputItem[] {
  const items: RawInputItem[] = [];
  let raw: { texts: string[]; offset: number } | undefined;
  const flushRaw = () => {
    if (!raw) return;
    items.push({
      id: `${inode}:${raw.offset}`,
      kind: "message",
      payload: { text: raw.texts.join("\n") },
      at: new Date().toISOString(),
    });
    raw = undefined;
  };
  for (const line of lines) {
    const trimmed = line.text.trim();
    if (!trimmed) continue;
    let rec: any;
    if (trimmed.startsWith("{")) {
      try {
        rec = JSON.parse(trimmed);
      } catch {
        rec = undefined;
      }
    }
    if (rec && typeof rec === "object" && !Array.isArray(rec) && (rec.kind || rec.text !== undefined || rec.payload !== undefined)) {
      flushRaw();
      const { id, kind, from, at, payload, ...rest } = rec;
      items.push({
        id: id ?? `${inode}:${line.offset}`,
        kind: kind ?? "message",
        payload: payload !== undefined ? payload : rest,
        from,
        at: at ?? new Date().toISOString(),
      });
    } else if (trimmed.startsWith("/")) {
      flushRaw();
      items.push({
        id: `${inode}:${line.offset}`,
        kind: "message",
        payload: { text: trimmed },
        at: new Date().toISOString(),
      });
    } else {
      if (!raw) raw = { texts: [], offset: line.offset };
      raw.texts.push(line.text.replace(/\r$/, ""));
    }
  }
  flushRaw();
  return items;
}

export interface InputBatch {
  items: RawInputItem[];
  cursor: FileCursor;
  /** file size when read */
  size: number;
  /** a trailing line without newline was left unread */
  partialPending: boolean;
  exists: boolean;
}

/** Read new records from `cursor` up to the last complete newline. */
export async function readInputBatch(
  filePath: string,
  cursor: FileCursor | undefined,
  opts: { includePartial?: boolean } = {}
): Promise<InputBatch> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, "r");
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      return {
        items: [],
        cursor: cursor ?? { inode: 0, offset: 0 },
        size: 0,
        partialPending: false,
        exists: false,
      };
    }
    throw e;
  }
  try {
    const st = await handle.stat();
    let offset = cursor && cursor.inode === st.ino ? cursor.offset : 0;
    if (offset > st.size) offset = 0; // truncated behind our back
    const length = st.size - offset;
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await handle.read(buf, read, length - read, offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const data = buf.subarray(0, read);
    const lastNl = data.lastIndexOf(0x0a);
    const completeLen = opts.includePartial ? data.length : lastNl + 1;
    const complete = data.subarray(0, completeLen);
    const text = complete.toString("utf8");
    const lines: Array<{ text: string; offset: number }> = [];
    let pos = offset;
    for (const piece of text.split("\n")) {
      lines.push({ text: piece, offset: pos });
      pos += Buffer.byteLength(piece, "utf8") + 1;
    }
    return {
      items: parseLines(lines, st.ino),
      cursor: { inode: st.ino, offset: offset + completeLen },
      size: st.size,
      partialPending: !opts.includePartial && completeLen < data.length,
      exists: true,
    };
  } finally {
    await handle.close();
  }
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface FileInputChannelOptions {
  path: string;
  id?: string;
  /** poll interval (fallback for unreliable fs.watch). Default 250ms. */
  pollMs?: number;
  /** deliver a trailing line without newline once the file stopped growing this long. Default 1000ms. */
  partialSettleMs?: number;
  /** use fs.watch as a wake-up hint (default true) */
  watch?: boolean;
  /** trim `input.txt` after consumption is persisted (default true) */
  trim?: boolean;
}

/** Input channel over an append-only file (see protocol above). */
export class FileInputChannel<
  S = any,
  C extends BaseControl = BaseControl,
  E = any,
> implements Channel<S, C, E>
{
  readonly id: string;
  readonly direction = "in" as const;
  private ctx?: ChannelContext<S, C, E>;
  private cursor?: FileCursor;
  private timer?: ReturnType<typeof setInterval>;
  private watcher?: fs.FSWatcher;
  private tail: Promise<unknown> = Promise.resolve();
  private scheduled?: Promise<void>;
  private stopped = false;
  private partialSeen?: { size: number; since: number };

  constructor(private opts: FileInputChannelOptions) {
    this.id = opts.id ?? "fs";
  }

  private get consumingPath() {
    return this.opts.path + ".consuming";
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => {});
    return p;
  }

  async start(ctx: ChannelContext<S, C, E>): Promise<void> {
    this.ctx = ctx;
    this.stopped = false;
    this.cursor = ctx.cursor() as FileCursor | undefined;
    await this.poke();
    const dir = path.dirname(this.opts.path);
    if (this.opts.watch !== false) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const base = path.basename(this.opts.path);
        this.watcher = fs.watch(dir, (_ev, name) => {
          if (!name || name === base) void this.poke();
        });
        this.watcher.on("error", () => {});
        (this.watcher as any).unref?.();
      } catch {
        // fs.watch is only a hint; polling still works
      }
    }
    this.timer = setInterval(() => void this.poke(), this.opts.pollMs ?? 250);
    (this.timer as any).unref?.();
  }

  /** Run one read cycle now (coalesced). Resolves when it ran. */
  poke(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.scheduled) return this.scheduled;
    const p = this.lock(async () => {
      this.scheduled = undefined;
      try {
        await this.cycle();
      } catch (e: any) {
        this.ctx?.log.error(`input channel ${this.id} cycle failed: ${e?.message ?? e}`);
      }
    });
    this.scheduled = p;
    return p;
  }

  async flush(): Promise<void> {
    await this.poke();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    this.timer = undefined;
    this.watcher = undefined;
    await this.tail;
  }

  /** Deliver; true when the process recorded the cursor (i.e. consumed). */
  private async deliver(items: RawInputItem[], cursor: FileCursor): Promise<number | undefined> {
    const ctx = this.ctx!;
    const version = await ctx.deliver(items, cursor);
    const recorded = ctx.cursor();
    if (sameJson(recorded, cursor)) {
      this.cursor = cursor;
      return version;
    }
    // not consumed: re-read from the last consumed cursor on the next fire
    this.cursor = recorded as FileCursor | undefined;
    return undefined;
  }

  private async cycle(): Promise<void> {
    if (fs.existsSync(this.consumingPath)) await this.finishTrim();
    if (this.stopped) return;
    let batch = await readInputBatch(this.opts.path, this.cursor);
    if (batch.partialPending) {
      const now = Date.now();
      if (this.partialSeen && this.partialSeen.size === batch.size) {
        if (now - this.partialSeen.since >= (this.opts.partialSettleMs ?? 1000)) {
          batch = await readInputBatch(this.opts.path, this.cursor, { includePartial: true });
          this.partialSeen = undefined;
        }
      } else {
        this.partialSeen = { size: batch.size, since: now };
      }
    } else {
      this.partialSeen = undefined;
    }
    if (!batch.items.length) {
      // blank lines only / new file: advance locally, nothing to record
      if (batch.exists) this.cursor = batch.cursor;
      return;
    }
    const version = await this.deliver(batch.items, batch.cursor);
    if (version !== undefined && this.opts.trim !== false) this.scheduleTrim(version);
  }

  private scheduleTrim(version: number) {
    const ctx = this.ctx!;
    ctx
      .persisted(version)
      .then(() => this.lock(() => this.doTrim()))
      .catch(() => {});
  }

  /** rename + drain + delete; only when the persisted cursor is at EOF. */
  private async doTrim(): Promise<void> {
    if (this.stopped || !this.ctx) return;
    const c = this.ctx.cursor() as FileCursor | undefined;
    if (!c || !c.offset || !this.cursor || !sameJson(c, this.cursor)) return;
    let st: fs.Stats;
    try {
      st = fs.statSync(this.opts.path);
    } catch {
      return;
    }
    if (st.ino !== c.inode || st.size !== c.offset) return;
    if (fs.existsSync(this.consumingPath)) return;
    fs.renameSync(this.opts.path, this.consumingPath);
    await this.finishTrim();
  }

  /** Idempotent: drain leftovers of `input.txt.consuming`, delete it, reset the cursor. */
  private async finishTrim(): Promise<void> {
    const ctx = this.ctx!;
    let st: fs.Stats;
    try {
      st = fs.statSync(this.consumingPath);
    } catch {
      return;
    }
    if (!this.cursor || this.cursor.inode !== st.ino) {
      // fully consumed in an earlier run (cursor already reset)
      fs.rmSync(this.consumingPath, { force: true });
      return;
    }
    for (let i = 0; i < 3; i++) {
      const batch = await readInputBatch(this.consumingPath, this.cursor, { includePartial: true });
      if (batch.cursor.offset === this.cursor.offset) break;
      if (batch.items.length) {
        const v = await this.deliver(batch.items, batch.cursor);
        if (v === undefined) return; // not consumed: keep the file, retry next cycle
        await ctx.persisted(v);
      } else {
        this.cursor = batch.cursor;
      }
    }
    fs.rmSync(this.consumingPath, { force: true });
    const reset: FileCursor = { inode: 0, offset: 0 };
    this.cursor = reset;
    await ctx.deliver([], reset);
  }
}
