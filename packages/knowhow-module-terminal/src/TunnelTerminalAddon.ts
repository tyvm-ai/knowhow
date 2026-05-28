import {
  TunnelAddon,
  TunnelAddonContext,
  AnyTunnelMessage,
  TunnelMessageType,
  TunnelPtyOpen,
  TunnelPtyData,
  TunnelPtyResize,
  TunnelPtyClose,
} from "@tyvm/knowhow-tunnel";
import * as pty from "node-pty";

interface PtySession {
  pty: pty.IPty;
  streamId: string;
}

/**
 * TunnelTerminalAddon
 *
 * Handles TUNNEL_PTY_* messages over the existing tunnel WebSocket.
 * No local port is opened — all communication flows through the tunnel.
 *
 * Message flow:
 *   backend → worker  TUNNEL_PTY_OPEN    → spawn PTY
 *   worker  → backend TUNNEL_PTY_DATA    → PTY stdout/stderr output
 *   backend → worker  TUNNEL_PTY_DATA    → keyboard input
 *   backend → worker  TUNNEL_PTY_RESIZE  → resize PTY window
 *   backend → worker  TUNNEL_PTY_CLOSE   → kill PTY
 *   worker  → backend TUNNEL_PTY_EXIT    → PTY process exited
 */
export class TunnelTerminalAddon implements TunnelAddon {
  name = "terminal";

  // Handle all TUNNEL_PTY_* messages via prefix matching
  handles = ["TUNNEL_PTY_"];

  private sessions = new Map<string, PtySession>();

  onDisconnect(): void {
    // Kill all active PTY sessions when the tunnel disconnects
    for (const [streamId, session] of this.sessions) {
      try {
        session.pty.kill();
      } catch {
        // ignore
      }
      this.sessions.delete(streamId);
    }
  }

  async onMessage(message: AnyTunnelMessage, ctx: TunnelAddonContext): Promise<void> {
    switch (message.type) {
      case TunnelMessageType.PTY_OPEN:
        this.handleOpen(message as TunnelPtyOpen, ctx);
        break;
      case TunnelMessageType.PTY_DATA:
        this.handleInput(message as TunnelPtyData);
        break;
      case TunnelMessageType.PTY_RESIZE:
        this.handleResize(message as TunnelPtyResize);
        break;
      case TunnelMessageType.PTY_CLOSE:
        this.handleClose(message as TunnelPtyClose, ctx);
        break;
    }
  }

  private handleOpen(msg: TunnelPtyOpen, ctx: TunnelAddonContext): void {
    const { streamId, command, args = [], cols = 80, rows = 24, env = {} } = msg;

    if (this.sessions.has(streamId)) {
      console.warn(`[terminal] PTY session already exists for streamId=${streamId}`);
      return;
    }

    console.log(`[terminal] Spawning PTY streamId=${streamId} cmd=${command} ${args.join(" ")}`);

    const shell = pty.spawn(command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      } as Record<string, string>,
    });

    const session: PtySession = { pty: shell, streamId };
    this.sessions.set(streamId, session);

    // Forward PTY output back through the tunnel
    shell.onData((data: string) => {
      ctx.send({
        type: TunnelMessageType.PTY_DATA,
        streamId,
        data: Buffer.from(data).toString("base64"),
      });
    });

    shell.onExit(({ exitCode }) => {
      console.log(`[terminal] PTY exited streamId=${streamId} code=${exitCode}`);
      this.sessions.delete(streamId);
      ctx.send({
        type: TunnelMessageType.PTY_EXIT,
        streamId,
        exitCode,
      });
    });
  }

  private handleInput(msg: TunnelPtyData): void {
    const session = this.sessions.get(msg.streamId);
    if (!session) return;
    const text = Buffer.from(msg.data, "base64").toString("utf8");
    session.pty.write(text);
  }

  private handleResize(msg: TunnelPtyResize): void {
    const session = this.sessions.get(msg.streamId);
    if (!session) return;
    session.pty.resize(msg.cols, msg.rows);
  }

  private handleClose(msg: TunnelPtyClose, ctx: TunnelAddonContext): void {
    const session = this.sessions.get(msg.streamId);
    if (!session) return;
    try {
      session.pty.kill();
    } catch {
      // ignore
    }
    this.sessions.delete(msg.streamId);
    ctx.send({
      type: TunnelMessageType.PTY_EXIT,
      streamId: msg.streamId,
      exitCode: 0,
    });
  }
}
