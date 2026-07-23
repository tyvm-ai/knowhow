import os from "os";
import { WebSocket } from "ws";
import { TunnelHandler } from "@tyvm/knowhow-tunnel";
import { includedTools } from "./agents/tools/list";
import { loadJwt } from "./login";
import { services } from "./services";
import { PasskeySetupService } from "./workers/auth/PasskeySetup";
import { WorkerPasskeyAuthService } from "./workers/auth/WorkerPasskeyAuth";
import {
  makeUnlockTool,
  makeLockTool,
  makeReloadConfigTool,
} from "./workers/tools";
import { McpServerService } from "./services/Mcp";
import * as allTools from "./agents/tools";
import workerTools from "./workers/tools";
import { wait } from "./utils";
import { getConfig, updateConfig } from "./config";
import { KNOWHOW_API_URL } from "./services/KnowhowClient";
import { registerWorkerPath } from "./workerRegistry";
import {
  extractTunnelDomain,
  resolveTunnelConfig,
  connectTunnelWebSocket,
} from "./tunnel";

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
  passkey?: boolean;
  passkeyReset?: boolean;
  allowedTools?: string[];
}) {
  const config = await getConfig();

  // Handle --passkey-reset: remove passkey from config
  if (options?.passkeyReset) {
    const passkeySetup = new PasskeySetupService();
    await passkeySetup.reset();
    return;
  }

  // Handle --passkey: run browser-based passkey registration flow
  if (options?.passkey) {
    let jwt: string;
    try {
      jwt = await loadJwt();
    } catch {
      console.error("❌ You must be logged in to set up a passkey.");
      console.error("   Run 'knowhow login' first.");
      process.exit(1);
    }
    const passkeySetup = new PasskeySetupService();
    await passkeySetup.setup(jwt);
    return;
  }

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

  const { Tools, Mcp } = services();
  // Combine agent tools and worker-specific tools
  const combinedTools = { ...allTools, ...workerTools.tools };
  Tools.defineTools(includedTools, combinedTools);
  Tools.defineTools(workerTools.definitions, workerTools.tools);

  await Mcp.addTools(Tools);

  const mcpServer = new McpServerService(Tools);
  const clientName = "knowhow-worker";
  const clientVersion = "1.1.1";

  // ---------------------------------------------------------------------------
  // Passkey auth gating
  // ---------------------------------------------------------------------------
  let authService: WorkerPasskeyAuthService | null = null;
  const passkeyConfig = config.worker?.auth?.passkey;

  if (passkeyConfig?.publicKey && passkeyConfig?.credentialId) {
    authService = new WorkerPasskeyAuthService(
      {
        publicKey: passkeyConfig.publicKey,
        credentialId: passkeyConfig.credentialId,
        algorithm: -7, // ES256
      },
      config.worker?.auth?.sessionDurationHours ?? 3
    );
    console.log("🔒 Passkey auth enabled — worker starts locked");
  }

  if (!shouldUseSandbox) {
    console.log(`🖥️  Using host mode (${sandboxSource})`);
  }

  // If a tool list override was passed (e.g. from tunnel mode), skip the
  // first-run config write and use it directly.
  if (!options?.allowedTools && (!config.worker || !config.worker.allowedTools)) {
    console.log(
      "Worker tools configured! Update knowhow.json to adjust which tools are allowed by the worker."
    );
    console.log(
      "Tunnel is disabled by default. Set worker.tunnel.enabled = true in knowhow.json to enable it."
    );
    config.worker = {
      ...config.worker,
      allowedTools: Tools.getToolNames(),
      tunnel: {
        enabled: false,
        ...config.worker?.tunnel,
      },
    };
    await updateConfig(config);
    return;
  }

  // Handle registration flag
  if (options?.register) {
    await registerWorkerPath(process.cwd());
    return;
  }

  const resolvedToolNames = options?.allowedTools ?? config.worker!.allowedTools;
  let toolsToUse = Tools.getToolsByNames(resolvedToolNames);

  // If passkey auth is enabled, wrap all tool functions to check locked state
  // and register the unlock/lock auth tools
  if (authService) {
    const _authService = authService;

    // Wrap every configured tool to gate on locked state
    for (const tool of toolsToUse) {
      const toolName = tool.function.name;
      const originalFn = Tools.getFunction(toolName);
      Tools.addFunctions({
        [toolName]: async (...args: any[]) => {
          if (_authService.isLocked()) {
            return {
              error: "WORKER_LOCKED",
              message:
                "Worker is locked. Call the `unlock` tool with your passkey assertion to unlock it first.",
            };
          }
          return originalFn(...args);
        },
      });
    }

    // Build and register the auth tools
    const { unlock, unlockDefinition } = makeUnlockTool(_authService);
    const { lock, lockDefinition } = makeLockTool(_authService);

    Tools.addFunctions({ unlock, lock });
    toolsToUse = [unlockDefinition, lockDefinition, ...toolsToUse];

    console.log("🔑 Auth tools registered: unlock, lock");
  }

  // Register the reloadConfig tool so agents can hot-reload MCPs/config
  // without restarting the worker process.
  // Uses a closure over `toolsToUse` so the tool can update it in-place.
  const { reloadConfig, reloadConfigDefinition } = makeReloadConfigTool(
    Mcp,
    Tools,
    mcpServer,
    (newTools) => {
      toolsToUse = newTools;
    }
  );
  Tools.addFunctions({ reloadConfig });
  toolsToUse = [...toolsToUse, reloadConfigDefinition];

  console.log("🔄 reloadConfig tool registered");

  mcpServer.createServer(clientName, clientVersion).withTools(toolsToUse);

  let connected = false;
  let tunnelHandler: TunnelHandler | null = null;
  let tunnelWs: WebSocket | null = null;
  let lastJwt: string | null = null;
  let unauthorizedJwt: string | null = null;

  // ---------------------------------------------------------------------------
  // Liveness watchdog state
  // ---------------------------------------------------------------------------
  // After a full snapshot (mem + disk) the VM is paused and later resumed,
  // potentially on a different host. The guest kernel resumes believing its
  // TCP socket to the backend is still ESTABLISHED, but the server tore that
  // connection down long ago. This produces a "zombie" half-open socket:
  //   - ws.on("close") never fires (guest never saw a FIN/RST)
  //   - ws.ping() does NOT throw (kernel still thinks the socket is open)
  // so `connected` would stay true forever and we'd never reconnect.
  //
  // The fix is an active heartbeat with a pong DEADLINE: we send a ping every
  // loop tick and require a pong before the next tick. If the pong never
  // arrives, we treat the socket as dead, terminate() it (frees the zombie
  // immediately and fires "close"), and let the reconnect loop take over.
  const PONG_TIMEOUT_MS = 15000;
  let awaitingPong = false;
  let lastPongAt = Date.now();
  let tunnelAwaitingPong = false;
  let tunnelLastPongAt = Date.now();
  // Check if tunnel is enabled.
  // When allowedTools is passed as an override (e.g. from `knowhow tunnel`),
  // the tunnel is always forced on — that's the whole point of tunnel mode.
  const tunnelEnabled = options?.allowedTools
    ? true
    : (config.worker?.tunnel?.enabled ?? false);

  const { tunnelLocalHost, portMapping } = resolveTunnelConfig(config, isInsideDocker);

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

  async function connectWebSocket() {
    const jwt = await loadJwt();
    console.log(`Connecting to ${API_URL}`);
    lastJwt = jwt;

    // Reset the MCP server to avoid "Already connected to a transport" error on reconnects
    await mcpServer.reset();
    // Re-register tools after reset (registeredTools set was cleared)
    mcpServer.withTools(toolsToUse);

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

    // Listen for workerRegistered message from the backend before MCP transport takes over.
    // The MCP transport will swallow non-JSONRPC messages silently, but we attach a raw
    // listener here first to capture the workerId sent back by the backend after upsert.
    const workerRegisteredHandler = async (data: any) => {
      try {
        const parsed = JSON.parse(
          typeof data === "string" ? data : data.toString()
        );
        if (parsed?.type === "workerRegistered" && parsed?.workerId) {
          const currentConfig = await getConfig();
          const currentWorkerId = currentConfig.worker?.workerId;
          if (currentWorkerId !== parsed.workerId) {
            await updateConfig({
              ...currentConfig,
              worker: {
                ...currentConfig.worker,
                workerId: parsed.workerId,
              },
            });
            console.log(`✅ Worker ID recorded: ${parsed.workerId}`);
          }
        }

        // Hot-reload: re-read config, reconnect MCPs, and rebuild the tool list
        // without restarting the worker process.
        if (parsed?.type === "reloadConfig") {
          console.log(
            "🔄 Received reloadConfig — reloading MCPs, modules and tools..."
          );
          try {
            // Re-read fresh config from disk
            const freshConfig = await getConfig();

            // Close all existing MCP connections
            await Mcp.closeAll();

            // Reconnect from fresh config and re-register tools
            await Mcp.connectToConfigured(Tools);

            // Rebuild the allowed tools list from fresh config
            const allowedToolNames =
              freshConfig.worker?.allowedTools ?? Tools.getToolNames();
            toolsToUse = Tools.getToolsByNames(allowedToolNames);

            // Update the MCP server with new tool list
            mcpServer.withTools(toolsToUse);

            console.log(
              `✅ Config reloaded: ${toolsToUse.length} tools active`
            );
          } catch (err) {
            console.error("❌ Failed to reload config:", err);
          }
        }
      } catch {
        // Not our message — ignore parse errors
      }
    };
    ws.on("message", workerRegisteredHandler);

    // Create separate WebSocket connection for tunnel if enabled
    let tunnelConnection: WebSocket | null = null;
    if (tunnelEnabled) {
      tunnelConnection = connectTunnelWebSocket({
        tunnelDomain,
        tunnelUseHttps,
        tunnelLocalHost,
        portMapping,
        config,
        headers,
        authService,
        onOpen: (handler) => {
          tunnelHandler = handler;
          // Reset tunnel heartbeat state for the fresh connection
          tunnelAwaitingPong = false;
          tunnelLastPongAt = Date.now();
        },
        onPong: () => {
          tunnelAwaitingPong = false;
          tunnelLastPongAt = Date.now();
        },
        onClose: (code, _reason) => {
          if (code === 1008) {
            unauthorizedJwt = lastJwt;
            console.error(
              "❌ Tunnel received Unauthorized (1008). The JWT may be expired."
            );
            console.error("   Pausing reconnection until JWT changes...");
          } else {
            console.log(
              "Tunnel connection will reconnect on next connection cycle..."
            );
          }
          if (tunnelHandler) {
            tunnelHandler.cleanup();
            tunnelHandler = null;
          }
          tunnelWs = null;
          // The tunnel websocket is separate but we should reconnect both
          connected = false;
        },
        onError: (_error) => {
          connected = false;
        },
      });

      tunnelWs = tunnelConnection;
    }

    ws.on("open", () => {
      console.log("Worker WebSocket connected");
      connected = true;
      // Reset heartbeat state for the fresh connection
      awaitingPong = false;
      lastPongAt = Date.now();
    });

    // Pong watchdog: the server responds to our ws.ping() with a pong frame.
    // Receiving it proves the socket is genuinely alive (not a snapshot zombie).
    ws.on("pong", () => {
      awaitingPong = false;
      lastPongAt = Date.now();
    });

    ws.on("close", async (code, reason) => {
      console.log(
        `WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`
      );

      // Cleanup tunnel handler
      if (tunnelHandler) {
        tunnelHandler = null;
      }

      connected = false;

      // If we got an Unauthorized (1008) close, record the JWT that failed
      // so we don't keep hammering the server with the same expired token
      if (code === 1008) {
        unauthorizedJwt = lastJwt;
        console.error(
          "❌ Worker received Unauthorized (1008). The JWT may be expired."
        );
        console.error(
          "   Run 'knowhow login' to refresh your token, then restart the worker."
        );
        console.error("   Pausing reconnection until JWT changes...");
      } else {
        console.log("Attempting to reconnect...");
      }
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });

    mcpServer.runWsServer(ws);

    return { ws, mcpServer, tunnelWs };
  }

  // Keep the active connection reference OUTSIDE the loop so it persists across
  // heartbeat ticks. (Previously this was declared inside the loop and reset to
  // null every iteration, so the heartbeat only ever ran on the tick right after
  // a (re)connect — meaning a live connection was never actively pinged.)
  let connection: {
    ws: WebSocket;
    mcpServer: McpServerService;
    tunnelWs: WebSocket | null;
  } | null = null;

  while (true) {
    if (!connected) {
      // If we got an Unauthorized error, check if the JWT has changed before retrying
      if (unauthorizedJwt !== null) {
        const currentJwt = await loadJwt().catch(() => null);
        if (currentJwt === unauthorizedJwt) {
          // JWT hasn't changed - don't reconnect, just wait
          await wait(5000);
          continue;
        }
        // JWT changed - clear the unauthorized state and reconnect
        console.log("🔄 JWT has changed, attempting to reconnect...");
        unauthorizedJwt = null;
      }

      console.log("Attempting to connect...");
      connection = await connectWebSocket();
    }

    if (connection && connected) {
      // -----------------------------------------------------------------------
      // Worker socket liveness: active ping + pong DEADLINE.
      //
      // On the previous tick we sent a ping and set awaitingPong=true. If the
      // "pong" handler fired, it cleared awaitingPong. If it's still set here
      // AND the deadline has elapsed, the socket is a zombie (e.g. after a full
      // snapshot resume where the guest's TCP connection is dead but the kernel
      // still thinks it's open, so ws.ping() won't throw and "close" won't fire).
      // Terminate it to free the socket immediately and drive a reconnect.
      // -----------------------------------------------------------------------
      if (awaitingPong && Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
        console.error(
          `WebSocket pong timeout (${PONG_TIMEOUT_MS}ms) — connection is dead (likely a snapshot-resume zombie). Forcing reconnect...`
        );
        try {
          connection.ws.terminate();
        } catch {
          // ignore
        }
        connected = false;
      } else {
        try {
          awaitingPong = true;
          connection.ws.ping();
        } catch (error) {
          console.error("WebSocket ping failed:", error);
          connected = false;
        }
      }

      // -----------------------------------------------------------------------
      // Tunnel socket liveness: same pong-deadline watchdog on the separate
      // tunnel WebSocket, which has the identical zombie problem after resume.
      // -----------------------------------------------------------------------
      if (connected && tunnelWs && tunnelWs.readyState === WebSocket.OPEN) {
        if (tunnelAwaitingPong && Date.now() - tunnelLastPongAt > PONG_TIMEOUT_MS) {
          console.error(
            `Tunnel WebSocket pong timeout (${PONG_TIMEOUT_MS}ms) — tunnel connection is dead. Forcing reconnect...`
          );
          try {
            tunnelWs.terminate();
          } catch {
            // ignore
          }
          // Dropping the tunnel forces the whole connection cycle to re-establish.
          connected = false;
        } else {
          try {
            tunnelAwaitingPong = true;
            tunnelWs.ping();
          } catch (error) {
            console.error("Tunnel WebSocket ping failed:", error);
            connected = false;
          }
        }
      }
    }
    await wait(5000);
  }
}
