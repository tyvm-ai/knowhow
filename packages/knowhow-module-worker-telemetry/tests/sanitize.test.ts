import { sanitizeAllowlist } from "../src/sanitize";

describe("sanitizeAllowlist", () => {
  it("drops keys not in allowlist", () => {
    const out = sanitizeAllowlist({ a: 1, b: 2 }, { a: true } as const);
    expect(out).toEqual({ a: 1 });
  });

  it("clips large strings", () => {
    const big = "x".repeat(1000);
    const out = sanitizeAllowlist({ a: big }, { a: true } as const);
    expect(typeof out.a).toBe("string");
    expect((out.a as string).length).toBeLessThanOrEqual(256);
  });

  it("drops unserializable types", () => {
    const out = sanitizeAllowlist(
      { a: () => 123, b: undefined, c: Symbol("x"), d: 1 },
      { a: true, b: true, c: true, d: true } as const
    );
    expect(out).toEqual({ d: 1 });
  });
});
