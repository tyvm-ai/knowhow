/**
 * Exact literal phrases must beat patterns that only match by filling a slot.
 * Regression: "toggle mouse" was parsed as hints "toggle {hint}" with name "mouse".
 */
import { parseUtterance } from "../src/grammar";
import { BUILTIN_VOICE_COMMANDS } from "../src/voiceCommands";
import { WINDOWS_PACK } from "../src/packs/windows";
import TEXT_PACK from "../src/packs/text";
import KEYS_PACK from "../src/packs/keys";
import META_PACK from "../src/packs/meta";
import GAZE_MOUSE_PACK from "../src/packs/gazeMouse";
import { SYSTEM_PACK } from "../src/packs/system";
import { HINTS_PACK } from "../src/packs/hints";

const ALL = [
  ...BUILTIN_VOICE_COMMANDS,
  ...META_PACK.extensions,
  ...GAZE_MOUSE_PACK.extensions,
  ...TEXT_PACK.extensions,
  ...KEYS_PACK.extensions,
  ...WINDOWS_PACK.extensions,
  ...SYSTEM_PACK.extensions,
  ...HINTS_PACK.extensions,
];


function name(text: string): string | undefined {
  const r = parseUtterance(text, ALL as any);
  return r.kind === "match" ? (r.result.command as any).phrase : undefined;
}

describe("literal phrase precedence", () => {
  it.each([
    ["toggle mouse", "toggle mouse"],
    ["stop mouse", "stop mouse"],
    ["select all", "select all"],
    ["toggle mute", "mute"],
  ])("%s → %s", (utterance, phrase) => {
    expect(name(utterance)).toBe(phrase);
  });

  it("toggle <field> still reaches the hint check command", () => {
    const r = parseUtterance("toggle newsletter", ALL as any);
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect((r.result.command as any).name).toMatch(/^hints\./);
  });
});
