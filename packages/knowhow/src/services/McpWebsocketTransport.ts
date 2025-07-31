import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { WebSocket } from "ws";

export class MCPWebSocketTransport implements Transport {
  protected _socket: WebSocket;
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(socket: WebSocket) {
    this._socket = socket;
  }

  async start(): Promise<void> {
    this._socket.on("message", (data: any) => {
      try {
        let parsed: unknown;
        if (typeof data === "string") {
          parsed = JSON.parse(data);
        } else if (Buffer.isBuffer(data)) {
          parsed = JSON.parse(data.toString("utf-8"));
        } else {
          parsed = JSON.parse(data.toString());
        }
        console.log("MCPW Message received", JSON.stringify(parsed));
        const message = JSONRPCMessageSchema.parse(parsed);
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error as Error);
      }
    });

    this._socket.on("close", () => {
      this.onclose?.();
    });

    this._socket.on("error", (err) => {
      this.onerror?.(err as Error);
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const json = JSON.stringify(message);
      console.log("MCPWs sending", json);

      if (this._socket.readyState !== WebSocket.OPEN) {
        return reject(
          new Error(
            `WebSocket is not open: readyState ${this._socket.readyState}`
          )
        );
      }

      this._socket.send(json, (error?: Error) => {
        if (error) {
          this.onerror?.(error);
          return reject(error);
        }
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this._socket.close();
  }
}
