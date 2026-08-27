import {
  TunnelAddon,
  TunnelAddonContext,
  AnyTunnelMessage,
  TunnelMessageType,
  TunnelPtyOpen,
  TunnelPtyData,
  TunnelPtyResize,
  TunnelPtyClose,
  TunnelPtyList,
  TunnelPtyDetach,
  TunnelPtySessionInfo,
} from "@tyvm/knowhow-tunnel";
import * as pty from "node-pty";
import { execSync } from "child_process";
import * as path from "path";
import {
  sessions,
  terminatedSessions,
  markTerminated,
  MAX_REPLAY_BYTES,
  MAX_TERMINATED_IDS,
  PtySession,
} from "./sessionAccessor";

// Fix spawn-helper permissions at module load time.
// node-pty's spawn-helper binary must be executable or posix_spawnp fails.
// npm sometimes strips execute permissions when unpacking tarballs.
try {
  const ptyDir = path.dirname(require.resolve("node-pty/package.json"));
  execSync(
    `find ${JSON.stringify(path.join(ptyDir, "prebuilds"))} -name spawn-helper -exec chmod +x {} \\;`,
    { stdio: "ignore" }
  );
} catch {
  // best-effort — don't crash the module if this fails
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
  private context: TunnelAddonContext | null = null;

  onDisconnect(): void {
    // A transport disconnect is only a detach. PTYs intentionally keep running.
    for (const session of sessions.values()) {
      for (const [streamId, ctx] of session.attachments) {
        if (ctx === this.context) session.attachments.delete(streamId);
      }
    }
    this.context = null;
  }

  async onMessage(message: AnyTunnelMessage, ctx: TunnelAddonContext): Promise<void> {
    this.context = ctx;
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
        this.handleClose(message as TunnelPtyClose);
        break;
      case TunnelMessageType.PTY_LIST:
        this.handleList(message as TunnelPtyList, ctx);
        break;
      case TunnelMessageType.PTY_DETACH:
        this.handleDetach(message as TunnelPtyDetach);
        break;
    }
  }

  private handleOpen(msg: TunnelPtyOpen, ctx: TunnelAddonContext): void {
    const { streamId, command, args = [], cols = 80, rows = 24, env = {} } = msg;
    const terminalId = msg.terminalId || streamId;

    // A stable ID that has already exited must not silently spawn a replacement
    // when a detached browser or CLI reconnects later.
    const priorExitCode = terminatedSessions.get(terminalId);
    if (priorExitCode !== undefined) {
      ctx.send({
        type: TunnelMessageType.PTY_EXIT,
        streamId,
        exitCode: priorExitCode,
      });
      return;
    }

    const existing = sessions.get(terminalId);
    if (existing) {
      this.attach(existing, streamId, ctx, cols, rows);
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

    const session: PtySession = {
      pty: shell,
      terminalId,
      command: [command, ...args].join(" "), createdAt: new Date(),
      cols,
      rows,
      output: Buffer.alloc(0),
      attachments: new Map([[streamId, ctx]]),
    };
    sessions.set(terminalId, session);
    ctx.send({
      type: TunnelMessageType.PTY_ATTACHED,
      streamId,
      terminalId,
      existing: false,
    });

    // Forward each PTY output chunk to every browser attached to this session.
    shell.onData((data: string) => {
      const chunk = Buffer.from(data);
      session.output = Buffer.concat([session.output, chunk]);
      if (session.output.length > MAX_REPLAY_BYTES) {
        session.output = session.output.subarray(session.output.length - MAX_REPLAY_BYTES);
      }
      for (const [attachedStreamId, attachedCtx] of session.attachments) {
        attachedCtx.send({
          type: TunnelMessageType.PTY_DATA,
          streamId: attachedStreamId,
          data: chunk.toString("base64"),
        });
      }
    });

    shell.onExit(({ exitCode }) => {
      console.log(`[terminal] PTY exited terminalId=${terminalId} code=${exitCode}`);
      markTerminated(terminalId, exitCode);
      sessions.delete(terminalId);
      for (const [attachedStreamId, attachedCtx] of session.attachments) {
        attachedCtx.send({
          type: TunnelMessageType.PTY_EXIT,
          streamId: attachedStreamId,
          exitCode,
        });
      }
      session.attachments.clear();
    });
  }

  private handleDetach(msg: TunnelPtyDetach): void {
    const session = this.findByStream(msg.streamId);
    if (!session) return;
    session.attachments.delete(msg.streamId);
  }

  private handleInput(msg: TunnelPtyData): void {
    const session = this.findByStream(msg.streamId);
    if (!session) return;
    const text = Buffer.from(msg.data, "base64").toString("utf8");
    session.pty.write(text);
  }

  private handleResize(msg: TunnelPtyResize): void {
    const session = this.findByStream(msg.streamId);
    if (!session) return;
    session.cols = msg.cols;
    session.rows = msg.rows;
    session.pty.resize(msg.cols, msg.rows);
  }

  private handleClose(msg: TunnelPtyClose): void {
    const session = msg.terminalId
      ? sessions.get(msg.terminalId)
      : this.findByStream(msg.streamId);
    if (!session) return;

    markTerminated(session.terminalId, 0);
    sessions.delete(session.terminalId);
    for (const [attachedStreamId, attachedCtx] of session.attachments) {
      attachedCtx.send({
        type: TunnelMessageType.PTY_EXIT,
        streamId: attachedStreamId,
        exitCode: 0,
      });
    }
    session.attachments.clear();

    try {
      session.pty.kill();
    } catch {
      // ignore
    }
  }

  private attach(session: PtySession, streamId: string, ctx: TunnelAddonContext, cols: number, rows: number): void {
    session.attachments.set(streamId, ctx);
    session.cols = cols;
    session.rows = rows;
    session.pty.resize(cols, rows);

    ctx.send({
      type: TunnelMessageType.PTY_ATTACHED,
      streamId,
      terminalId: session.terminalId,
      existing: true,
    });

    if (session.output.length) {
      ctx.send({
        type: TunnelMessageType.PTY_DATA,
        streamId,
        data: session.output.toString("base64"),
      });
    }
  }

  private handleList(msg: TunnelPtyList, ctx: TunnelAddonContext): void {
    const result: TunnelPtySessionInfo[] = Array.from(sessions.values()).map((session) => ({
      terminalId: session.terminalId,
      pid: session.pty.pid,
      command: session.command,
      createdAt: session.createdAt.toISOString(),
      cols: session.cols,
      rows: session.rows,
    }));
    ctx.send({
      type: TunnelMessageType.PTY_LIST_RESPONSE,
      streamId: msg.streamId,
      sessions: result,
    });
  }

  private findByStream(streamId: string): PtySession | undefined {
    for (const session of sessions.values()) {
      if (session.attachments.has(streamId)) return session;
    }
    return undefined;
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
