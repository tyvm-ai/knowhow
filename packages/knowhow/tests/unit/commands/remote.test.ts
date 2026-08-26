import { Command } from "commander";

const getConfig = jest.fn();
const updateConfig = jest.fn();

jest.mock("../../../src/config", () => ({ getConfig, updateConfig }));

import { addRemoteCommand } from "../../../src/commands/remote";

describe("remote command", () => {
  let program: Command;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    program = new Command();
    program.exitOverride();
    addRemoteCommand(program);
  });

  afterEach(() => jest.restoreAllMocks());

  it("adds a named remote with an independent JWT path", async () => {
    const config: any = {
      orgIds: {
        "http://localhost:4000": "org-local",
      },
    };
    getConfig.mockResolvedValue(config);

    await program.parseAsync([
      "node",
      "knowhow",
      "remote",
      "add",
      "dev",
      "https://api.dev.knowhow.tyvm.ai/",
    ]);

    expect(updateConfig).toHaveBeenCalledWith(config);
    expect(config.remotes.dev).toEqual({
      name: "dev",
      apiUrl: "https://api.dev.knowhow.tyvm.ai",
      jwtPath: ".knowhow/.jwt.dev",
    });
    expect(config.orgIds).toBeUndefined();
    expect(config.remotes.local).toEqual({
      name: "local",
      apiUrl: "http://localhost:4000",
      jwtPath: ".knowhow/.jwt.local",
      orgId: "org-local",
    });
  });

  it("selects a configured remote for subsequent commands", async () => {
    const config: any = {
      remotes: {
        local: {
          name: "local",
          apiUrl: "http://localhost:4000",
          jwtPath: ".knowhow/.jwt.local",
          orgId: "org-local",
        },
      },
    };
    getConfig.mockResolvedValue(config);

    await program.parseAsync([
      "node",
      "knowhow",
      "remote",
      "use",
      "local",
    ]);

    expect(config.activeRemote).toBe("local");
    expect(updateConfig).toHaveBeenCalledWith(config);
  });
});
