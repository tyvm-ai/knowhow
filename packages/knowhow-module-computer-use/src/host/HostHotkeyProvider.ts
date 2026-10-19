import type { HostClient } from "./HostClient";
import type { HotkeyProvider, HotkeyRegistration } from "../hotkeys";
import { formatHotkey } from "../hotkeySpec";
import type { TrayBridge } from "../automation";
import { HostGuiBackend } from "../gui/backends";
import type { GuiBackend } from "../gui/types";

/** The subset of AutomationRunner the host bridge drives. */
export interface RunnerLike {
  ctl: { stop(): void; paused: boolean; stopped: boolean };
  setPaused?(paused: boolean, reason?: string): void;
}

/**
 * HotkeyProvider backed by a host worker connection. The host owns the real
 * keyboard hook; we register chords, run the handler on `{type:"hotkey"}`, and
 * always answer with `hotkeyDone` afterwards (the host uses it for `drop`
 * concurrency). TS-side drop/queue/when logic stays in `reg.onTrigger()`.
 */
export class HostHotkeyProvider implements HotkeyProvider {
  private regs = new Map<string, HotkeyRegistration>();
  private menu = new Map<string, () => void | Promise<void>>();
  private runner: RunnerLike | null = null;
  private guiBackend: HostGuiBackend | null = null;
  private onEvent = (ev: any) => this.handleEvent(ev);

  constructor(private client: HostClient, private onError: (msg: string) => void = () => {}) {
    client.on("event", this.onEvent);
  }

  async register(reg: HotkeyRegistration): Promise<void> {
    this.regs.set(reg.id, reg);
    const o = reg.options;
    try {
      await this.client.request({
        type: "registerHotkey",
        id: reg.id,
        chord: formatHotkey(reg.parsed),
        anyModifiers: !!o.anyModifiers,
        consume: o.consume !== false,
        noRepeat: !!o.noRepeat,
        // The host only distinguishes "drop"; queue/parallel are handled in TS.
        concurrency: o.concurrency === "drop" ? "drop" : "parallel",
      });
    } catch (e) {
      this.regs.delete(reg.id);
      throw e;
    }
  }

  unregister(id: string): void {
    if (!this.regs.delete(id)) return;
    this.client.send({ type: "unregisterHotkey", id });
  }

  /** Wire host stop/pause/resume events to a runner. */
  bindRunner(runner: RunnerLike): void {
    this.runner = runner;
  }

  /** `heldKeys` reporter for `RunOptions.onHeldKeysChange`. */
  heldKeysReporter(): (keys: string[]) => void {
    return (keys) => this.client.send({ type: "heldKeys", keys });
  }

  /** Tray bridge for `RunOptions.tray` (sdk.tray.setStatus / addMenuItem). */
  trayBridge(): TrayBridge {
    return {
      setStatus: (text) => this.client.send({ type: "trayStatus", text }),
      addMenuItem: (id, label, fn) => {
        this.menu.set(id, fn);
        this.client.send({ type: "trayMenuItem", id, label });
      },
    };
  }

  /**
   * GUI backend (forms, dialogs, tooltips) sharing this worker connection.
   * Pass as `RunOptions.gui`. Created lazily; disposed with the provider.
   */
  gui(): GuiBackend {
    if (!this.guiBackend) this.guiBackend = new HostGuiBackend(this.client);
    return this.guiBackend;
  }

  dispose(): void {
    this.guiBackend?.dispose();
    this.guiBackend = null;
    this.client.off("event", this.onEvent);
    this.regs.clear();
  }

  private handleEvent(ev: any): void {
    switch (ev?.type) {
      case "hotkey": {
        const reg = this.regs.get(ev.id);
        if (!reg) {
          // Unknown id (unregistered meanwhile): still release the host's busy flag.
          this.client.send({ type: "hotkeyDone", id: ev.id });
          return;
        }
        reg
          .onTrigger()
          .catch((e) => this.onError(`hotkey ${reg.spec}: ${e?.message ?? e}`))
          .finally(() => this.client.send({ type: "hotkeyDone", id: ev.id }));
        return;
      }
      case "stop":
        this.runner?.ctl.stop();
        return;
      case "pause":
        this.setPaused(true);
        return;
      case "resume":
        this.setPaused(false);
        return;
      case "trayMenu": {
        const fn = this.menu.get(ev.id);
        if (fn) {
          Promise.resolve()
            .then(fn)
            .catch((e) => this.onError(`tray menu ${ev.id}: ${e?.message ?? e}`));
        }
        return;
      }
    }
  }

  private setPaused(paused: boolean): void {
    const r = this.runner;
    if (!r) return;
    if (r.setPaused) r.setPaused(paused);
    else r.ctl.paused = paused;
  }
}
