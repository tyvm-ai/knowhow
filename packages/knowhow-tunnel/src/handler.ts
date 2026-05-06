import WebSocket from "ws";
import { TunnelProxy } from "./proxy";
import {
  TunnelConfig,
  AnyTunnelMessage,
  TunnelAddon,
  TunnelAddonContext,
} from "./types";
import { parseTunnelMessage } from "./protocol";
import { Logger } from "./utils";
import { TunnelPortForwardingAddon } from "./addon";

/**
 * Tunnel Handler
 * Main entry point for handling tunnel messages over WebSocket.
 *
 * Supports pluggable TunnelAddons via `use()`.  The built-in port-forwarding
 * behaviour is automatically registered as the first addon so that existing
 * behaviour is fully preserved.
 */
export class TunnelHandler {
  private proxy: TunnelProxy;
  private logger: Logger;
  private ws: WebSocket;
  private addons: TunnelAddon[] = [];
  private ctx!: TunnelAddonContext;

  constructor(ws: WebSocket, config: TunnelConfig = {}) {
    this.ws = ws;
    this.logger = new Logger(config.logLevel || "info");

    // Create proxy with send message function
    this.proxy = new TunnelProxy(config, (message: string) => {
      this.sendRaw(message);
    });

    // Build the addon context (shared by all addons)
    this.ctx = {
      send: (message) => {
        this.sendRaw(JSON.stringify(message));
      },
    };

    // Auto-register the port-forwarding addon so existing behaviour is preserved
    this.addons.push(new TunnelPortForwardingAddon(this.proxy));

    this.setupWebSocketHandlers();
  }

  /**
   * Register an addon.  Addons are called in registration order.
   * The built-in TunnelPortForwardingAddon is always registered first.
   */
  use(addon: TunnelAddon): this {
    this.addons.push(addon);
    // If we're already "connected" (ws is open), fire onConnect immediately
    if (this.ws.readyState === WebSocket.OPEN && addon.onConnect) {
      addon.onConnect(this.ctx);
    }
    return this;
  }

  /**
   * Setup WebSocket message handlers
   */
  private setupWebSocketHandlers(): void {
    this.ws.on("open", () => {
      for (const addon of this.addons) {
        if (addon.onConnect) addon.onConnect(this.ctx);
      }
    });

    this.ws.on("message", async (data: WebSocket.Data) => {
      try {
        await this.handleMessage(data);
      } catch (err: any) {
        this.logger.error("Error handling tunnel message:", err.message);
      }
    });

    this.ws.on("error", (err) => {
      this.logger.error("WebSocket error:", err.message);
    });

    this.ws.on("close", () => {
      this.logger.info("WebSocket closed, cleaning up");
      this.cleanup();
    });
  }

  /**
   * Handle incoming message from WebSocket — route to matching addons
   */
  private async handleMessage(data: WebSocket.Data): Promise<void> {
    let messageStr: string;

    if (Buffer.isBuffer(data)) {
      messageStr = data.toString("utf8");
    } else if (typeof data === "string") {
      messageStr = data;
    } else if (Array.isArray(data)) {
      messageStr = Buffer.concat(data).toString("utf8");
    } else {
      this.logger.error("Unknown message data type");
      return;
    }

    let message: AnyTunnelMessage;
    try {
      // parseTunnelMessage validates known types; for unknown (addon) types we
      // do a raw parse so addons still receive them.
      try {
        message = parseTunnelMessage(messageStr) as AnyTunnelMessage;
      } catch {
        const raw = JSON.parse(messageStr);
        message = raw as AnyTunnelMessage;
      }
    } catch (err: any) {
      this.logger.error("Failed to parse tunnel message:", err.message);
      return;
    }

    const msgType: string = (message as any).type;

    // Route to all addons that declare they handle this message type
    let handled = false;
    for (const addon of this.addons) {
      if (this.addonHandles(addon, msgType)) {
        handled = true;
        await addon.onMessage(message, this.ctx);
      }
    }

    if (!handled) {
      this.logger.warn("No addon handled message type:", msgType);
    }
  }

  /**
   * Check whether an addon's `handles` list matches a given message type.
   * Supports exact strings and prefix patterns ending with "_".
   */
  private addonHandles(addon: TunnelAddon, msgType: string): boolean {
    for (const pattern of addon.handles) {
      if (pattern.endsWith("_")) {
        if (msgType.startsWith(pattern)) return true;
      } else {
        if (msgType === pattern) return true;
      }
    }
    return false;
  }

  /**
   * Send raw string over WebSocket
   */
  private sendRaw(message: string): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    } else {
      this.logger.warn("Cannot send message, WebSocket not open");
    }
  }

  /**
   * Get statistics
   */
  getStats(): { activeStreams: number } {
    return {
      activeStreams: this.proxy.getActiveStreamCount(),
    };
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.proxy.cleanup();
    for (const addon of this.addons) {
      if (addon.onDisconnect) addon.onDisconnect();
    }
  }
}

/**
 * Create tunnel handler for a WebSocket connection
 */
export function createTunnelHandler(
  ws: WebSocket,
  config?: TunnelConfig
): TunnelHandler {
  return new TunnelHandler(ws, config);
}
