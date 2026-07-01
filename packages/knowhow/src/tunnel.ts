import os from "os";
import { WebSocket } from "ws";
import { createTunnelHandler, TunnelHandler } from "@tyvm/knowhow-tunnel";
import { loadJwt } from "./login";
import { wait } from "./utils";
import { getConfig } from "./config";
import { KNOWHOW_API_URL } from "./services/KnowhowClient";
import { ModulesService } from "./services/modules";
import { WorkerPasskeyAuthService } from "./workers/auth/WorkerPasskeyAuth";
import { WsMiddlewareStack } from "./workers/auth/WsMiddleware";
import { makeAuthMiddleware } from "./workers/auth/authMiddleware";

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
  /** Optional passkey auth service — if provided, applies WS middleware to gate tunnel traffic */
  authService?: WorkerPasskeyAuthService | null;
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
    authService,
  } = options;

  const tunnelConnection = new WebSocket(`${KNOWHOW_API_URL}/ws/tunnel`, { headers });

  tunnelConnection.on("open", async () => {
    console.log("Tunnel WebSocket connected");

    // Apply passkey auth middleware FIRST, before tunnel handler registers its
    // "message" listener. Node.js EventEmitter fires listeners in registration
    // order, so our middleware runs first. wrapSocket() also redirects future
    // ws.on("message", ...) calls to an inner emitter, ensuring the tunnel
    // handler only receives messages that passed the middleware.
    if (authService) {
      const stack = new WsMiddlewareStack();
      stack.use(makeAuthMiddleware(authService));
      stack.wrapSocket(tunnelConnection);
    }

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
 * The minimal set of tool names that are always registered when running in
 * tunnel mode. These are the tools the backend and frontend need to interact
 * with the tunnel worker (port discovery, passkey auth).
 *
 * Additional tools can be added here in the future without changing the CLI.
 */
export const TUNNEL_MINIMAL_TOOLS = [
  "listAllowedPorts",
  "unlock",
  "lock",
  "reloadConfig",
];
