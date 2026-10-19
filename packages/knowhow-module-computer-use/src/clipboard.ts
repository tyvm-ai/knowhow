import { spawn } from "child_process";
import { ComputerDriver, isUnsupportedError } from "./contracts";

/**
 * Clipboard service: native (driver) when available, else a CLI fallback.
 *
 *  - macOS:   pbpaste / pbcopy
 *  - Windows: powershell -NoProfile Get-Clipboard / Set-Clipboard (UTF-8, via stdin)
 *  - Linux:   wl-paste / wl-copy, then xclip -selection clipboard
 *
 * Change detection uses the native change count when present, else polls for
 * text inequality.
 */

export interface ClipboardSnapshot {
  /** Plain-text contents at snapshot time (null if the clipboard was unreadable). */
  text: string | null;
}

export interface CopySelectionOptions {
  /** Key chord that copies the selection. Default `["mod", "c"]`. */
  chord?: string[];
  /** How long to wait for the clipboard to receive text. Default 600 ms. */
  timeoutMs?: number;
  /** Restore the previous clipboard text afterwards. Default true. */
  restore?: boolean;
}

export type RunCommand = (
  cmd: string,
  args: string[],
  input?: string
) => Promise<string>;

export interface ClipboardServiceOptions {
  /** Resolve the active driver (for native clipboard methods). */
  getDriver?: () => Promise<ComputerDriver | null | undefined>;
  platform?: NodeJS.Platform;
  /** Override the process runner (tests). */
  runCommand?: RunCommand;
  /** Poll interval for change detection. Default 15 ms. */
  pollMs?: number;
}

/** Spawn `cmd`, optionally piping UTF-8 `input` to stdin; resolves stdout. */
export const defaultRunCommand: RunCommand = (cmd, args, input) =>
  new Promise<string>((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else
        reject(
          new Error(
            `${cmd} exited with ${code}: ${Buffer.concat(err).toString("utf8").trim()}`
          )
        );
    });
    child.stdin.on("error", () => {
      /* the process may exit before reading stdin (e.g. wl-copy forks) */
    });
    if (input !== undefined) child.stdin.end(Buffer.from(input, "utf8"));
    else child.stdin.end();
  });

const PS_UTF8_READ =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $t=Get-Clipboard -Raw; if ($null -ne $t) { [Console]::Out.Write($t) }";
const PS_UTF8_WRITE =
  "[Console]::InputEncoding=[System.Text.Encoding]::UTF8; $t=[Console]::In.ReadToEnd(); Set-Clipboard -Value $t";

export class ClipboardService {
  private getDriver?: ClipboardServiceOptions["getDriver"];
  private platform: NodeJS.Platform;
  private run: RunCommand;
  private pollMs: number;
  /** Cached result of which CLI worked on Linux (wl vs xclip). */
  private linuxTool: "wl" | "xclip" | null = null;

  constructor(opts: ClipboardServiceOptions = {}) {
    this.getDriver = opts.getDriver;
    this.platform = opts.platform ?? process.platform;
    this.run = opts.runCommand ?? defaultRunCommand;
    this.pollMs = Math.max(1, opts.pollMs ?? 15);
  }

  // ── native helpers ──

  private async nativeDriver(): Promise<ComputerDriver | null> {
    if (!this.getDriver) return null;
    try {
      return (await this.getDriver()) ?? null;
    } catch {
      return null;
    }
  }

  /** Try a native call; returns `{ ok: false }` when unsupported (→ CLI fallback). */
  private async tryNative<T>(
    pick: (d: ComputerDriver) => (() => Promise<T>) | undefined
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    const driver = await this.nativeDriver();
    if (!driver) return { ok: false };
    const fn = pick(driver);
    if (!fn) return { ok: false };
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (isUnsupportedError(e)) return { ok: false };
      throw e;
    }
  }

  // ── public API ──

  async readText(): Promise<string> {
    const native = await this.tryNative((d) =>
      d.clipboardReadText ? () => d.clipboardReadText!() : undefined
    );
    if (native.ok) return native.value ?? "";
    return this.cliRead();
  }

  async writeText(text: string): Promise<void> {
    const value = String(text ?? "");
    const native = await this.tryNative((d) =>
      d.clipboardWriteText ? () => d.clipboardWriteText!(value) : undefined
    );
    if (native.ok) return;
    await this.cliWrite(value);
  }

  /** Native change counter, or null when unavailable (callers poll text instead). */
  async changeCount(): Promise<number | null> {
    const native = await this.tryNative((d) =>
      d.clipboardChangeCount ? () => d.clipboardChangeCount!() : undefined
    );
    return native.ok ? native.value : null;
  }

  async snapshot(): Promise<ClipboardSnapshot> {
    try {
      return { text: await this.readText() };
    } catch {
      return { text: null };
    }
  }

  async restore(snapshot: ClipboardSnapshot): Promise<void> {
    if (!snapshot || snapshot.text === null) return;
    await this.writeText(snapshot.text);
  }

  /**
   * Wait until the clipboard changes (native change count when available, else
   * text inequality vs. the contents at call time). Resolves true on change,
   * false on timeout.
   */
  async waitForChange(opts: { timeoutMs?: number } = {}): Promise<boolean> {
    const timeoutMs = opts.timeoutMs ?? 600;
    const startCount = await this.changeCount();
    const startText = startCount === null ? await this.safeRead() : null;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (startCount !== null) {
        const now = await this.changeCount();
        if (now !== null && now !== startCount) return true;
      } else {
        const now = await this.safeRead();
        if (now !== startText) return true;
      }
      if (Date.now() >= deadline) return false;
      await sleep(this.pollMs);
    }
  }

  /**
     * snapshot text → write "" → send chord → wait until text is non-empty or timeout → read → restore snapshot → return the
   * text, or `null` if nothing was copied.
   *
   * `sendChord` is supplied by the caller (it presses the keys through the
   * driver/SDK so pause/dry-run rules still apply).
   */
  async copySelection(
    opts: CopySelectionOptions,
    sendChord: (chord: string[]) => Promise<void>
  ): Promise<string | null> {
    const chord = opts.chord ?? ["mod", "c"];
    const timeoutMs = opts.timeoutMs ?? 600;
    const restore = opts.restore !== false;

    const snap = await this.snapshot();
    let result: string | null = null;
    try {
      await this.writeText("");
      await sendChord(chord);
      const deadline = Date.now() + Math.max(0, timeoutMs);
      for (;;) {
        const text = await this.safeRead();
        if (text !== null && text !== "") {
          result = text;
          break;
        }
        if (Date.now() >= deadline) break;
        await sleep(this.pollMs);
      }
    } finally {
      if (restore) {
        try {
          await this.restore(snap);
        } catch {
          /* best-effort */
        }
      }
    }
    return result;
  }

  // ── CLI fallback ──

  private async safeRead(): Promise<string | null> {
    try {
      return await this.readText();
    } catch {
      return null;
    }
  }

  private async cliRead(): Promise<string> {
    switch (this.platform) {
      case "darwin":
        return this.run("pbpaste", []);
      case "win32":
        return stripTrailingPsNewline(
          await this.run("powershell", ["-NoProfile", "-Command", PS_UTF8_READ])
        );
      default:
        return this.linuxRead();
    }
  }

  private async cliWrite(text: string): Promise<void> {
    switch (this.platform) {
      case "darwin":
        await this.run("pbcopy", [], text);
        return;
      case "win32":
        await this.run("powershell", ["-NoProfile", "-Command", PS_UTF8_WRITE], text);
        return;
      default:
        await this.linuxWrite(text);
    }
  }

  private async linuxRead(): Promise<string> {
    const order: Array<"wl" | "xclip"> = this.linuxTool
      ? [this.linuxTool]
      : ["wl", "xclip"];
    let lastErr: unknown;
    for (const tool of order) {
      try {
        const out =
          tool === "wl"
            ? await this.run("wl-paste", ["--no-newline"])
            : await this.run("xclip", ["-selection", "clipboard", "-o"]);
        this.linuxTool = tool;
        return out;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error("No clipboard tool available (wl-paste / xclip)");
  }

  private async linuxWrite(text: string): Promise<void> {
    const order: Array<"wl" | "xclip"> = this.linuxTool
      ? [this.linuxTool]
      : ["wl", "xclip"];
    let lastErr: unknown;
    for (const tool of order) {
      try {
        if (tool === "wl") await this.run("wl-copy", [], text);
        else await this.run("xclip", ["-selection", "clipboard"], text);
        this.linuxTool = tool;
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error("No clipboard tool available (wl-copy / xclip)");
  }
}

/** `Get-Clipboard -Raw` output is already raw; nothing to strip but be tolerant of CRLF-only. */
function stripTrailingPsNewline(s: string): string {
  return s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
