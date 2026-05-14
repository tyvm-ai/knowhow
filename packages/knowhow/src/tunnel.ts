import os from "os";
import { WebSocket } from "ws";
import { createTunnelHandler, TunnelHandler } from "@tyvm/knowhow-tunnel";
import { loadJwt } from "./login";
import { wait } from "./utils";
import { getConfig } from "./config";
import { KNOWHOW_API_URL } from "./services/KnowhowClient";
import { ModulesService } from "./services/modules";

const API_URL = KNOWHOW_API_URL;

/**
 * Extract the tunnel domain and protocol from the API URL.
 * e.g., "https://api.knowhow.tyvm.ai" -> { domain: "worker.knowhow.tyvm.ai", useHttps: true }
 * e.g., "http://localhost:4000" -> { domain: "worker.localhost:4000", useHttps: false }
 */
export function extractTunnelDomain(apiUrl: string): {
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

/**
 * Initialize a tunnel handler and load tunnel modules.
 */
export async function initTunnelHandler(
  tunnelConnection: WebSocket,
  tunnelConfig: Parameters<typeof createTunnelHandler>[1]
): Promise<TunnelHandler> {
  const handler = createTunnelHandler(tunnelConnection, tunnelConfig);
  console.log("🌐 Tunnel handler initialized");
  console.log(tunnelConfig);

  const tunnelModuleService = new ModulesService();
  const tunnelContext = await tunnelModuleService.overrideDefaultContext({
    Tunnel: handler,
  });
  tunnelModuleService.loadModulesFromConfig(tunnelContext).catch((err) => {
    console.error("Failed to load tunnel modules:", err);
  });

  return handler;
}

/**
 * Resolve tunnel local host, log port mapping, and return shared tunnel setup values.
 * Extracted to avoid duplication between worker() and tunnel().
 */
export function resolveTunnelConfig(
  config: Awaited<ReturnType<typeof getConfig>>,
  isInsideDocker: boolean
): { tunnelLocalHost: string; portMapping: Record<string, number> } {
  // Determine localHost based on environment
  let tunnelLocalHost = config.worker?.tunnel?.localHost;
  if (!tunnelLocalHost) {
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
  const portMapping = (config.worker?.tunnel?.portMapping || {}) as Record<string, number>;
  if (Object.keys(portMapping).length > 0) {
    console.log("🔀 Port mapping configured:");
    for (const [containerPort, hostPort] of Object.entries(portMapping)) {
      console.log(`   Container port ${containerPort} → Host port ${hostPort}`);
    }
  }

  return { tunnelLocalHost, portMapping };
}

/**
 * Options for connectTunnelWebSocket helper.
 */
export interface TunnelWebSocketOptions {
  /** Already-resolved tunnel domain (hostname only, no protocol) */
  tunnelDomain: string;
  /** Whether the tunnel should use HTTPS */
  tunnelUseHttps: boolean;
  /** Local host to forward tunnel traffic to */
  tunnelLocalHost: string;
  /** Port mapping configuration */
  portMapping: Record<string, number>;
  /** Worker config (for tunnel sub-config) */
  config: Awaited<ReturnType<typeof getConfig>>;
  /** HTTP headers to attach to the WebSocket upgrade request */
  headers: Record<string, string>;
  /** Callback invoked with the TunnelHandler once the connection opens */
  onOpen?: (handler: TunnelHandler) => void;
  /** Called when the connection closes; receives code + reason string */
  onClose?: (code: number, reason: string) => void;
  /** Called on error */
  onError?: (error: Error) => void;
}

/**
 * Create a tunnel WebSocket connection, build the tunnelConfig, and
 * initialize the tunnel handler.  Returns the WebSocket.
 *
 * The caller is responsible for storing a reference to the returned TunnelHandler
 * (via onOpen) and performing any outer-state cleanup (via onClose / onError).
 */
export function connectTunnelWebSocket(
  options: TunnelWebSocketOptions
): WebSocket {
  const {
    tunnelDomain,
    tunnelUseHttps,
    tunnelLocalHost,
    portMapping,
    config,
    headers,
    onOpen,
    onClose,
    onError,
  } = options;

  const tunnelConnection = new WebSocket(`${API_URL}/ws/tunnel`, { headers });

  tunnelConnection.on("open", async () => {
    console.log("Tunnel WebSocket connected");

    const allowedPorts = config.worker?.tunnel?.allowedPorts || [];

    // Create URL rewriter callback that returns the hostname (without protocol).
    // The tunnel package will add the protocol based on the useHttps config.
    const urlRewriter = (port: number, metadata?: any) => {
      const workerId = metadata?.workerId;
      const secret = metadata?.secret;
      // Examples: secret-p3000.worker.example.com  /  workerId-p3000.worker.example.com
      const subdomain = secret
        ? `${secret}-p${port}`
        : `${workerId}-p${port}`;
      return `${subdomain}.${tunnelDomain}`;
    };

    const tunnelConfig = {
      allowedPorts,
      maxConcurrentStreams: config.worker?.tunnel?.maxConcurrentStreams || 50,
      tunnelUseHttps,
      localHost: tunnelLocalHost,
      urlRewriter,
      enableUrlRewriting: config.worker?.tunnel?.enableUrlRewriting !== false,
      portMapping,
      logLevel: "debug" as const,
    };

    const handler = await initTunnelHandler(tunnelConnection, tunnelConfig);
    onOpen?.(handler);
  });

  tunnelConnection.on("close", (code, reason) => {
    console.log(
      `Tunnel WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`
    );
    onClose?.(code, reason.toString());
  });

  tunnelConnection.on("error", (error) => {
    console.error("Tunnel WebSocket error:", error);
    onError?.(error);
  });

  return tunnelConnection;
}

/**
 * Run tunnel-only mode: connects to the Knowhow tunnel WebSocket without
 * registering any MCP tools. Useful for users who only want the web tunnel
 * feature to expose local ports to the cloud.
 */
export async function tunnel(options?: { share?: boolean; unshare?: boolean }) {
  const config = await getConfig();

  const isInsideDocker = process.env.KNOWHOW_DOCKER === "true";

  const { tunnelLocalHost, portMapping } = resolveTunnelConfig(config, isInsideDocker);

  const tunnelPorts = config.worker?.tunnel?.allowedPorts || [];
  if (tunnelPorts.length === 0) {
    console.warn(
      "⚠️  No allowedPorts configured. Add worker.tunnel.allowedPorts to knowhow.json"
    );
  } else {
    console.log(`🌐 Tunnel mode for ports: ${tunnelPorts.join(", ")}`);
  }

  let connected = false;
  let tunnelHandler: TunnelHandler | null = null;
  let lastJwt: string | null = null;
  let unauthorizedJwt: string | null = null;

  async function connectTunnel() {
    const jwt = await loadJwt();
    lastJwt = jwt;
    console.log(`Connecting tunnel to ${API_URL}`);

    const dir = process.cwd();
    const homedir = os.homedir();
    const hostname = process.env.WORKER_HOSTNAME || os.hostname();
    const root =
      process.env.WORKER_ROOT ||
      (dir === homedir ? "~" : dir.replace(homedir, "~"));

    const headers: Record<string, string> = {
      Authorization: `Bearer ${jwt}`,
      "User-Agent": `knowhow-tunnel/1.0.0/${hostname}`,
      Root: root,
    };

    if (options?.share) {
      headers.Shared = "true";
      console.log("🔓 Tunnel shared with organization");
    } else if (options?.unshare) {
      headers.Shared = "false";
      console.log("🔒 Tunnel is now private (unshared)");
    } else {
      console.log("🔒 Tunnel is private (only you can use it)");
    }

    const { domain: tunnelDomain, useHttps: tunnelUseHttps } =
      extractTunnelDomain(API_URL);

    const tunnelConnection = connectTunnelWebSocket({
      tunnelDomain,
      tunnelUseHttps,
      tunnelLocalHost,
      portMapping,
      config,
      headers,
      onOpen: (handler) => {
        connected = true;
        tunnelHandler = handler;
      },
      onClose: (code, _reason) => {
        if (code === 1008) {
          unauthorizedJwt = lastJwt;
          console.error(
            "❌ Tunnel received Unauthorized (1008). The JWT may be expired."
          );
          console.error(
            "   Run 'knowhow login' to refresh your token, then restart."
          );
          console.error("   Pausing reconnection until JWT changes...");
        } else {
          console.log("Tunnel connection will reconnect on next cycle...");
        }
        if (tunnelHandler) {
          tunnelHandler.cleanup();
          tunnelHandler = null;
        }
        connected = false;
      },
      onError: (_error) => {
        connected = false;
      },
    });

    return tunnelConnection;
  }

  while (true) {
    if (!connected) {
      if (unauthorizedJwt !== null) {
        const currentJwt = await loadJwt().catch(() => null);
        if (currentJwt === unauthorizedJwt) {
          await wait(5000);
          continue;
        }
        console.log("🔄 JWT has changed, attempting to reconnect tunnel...");
        unauthorizedJwt = null;
      }
      console.log("Attempting to connect tunnel...");
      await connectTunnel();
    }
    await wait(5000);
  }
}
