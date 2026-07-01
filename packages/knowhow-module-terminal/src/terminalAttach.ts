import * as readline from "readline";
import * as https from "https";
import * as http from "http";

export interface AttachOptions {
  interactive?: boolean;
  attach?: string;
  id?: string;
  command?: string;
}

interface OrgWorker {
  id: string;
  connected: boolean;
  userAgent?: string;
  fsRoot?: string;
  shared?: boolean;
  user?: { email?: string; name?: string };
}

function fetchJson<T>(url: string, jwt: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = (client as typeof https).get(
      url,
      { headers: { Authorization: `Bearer ${jwt}` } },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Failed to parse JSON: ${body.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
  });
}

function findWorkerByName(workers: OrgWorker[], name: string): OrgWorker {
  const match = name.toLowerCase();
  const matches = workers.filter(
    (w) =>
      w.userAgent?.toLowerCase().includes(match) ||
      w.fsRoot?.toLowerCase().includes(match) ||
      w.user?.name?.toLowerCase().includes(match) ||
      w.user?.email?.toLowerCase().includes(match) ||
      w.id.toLowerCase().includes(match)
  );
  if (!matches.length) {
    console.error(`No connected worker matching "${name}".`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Multiple workers match "${name}":`);
    matches.forEach((w) =>
      console.error(`  ${w.id}  ${w.userAgent || w.fsRoot || ""}`)
    );
    console.error('Use --id for an exact match.');
    process.exit(1);
  }
  return matches[0];
}

function displayWorkerName(w: OrgWorker): string {
  const parts: string[] = [];
  if (w.userAgent) parts.push(w.userAgent);
  if (w.fsRoot) parts.push(w.fsRoot);
  if (!parts.length) parts.push(w.id);
  if (w.shared) parts.push("(shared)");
  return parts.join("  ");
}

async function pickWorkerInteractive(workers: OrgWorker[]): Promise<OrgWorker> {
  console.log("\nConnected workers:");
  workers.forEach((w, i) => {
    console.log(`  [${i + 1}] ${displayWorkerName(w)}`);
  });
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`Select worker [1-${workers.length}]: `, (answer) => {
      rl.close();
      const n = parseInt(answer.trim(), 10);
      if (isNaN(n) || n < 1 || n > workers.length) {
        console.error("Invalid selection.");
        process.exit(1);
      }
      resolve(workers[n - 1]);
    });
  });
}

/**
 * Prompt the user (after a disconnect) whether to reconnect or exit.
 * Uses raw mode + single keypress detection so it works reliably after
 * a WebSocket disconnect (no readline buffering issues).
 */
async function promptReconnect(): Promise<boolean> {
  return new Promise((resolve) => {
    process.stderr.write(
      "\r\n\x1b[33m[Disconnected] Reconnect? [y/N]: \x1b[0m"
    );

    // Use raw mode so we can read a single keypress immediately
    if ((process.stdin as any).isTTY) {
      try { (process.stdin as any).setRawMode(true); } catch {}
    }
    process.stdin.resume();

    let settled = false;

    const cleanup = (answer: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      // Restore cooked mode after prompt
      if ((process.stdin as any).isTTY) {
        try { (process.stdin as any).setRawMode(false); } catch {}
      }
      process.stdin.pause();
      resolve(answer);
    };

    const onData = (chunk: Buffer) => {
      const key = chunk.toString("utf8").toLowerCase();
      if (key === "y") {
        process.stderr.write("y\r\n");
        cleanup(true);
      } else if (
        key === "n" ||
        key === "\r" ||    // Enter = default No
        key === "\n" ||
        key === "\x03" ||  // Ctrl+C = No
        key === "\x1b"     // Escape = No
      ) {
        process.stderr.write("\r\n");
        cleanup(false);
      }
      // Ignore other keys
    };

    process.stdin.on("data", onData);

    // Default to "no" after 10 seconds
    const timer = setTimeout(() => {
      process.stderr.write("\r\n[Timed out — exiting]\r\n");
      cleanup(false);
    }, 10_000);
  });
}

/**
 * Connect to a single terminal session and return when disconnected.
 * Returns:
 *   "exit"       — clean process exit (user typed 'exit' or process ended normally)
 *   "disconnect" — connection lost unexpectedly (worker stopped, network drop, etc.)
 *   "error"      — unrecoverable error
 */
async function connectSession(
  worker: OrgWorker,
  jwt: string,
  apiUrl: string,
  command: string,
  isReconnect: boolean
): Promise<"exit" | "disconnect" | "error"> {
  const { default: WebSocket } = await import("ws");

  const url = new URL(apiUrl);
  const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  const cols = (process.stdout as any).columns || 220;
  const rows = (process.stdout as any).rows || 50;

  const wsUrl = `${wsProtocol}//${url.host}/ws/terminal?workerId=${worker.id}&cols=${cols}&rows=${rows}&token=${encodeURIComponent(jwt)}`;

  if (isReconnect) {
    process.stderr.write(`\r\nReconnecting to ${displayWorkerName(worker)}…\r\n`);
  } else {
    process.stderr.write(`Connecting to ${displayWorkerName(worker)}…\n`);
  }

  return new Promise((resolve) => {
    let ws: any;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err: any) {
      process.stderr.write(`\r\nFailed to create WebSocket: ${err.message}\r\n`);
      resolve("error");
      return;
    }

    (ws as any).binaryType = "nodebuffer";

    let rawModeActive = false;
    let stdinDataHandler: ((chunk: Buffer) => void) | null = null;
    let resizeHandler: (() => void) | null = null;
    let ctrlCCount = 0;
    let ctrlCTimer: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    const done = (result: "exit" | "disconnect" | "error") => {
      if (resolved) return;
      resolved = true;

      // Remove stdin/resize listeners
      if (stdinDataHandler) {
        process.stdin.removeListener("data", stdinDataHandler);
        stdinDataHandler = null;
      }
      if (resizeHandler) {
        process.stdout.removeListener("resize", resizeHandler);
        resizeHandler = null;
      }
      if (ctrlCTimer) {
        clearTimeout(ctrlCTimer);
        ctrlCTimer = null;
      }

      // Restore terminal to cooked mode
      if (rawModeActive && (process.stdin as any).isTTY) {
        try { (process.stdin as any).setRawMode(false); } catch {}
        rawModeActive = false;
      }
      // Only pause stdin on clean exit/error — for disconnect we need stdin
      // still readable so the reconnect prompt can receive input.
      if (result !== "disconnect") {
        process.stdin.pause();
      }

      try { ws.close(1000, "client exit"); } catch {}

      resolve(result);
    };

    ws.on("open", () => {
      // Send the open message
      ws.send(JSON.stringify({ type: "open", command }));

      // Enable raw mode
      if ((process.stdin as any).isTTY) {
        try {
          (process.stdin as any).setRawMode(true);
          rawModeActive = true;
        } catch {}
      }
      process.stdin.resume();

      // Pipe stdin → WebSocket, but intercept Ctrl+C (0x03) for escape hatch.
      // Single Ctrl+C is forwarded to the remote PTY (e.g. to kill a running command).
      // Double Ctrl+C within 1.5 seconds exits the local attach process.
      stdinDataHandler = (chunk: Buffer) => {
        // Check if chunk contains Ctrl+C (0x03)
        const hasCtrlC = chunk.length === 1 && chunk[0] === 0x03;

        if (hasCtrlC) {
          ctrlCCount++;
          if (ctrlCCount === 1) {
            // First Ctrl+C: forward to remote and show hint
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(chunk);
            }
            process.stderr.write(
              "\r\n\x1b[33m[Press Ctrl+C again to detach from this terminal]\x1b[0m\r\n"
            );
            // Reset counter after 1.5 seconds
            ctrlCTimer = setTimeout(() => {
              ctrlCCount = 0;
              ctrlCTimer = null;
            }, 1500);
          } else {
            // Second Ctrl+C: detach
            if (ctrlCTimer) {
              clearTimeout(ctrlCTimer);
              ctrlCTimer = null;
            }
            ctrlCCount = 0;
            process.stderr.write("\r\n\x1b[33m[Detaching…]\x1b[0m\r\n");
            done("exit");
          }
          return;
        }

        // Reset Ctrl+C counter on any other key
        if (ctrlCCount > 0) {
          ctrlCCount = 0;
          if (ctrlCTimer) {
            clearTimeout(ctrlCTimer);
            ctrlCTimer = null;
          }
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      };
      process.stdin.on("data", stdinDataHandler);

      // Forward terminal resize events
      resizeHandler = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: (process.stdout as any).columns || 80,
              rows: (process.stdout as any).rows || 24,
            })
          );
        }
      };
      process.stdout.on("resize", resizeHandler);

      const hint = isReconnect
        ? "Reconnected! Press Ctrl+C twice to detach.\r\n"
        : "Connected! Press Ctrl+C twice to detach.\r\n";
      process.stderr.write(hint);
    });

    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let data: Buffer;
      if (Buffer.isBuffer(raw)) {
        data = raw;
      } else if (Array.isArray(raw)) {
        data = Buffer.concat(raw);
      } else {
        data = Buffer.from(raw);
      }

      // Try JSON control messages first
      try {
        const str = data.toString("utf8");
        if (str.trimStart().startsWith("{")) {
          const msg = JSON.parse(str);
          if (msg.type === "exit") {
            process.stderr.write(
              `\r\n[Process exited with code ${msg.exitCode ?? 0}]\r\n`
            );
            done("exit");
            return;
          } else if (msg.type === "requires_passkey") {
            process.stderr.write(
              "\r\nThis worker requires passkey authentication.\r\n" +
                "Please unlock it via the web UI first, then retry.\r\n"
            );
            done("error");
            return;
          }
        }
      } catch {
        // Not JSON — raw PTY output
      }

      process.stdout.write(data);
    });

    ws.on("close", (code: number) => {
      if (resolved) return;
      if (code === 1000) {
        // Normal closure initiated by us
        done("exit");
      } else {
        // Unexpected disconnect — the worker stopped or network dropped
        process.stderr.write(`\r\n\x1b[31m[Connection lost (code ${code})]\x1b[0m\r\n`);
        done("disconnect");
      }
    });

    ws.on("error", (err: Error) => {
      if (resolved) return;
      process.stderr.write(`\r\n\x1b[31m[WebSocket error: ${err.message}]\x1b[0m\r\n`);
      done("disconnect");
    });
  });
}

async function connectToWorkerTerminal(
  worker: OrgWorker,
  jwt: string,
  apiUrl: string,
  command: string
): Promise<void> {
  let isReconnect = false;
  let reconnectDelay = 2000;

  while (true) {
    const result = await connectSession(worker, jwt, apiUrl, command, isReconnect);

    if (result === "exit") {
      // Clean exit — restore terminal and leave
      if ((process.stdin as any).isTTY) {
        try { (process.stdin as any).setRawMode(false); } catch {}
      }
      process.stdin.pause();
      process.exit(0);
    }

    if (result === "error") {
      // Unrecoverable (e.g. passkey required)
      if ((process.stdin as any).isTTY) {
        try { (process.stdin as any).setRawMode(false); } catch {}
      }
      process.stdin.pause();
      process.exit(1);
    }

    // result === "disconnect" — ask user what to do
    // At this point raw mode has already been turned off by connectSession's cleanup
    const shouldReconnect = await promptReconnect();

    if (!shouldReconnect) {
      process.stderr.write("[Exiting]\r\n");
      if ((process.stdin as any).isTTY) {
        try { (process.stdin as any).setRawMode(false); } catch {}
      }
      process.stdin.pause();
      process.exit(0);
    }

    // Wait a moment before reconnecting, with a small backoff
    process.stderr.write(`\r\nReconnecting in ${reconnectDelay / 1000}s…\r\n`);
    await new Promise((r) => setTimeout(r, reconnectDelay));
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15_000);
    isReconnect = true;
  }
}

export async function attachTerminal(options: AttachOptions): Promise<void> {
  // Load JWT and API URL from @tyvm/knowhow peer
  const { loadJwt } = await import(
    "@tyvm/knowhow/ts_build/src/login"
  );
  const { KNOWHOW_API_URL } = await import(
    "@tyvm/knowhow/ts_build/src/services/KnowhowClient"
  );

  let jwt: string;
  try {
    jwt = await loadJwt();
  } catch (err: any) {
    console.error(`Authentication error: ${err.message}`);
    console.error("Run `knowhow login` first.");
    process.exit(1);
  }

  // Fetch all org workers
  let workers: OrgWorker[];
  try {
    const result = await fetchJson<OrgWorker[]>(
      `${KNOWHOW_API_URL}/api/org-workers`,
      jwt
    );
    workers = Array.isArray(result) ? result : [];
  } catch (err: any) {
    console.error(`Failed to fetch workers: ${err.message}`);
    process.exit(1);
  }

  const connected = workers.filter((w) => w.connected);

  if (!connected.length) {
    console.error(
      "No connected workers found. Start a worker with `knowhow worker`."
    );
    process.exit(1);
  }

  // Pick the target worker
  let worker: OrgWorker;

  if (options.id) {
    const found = connected.find((w) => w.id === options.id);
    if (!found) {
      console.error(
        `Worker "${options.id}" not found or not connected.`
      );
      process.exit(1);
    }
    worker = found;
  } else if (options.attach) {
    worker = findWorkerByName(connected, options.attach);
  } else if (options.interactive) {
    worker = await pickWorkerInteractive(connected);
  } else {
    // If only one worker is connected, use it automatically
    if (connected.length === 1) {
      worker = connected[0];
      process.stderr.write(
        `Auto-selecting only connected worker: ${displayWorkerName(worker)}\n`
      );
    } else {
      // Default to interactive picker when multiple workers exist
      worker = await pickWorkerInteractive(connected);
    }
  }

  await connectToWorkerTerminal(
    worker,
    jwt,
    KNOWHOW_API_URL,
    options.command ?? "bash"
  );
}
