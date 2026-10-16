import { stabilizeLabels, duplicateLabels } from "../src/hints/labels";
import { resolveHintRef } from "../src/hints/refs";
import { Candidate } from "../src/hints/types";
import { suggestApp, appNameSimilarity, namesRunningApp, appNameRecoverer } from "../src/appSuggest";
import { lookupAppAlias, resetLearnedAppAliases } from "../src/grammar/slots";
import { RecoveryEngine, RECOVERY_CONFIRM_TTL_MS } from "../src/recovery/engine";
import { createFakePlatform, createTestHarness } from "./helpers/services";

function cand(role: string, idx: number, x: number, y: number, name?: string): Candidate {
  return {
    element: { id: `${role}-${x}-${y}`, role: "VXText", title: name, bounds: { x, y, width: 80, height: 20 }, actions: [] } as any,
    score: 1,
    label: `${role} ${idx}`,
    roleName: role,
    roleIndex: idx,
    displayName: name,
  };
}

describe("stable, unique hint labels", () => {
  test("an element keeps its number across a refresh; new ones take free numbers", () => {
    const prev = [cand("text", 1, 0, 0, "Who to follow"), cand("text", 2, 0, 40, "Tom Lee")];
    // After a rescan "Tom Lee" ranks first and a new item appears.
    const next = [cand("text", 1, 0, 40, "Tom Lee"), cand("text", 2, 0, 80, "Show more"), cand("text", 3, 0, 0, "Who to follow")];
    const out = stabilizeLabels(prev, next);
    const byName = Object.fromEntries(out.map((c) => [c.displayName, c.label]));
    expect(byName["Tom Lee"]).toBe("text 2");
    expect(byName["Who to follow"]).toBe("text 1");
    expect(byName["Show more"]).toBe("text 3");
    expect(duplicateLabels(out)).toEqual([]);
  });

  test("labels are unique even when two prev items match the same slot", () => {
    const prev = [cand("text", 1, 0, 0, "A"), cand("text", 1, 0, 0, "A")];
    const next = [cand("text", 1, 0, 0, "A"), cand("text", 2, 2, 2, "A")];
    expect(duplicateLabels(stabilizeLabels(prev, next))).toEqual([]);
  });

  test("equal name matches pick the one nearest the gaze", () => {
    const list = [cand("text", 1, 0, 0, "Explore"), cand("text", 2, 1000, 1000, "Explore")];
    expect(resolveHintRef({ name: "explore" }, list, { x: 990, y: 1000 })?.label).toBe("text 2");
    expect(resolveHintRef({ name: "explore" }, list, { x: 0, y: 0 })?.label).toBe("text 1");
  });
});

describe("app name suggestions", () => {
  const running = ["Finder", "ghostty", "Google Chrome", "Spotify", "Obsidian"];

  test("'ghosting' suggests Ghostty", () => {
    expect(suggestApp("ghosting", running)?.app).toBe("ghostty");
    expect(appNameSimilarity("ghosting", "ghostty")).toBeGreaterThan(0.55);
  });

  test("real names are accepted without a suggestion", () => {
    expect(namesRunningApp("chrome", running)).toBe(true);
    expect(namesRunningApp("Ghostty", running)).toBe(true);
    expect(namesRunningApp("ghosting", running)).toBe(false);
  });

  test("unrelated words get no suggestion", () => {
    expect(suggestApp("banana", running)).toBeUndefined();
  });

  /** The app-name recoverer through the engine, for `maximize ghosting` with `running` apps. */
  function setup(spoken = "ghosting", text = "maximize ghosting.") {
    const harness = createTestHarness({ platform: createFakePlatform({ listRunningApps: async () => running }) });
    const logs: string[] = [];
    const ran: string[] = [];
    const engine = new RecoveryEngine({ recoverers: [appNameRecoverer], services: harness.services, log: (l) => logs.push(l) });
    const recover = () =>
      engine.recover(
        { text, normalised: text.toLowerCase(), match: { command: "voice-control.windows.maximize", slots: { app: spoken } } },
        { run: async (t) => { ran.push(t); } },
      );
    return { ...harness, engine, logs, ran, recover };
  }

  test("a near-miss app is held as a pending question and 'yes' runs the corrected command", async () => {
    const { services, recover, ran } = setup();
    const out = await recover();
    expect(out).toEqual({ kind: "handled", asked: "maximize ghostty" });
    const pending = services.pending.take();
    expect(pending?.describe).toContain("maximize ghostty");
    await pending!.accept();
    expect(ran).toEqual(["maximize ghostty"]);
    // remembered in the shared learned store, and applied to the grammar's aliases
    expect(services.learned.list("app-name")).toEqual(["ghosting=>ghostty"]);
    expect(lookupAppAlias("ghosting")).toBe("ghostty");
    resetLearnedAppAliases();
  });

  test("a held suggestion is dropped after its TTL on the injected clock, and nothing is persisted in tests", async () => {
    const { services, clock, recover } = setup();
    expect(await recover()).toMatchObject({ kind: "handled" });
    expect(services.pending.peek()).toBeDefined();
    clock.advance(RECOVERY_CONFIRM_TTL_MS + 1);
    expect(services.pending.peek()).toBeUndefined();
    expect(clock.pendingTimers()).toBe(0);
  });

  test("a running app passes through untouched", async () => {
    const { recover, services } = setup("chrome", "maximize chrome");
    expect(await recover()).toEqual({ kind: "none" });
    expect(services.pending.peek()).toBeUndefined();
  });

  test("learned aliases are re-applied at engine init", () => {
    const { engine, services } = setup();
    resetLearnedAppAliases();
    services.learned.reset({ "app-name": ["zzz-heard=>ghostty"] });
    engine.init();
    expect(lookupAppAlias("zzz-heard")).toBe("ghostty");
    resetLearnedAppAliases();
  });
});
