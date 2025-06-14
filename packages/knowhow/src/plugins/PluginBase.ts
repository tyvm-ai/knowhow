import { MinimalEmbedding } from "../types";
import { Plugin, PluginMeta } from "./types";

export abstract class PluginBase implements Plugin {
  /** Manual on/off toggle (default ON) */
  private active = true;

  constructor(public readonly meta: PluginMeta) {}

  /* ------------------------------------------------------------------ */
  /** Public helpers called by PluginService -------------------------- */
  /* ------------------------------------------------------------------ */
  enable(): void {
    this.active = true;
  }

  disable(): void {
    this.active = false;
  }

  async isEnabled(): Promise<boolean> {
    if (!this.active) return false;

    const envOk = this.hasRequiredEnv();

    const extraOk = await this.customEnableCheck();
    return envOk && extraOk;
  }

  protected hasRequiredEnv(): boolean {
    return (
      !this.meta.requires ||
      this.meta.requires.every((k) => process.env[k] && process.env[k] !== "")
    );
  }

  protected customEnableCheck(): boolean | Promise<boolean> {
    return true; // subclasses override if needed
  }

  /* ------------------------------------------------------------------ */
  /** Mandatory plugin actions ---------------------------------------- */
  /* ------------------------------------------------------------------ */
  abstract call(input?: string): Promise<string>;
  abstract embed(input: string): Promise<MinimalEmbedding[]>;
}

export { PluginMeta, Plugin } from "./types";
