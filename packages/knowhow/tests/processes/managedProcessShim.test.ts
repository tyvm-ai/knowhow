import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("managed process shim", () => {
  const testOnPosix = process.platform === "win32" ? test.skip : test;

  testOnPosix("exits after a short command instead of leaking the shim process", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-shim-test-"));
    const configPath = path.join(directory, "launch.json");
    const shimModule = path.resolve(__dirname, "../../src/processes/managedProcessShim");
    fs.writeFileSync(configPath, JSON.stringify({
      id: "short-command",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: directory,
      env: {},
      background: true,
      parentProcessId: null,
      parentPid: null,
      shell: false,
      processesDir: path.dirname(directory),
    }));

    const script = `require(${JSON.stringify(shimModule)})`
      + `.runManagedProcessShim(${JSON.stringify(configPath)})`
      + `.catch(error => { console.error(error); process.exitCode = 1; });`;
    const shim = spawn(process.execPath, ["-r", "ts-node/register/transpile-only", "-e", script], {
      cwd: path.resolve(__dirname, "../.."),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    shim.stderr!.setEncoding("utf8");
    shim.stderr!.on("data", (chunk) => { stderr += chunk; });

    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const timer = setTimeout(() => {
          shim.kill("SIGKILL");
          reject(new Error(`Shim PID ${shim.pid} did not exit after its command completed`));
        }, 10000);
        shim.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });

      expect(stderr).toBe("");
      expect(result).toEqual({ code: 0, signal: null });
      const status = JSON.parse(fs.readFileSync(path.join(directory, "status.json"), "utf8"));
      expect(status).toMatchObject({ shimPid: shim.pid, state: "exited", exitCode: 0 });
      expect(() => process.kill(shim.pid!, 0)).toThrow();
    } finally {
      if (shim.exitCode === null && shim.signalCode === null) shim.kill("SIGKILL");
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
