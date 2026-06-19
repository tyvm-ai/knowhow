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
import { execSync } from "child_process";
import * as path from "path";

// Fix spawn-helper permissions at module load time.
// node-pty's spawn-helper binary must be executable or posix_spawnp fails.
// npm sometimes strips execute permissions when unpacking tarballs.
try {
  const ptyDir = path.dirname(require.resolve("node-pty/package.json"));
  execSync(
    `find ${JSON.stringify(path.join(ptyDir, "prebuilds"))} -name spawn-helper -exec chmod +x {} ;`,
    { stdio: "ignore" }
  );
} catch {
  // best-effort — don't crash the module if this fails
}

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

    // Resolve short command names (e.g. "sh", "bash") to full absolute paths
    // so that node-pty's posix_spawnp can find them regardless of PATH.
    const resolvedCommand = resolveCommand(command);
    if (!resolvedCommand) {
      console.error(`[terminal] Cannot spawn PTY: command not found: ${command}`);
      ctx.send({
        type: TunnelMessageType.PTY_EXIT,
        streamId,
        exitCode: 127,
      });
      return;
    }

    console.log(`[terminal] Spawning PTY streamId=${streamId} cmd=${resolvedCommand} ${args.join(" ")}`);

    let shell: pty.IPty;
    try {
      shell = pty.spawn(resolvedCommand, args, {
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[terminal] pty.spawn failed for cmd=${resolvedCommand}: ${message}`);
      ctx.send({
        type: TunnelMessageType.PTY_EXIT,
        streamId,
        exitCode: 127,
      });
      return;
    }

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

/**
 * Resolve a command name to its full absolute path.
 * If the command is already an absolute path and exists, return it directly.
 * Otherwise try `which <command>` first, then check common shell locations as fallbacks.
 * Returns null if the command cannot be found.
 */
function resolveCommand(command: string): string | null {
  // Already absolute — check it exists and is executable
  if (path.isAbsolute(command)) {
    try {
      execSync(`test -x ${JSON.stringify(command)}`, { stdio: "ignore" });
      return command;
    } catch {
      return null;
    }
  }

  // Try `which` to find it on PATH
  try {
    const result = execSync(`which ${JSON.stringify(command)}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const resolved = result.trim();
    if (resolved) return resolved;
  } catch {
    // which failed — fall through to well-known paths
  }

  // Last-resort: try common absolute paths for well-known shells
  const fallbacks: Record<string, string[]> = {
    sh:   ["/bin/sh", "/usr/bin/sh"],
    bash: ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"],
    zsh:  ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"],
    fish: ["/usr/bin/fish", "/usr/local/bin/fish"],
    dash: ["/bin/dash", "/usr/bin/dash"],
  };

  const candidates = fallbacks[command] ?? [];
  for (const candidate of candidates) {
    try {
      execSync(`test -x ${JSON.stringify(candidate)}`, { stdio: "ignore" });
      return candidate;
    } catch {
      // not found at this path
    }
  }

  return null;
}
