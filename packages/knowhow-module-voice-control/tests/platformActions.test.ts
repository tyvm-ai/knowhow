import { DarwinPlatformActions } from "../src/actions/darwin";
import { getPlatformActions, sharedPlatformActions } from "../src/actions/index";
import { getComputerService, setComputerService } from "../src/computerService";

jest.mock("../src/actions/osa", () => {
  const actual = jest.requireActual("../src/actions/osa");
  return { ...actual, runJxa: jest.fn(), runAppleScript: jest.fn() };
});
import * as osa from "../src/actions/osa";

const jxa = osa.runJxa as jest.Mock;
const svc = { typeText: jest.fn(), hotkey: jest.fn(), pressKey: jest.fn() };

describe("PlatformActions.frontmostApp", () => {
  beforeEach(() => {
    jxa.mockReset();
    jxa.mockResolvedValue("Ghostty\n");
  });

  it("is always fresh by default (activate → frontmost sequences stay exact)", async () => {
    const actions = new DarwinPlatformActions(svc);
    expect(await actions.frontmostApp()).toBe("Ghostty");
    expect(await actions.frontmostApp()).toBe("Ghostty");
    expect(jxa).toHaveBeenCalledTimes(2);
  });

  it("caches inside the implementation when maxAgeMs is given", async () => {
    const actions = new DarwinPlatformActions(svc);
    await actions.frontmostApp({ maxAgeMs: 1000 });
    await actions.frontmostApp({ maxAgeMs: 1000 });
    await actions.frontmostApp({ maxAgeMs: 1000 });
    expect(jxa).toHaveBeenCalledTimes(1);
    jxa.mockResolvedValue("Safari\n");
    expect(await actions.frontmostApp({ maxAgeMs: 0 })).toBe("Safari");
    expect(await actions.frontmostApp({ maxAgeMs: 1000 })).toBe("Safari");
  });

  it("activateApp invalidates the cache", async () => {
    const actions = new DarwinPlatformActions(svc);
    (osa.runAppleScript as jest.Mock).mockResolvedValue("");
    jxa.mockResolvedValueOnce("Ghostty\n"); // frontmost
    await actions.frontmostApp({ maxAgeMs: 60_000 });
    jxa.mockResolvedValue(JSON.stringify(["Safari"])); // running apps for activateApp
    await actions.activateApp("Safari");
    jxa.mockResolvedValue("Safari\n");
    expect(await actions.frontmostApp({ maxAgeMs: 60_000 })).toBe("Safari");
  });

  it("maxWaitMs resolves undefined instead of hanging", async () => {
    jxa.mockReturnValue(new Promise(() => undefined));
    const actions = new DarwinPlatformActions(svc);
    const started = Date.now();
    expect(await actions.frontmostApp({ maxWaitMs: 30 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("resolves undefined when the script fails", async () => {
    jxa.mockRejectedValue(new Error("no permission"));
    expect(await new DarwinPlatformActions(svc).frontmostApp()).toBeUndefined();
  });
});

describe("platform selection", () => {
  it("non-mac platforms get a stub that fails cleanly", async () => {
    const linux = getPlatformActions(undefined, "linux");
    expect(linux.platform).toBe("linux");
    await expect(linux.pressCombo("mod+a")).rejects.toThrow(/not supported on "linux"/);
    await expect(linux.typeText("x")).rejects.toThrow(/not supported/);
    expect(await linux.frontmostApp({ maxWaitMs: 10 })).toBeUndefined();
    expect(await linux.activateApp("x")).toBe(false);
  });

  it("sharedPlatformActions is one instance (so frontmostApp caching is shared)", () => {
    expect(sharedPlatformActions()).toBe(sharedPlatformActions());
  });
});

describe("computerService", () => {
  it("setComputerService only accepts service-shaped objects and getComputerService returns it", () => {
    setComputerService({ nope: true });
    setComputerService(svc);
    expect(getComputerService()).toBe(svc);
  });
});
