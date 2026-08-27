import fs from "fs";
import os from "os";
import path from "path";

interface CapturedTransportOptions {
  requestInit?: { headers?: Record<string, string> };
}

let capturedOptions: CapturedTransportOptions | undefined;

jest.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(
    (_url: URL, options: unknown) => {
      capturedOptions = options as CapturedTransportOptions;
      return { close: jest.fn() };
    }
  ),
}));

import { McpService } from "../../../src/services/Mcp";

describe("McpService JWT file transport", () => {
  let temporaryDirectory: string;
  let tokenFile: string;

  beforeEach(() => {
    capturedOptions = undefined;
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-mcp-"));
    tokenFile = path.join(temporaryDirectory, ".jwt");
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("reads the refreshed JWT when the transport is created", async () => {
    fs.writeFileSync(tokenFile, "expired-jwt");
    fs.writeFileSync(tokenFile, "fresh-jwt");

    await new McpService().createTransport({
      name: "authenticated-remote",
      url: "https://api.example.test/mcp",
      authorization_token_file: tokenFile,
    });

    expect(capturedOptions).toEqual(
      expect.objectContaining({
        requestInit: {
          headers: expect.objectContaining({
            Authorization: "Bearer fresh-jwt",
          }),
        },
      })
    );
  });
});
