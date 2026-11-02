import { buildWaves, ioOverlaps } from "../../src/generate";

describe("generate dependency waves", () => {
  it("orders a reader after the writer of the file it reads, without a false cycle", () => {
    const write = { input: "./src/cmd.ts", output: "./docs/chat/index.mdx" } as any;
    const review = { input: "./docs/chat/index.mdx", output: "./docs/chat/llmFeedback.json" } as any;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const waves = buildWaves([review, write]);
    expect(warn).not.toHaveBeenCalled();
    expect(waves).toEqual([[write], [review]]);
    warn.mockRestore();
  });

  it("sharing a parent folder alone is not a dependency", () => {
    expect(ioOverlaps({ output: "./docs/a/x.json" } as any, { input: "./docs/a/y.md" } as any)).toBe(false);
  });

  it("globs and directory outputs still create dependencies", () => {
    expect(ioOverlaps({ output: "autodoc/a.md" } as any, { input: "autodoc/**/*.md" } as any)).toBe(true);
    expect(ioOverlaps({ output: "autodoc/" } as any, { input: "autodoc/**/*.md" } as any)).toBe(true);
    expect(ioOverlaps({ output: "./autodoc/" } as any, { input: "x.ts,autodoc/a.md" } as any)).toBe(true);
    expect(ioOverlaps({ output: "autodoc/" } as any, { input: "src/**/*.ts" } as any)).toBe(false);
  });
});
