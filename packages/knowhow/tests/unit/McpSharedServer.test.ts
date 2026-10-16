import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { ensureLocalServer } from "../../src/services/Mcp";

function listen(server: http.Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("shared HTTP MCP bootstrap", () => {
  it("does not start the command when the URL is already available", async () => {
    const server = http.createServer((_request, response) => response.end("ok"));
    const port = await listen(server);
    await expect(ensureLocalServer({
      name: "available",
      url: `http://127.0.0.1:${port}/mcp`,
      command: "/definitely/not/a/command",
    })).resolves.toBeUndefined();
    await close(server);
  });

  it("starts only one command for concurrent clients", async () => {
    const marker = path.join(os.tmpdir(), `knowhow-mcp-test-${process.pid}-${Date.now()}`);
    const probe = http.createServer();
    const port = await listen(probe);
    await close(probe);
    const script = `require('fs').appendFileSync(${JSON.stringify(marker)}, 'start\\n'); const s=require('http').createServer((q,r)=>r.end('ok')); s.listen(${port},'127.0.0.1'); setTimeout(()=>s.close(),2000);`;
    const config = {
      name: "concurrent",
      url: `http://127.0.0.1:${port}/mcp`,
      command: process.execPath,
      args: ["-e", script],
    };

    await Promise.all(Array.from({ length: 4 }, () => ensureLocalServer(config)));
    expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
    fs.unlinkSync(marker);
  });

  it("reports a startup command that exits before readiness", async () => {
    const probe = http.createServer();
    const port = await listen(probe);
    await close(probe);

    await expect(ensureLocalServer({
      name: "early-exit",
      url: `http://127.0.0.1:${port}/mcp`,
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
    })).rejects.toThrow("startup command exited");
  });
});
