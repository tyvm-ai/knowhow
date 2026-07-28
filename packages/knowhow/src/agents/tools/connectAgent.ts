import * as fs from "fs";
import * as path from "path";
import { Tool } from "../../clients/types";
import { ToolCallContext } from "../../services/Tools";

/** Resolve the agents dir lazily so tests (and cwd changes) are respected. */
function agentsDir(): string {
  return path.join(process.cwd(), ".knowhow", "processes", "agents");
}

/**
 * Active relays, keyed by connection id, so stopConnections can tear them down.
 * A relay watches a speaker task's thread and appends new assistant messages to
 * a listener task's input.txt.
 */
interface ActiveRelay {
  id: string;
  listener: string;
  speaker: string;
  timer: NodeJS.Timeout;
  expiry?: NodeJS.Timeout;
  seenAssistant: number;
  updates: number;
}

const relays = new Map<string, ActiveRelay>();
let relaySeq = 0;

function readMeta(taskId: string): any | null {
  try {
    const metaPath = path.join(agentsDir(), taskId, "metadata.json");
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

/** Flatten a metadata.threads structure into a single message array. */
function flattenThreads(threads: any): any[] {
  if (!threads) return [];
  if (Array.isArray(threads)) {
    if (threads.length && Array.isArray(threads[0])) return threads.flat();
    return threads;
  }
  return [];
}

/** Extract the text content of an assistant message. */
function assistantText(msg: any): string | undefined {
  if (!msg || msg.role !== "assistant") return undefined;
  if (typeof msg.content === "string" && msg.content.trim()) {
    return msg.content.trim();
  }
  if (Array.isArray(msg.content)) {
    const text = msg.content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}

function appendToInput(inputPath: string, line: string): void {
  const existing = fs.existsSync(inputPath)
    ? fs.readFileSync(inputPath, "utf8")
    : "";
  const next =
    existing && !existing.endsWith("\n")
      ? `${existing}\n${line}\n`
      : `${existing}${line}\n`;
  fs.writeFileSync(inputPath, next, "utf8");
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "killed",
  "error",
  "done",
]);

function isTerminal(meta: any | null): boolean {
  if (!meta) return false;
  if (meta.status && TERMINAL_STATUSES.has(meta.status)) return true;
  if (meta.inProgress === false) return true;
  return false;
}

export interface AgentConnection {
  /** taskId of the agent that RECEIVES the speaker's messages. */
  listener: string;
  /** taskId of the agent whose output is relayed to the listener. */
  speaker: string;
}

export interface ConnectAgentParams {
  /**
   * The connections to wire up. Each connection relays the speaker's new
   * assistant messages into the listener's input queue.
   *
   * Topologies are expressed as arrays of connections, e.g.:
   *   bidirectional(a,b): [{listener:a,speaker:b},{listener:b,speaker:a}]
   *   pipeline(a,b,c):    [{listener:b,speaker:a},{listener:c,speaker:b}]
   *   star(hub,[x,y]):    [{listener:hub,speaker:x},{listener:hub,speaker:y},...]
   *   mesh([a,b,c]):      every ordered pair.
   */
  connections: AgentConnection[];
  /** Poll interval in ms for reading speaker threads. Default 3000. */
  intervalMs?: number;
  /** Max relayed messages per connection before auto-stopping. Default 50. */
  maxUpdates?: number;
  /** Max total duration in ms before auto-stopping each relay. Default 30 min. */
  maxDurationMs?: number;
  _ctx?: ToolCallContext;
}

/**
 * Wire agents together so they can communicate while working. Each connection
 * relays a speaker agent's new assistant messages into a listener agent's input
 * queue (via sendAgentMessage-style input.txt appends). Because it accepts an
 * ARRAY of connections, any topology — bidirectional, pipeline, ring, star,
 * mesh — is expressible in a single call.
 *
 * Relays run in the background on the orchestrating process, dedupe by thread
 * position, and auto-expire after maxUpdates / maxDurationMs so they can't leak.
 * Call stopConnections to tear them down early.
 */
export async function connectAgent(
  params: ConnectAgentParams
): Promise<string> {
  const {
    connections,
    intervalMs = 3000,
    maxUpdates = 50,
    maxDurationMs = 30 * 60 * 1000,
  } = params;

  if (!Array.isArray(connections) || connections.length === 0) {
    return "connectAgent: connections must be a non-empty array of { listener, speaker }.";
  }

  const interval = Math.max(1000, intervalMs);
  const started: string[] = [];
  const errors: string[] = [];

  for (const conn of connections) {
    const { listener, speaker } = conn || ({} as AgentConnection);
    if (!listener || !speaker) {
      errors.push(`skipped connection missing listener/speaker: ${JSON.stringify(conn)}`);
      continue;
    }
    if (listener === speaker) {
      errors.push(`skipped self-connection for ${listener}`);
      continue;
    }

    const speakerDir = path.join(agentsDir(), speaker);
    const listenerDir = path.join(agentsDir(), listener);
    if (!fs.existsSync(speakerDir)) {
      errors.push(`speaker task dir not found: ${speaker}`);
      continue;
    }
    if (!fs.existsSync(listenerDir)) {
      errors.push(`listener task dir not found: ${listener}`);
      continue;
    }

    relaySeq += 1;
    const id = `conn_${speaker.slice(0, 8)}_to_${listener.slice(0, 8)}_${relaySeq}`;
    const listenerInput = path.join(listenerDir, "input.txt");

    // Seed the seen-count to the CURRENT number of assistant messages so we
    // only relay NEW output produced after the connection is established.
    const seedMeta = readMeta(speaker);
    const seedAssistants = flattenThreads(seedMeta?.threads).filter(
      (m) => m?.role === "assistant"
    ).length;

    const relay: ActiveRelay = {
      id,
      listener,
      speaker,
      timer: undefined as any,
      seenAssistant: seedAssistants,
      updates: 0,
    };

    const tick = () => {
      try {
        const meta = readMeta(speaker);
        const assistants = flattenThreads(meta?.threads).filter(
          (m) => m?.role === "assistant"
        );
        // Relay any assistant messages beyond what we've seen.
        for (let i = relay.seenAssistant; i < assistants.length; i++) {
          const text = assistantText(assistants[i]);
          if (text) {
            appendToInput(
              listenerInput,
              `[from:${speaker}] ${text}`
            );
            relay.updates += 1;
          }
        }
        relay.seenAssistant = assistants.length;

        if (relay.updates >= maxUpdates || isTerminal(meta)) {
          stopRelay(id);
        }
      } catch {
        // ignore transient read/write errors; try again next tick
      }
    };

    relay.timer = setInterval(tick, interval);
    if (typeof (relay.timer as any).unref === "function") {
      (relay.timer as any).unref();
    }
    if (maxDurationMs) {
      relay.expiry = setTimeout(() => stopRelay(id), maxDurationMs);
      if (typeof (relay.expiry as any).unref === "function") {
        (relay.expiry as any).unref();
      }
    }

    relays.set(id, relay);
    started.push(id);
  }

  const parts = [
    `Wired ${started.length} connection(s): ${started.join(", ") || "(none)"}.`,
  ];
  if (errors.length) {
    parts.push(`Issues: ${errors.join("; ")}.`);
  }
  parts.push(
    `Relays poll every ${interval}ms, up to ${maxUpdates} messages each. Call stopConnections to tear them down.`
  );
  return parts.join(" ");
}

function stopRelay(id: string): void {
  const relay = relays.get(id);
  if (!relay) return;
  if (relay.timer) clearInterval(relay.timer);
  if (relay.expiry) clearTimeout(relay.expiry);
  relays.delete(id);
}

export interface StopConnectionsParams {
  /** Connection id to stop. Omit to stop ALL active relays. */
  id?: string;
  _ctx?: ToolCallContext;
}

/** Tear down one relay (by id) or all of them. Companion to connectAgent. */
export async function stopConnections(
  params: StopConnectionsParams
): Promise<string> {
  const { id } = params;
  if (id) {
    const existed = relays.has(id);
    stopRelay(id);
    return existed
      ? `Stopped connection ${id}.`
      : `No active connection with id ${id}.`;
  }
  const count = relays.size;
  for (const rid of [...relays.keys()]) stopRelay(rid);
  return `Stopped ${count} active connection(s).`;
}

export const connectAgentDefinition: Tool = {
  type: "function",
  function: {
    name: "connectAgent",
    description:
      "Wire running agents together so they can communicate while working. Takes an ARRAY of " +
      "{ listener, speaker } connections — each relays the speaker's new assistant messages into the " +
      "listener's input queue. Because it accepts an array, ANY topology is one call: bidirectional " +
      "([{listener:a,speaker:b},{listener:b,speaker:a}]), pipeline, ring, star (many speakers → one hub), " +
      "or full mesh (every ordered pair). Relays run in the background, dedupe by thread position, and " +
      "auto-expire (or stop when the speaker completes). Use stopConnections to tear them down early. " +
      "Combine with startAgentTask (spawn) and waitForAgentCompleted (join).",
    parameters: {
      type: "object",
      positional: false,
      usesContext: true,
      properties: {
        connections: {
          type: "array",
          description:
            "Array of connections to establish. Each is { listener, speaker } where speaker's output " +
            "is relayed into listener's input queue.",
          items: {
            type: "object",
            properties: {
              listener: {
                type: "string",
                description: "taskId of the agent that receives messages.",
              },
              speaker: {
                type: "string",
                description:
                  "taskId of the agent whose output is relayed to the listener.",
              },
            },
          },
        },
        intervalMs: {
          type: "number",
          description:
            "Poll interval in ms for reading speaker threads. Default: 3000.",
        },
        maxUpdates: {
          type: "number",
          description:
            "Max relayed messages per connection before auto-stopping. Default: 50.",
        },
        maxDurationMs: {
          type: "number",
          description:
            "Max total duration in ms before auto-stopping each relay. Default: 1800000 (30 min).",
        },
      },
      required: ["connections"],
    },
  },
};

export const stopConnectionsDefinition: Tool = {
  type: "function",
  function: {
    name: "stopConnections",
    description:
      "Tear down agent connections established with connectAgent. Pass a connection id to stop a " +
      "specific relay, or omit id to stop ALL active relays.",
    parameters: {
      type: "object",
      positional: false,
      usesContext: true,
      properties: {
        id: {
          type: "string",
          description:
            "The connection id returned by connectAgent. Omit to stop ALL active connections.",
        },
      },
      required: [],
    },
  },
};
