import { stabilizeLabels, duplicateLabels, resolveHintRef, Candidate } from "../src/smartSelector";
import { suggestApp, appNameSimilarity, namesRunningApp, checkAppSlot } from "../src/appSuggest";
import { takePending, clearPending } from "../src/pendingAction";

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

  test("checkAppSlot holds the command and 'yes' re-runs it with the fix", async () => {
    clearPending();
    const reran: string[] = [];
    const res = await checkAppSlot({
      spoken: "ghosting",
      commandText: "maximize ghosting.",
      listRunningApps: async () => running,
      rerun: async (app) => { reran.push(app); },
      log: () => undefined,
      notify: () => undefined,
    });
    expect(res.status).toBe("suggested");
    const pending = takePending();
    expect(pending?.describe).toContain("maximize ghostty");
    await pending!.accept();
    expect(reran).toEqual(["ghostty"]);
  });

  test("checkAppSlot passes through a running app", async () => {
    const res = await checkAppSlot({
      spoken: "Google Chrome",
      commandText: "maximize chrome",
      listRunningApps: async () => running,
      rerun: async () => undefined,
      log: () => undefined,
      notify: () => undefined,
    });
    expect(res.status).toBe("ok");
  });
});
