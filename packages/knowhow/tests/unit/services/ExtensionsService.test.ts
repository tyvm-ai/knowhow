import { ExtensionsService, ModuleExtension } from "../../../src/services/ExtensionsService";

interface VoiceCmd extends ModuleExtension {
  type: "voice.command";
  name: string;
}

describe("ExtensionsService", () => {
  it("keeps register / list / removeOwner working untyped", () => {
    const svc = new ExtensionsService();
    svc.register("a", { type: "t", n: 1 });
    svc.register("b", { type: "t", n: 2 });
    svc.register("b", { type: "other" });
    expect(svc.list("t").map((e: any) => e.n)).toEqual([1, 2]);
    expect((svc.list("t")[0] as any).owner).toBe("a");
    svc.removeOwner("b");
    expect(svc.list("t")).toHaveLength(1);
    expect(svc.list("other")).toHaveLength(0);
  });

  describe("defineExtensionPoint", () => {
    const define = (svc: ExtensionsService) =>
      svc.defineExtensionPoint<VoiceCmd>("voice.command", {
        validate: (ext, existing) =>
          existing.some((e) => e.name === ext.name) ? `duplicate command "${ext.name}"` : undefined,
      });

    it("returns a typed handle that lists and registers", () => {
      const svc = new ExtensionsService();
      const point = define(svc);
      point.register("mod", { type: "voice.command", name: "go" });
      expect(point.type).toBe("voice.command");
      expect(point.list().map((e) => e.name)).toEqual(["go"]);
      expect(svc.list("voice.command")).toHaveLength(1);
    });

    it("validates on register — via the handle and via plain register()", () => {
      const svc = new ExtensionsService();
      const point = define(svc);
      point.register("one", { type: "voice.command", name: "go" });
      expect(() => point.register("two", { type: "voice.command", name: "go" })).toThrow(
        /voice\.command.*"two".*duplicate command "go"/
      );
      expect(() => svc.register("three", { type: "voice.command", name: "go" })).toThrow(/"three"/);
      expect(point.list()).toHaveLength(1);
    });

    it("treats a throwing validator as a rejection", () => {
      const svc = new ExtensionsService();
      svc.defineExtensionPoint("t", { validate: () => { throw new Error("nope"); } });
      expect(() => svc.register("o", { type: "t" })).toThrow(/"o".*nope/);
    });

    it("onRegister fires for new registrations of that type only and can unsubscribe", () => {
      const svc = new ExtensionsService();
      const point = define(svc);
      const cb = jest.fn();
      const off = point.onRegister(cb);
      point.register("m", { type: "voice.command", name: "a" });
      svc.register("m", { type: "unrelated" });
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][1]).toBe("m");
      off();
      point.register("m", { type: "voice.command", name: "b" });
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("onRegister does not replay by default, but does with { replay: true }", () => {
      const svc = new ExtensionsService();
      const point = define(svc);
      point.register("m", { type: "voice.command", name: "early" });
      const noReplay = jest.fn();
      const replay = jest.fn();
      point.onRegister(noReplay);
      point.onRegister(replay, { replay: true });
      expect(noReplay).not.toHaveBeenCalled();
      expect(replay).toHaveBeenCalledTimes(1);
      expect(replay.mock.calls[0][0].name).toBe("early");
    });

    it("a throwing listener does not break registration", () => {
      const svc = new ExtensionsService();
      const point = define(svc);
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
      point.onRegister(() => { throw new Error("listener"); });
      expect(() => point.register("m", { type: "voice.command", name: "a" })).not.toThrow();
      expect(point.list()).toHaveLength(1);
      warn.mockRestore();
    });

    it("redefining a point without validate keeps the existing validator", () => {
      const svc = new ExtensionsService();
      define(svc).register("m", { type: "voice.command", name: "a" });
      const again = svc.defineExtensionPoint<VoiceCmd>("voice.command");
      expect(() => again.register("n", { type: "voice.command", name: "a" })).toThrow();
    });
  });
});
