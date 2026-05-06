import { TunnelProxy } from "./proxy";
import {
  TunnelAddon,
  TunnelAddonContext,
  AnyTunnelMessage,
  TunnelMessageType,
  TunnelMessage,
} from "./types";

/**
 * TunnelPortForwardingAddon
 *
 * Wraps the existing TunnelProxy so all existing HTTP/WS port-forwarding
 * behaviour is preserved when the addon system is in use.
 */
export class TunnelPortForwardingAddon implements TunnelAddon {
  name = "port-forwarding";

  handles = [
    TunnelMessageType.REQUEST,
    TunnelMessageType.DATA,
    TunnelMessageType.END,
    TunnelMessageType.WS_UPGRADE,
    TunnelMessageType.WS_DATA,
    TunnelMessageType.WS_CLOSE,
  ];

  private proxy: TunnelProxy;

  constructor(proxy: TunnelProxy) {
    this.proxy = proxy;
  }

  onMessage(message: AnyTunnelMessage, _ctx: TunnelAddonContext): void {
    const msg = message as TunnelMessage;
    switch (msg.type) {
      case TunnelMessageType.REQUEST:
        this.proxy.handleRequest(msg);
        break;
      case TunnelMessageType.DATA: {
        const data = Buffer.isBuffer(msg.data)
          ? msg.data
          : Buffer.from(msg.data as string, "base64");
        this.proxy.handleData(msg.streamId, data);
        break;
      }
      case TunnelMessageType.END:
        this.proxy.handleEnd(msg.streamId);
        break;
      case TunnelMessageType.WS_UPGRADE:
        this.proxy.handleWsUpgrade(msg);
        break;
      case TunnelMessageType.WS_DATA: {
        const data = Buffer.isBuffer(msg.data)
          ? msg.data
          : Buffer.from(msg.data as string, "base64");
        this.proxy.handleWsData(msg.streamId, data, msg.isBinary);
        break;
      }
      case TunnelMessageType.WS_CLOSE:
        this.proxy.handleWsClose(msg.streamId, msg.code, msg.reason);
        break;
    }
  }
}
