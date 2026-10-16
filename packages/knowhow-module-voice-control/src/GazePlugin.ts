import {
  MinimalEmbedding,
  PluginBase,
  PluginContext,
  PluginMeta,
} from "@tyvm/knowhow";
import { GazeClient, GAZE_TIMEOUT } from "./gaze";

const MAX_SAMPLE_AGE_MS = 2_000;

/** Adds the user's current desktop gaze position to agent input while tracking is active. */
export class GazePlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "gaze",
    name: "Gaze Context Plugin",
    description: "Reports the latest fresh eye-tracking desktop coordinate",
    requires: [],
  };

  meta = GazePlugin.meta;
  private readonly gaze: GazeClient;

  constructor(context: PluginContext) {
    super(context);
    this.gaze = new GazeClient();
  }

  async call(): Promise<string> {
    try {
      const sample = await this.gaze.current({ timeoutMs: GAZE_TIMEOUT.normal });
      if (!sample) return "";
      const ageMs = Date.now() - sample.timestamp;
      if (sample.phase !== "live" || ageMs < 0 || ageMs > MAX_SAMPLE_AGE_MS) return "";
      return `GAZE CONTEXT: The user is currently looking near desktop coordinate (${Math.round(sample.x)}, ${Math.round(sample.y)}) on the monitor at (${sample.monitor.x}, ${sample.monitor.y}) sized ${sample.monitor.width}x${sample.monitor.height}. Treat this as approximate context, not authorization to click or perform a consequential action.`;
    } catch {
      // Eye tracking is optional. An absent tracker should not delay or pollute input.
      return "";
    }
  }

  async embed(): Promise<MinimalEmbedding[]> {
    return [];
  }
}
