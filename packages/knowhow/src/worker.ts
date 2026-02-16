import os from "os";
import { WebSocket } from "ws";
import { includedTools } from "./agents/tools/list";
import { loadJwt } from "./login";
import { services } from "./services";
import { McpServerService } from "./services/Mcp";
import * as allTools from "./agents/tools";
import { wait } from "./utils";
import { getConfig, updateConfig } from "./config";
import { KNOWHOW_API_URL } from "./services/KnowhowClient";
import { registerWorkerPath } from "./workerRegistry";

const API_URL = KNOWHOW_API_URL;

/**
 * Run the worker in a Docker sandbox
 */
async function runWorkerInSandbox(
  options: { share?: boolean; unshare?: boolean; sandbox?: boolean },
  config: any
) {
  const { Docker } = services();

  console.log("🐳 Starting knowhow worker in Docker sandbox mode...\n");

  // Check if Docker is available
  const dockerAvailable = await Docker.checkDockerAvailable();

  if (!dockerAvailable) {
    console.error("❌ Docker is not installed or not running.");
    console.error("\nTo use --sandbox mode, you need to:");
    console.error("  1. Install Docker: https://docs.docker.com/get-docker/");
    console.error("  2. Start the Docker daemon");
    console.error("  3. Run this command again with --sandbox\n");
    process.exit(1);
  }

  console.log("✓ Docker is available");

  // Always rebuild the image to ensure it's up to date with any Dockerfile changes
  console.log("🔄 Building Docker image (ensuring latest version)...");
  try {
    await Docker.buildWorkerImage();
  } catch (error) {
    console.error("❌ Failed to build Docker image:", error.message);
    console.error("\nPlease check the .knowhow/Dockerfile.worker for errors");
    console.error("  You can edit this file to customize the worker image\n");
    process.exit(1);
  }

  // Get JWT token
  const jwt = await loadJwt();

  // Run the container
  let containerId: string;

  console.log("🚀 Starting Docker container...");
  try {
    containerId = await Docker.runWorkerContainer({
      workspaceDir: process.cwd(),
      jwt,
      apiUrl: API_URL,
      config,
      share: options?.share,
      unshare: options?.unshare,
    });
  } catch (error) {
    console.error("❌ Failed to start Docker container:", error.message);
    process.exit(1);
  }

  // Follow logs and handle cleanup
  try {
    await Docker.followContainerLogs(containerId);
  } finally {
    await Docker.stopContainer(containerId);
  }
}

export async function worker(options?: {
  register?: boolean;
  share?: boolean;
  unshare?: boolean;
  sandbox?: boolean;
  noSandbox?: boolean;
}) {
  const config = await getConfig();

  // Check if we're already running inside a Docker container
  const isInsideDocker = process.env.KNOWHOW_DOCKER === "true";

  if (isInsideDocker) {
    console.log(
      "🐳 Already running inside Docker container, skipping sandbox mode"
    );
    // Force sandbox mode off when inside Docker to prevent nested containers
    if (options) {
      options.sandbox = false;
      options.noSandbox = true;
    }
  }

  // Determine sandbox mode with priority: command line flags > config > default (false)
  let shouldUseSandbox = false;
  let sandboxSource = "";

  if (options?.sandbox) {
    shouldUseSandbox = true;
    sandboxSource = "command line (--sandbox)";

    // Save sandbox preference to config
    const updatedConfig = {
      ...config,
      worker: {
        ...config.worker,
        sandbox: true,
      },
    };
    await updateConfig(updatedConfig);
    console.log("💾 Sandbox mode preference saved to config");
  } else if (options?.noSandbox) {
    shouldUseSandbox = false;
    sandboxSource = "command line (--no-sandbox)";

    // Save no-sandbox preference to config
    const updatedConfig = {
      ...config,
      worker: {
        ...config.worker,
        sandbox: false,
      },
    };
    await updateConfig(updatedConfig);
    console.log("💾 No-sandbox mode preference saved to config");
  } else {
    // Use config preference or default to false
    shouldUseSandbox = config.worker?.sandbox ?? false;
    sandboxSource =
      config.worker?.sandbox !== undefined
        ? `config (${shouldUseSandbox ? "sandbox" : "no-sandbox"})`
        : "default (no-sandbox)";
  }

  if (shouldUseSandbox) {
    console.log(`🐳 Using sandbox mode (${sandboxSource})`);
    return runWorkerInSandbox(options, config);
  }

  const { Tools } = services();
  Tools.defineTools(includedTools, allTools);
  const mcpServer = new McpServerService(Tools);
  const clientName = "knowhow-worker";
  const clientVersion = "1.1.1";

  if (!shouldUseSandbox) {
    console.log(`🖥️  Using host mode (${sandboxSource})`);
  }

  // Use the config we already loaded above

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

  // Handle registration flag
  if (options?.register) {
    await registerWorkerPath(process.cwd());
    return;
  }

  const toolsToUse = Tools.getToolsByNames(config.worker.allowedTools);
  mcpServer.createServer(clientName, clientVersion).withTools(toolsToUse);
  console.log("creating mcp server");

  let connected = false;

  async function connectWebSocket() {
    const jwt = await loadJwt();
    console.log(`Connecting to ${API_URL}`);

    const dir = process.cwd();
    const homedir = os.homedir();

    // Use environment variables if available (set by Docker), otherwise compute defaults
    const hostname = process.env.WORKER_HOSTNAME || os.hostname();
    const root =
      process.env.WORKER_ROOT ||
      (dir === homedir ? "~" : dir.replace(homedir, "~"));

    const headers: Record<string, string> = {
      Authorization: `Bearer ${jwt}`,
      "User-Agent": `${clientName}/${clientVersion}/${hostname}`,
      Root: root,
    };

    // Add shared header based on flags
    if (options?.share) {
      headers.Shared = "true";
      console.log("🔓 Worker shared with organization");
    } else if (options?.unshare) {
      headers.Shared = "false";
      console.log("🔒 Worker is now private (unshared)");
    } else {
      console.log("🔒 Worker is private (only you can use it)");
    }

    const ws = new WebSocket(`${API_URL}/ws/worker`, {
      headers,
    });

    console.log("Connecting with ws");
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

    return { ws, mcpServer };
  }

  while (true) {
    let connection: { ws: WebSocket; mcpServer: McpServerService } | null =
      null;

    if (!connected) {
      console.log("Attempting to connect...");
      connection = await connectWebSocket();
    }
    if (connection && connected) {
      try {
        await connection.ws.ping();
      } catch (error) {
        console.error("WebSocket ping failed:", error);
        connected = false;
      }
    }
    await wait(5000);
  }
}
