/**
 * Unit tests for the github-credentials command.
 *
 * Key invariant: running `github-credentials` must NEVER write anything other than
 * the credential lines to stdout. Module loading logs, warnings, etc. must be
 * silenced so the git credential helper protocol is not corrupted.
 */

// Mock config before any imports that depend on it
jest.mock("../../../src/config", () => ({
  getConfig: jest.fn().mockResolvedValue({ modules: [] }),
  getGlobalConfig: jest.fn().mockResolvedValue({ modules: [] }),
  getConfigSync: jest.fn().mockReturnValue({}),
  migrateConfig: jest.fn().mockResolvedValue(undefined),
}));

// Mock clients to avoid openai.ts side-effects
jest.mock("../../../src/clients", () => ({
  AIClient: jest.fn(),
  Clients: { registerClient: jest.fn(), registerModels: jest.fn() },
}));

// Mock KnowhowSimpleClient so we control what getGitCredential returns
// without needing a real JWT or network connection
jest.mock("../../../src/services/KnowhowClient", () => ({
  KnowhowSimpleClient: jest.fn().mockImplementation(() => ({
    getGitCredential: jest.fn().mockResolvedValue({
      protocol: "https",
      host: "github.com",
      username: "x-access-token",
      password: "ghu_TESTTOKEN123",
    }),
  })),
}));

// Mock readline so the 'get' action doesn't hang waiting for stdin
jest.mock("readline", () => ({
  createInterface: jest.fn().mockReturnValue({
    on: jest.fn().mockImplementation(function (event: string, cb: Function) {
      // Immediately fire 'close' so the readline promise resolves
      if (event === "close") {
        setImmediate(() => cb());
      }
      return this;
    }),
  }),
}));

import { Command } from "commander";
import { addGithubCredentialsCommand } from "../../../src/commands/misc";
import { logger } from "../../../src/logger";

describe("github-credentials command", () => {
  /**
   * This test verifies the EARLY silencing logic in cli.ts main().
   * The problem: modules load BEFORE parseAsync, so any module that emits
   * warnings (e.g. Terminal module: no TunnelHandler) does so before the
   * action's logger.silence() call can stop it.
   *
   * The fix: cli.ts checks process.argv before module loading and silences early.
   * This test simulates that logic directly.
   */
  describe("early silencing (pre-module-load)", () => {
    beforeEach(() => {
      logger.unsilence();
      logger.installConsoleOverload();
    });

    afterEach(() => {
      logger.unsilence();
      logger.uninstallConsoleOverload();
    });

    it("silences before module loading when github-credentials is in argv", () => {
      const originalArgv = process.argv;
      process.argv = ["node", "knowhow", "github-credentials", "get"];

      // Simulate the exact early-detection logic from cli.ts main()
      const rawArgs = process.argv.slice(2);
      const SILENT_COMMANDS = ["github-credentials"];
      if (rawArgs.some((a) => SILENT_COMMANDS.includes(a))) {
        logger.silence();
      }

      // Now any module-load-time console.log/warn should be suppressed
      const consoleSpy = jest.spyOn(process.stdout, "write");
      console.warn("⚠️  Terminal module: no TunnelHandler in context — terminal addon not registered");
      console.log("some other module loading noise");

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
      process.argv = originalArgv;
    });

    it("does NOT silence for other commands", () => {
      const originalArgv = process.argv;
      process.argv = ["node", "knowhow", "chat"];

      const rawArgs = process.argv.slice(2);
      const SILENT_COMMANDS = ["github-credentials"];
      if (rawArgs.some((a) => SILENT_COMMANDS.includes(a))) {
        logger.silence();
      }

      expect(logger.isSilenced()).toBe(false);
      process.argv = originalArgv;
    });
  });

  let program: Command;
  let stdoutSpy: jest.SpyInstance;
  let writtenToStdout: string[];

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset logger silence state between tests
    logger.unsilence();

    // Capture process.stdout.write — this is what the credential helper uses
    writtenToStdout = [];
    stdoutSpy = jest
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: any) => {
        writtenToStdout.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      });

    program = new Command();
    program.exitOverride(); // prevent process.exit during tests
    addGithubCredentialsCommand(program);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    logger.unsilence();
  });

  it("outputs only credential lines to stdout for 'get' action", async () => {
    await program.parseAsync([
      "node", "knowhow", "github-credentials", "get", "--repo", "myorg/myrepo",
    ]);

    expect(writtenToStdout).toHaveLength(1);
    expect(writtenToStdout[0]).toBe(
      "protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghu_TESTTOKEN123\n"
    );
  });

  it("silences the logger immediately so module logs don't pollute stdout", async () => {
    await program.parseAsync([
      "node", "knowhow", "github-credentials", "get", "--repo", "myorg/myrepo",
    ]);

    // The action must have called logger.silence() — state persists after action
    expect(logger.isSilenced()).toBe(true);
  });

  it("produces exactly 4 credential field lines and nothing else", async () => {
    await program.parseAsync([
      "node", "knowhow", "github-credentials", "get", "--repo", "myorg/myrepo",
    ]);

    const allOutput = writtenToStdout.join("");
    const lines = allOutput.trim().split("\n");

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^protocol=/);
    expect(lines[1]).toMatch(/^host=/);
    expect(lines[2]).toMatch(/^username=/);
    expect(lines[3]).toMatch(/^password=/);
  });

  it("exits cleanly for 'store' action without writing credentials", async () => {
    let exitCode: number | undefined;
    // Throw to stop execution after exit() is called — otherwise the mock
    // just sets a flag and the action continues to fetch credentials.
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        exitCode = code ?? 0;
        throw new Error(`process.exit(${exitCode})`);
      }) as any);

    await expect(
      program.parseAsync(["node", "knowhow", "github-credentials", "store"])
    ).rejects.toThrow("process.exit(0)");

    expect(exitCode).toBe(0);
    expect(writtenToStdout).toHaveLength(0);
    exitSpy.mockRestore();
  });

  it("exits cleanly for 'erase' action without writing credentials", async () => {
    let exitCode: number | undefined;
    const exitSpy = jest
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        exitCode = code ?? 0;
        throw new Error(`process.exit(${exitCode})`);
      }) as any);

    await expect(
      program.parseAsync(["node", "knowhow", "github-credentials", "erase"])
    ).rejects.toThrow("process.exit(0)");

    expect(exitCode).toBe(0);
    expect(writtenToStdout).toHaveLength(0);
    exitSpy.mockRestore();
  });
});
