import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createCommandResolver,
  PosixCommandResolver,
  WindowsCommandResolver,
} from "../src/platform/commandResolver";

describe("platform command resolver", () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-command-"));
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("selects platform behavior in one factory", () => {
    expect(createCommandResolver("win32", {})).toBeInstanceOf(WindowsCommandResolver);
    expect(createCommandResolver("linux", {})).toBeInstanceOf(PosixCommandResolver);
    expect(createCommandResolver("darwin", {})).toBeInstanceOf(PosixCommandResolver);
  });

  it("resolves a command according to the current platform", () => {
    const extension = process.platform === "win32" ? ".CMD" : "";
    const executable = path.join(temporaryDirectory, `knowhow-test-command${extension}`);
    fs.writeFileSync(executable, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
    if (process.platform !== "win32") fs.chmodSync(executable, 0o755);

    const resolver = createCommandResolver(process.platform, {
      PATH: temporaryDirectory,
      PATHEXT: ".EXE;.CMD",
    });

    expect(resolver.resolve("knowhow-test-command")).toBe(executable);
    expect(resolver.resolve(executable)).toBe(executable);
    expect(resolver.resolve("missing-command")).toBeNull();
  });
});
