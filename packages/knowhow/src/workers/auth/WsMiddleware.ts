import { WebSocket } from "ws";
import EventEmitter from "events";

/**
 * A middleware function that intercepts raw WebSocket messages before
 * they reach the transport/handler layer.
 *
 * - Call next() to pass the message through.
 * - Call next(err) to abort (the socket will be closed with code 1008 + reason).
 * - Sending a reply directly on ws is allowed (e.g. for auth challenges).
 */
export type WsMiddlewareFn = (
  ws: WebSocket,
  data: Buffer | string,
  next: (err?: Error) => void
) => void | Promise<void>;

export class WsMiddlewareStack {
  private fns: WsMiddlewareFn[] = [];

  use(fn: WsMiddlewareFn): this {
    this.fns.push(fn);
    return this;
  }

  /**
   * Attach all middleware to a WebSocket, intercepting every "message" event.
   * Once a message passes all middleware, onMessage is called.
   * Use this for MCP transports where you control the message handler directly.
   */
  attach(ws: WebSocket, onMessage: (data: Buffer | string) => void): void {
    ws.on("message", async (data: Buffer | string) => {
      let i = 0;
      const next = async (err?: Error): Promise<void> => {
        if (err) {
          console.error("WS middleware rejected message:", err.message);
          ws.close(1008, err.message);
          return;
        }
        const fn = this.fns[i++];
        if (fn) {
          await fn(ws, data, next);
        } else {
          onMessage(data);
        }
      };
      await next();
    });
  }

  /**
   * Wrap a WebSocket so ALL incoming messages pass through this middleware
   * before being dispatched to any subsequently-registered "message" listeners.
   *
   * Call this BEFORE any other code attaches "message" handlers (e.g. before
   * initTunnelHandler). Uses Node.js EventEmitter ordering: our listener runs
   * first because it was registered first.
   *
   * After wrapSocket(), any subsequent ws.on("message", handler) calls are
   * redirected to an inner EventEmitter that only receives messages that have
   * passed all middleware. This ensures the tunnel handler's listener is
   * automatically gated by the middleware.
   */
  wrapSocket(ws: WebSocket): void {
    const innerEmitter = new EventEmitter();

    // Our listener runs first (registered before tunnel handler's listener).
    ws.on("message", async (data: Buffer | string) => {
      let i = 0;
      const next = async (err?: Error): Promise<void> => {
        if (err) {
          console.error("WS middleware rejected message:", err.message);
          ws.close(1008, err.message);
          return;
        }
        const fn = this.fns[i++];
        if (fn) {
          await fn(ws, data, next);
        } else {
          // All middleware passed — dispatch to inner listeners
          innerEmitter.emit("message", data);
        }
      };
      await next();
    });

    // Redirect future ws.on("message", ...) calls to innerEmitter.
    // This means createTunnelHandler()'s listener goes to innerEmitter,
    // so it only receives messages that passed middleware.
    const originalOn = ws.on.bind(ws);
    (ws as any).on = (event: string, listener: (...args: any[]) => void) => {
      if (event === "message") {
        innerEmitter.on("message", listener);
        return ws;
      }
      return originalOn(event, listener);
    };
  }
}
