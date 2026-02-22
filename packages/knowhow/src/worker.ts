import os from "os";
import { WebSocket } from "ws";
import { createTunnelHandler, TunnelHandler } from "@tyvm/knowhow-tunnel";
import { includedTools } from "./agents/tools/list";
import { loadJwt } from "./login";
import { services } from "./services";
import { McpServerService } from "./services/Mcp";
import * as allTools from "./agents/tools";
import workerTools from "./workers/tools";
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
  // Combine agent tools and worker-specific tools
  const combinedTools = { ...allTools, ...workerTools.tools };
  Tools.defineTools(includedTools, combinedTools);
  Tools.defineTools(workerTools.definitions, workerTools.tools);

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

  let connected = false;
  let tunnelHandler: TunnelHandler | null = null;
  let tunnelWs: WebSocket | null = null;

  // Check if tunnel is enabled
  const tunnelEnabled = config.worker?.tunnel?.enabled ?? false;

  // Determine localHost based on environment
  let tunnelLocalHost = config.worker?.tunnel?.localHost;
  if (!tunnelLocalHost) {
    // Auto-detect based on Docker environment
    if (isInsideDocker) {
      tunnelLocalHost = "host.docker.internal";
      console.log(
        "🐳 Docker detected: tunnel will use host.docker.internal to reach host services"
      );
    } else {
      tunnelLocalHost = "127.0.0.1";
    }
  }

  // Check for port mapping configuration
  const portMapping = config.worker?.tunnel?.portMapping || {};
  if (Object.keys(portMapping).length > 0) {
    console.log("🔀 Port mapping configured:");
    for (const [containerPort, hostPort] of Object.entries(portMapping)) {
      console.log(`   Container port ${containerPort} → Host port ${hostPort}`);
    }
  }

  if (tunnelEnabled) {
    const tunnelPorts = config.worker?.tunnel?.allowedPorts || [];
    if (tunnelPorts.length === 0) {
      console.warn(
        "⚠️  Tunnel enabled but no allowedPorts configured. Add tunnel.allowedPorts to knowhow.json"
      );
    } else {
      console.log(`🌐 Tunnel enabled for ports: ${tunnelPorts.join(", ")}`);
    }
  } else {
    console.log(
      "🚫 Tunnel disabled (enable in knowhow.json: worker.tunnel.enabled = true)"
    );
  }

  // Extract tunnel domain from API_URL
  // e.g., "https://api.knowhow.tyvm.ai" -> "knowhow.tyvm.ai"
  // e.g., "http://localhost:4000" -> "localhost:4000"
  function extractTunnelDomain(apiUrl: string): {
    domain: string;
    useHttps: boolean;
  } {
    try {
      const url = new URL(apiUrl);
      const useHttps = url.protocol === "https:";

      // For localhost, include port; for production, just use hostname
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
        return {
          domain: `worker.${url.hostname}:${url.port || "80"}`,
          useHttps,
        };
      }
      return { domain: `worker.${url.hostname}`, useHttps };
    } catch (err) {
      console.error("Failed to parse API_URL for tunnel domain:", err);
      return { domain: "worker.localhost:4000", useHttps: false }; // fallback
    }
  }

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

    const { domain: tunnelDomain, useHttps: tunnelUseHttps } =
      extractTunnelDomain(API_URL);

    const ws = new WebSocket(`${API_URL}/ws/worker`, {
      headers,
    });

    // Create separate WebSocket connection for tunnel if enabled
    let tunnelConnection: WebSocket | null = null;
    if (tunnelEnabled) {
      tunnelConnection = new WebSocket(`${API_URL}/ws/tunnel`, {
        headers,
      });

      tunnelConnection.on("open", () => {
        console.log("Tunnel WebSocket connected");

        // Get the allowedPorts configuration
        const allowedPorts = config.worker?.tunnel?.allowedPorts || [];

        // Create URL rewriter callback that can customize URL replacement logic
        // This receives port and metadata from the tunnel request
        const urlRewriter = (port: number, metadata?: any) => {
          const workerId = metadata?.workerId;
          const secret = metadata?.secret;

          // Build the replacement URL based on metadata
          // Examples:
          // - https://workerId-p.tunnelDomain
          // - https://secret.workerId-p.tunnelDomain
          const subdomain = secret
            ? `${secret}.${workerId}-p${port}`
            : `${workerId}-p${port}`;

          const protocol = tunnelUseHttps ? "https" : "http";
          const replacementUrl = `${subdomain}.${tunnelDomain}`;
          return replacementUrl;
        };

        // Initialize tunnel handler with the tunnel-specific WebSocket
        tunnelHandler = createTunnelHandler(tunnelConnection!, {
          allowedPorts,
          maxConcurrentStreams:
            config.worker?.tunnel?.maxConcurrentStreams || 50,
          localHost: tunnelLocalHost,
          urlRewriter,
          enableUrlRewriting:
            config.worker?.tunnel?.enableUrlRewriting !== false,
          portMapping,
          logLevel: "debug",
        });
        console.log("🌐 Tunnel handler initialized");
      });

      tunnelConnection.on("close", (code, reason) => {
        console.log(
          `Tunnel WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`
        );
        console.log(
          "Tunnel connection will reconnect on next connection cycle..."
        );

        // Cleanup tunnel handler
        if (tunnelHandler) {
          tunnelHandler.cleanup();
          tunnelHandler = null;
        }
        tunnelWs = null;

        // Mark as disconnected to trigger reconnection
        // The tunnel websocket is separate but we should reconnect both
        connected = false;
      });

      tunnelConnection.on("error", (error) => {
        console.error("Tunnel WebSocket error:", error);
        // Mark as disconnected on error to trigger reconnection
        connected = false;
      });

      tunnelWs = tunnelConnection;
    }

    ws.on("open", () => {
      console.log("Worker WebSocket connected");
      connected = true;
    });

    ws.on("close", async (code, reason) => {
      console.log(
        `WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`
      );
      console.log("Attempting to reconnect...");

      // Cleanup tunnel handler
      if (tunnelHandler) {
        tunnelHandler = null;
      }

      connected = false;
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });

    mcpServer.runWsServer(ws);

    return { ws, mcpServer, tunnelWs };
  }

  while (true) {
    let connection: {
      ws: WebSocket;
      mcpServer: McpServerService;
      tunnelWs: WebSocket | null;
    } | null = null;

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
