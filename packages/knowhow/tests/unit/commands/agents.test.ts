import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Command } from "commander";

const startChat = jest.fn().mockResolvedValue(undefined);
const setupServices = jest.fn().mockResolvedValue(undefined);

jest.mock("../../../src/chat", () => ({ startChat }));
jest.mock("../../../src/commands/services", () => ({ setupServices }));

import { addAgentsCommand } from "../../../src/commands/agents";

describe("agents resume terminal UX", () => {
  let previousCwd: string;
  let tempDir: string;
  let isTTYDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    previousCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-agents-command-"));
    process.chdir(tempDir);
    const taskId = "1700000000-resumable-task";
    fs.mkdirSync(path.join(".knowhow", "processes", "agents", taskId), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(".knowhow", "processes", "agents", taskId, "metadata.json"),
      JSON.stringify({ taskId, status: "completed", threads: [[]] })
    );
    isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (isTTYDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", isTTYDescriptor);
    } else {
      delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
    }
  });

  test("opens chat with the interactive resume command by default", async () => {
    const program = new Command();
    addAgentsCommand(program, jest.fn());

    await program.parseAsync([
      "node",
      "knowhow",
      "agents",
      "resume",
      "1700000000-resumable-task",
      "--rollback",
      "2",
    ]);

    expect(setupServices).toHaveBeenCalledTimes(1);
    expect(startChat).toHaveBeenCalledWith(
      "/resume 1700000000-resumable-task --rollback 2"
    );
  });
});
