import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { BaseControl, ProcessDocument, Unsubscribe } from "../types";
import { DuplexChannel } from "./base";
import { OutputChannel } from "./base";
import type { Channel, ChannelContext, DocSource, OutputPolicy } from "./Channel";
import { FileInputChannel, appendInput } from "./inputStream";
import type { FileInputChannelOptions } from "./inputStream";

/** Atomic write: tmp file in the same dir + rename. */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fs.promises.rename(tmp, filePath);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8")) as T;
  } catch (e: any) {
    if (e?.code === "ENOENT" || e instanceof SyntaxError) return undefined;
    throw e;
  }
}

/** Output channel: the whole document, atomically, to one JSON file. */
export class JsonFileChannel<
  S = any,
  C extends BaseControl = BaseControl,
  E = any,
> extends OutputChannel<S, C, E> {
  readonly id: string;

  constructor(
    private filePath: string,
    opts: { id?: string; policy?: OutputPolicy } = {}
  ) {
    super();
    this.id = opts.id ?? "json-file";
    this.policy = opts.policy;
  }

  async publish(doc: ProcessDocument<S, C>): Promise<void> {
    await writeJsonAtomic(this.filePath, doc);
  }
}

/**
 * Input channel: `control.json` (written by outsiders) -> `applyControl`.
 * The file holds a (partial) control object; re-applying an identical control
 * is a no-op in the process, so re-reads are harmless. Unparseable content is
 * logged and ignored (the channel owns interpretation).
 */
export class ControlFileChannel<S = any, C extends BaseControl = BaseControl, E = any>
  implements Channel<S, C, E>
{
  readonly id: string;
  readonly direction = "in" as const;
  private ctx?: ChannelContext<S, C, E>;
  private timer?: ReturnType<typeof setInterval>;
  private watcher?: fs.FSWatcher;
  private last?: string;

  constructor(
    private filePath: string,
    private opts: { id?: string; pollMs?: number; watch?: boolean } = {}
  ) {
    this.id = opts.id ?? "control-file";
  }

  async start(ctx: ChannelContext<S, C, E>): Promise<void> {
    this.ctx = ctx;
    await this.check();
    if (this.opts.watch !== false) {
      try {
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true });
        const base = path.basename(this.filePath);
        this.watcher = fs.watch(dir, (_e, name) => {
          if (!name || name === base) void this.check();
        });
        this.watcher.on("error", () => {});
        (this.watcher as any).unref?.();
      } catch {
        // hint only
      }
    }
    this.timer = setInterval(() => void this.check(), this.opts.pollMs ?? 250);
    (this.timer as any).unref?.();
  }

  async check(): Promise<void> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    if (text === this.last) return;
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return; // possibly mid-write by a non-atomic writer; retry on next tick
    }
    this.last = text;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.ctx?.log.warn(`${this.id}: ignoring non-object control in ${this.filePath}`);
      return;
    }
    this.ctx?.applyControl(parsed as Partial<C>);
  }

  async flush(): Promise<void> {
    await this.check();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    this.timer = this.watcher = undefined;
  }
}

/** Mirror-side write of control.json (merge + atomic replace). */
export async function writeControlFile(filePath: string, patch: object): Promise<void> {
  const current = (await readJson<object>(filePath)) ?? {};
  await writeJsonAtomic(filePath, { ...current, ...patch });
}

/**
 * Directory channel, duplex:
 *   state.json    (out)  the full document, atomic rewrite
 *   control.json  (in)   control patch from outside
 *   input.txt     (in)   input stream (see inputStream.ts)
 * Also a `DocSource`, so `ProcessMirror.open(new FsProcessChannel(dir))` works
 * from another process without attaching it.
 */
export class FsProcessChannel<S = any, C extends BaseControl = BaseControl, E = any>
  extends DuplexChannel<S, C, E>
  implements DocSource<S, C, E>
{
  readonly id: string;
  private control: ControlFileChannel<S, C, E>;
  private input: FileInputChannel<S, C, E>;
  private pollMs: number;

  constructor(
    readonly dir: string,
    opts: {
      id?: string;
      policy?: OutputPolicy;
      pollMs?: number;
      input?: Partial<FileInputChannelOptions>;
    } = {}
  ) {
    super();
    this.id = opts.id ?? "fs";
    this.policy = opts.policy;
    this.pollMs = opts.pollMs ?? 250;
    this.control = new ControlFileChannel(path.join(dir, "control.json"), {
      id: this.id,
      pollMs: this.pollMs,
    });
    this.input = new FileInputChannel({
      pollMs: this.pollMs,
      ...opts.input,
      id: this.id,
      path: path.join(dir, "input.txt"),
    });
  }

  get statePath() {
    return path.join(this.dir, "state.json");
  }
  get controlPath() {
    return path.join(this.dir, "control.json");
  }
  get inputPath() {
    return path.join(this.dir, "input.txt");
  }

  protected async onStart(): Promise<void> {
    await this.control.start(this.ctx);
    await this.input.start(this.ctx);
  }

  async publish(doc: ProcessDocument<S, C>): Promise<void> {
    await writeJsonAtomic(this.statePath, doc);
  }

  async flush(): Promise<void> {
    await this.control.flush();
    await this.input.flush();
  }

  async stop(): Promise<void> {
    await this.control.stop();
    await this.input.stop();
  }

  // ---- DocSource (mirror side) ----
  readDocument(): Promise<ProcessDocument<S, C> | undefined> {
    return readJson<ProcessDocument<S, C>>(this.statePath);
  }

  watchDocument(cb: (doc: ProcessDocument<S, C>, events: E[]) => void): Unsubscribe {
    let lastText: string | undefined;
    let stopped = false;
    const check = async () => {
      let text: string;
      try {
        text = await fs.promises.readFile(this.statePath, "utf8");
      } catch {
        return;
      }
      if (stopped || text === lastText) return;
      try {
        const doc = JSON.parse(text) as ProcessDocument<S, C>;
        lastText = text;
        cb(doc, []);
      } catch {
        // partial read by a non-atomic writer: retry next tick
      }
    };
    let watcher: fs.FSWatcher | undefined;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      watcher = fs.watch(this.dir, (_e, name) => {
        if (!name || name === "state.json") void check();
      });
      watcher.on("error", () => {});
      (watcher as any).unref?.();
    } catch {
      // hint only
    }
    const timer = setInterval(() => void check(), this.pollMs);
    (timer as any).unref?.();
    // do not replay the current document as a "change"
    readJson<any>(this.statePath).then((d) => {
      if (d && lastText === undefined) lastText = JSON.stringify(d, null, 2);
    });
    return () => {
      stopped = true;
      clearInterval(timer);
      watcher?.close();
    };
  }

  async writeControl(patch: Partial<C>): Promise<void> {
    await writeControlFile(this.controlPath, patch);
  }

  async appendInput(item: {
    id?: string;
    kind?: string;
    text?: string;
    payload?: unknown;
    from?: string;
  }): Promise<void> {
    appendInput(this.inputPath, item);
  }
}
