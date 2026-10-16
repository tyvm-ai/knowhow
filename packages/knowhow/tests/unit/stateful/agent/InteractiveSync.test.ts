jest.mock("../../../../src/services/Tools", () => ({}));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BaseInteractiveAgentHandle } from "../../../../src/services/InteractiveAgentRuntime";
import { AgentFsChannel, appendInput } from "../../../../src/services/stateful";
import { FakeAgent, waitFor } from "./fakeAgent";

describe("interactive handle with sync requested", () => {
  it("is attachable from another terminal: metadata.json, input.txt and status.txt work", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "interactive-sync-"));
    try {
      const agent = new FakeAgent();
      const handle = new BaseInteractiveAgentHandle(agent as any, {
        taskId: "voice-1",
        initialInput: { id: "1", kind: "user", content: "hello", timestamp: Date.now() },
        channels: [new AgentFsChannel({ taskId: "voice-1", baseDir: dir, pollMs: 20 })],
      });
      const task = path.join(dir, "voice-1");
      await waitFor(() => fs.existsSync(path.join(task, "metadata.json")));
      await waitFor(() => JSON.parse(fs.readFileSync(path.join(task, "metadata.json"), "utf8")).threads?.length === 1);
      // a message from another terminal reaches the running agent
      appendInput(path.join(task, "input.txt"), { text: "from elsewhere", from: "peer" });
      await waitFor(() => agent.pendingUser.length === 1);
      expect(agent.pendingUser[0].content).toBe("[from:peer] from elsewhere");
      // and so does the local send() path
      await handle.send({ id: "2", kind: "user", content: "local", timestamp: Date.now() });
      expect(agent.pendingUser.map((m) => m.content)).toContain("local");
      agent.release();
      await expect(handle.done).resolves.toMatchObject({ answer: "ok" });
      const meta = JSON.parse(fs.readFileSync(path.join(task, "metadata.json"), "utf8"));
      expect(meta).toMatchObject({ taskId: "voice-1", status: "completed", result: "ok", inProgress: false });
      expect(fs.readFileSync(path.join(task, "status.txt"), "utf8")).toBe("completed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
