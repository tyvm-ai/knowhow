import WebSocket from "ws";
import { TunnelProxy } from "./proxy";
import {
  TunnelConfig,
  TunnelMessage,
  TunnelMessageType,
} from "./types";
import { parseTunnelMessage } from "./protocol";
import { Logger } from "./utils";

/**
 * Tunnel Handler
 * Main entry point for handling tunnel messages over WebSocket
 */
export class TunnelHandler {
  private proxy: TunnelProxy;
  private logger: Logger;
  private ws: WebSocket;

  constructor(ws: WebSocket, config: TunnelConfig = {}) {
    this.ws = ws;
    this.logger = new Logger(config.logLevel || "info");
    
    // Create proxy with send message function
    this.proxy = new TunnelProxy(config, (message: string) => {
      this.sendMessage(message);
    });

    this.setupWebSocketHandlers();
  }

  /**
   * Setup WebSocket message handlers
   */
  private setupWebSocketHandlers(): void {
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
   * Handle incoming message from WebSocket
   */
  private async handleMessage(data: WebSocket.Data): Promise<void> {
    // Convert data to string if it's JSON
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

    // Try to parse as JSON
    let message: TunnelMessage;
    try {
      message = parseTunnelMessage(messageStr);
    } catch (err: any) {
      this.logger.error("Failed to parse tunnel message:", err.message);
      return;
    }

    // Route message to appropriate handler
    switch (message.type) {
      case TunnelMessageType.REQUEST:
        await this.proxy.handleRequest(message);
        break;

      case TunnelMessageType.DATA:
        {
          const data = this.decodeData(message.data);
          this.proxy.handleData(message.streamId, data);
        }
        break;

      case TunnelMessageType.END:
        this.proxy.handleEnd(message.streamId);
        break;

      case TunnelMessageType.WS_UPGRADE:
        await this.proxy.handleWsUpgrade(message);
        break;

      case TunnelMessageType.WS_DATA:
        {
          const data = this.decodeData(message.data);
          this.proxy.handleWsData(message.streamId, data, message.isBinary);
        }
        break;

      case TunnelMessageType.WS_CLOSE:
        this.proxy.handleWsClose(message.streamId, message.code, message.reason);
        break;

      default:
        this.logger.warn("Unknown message type:", (message as any).type);
    }
  }

  /**
   * Decode data from message (handle base64 encoding)
   */
  private decodeData(data: Buffer | string): Buffer {
    if (Buffer.isBuffer(data)) {
      return data;
    }
    
    // Assume base64 encoded string
    return Buffer.from(data, "base64");
  }

  /**
   * Send message over WebSocket
   */
  private sendMessage(message: string): void {
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
