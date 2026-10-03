const {
  getWebSocketForwardHeaders,
  getWebSocketProtocols,
} = require("../dist/proxy");

describe("getWebSocketProtocols", () => {
  test("extracts Vite's WebSocket subprotocol case-insensitively", () => {
    expect(
      getWebSocketProtocols({ "Sec-WebSocket-Protocol": "vite-hmr" })
    ).toEqual(["vite-hmr"]);
  });

  test("splits multiple protocols and ignores missing headers", () => {
    expect(
      getWebSocketProtocols({ "sec-websocket-protocol": "one, two" })
    ).toEqual(["one", "two"]);
    expect(getWebSocketProtocols({ host: "localhost" })).toEqual([]);
  });
});

describe("getWebSocketForwardHeaders", () => {
  test("removes outer handshake headers but preserves application headers", () => {
    expect(
      getWebSocketForwardHeaders({
        Host: "tunnel.example",
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "outer-key",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Protocol": "vite-hmr",
        Cookie: "session=abc",
        Origin: "https://tunnel.example",
      })
    ).toEqual({
      Cookie: "session=abc",
      Origin: "https://tunnel.example",
    });
  });
});
