import { EventEmitter } from "events";
import { WebSocket } from "ws";
import { MCPWebSocketTransport } from "../../src/services/McpWebsocketTransport";

class TestSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  // Simulate send() calling the callback immediately (required by MCPWebSocketTransport.send())
  send = jest.fn((data: string, cb?: (err?: Error) => void) => { cb?.(); });
  close = jest.fn();
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("MCPWebSocketTransport", () => {
  it("delivers valid JSON-RPC frames to onmessage", async () => {
    const socket = new TestSocket();
    const transport = new MCPWebSocketTransport(socket as unknown as WebSocket);
    const response = { jsonrpc: "2.0", id: 1, result: {} };
    transport.onmessage = jest.fn();
    transport.onerror = jest.fn();

    await transport.start();
    socket.emit("message", JSON.stringify(response));
    await flush();
    await flush();

    expect(transport.onmessage).toHaveBeenCalledWith(response);
    expect(transport.onerror).not.toHaveBeenCalled();
  });

  it("calls onerror for invalid JSON-RPC frames", async () => {
    const socket = new TestSocket();
    const transport = new MCPWebSocketTransport(socket as unknown as WebSocket);
    const invalid = { notJsonRpc: true };
    transport.onmessage = jest.fn();
    transport.onerror = jest.fn();

    await transport.start();
    socket.emit("message", JSON.stringify(invalid));
    await flush();

    expect(transport.onmessage).not.toHaveBeenCalled();
    expect(transport.onerror).toHaveBeenCalled();
  });

  it("sends serialized JSON over the socket", async () => {
    const socket = new TestSocket();
    const transport = new MCPWebSocketTransport(socket as unknown as WebSocket);
    await transport.start();

    const msg = { jsonrpc: "2.0" as const, method: "ping", id: 42 };
    await transport.send(msg);

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify(msg), expect.any(Function));
  });
});
