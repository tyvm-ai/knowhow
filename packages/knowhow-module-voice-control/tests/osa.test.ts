import {
  appleScriptString,
  escapeAppleScriptString,
  runAppleScript,
  runAppleScriptSync,
  runJxa,
  runJxaSync,
} from "../src/actions/osa";

const mac = process.platform === "darwin" ? describe : describe.skip;

describe("AppleScript escaping", () => {
  it("escapes backslashes and double quotes", () => {
    expect(escapeAppleScriptString('say "hi" \\ there')).toBe('say \\"hi\\" \\\\ there');
    expect(appleScriptString('a"b')).toBe('"a\\"b"');
  });
});

mac("osa helper (macOS)", () => {
  it("runs AppleScript and JXA, async and sync", async () => {
    expect((await runAppleScript("return 1 + 1")).trim()).toBe("2");
    expect((await runJxa("1 + 2")).trim()).toBe("3");
    expect(runAppleScriptSync("return 4").stdout.trim()).toBe("4");
    expect(runJxaSync("5").stdout.trim()).toBe("5");
  });

  it("passes argv and reports sync failures without throwing", async () => {
    expect((await runAppleScript("on run argv\nreturn item 1 of argv\nend run", { args: ["hello"] })).trim()).toBe("hello");
    const bad = runAppleScriptSync("this is not applescript", { timeoutMs: 5000 });
    expect(bad.ok).toBe(false);
    await expect(runAppleScript("error \"boom\"")).rejects.toBeDefined();
  });
});
