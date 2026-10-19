import * as net from "net";
import * as path from "path";
import { EventEmitter } from "events";
import type {
  ClientMessage,
  ControlRequest,
  ControlResults,
  HostEvent,
  HostResponse,
  HostRole,
  WorkerMessage,
} from "./protocol";
import { homeDir } from "../homeDir";

/** Default IPC endpoint (unix socket path or Windows pipe name). */
export function hostEndpoint(): string {
  if (process.env.KNOWHOW_HOST_ENDPOINT) return process.env.KNOWHOW_HOST_ENDPOINT;
  if (process.platform === "win32") {
    const user = process.env.USERNAME || process.env.USER || "user";
    return `\\\\.\\pipe\\knowhow-host-${user}`;
  }
  return path.join(homeDir(), ".knowhow", "run", "host.sock");
}

export interface ConnectOptions {
  workerId?: string;
  name?: string;
  endpoint?: string;
  /** Default per-request timeout (ms). */
  timeoutMs?: number;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * JSON-lines client for the knowhow computer host.
 * Events: "event" (HostEvent), plus each event's `type` (e.g. "hotkey", "stop"),
 * "close", "error".
 */
export class HostClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buf = "";
  private seq = 0;
  private pending = new Map<number, Pending>();
  private timeoutMs = 5000;
  closed = false;
  /** Result of the hello handshake (status for control, {workerId} for worker). */
  helloResult: any;

  static async connect(role: HostRole, opts: ConnectOptions = {}): Promise<HostClient> {
    const client = new HostClient();
    client.timeoutMs = opts.timeoutMs ?? 5000;
    await client.open(opts.endpoint ?? hostEndpoint());
    try {
      client.helloResult = await client.request(
        role === "worker"
          ? { type: "hello", role, workerId: opts.workerId ?? "", name: opts.name ?? "" }
          : { type: "hello", role }
      );
    } catch (e) {
      client.close();
      throw e;
    }
    return client;
  }

  private open(endpoint: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(endpoint);
      this.socket = s;
      let opened = false;
      s.setEncoding("utf8");
      s.once("connect", () => {
        opened = true;
        resolve();
      });
      s.on("data", (chunk: string) => this.onData(chunk));
      s.on("error", (e) => {
        if (!opened) return reject(e);
        this.emit("error", e);
      });
      s.on("close", () => this.onClose());
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any): void {
    if (msg && typeof msg.reqId === "number" && "ok" in msg) {
      const p = this.pending.get(msg.reqId);
      if (!p) return;
      this.pending.delete(msg.reqId);
      clearTimeout(p.timer);
      const res = msg as HostResponse;
      if (res.ok) p.resolve(res.result);
      else p.reject(new Error(res.error || "host request failed"));
      return;
    }
    if (msg && typeof msg.type === "string") {
      this.emit("event", msg as HostEvent);
      this.emit(msg.type, msg);
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("host connection closed"));
    }
    this.pending.clear();
    this.emit("close");
  }

  /** Send a request and wait for the correlated response. */
  request<T extends ControlRequest["type"]>(
    msg: Extract<ControlRequest, { type: T }>,
    timeoutMs?: number
  ): Promise<ControlResults[T]>;
  request(msg: ClientMessage, timeoutMs?: number): Promise<any>;
  request(msg: ClientMessage, timeoutMs = this.timeoutMs): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.closed) return reject(new Error("host connection closed"));
      const reqId = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`host request "${(msg as any).type}" timed out`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ ...msg, reqId }) + "\n", (err) => {
        if (err && this.pending.delete(reqId)) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /** Fire-and-forget worker message (no reqId, no response). */
  send(msg: WorkerMessage): void {
    if (!this.socket || this.closed) return;
    this.socket.write(JSON.stringify(msg) + "\n");
  }

  close(): void {
    if (this.closed && !this.socket) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("host connection closed"));
    }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = null;
  }
}
