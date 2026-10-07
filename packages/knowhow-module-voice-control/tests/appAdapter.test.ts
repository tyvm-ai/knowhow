/**
 * App adapters: app-specific behaviour is added by registering an adapter —
 * no generic code changes. The toy "notes" adapter below makes "double click that"
 * on a note row open it with Cmd+O instead of double-clicking.
 */
import { AppAdapterRegistry, adaptersFromExtensions, APP_ADAPTER_EXTENSION } from "../src/targeting/adapter";
import type { AppAdapter } from "../src/targeting/adapter";
import { performClick } from "../src/targeting/act";
import { builtinAdapters, spotifyAdapter, chromeAdapter } from "../src/adapters/index";
import { collectCandidates, SelectorState } from "../src/smartSelector";
import { createTestServices, createFakePlatform } from "./helpers/services";

const noteRow = (id = "n1") =>
  ({ id, role: "AXRow", title: "Shopping list", actions: [], bounds: { x: 0, y: 0, width: 100, height: 20 } }) as any;

function ctxFor(services: ReturnType<typeof createTestServices>, text: string, mouse: object) {
  return { text, slots: {}, gaze: { x: 900, y: 900 }, target: () => ({ x: 900, y: 900 }), mouse, services, log: () => undefined } as any;
}

describe("AppAdapterRegistry", () => {
  const a: AppAdapter = { name: "a", app: /^Alpha$/ };
  const b: AppAdapter = { name: "b", app: /alpha|beta/i, labelFor: () => "b-label", candidateFilter: (el) => el.role !== "AXGroup" };

  it("matches by app, latest registration first, and replaces by name", () => {
    const r = new AppAdapterRegistry([a, b]);
    expect(r.forApp("Alpha").map((x) => x.name)).toEqual(["b", "a"]);
    expect(r.forApp("Gamma")).toEqual([]);
    expect(r.forApp(undefined)).toEqual([]);
    r.register({ ...a, app: /^Gamma$/ });
    expect(r.forApp("Gamma").map((x) => x.name)).toEqual(["a"]);
    r.unregister("a");
    expect(r.forApp("Gamma")).toEqual([]);
  });

  it("combines label and filter hooks for the front app", () => {
    const r = new AppAdapterRegistry([a, b]);
    expect(r.labelFnFor("Beta")?.({} as any)).toBe("b-label");
    expect(r.labelFnFor("Gamma")).toBeUndefined();
    expect(r.filterFnFor("Beta")?.({ role: "AXGroup" } as any)).toBe(false);
    expect(r.filterFnFor("Beta")?.({ role: "AXButton" } as any)).toBe(true);
  });

  it("picks adapters out of a module's extension list", () => {
    expect(adaptersFromExtensions([{ type: "other" }, { type: APP_ADAPTER_EXTENSION, name: "x" } as any])).toHaveLength(1);
  });

  it("ships the spotify and chrome adapters", () => {
    expect(builtinAdapters()).toEqual([chromeAdapter, spotifyAdapter]);
    expect(new AppAdapterRegistry(builtinAdapters()).forApp("Spotify")[0]).toBe(spotifyAdapter);
    expect(new AppAdapterRegistry(builtinAdapters()).forApp("Google Chrome")[0]).toBe(chromeAdapter);
  });
});

describe("a toy adapter changes 'double click that' without touching generic code", () => {
  it("is used for the app the pointer was placed in, and only then", async () => {
    const pressCombo = jest.fn();
    const services = createTestServices({ platform: createFakePlatform({ pressCombo }) });
    const activate = jest.fn(async (_t, _a, svc) => {
      await svc.platform.pressCombo("mod+o");
      return true;
    });
    services.adapters.register({ name: "notes", app: /^Notes$/, activate });

    const element = noteRow();
    services.pointer.notePlaced({ x: 5, y: 5 }, { element, score: 1, label: "row 1", roleName: "row", roleIndex: 1 }, "Notes");
    const mouse = { clickAt: jest.fn(), doubleClickAt: jest.fn() };
    await performClick(ctxFor(services, "double click that", mouse), "doubleClick", { that: true });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0][0]).toMatchObject({ source: "pointer", app: "Notes", point: { x: 5, y: 5 } });
    expect(activate.mock.calls[0][1]).toBe("doubleClick");
    expect(pressCombo).toHaveBeenCalledWith("mod+o");
    expect(mouse.doubleClickAt).not.toHaveBeenCalled();

    // Same placement in another app: the generic coordinate double-click runs.
    services.pointer.notePlaced({ x: 5, y: 5 }, { element, score: 1, label: "row 1", roleName: "row", roleIndex: 1 }, "Mail");
    await performClick(ctxFor(services, "double click that", mouse), "doubleClick", { that: true });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(mouse.doubleClickAt).toHaveBeenCalledWith(5, 5);
  });

  it("falls back to the coordinate double-click when the adapter declines or throws", async () => {
    const services = createTestServices();
    services.adapters.register({ name: "notes", app: /^Notes$/, activate: async () => false });
    services.adapters.register({ name: "notes2", app: /^Notes$/, activate: async () => { throw new Error("boom"); } });
    services.pointer.notePlaced({ x: 5, y: 5 }, { element: noteRow(), score: 1, label: "row 1", roleName: "row", roleIndex: 1 }, "Notes");
    const mouse = { clickAt: jest.fn(), doubleClickAt: jest.fn() };
    await performClick(ctxFor(services, "double click that", mouse), "doubleClick", { that: true });
    expect(mouse.doubleClickAt).toHaveBeenCalledWith(5, 5);
  });

  it("plain 'double click' never consults adapters", async () => {
    const services = createTestServices();
    const activate = jest.fn(async () => true);
    services.adapters.register({ name: "notes", app: /^Notes$/, activate });
    services.pointer.notePlaced({ x: 5, y: 5 }, { element: noteRow(), score: 1, label: "row 1", roleName: "row", roleIndex: 1 }, "Notes");
    const mouse = { clickAt: jest.fn(), doubleClickAt: jest.fn() };
    await performClick(ctxFor(services, "double click", mouse), "doubleClick");
    expect(activate).not.toHaveBeenCalled();
    expect(mouse.doubleClickAt).toHaveBeenCalledWith(5, 5);
  });

  it("the front app's adapter is used when the placement did not record an app", async () => {
    const services = createTestServices({ platform: createFakePlatform({ frontmostApp: () => Promise.resolve("Notes") }) });
    const activate = jest.fn(async () => true);
    services.adapters.register({ name: "notes", app: /^Notes$/, activate });
    services.pointer.notePlaced({ x: 5, y: 5 }, { element: noteRow(), score: 1, label: "row 1", roleName: "row", roleIndex: 1 });
    await performClick(ctxFor(services, "double click that", { doubleClickAt: jest.fn() }), "doubleClick", { that: true });
    expect(activate).toHaveBeenCalledTimes(1);
  });
});

describe("adapters feed candidate collection", () => {
  const button = (id: string, title: string, x: number) =>
    ({ id, role: "AXButton", title, actions: ["AXPress"], bounds: { x, y: 100, width: 80, height: 30 } }) as any;
  const fakeComputer = (els: any[]) =>
    ({
      accessibilityElements: async () => els,
      getActiveWindow: async () => ({ bounds: { x: 0, y: 0, width: 800, height: 600 } }),
    }) as any;

  it("extraElements are added, labelFor renames, candidateFilter hides", async () => {
    const adapters = new AppAdapterRegistry([
      {
        name: "toy",
        app: /^Toy$/,
        extraElements: async ({ elements }) => [button("x1", "Extra thing", 300), ...(elements.length ? [] : [])],
        labelFor: (el) => (el.title === "Alpha" ? "renamed alpha" : undefined),
        candidateFilter: (el) => el.title !== "Hidden",
      },
    ]);
    const els = [button("a", "Alpha", 10), button("h", "Hidden", 100), button("c", "Gamma", 200), button("d", "Delta", 400)];
    const out = await collectCandidates(new SelectorState(), fakeComputer(els), { x: 200, y: 115 }, { x: 600, y: 300 }, "w", {
      appName: "Toy",
      adapters,
      source: "ax",
      wholeWindow: true,
      log: () => undefined,
    });
    const names = out.map((c) => c.displayName);
    expect(names).toContain("renamed alpha");
    expect(names).toContain("extra thing");
    expect(names).not.toContain("hidden");
  });

  it("another app does not get the toy adapter's behaviour", async () => {
    const adapters = new AppAdapterRegistry([{ name: "toy", app: /^Toy$/, labelFor: () => "always" }]);
    const out = await collectCandidates(new SelectorState(), fakeComputer([button("a", "Alpha", 10)]), { x: 50, y: 115 }, { x: 600, y: 300 }, "w2", {
      appName: "Other",
      adapters,
      source: "ax",
      wholeWindow: true,
      log: () => undefined,
    });
    expect(out.map((c) => c.displayName)).toEqual(["alpha"]);
  });
});
