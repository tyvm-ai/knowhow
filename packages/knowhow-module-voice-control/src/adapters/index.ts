/** The app adapters that ship with voice-control. Add yours here (or register one at runtime on `services.adapters`). */

import type { AppAdapter } from "../targeting/adapter";
import { chromeAdapter } from "./chrome";
import { spotifyAdapter } from "./spotify";

export { chromeAdapter } from "./chrome";
export { spotifyAdapter, findPlayButton, spotifyLabel } from "./spotify";

export function builtinAdapters(): AppAdapter[] {
  return [chromeAdapter, spotifyAdapter];
}
