import os from "os";
import { WebSocket } from "ws";
import { Developer, Patcher, Researcher } from "./agents";
import { includedTools } from "./agents/tools/list";
import { loadJwt } from "./login";
import { Agents, Tools } from "./services";
import { Mcp, McpServerService } from "./services/Mcp";
import * as allTools from "./agents/tools";
import { wait } from "./utils";
import { getConfig, updateConfig } from "./config";

const API_URL = process.env.KNOWHOW_API_URL;

export async function worker() {
  const mcpServer = new McpServerService(Tools);
  const clientName = "knowhow-worker";
  const clientVersion = "1.1.1";
  const config = await getConfig();

  if (!config.worker || !config.worker.allowedTools) {
    console.log(
      "Worker tools configured! Update knowhow.json to adjust which tools are allowed by the worker."
    );
    config.worker = {
      ...config.worker,
      allowedTools: Tools.getToolNames(),
    };

    await updateConfig(config);
    return;
  }

  const toolsToUse = Tools.getToolsByNames(config.worker.allowedTools);
  mcpServer.createServer(clientName, clientVersion).withTools(toolsToUse);

  let connected = false;

  async function connectWebSocket() {
    const jwt = await loadJwt();
    console.log(`Connecting to ${API_URL}`);

    const dir = process.cwd();
    const homedir = os.homedir();
    const root = dir === homedir ? "~" : dir.replace(homedir, "~");
    const ws = new WebSocket(`${API_URL}/ws/worker`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        "User-Agent": `${clientName}/${clientVersion}/${os.hostname()}`,
        Root: `${root}`,
      },
    });

    ws.on("open", () => {
      console.log("Connected to the server");
      connected = true;
    });

    ws.on("close", async (code, reason) => {
      console.log(
        `WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`
      );
      console.log("Attempting to reconnect...");
      connected = false;
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });

    mcpServer.runWsServer(ws);
  }

  while (true) {
    if (!connected) {
      console.log("Attempting to connect...");
      connectWebSocket();
    }
    await wait(5000);
  }
}
