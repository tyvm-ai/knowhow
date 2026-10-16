import {
  JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { WebSocket } from "ws";

export class MCPWebSocketTransport implements Transport {
  protected _socket: WebSocket;
  onmessage?: (message: JSONRPCMessage) => void;
  onrawmessage?: (message: unknown) => boolean | Promise<boolean>;
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
        Promise.resolve(this.onrawmessage?.(parsed) ?? false)
          .then((consumed) => {
            if (consumed) return;
            const message = JSONRPCMessageSchema.parse(parsed);
            // Process message asynchronously to avoid blocking the WebSocket
            // event loop while a long-running tool call is in progress.
            // Without this, all subsequent messages are queued until the
            // current tool call completes.
            setImmediate(() => {
              this.onmessage?.(message);
            });
          })
          .catch((error) => this.onerror?.(error as Error));
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

      if (this._socket.readyState !== WebSocket.OPEN) {
        return reject(
          new Error(
            `WebSocket is not open: readyState ${this._socket.readyState}`
          )
        );
      }

      try {
        this._socket.send(json, (error?: Error) => {
          if (error) {
            this.onerror?.(error);
            return reject(error);
          }
          resolve();
        });
      } catch (error) {
        this.onerror?.(error as Error);
        reject(error);
      }
    });
  }

  async close(): Promise<void> {
    this._socket.close();
  }
}
