import { Command } from "commander";

const login = jest.fn().mockResolvedValue(undefined);
const registerIdentity = jest.fn().mockResolvedValue(undefined);
const ensureIdentityKeyPair = jest.fn();

jest.mock("../../../src/login", () => ({ login }));
jest.mock("../../../src/index", () => ({
  embed: jest.fn(),
  upload: jest.fn(),
  download: jest.fn(),
  purge: jest.fn(),
}));
jest.mock("../../../src/auth/registerIdentity", () => ({ registerIdentity }));
jest.mock("../../../src/auth/keyManager", () => ({ ensureIdentityKeyPair }));

import { addLoginCommand } from "../../../src/commands/misc";

describe("login command", () => {
  let program: Command;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    program = new Command();
    program.exitOverride();
    addLoginCommand(program);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("supports --key-gen non-interactively and exits without login", async () => {
    ensureIdentityKeyPair.mockReturnValue({
      created: true,
      keyPair: {
        fingerprint: "SHA256:test",
        privateKeyPath: "/keys/id_ed25519",
        publicKeyPath: "/keys/id_ed25519.pub",
      },
    });

    await program.parseAsync(["node", "knowhow", "login", "--key-gen"]);

    expect(ensureIdentityKeyPair).toHaveBeenCalledWith(undefined);
    expect(login).not.toHaveBeenCalled();
    expect(registerIdentity).not.toHaveBeenCalled();

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Generated CLI identity keypair");
    expect(output).toContain("/keys/id_ed25519");
    expect(output).toContain("/keys/id_ed25519.pub");
  });

  it("does not overwrite existing key when using --key-gen", async () => {
    ensureIdentityKeyPair.mockReturnValue({
      created: false,
      keyPair: {
        fingerprint: "SHA256:existing",
        privateKeyPath: "/keys/id_ed25519",
        publicKeyPath: "/keys/id_ed25519.pub",
      },
    });

    await program.parseAsync(["node", "knowhow", "login", "--key-gen", "--identity", "/keys/id_ed25519"]);

    expect(ensureIdentityKeyPair).toHaveBeenCalledWith("/keys/id_ed25519");
    expect(login).not.toHaveBeenCalled();
    expect(registerIdentity).not.toHaveBeenCalled();

    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("CLI identity keypair already exists");
  });

  it("rejects incompatible flag combinations with --key-gen", async () => {
    await expect(
      program.parseAsync(["node", "knowhow", "login", "--key-gen", "--jwt"])
    ).rejects.toThrow("--key-gen cannot be used with --jwt or --register-identity");

    expect(login).not.toHaveBeenCalled();
    expect(registerIdentity).not.toHaveBeenCalled();
  });
});
