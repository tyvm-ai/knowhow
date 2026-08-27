import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SessionManager } from "../../../src/services/SessionManager";
import { TaskInfo } from "../../../src/chat/types";

describe("SessionManager persisted run settings", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-sessions-"));
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  test("saves and updates the exact enabled tool list", () => {
    const manager = new SessionManager(sessionsDir);
    const taskInfo = {
      taskId: "local-task",
      agentName: "Patcher",
      initialInput: "continue",
      status: "running",
      startTime: Date.now(),
      totalCost: 0,
      enabledTools: ["alpha", "finalAnswer"],
    } as TaskInfo;

    manager.saveSession(taskInfo.taskId, taskInfo, [[]]);
    expect(manager.loadSession(taskInfo.taskId)?.enabledTools).toEqual([
      "alpha",
      "finalAnswer",
    ]);

    taskInfo.enabledTools = ["beta", "finalAnswer"];
    manager.updateSession(taskInfo.taskId, taskInfo, [[]]);
    expect(manager.loadSession(taskInfo.taskId)?.enabledTools).toEqual([
      "beta",
      "finalAnswer",
    ]);
  });
});
