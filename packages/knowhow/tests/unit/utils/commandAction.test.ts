import { normalizeCommandAction, parseCommandActionArgs } from "../../../src/utils/commandAction";

const fakeCommand = (opts: Record<string, any>) => ({ opts: () => opts, name: "x" });

describe("normalizeCommandAction", () => {
  it("handles commander v14: (...positionals, options, command)", async () => {
    const handler = jest.fn();
    const cmd = fakeCommand({ a: 1 });
    await normalizeCommandAction(handler)("sub", ["x", "y"], { json: true }, cmd);
    expect(handler).toHaveBeenCalledWith(["sub", "x", "y"], { json: true }, cmd);
  });

  it("handles commander v2: (...positionals, command)", async () => {
    const handler = jest.fn();
    const cmd = fakeCommand({ json: true });
    await normalizeCommandAction(handler)("sub", cmd);
    expect(handler).toHaveBeenCalledWith(["sub"], { json: true }, cmd);
  });

  it("drops omitted optional positionals", () => {
    const parsed = parseCommandActionArgs([undefined, { once: "hi" }, fakeCommand({})]);
    expect(parsed.args).toEqual([]);
    expect(parsed.opts).toEqual({ once: "hi" });
  });

  it("handles a bare (..., options) call", () => {
    expect(parseCommandActionArgs(["a", { b: 1 }])).toMatchObject({ args: ["a"], opts: { b: 1 } });
  });

  it("handles no arguments", () => {
    expect(parseCommandActionArgs([])).toMatchObject({ args: [], opts: {} });
  });
});
