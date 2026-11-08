/**
 * Call tools on the user's connected CLIENT workers (Knowhow mobile app, phone companion, browser, extension,
 * desktop) through the backend's `/api/worker-tools` routes — no agent run needed.
 *
 * These are different from the "knowhow worker" machines handled by RemoteWorkers.ts (`/api/org-workers` +
 * `/api/ai/tools/call`): client workers are ephemeral, owned by the user, carry a `clientKind`, and mutating tools go
 * through an approval flow (`approval_pending` -> approve on the device UI -> retry with `approvalId`).
 */
import {
  ClientWorkerInfo,
  ClientWorkerToolResult,
  KnowhowSimpleClient,
} from "./KnowhowClient";

export type { ClientWorkerInfo, ClientWorkerToolResult };

export async function listClientWorkers(
  client: KnowhowSimpleClient = new KnowhowSimpleClient(),
  opts: { includeTools?: boolean; kind?: string; all?: boolean } = {}
): Promise<ClientWorkerInfo[]> {
  const res = await client.listClientWorkersRaw(opts.includeTools !== false);
  let workers = Array.isArray(res?.data) ? res.data : [];
  if (!opts.all) workers = workers.filter((w) => w.connected);
  if (opts.kind) {
    const k = opts.kind.toLowerCase();
    workers = workers.filter((w) => (w.clientKind || "").toLowerCase() === k);
  }
  return workers;
}

export function offersTool(w: ClientWorkerInfo, tool?: string): boolean {
  if (!tool) return true;
  return !!w.tools?.some((t) => t.name === tool);
}

function describe(w: ClientWorkerInfo) {
  return `  ${w.id.slice(0, 8)}  ${w.clientKind ?? "?"}  ${w.userAgent ?? ""}  (${
    w.tools?.length ?? 0
  } tools)`;
}

/**
 * Pick the client worker to call.
 *  - `ref` may be a full id, an id prefix (>= 4 chars), a clientKind (e.g. "mobile", "phone-companion") or a
 *    substring of the user agent. A kind may match several workers (the mobile app registers one per WebView): the
 *    connected one that offers `tool` wins (most recently connected first).
 *  - without `ref`, any connected worker offering `tool`; ambiguous when different kinds offer it.
 */
export function pickClientWorker(
  workers: ClientWorkerInfo[],
  opts: { ref?: string; tool?: string; kind?: string }
): ClientWorkerInfo {
  const { ref, tool } = opts;
  const sorted = [...workers].sort(
    (a, b) =>
      new Date(b.lastConnected || 0).getTime() -
      new Date(a.lastConnected || 0).getTime()
  );
  let pool = sorted;
  if (opts.kind) {
    pool = pool.filter(
      (w) => (w.clientKind || "").toLowerCase() === opts.kind!.toLowerCase()
    );
  }

  if (ref) {
    const q = ref.trim();
    const lower = q.toLowerCase();
    const byId = pool.find((w) => w.id === q);
    if (byId) {
      if (!byId.connected) throw new Error(`Worker ${q} is not connected`);
      return byId;
    }
    const stages: Array<(w: ClientWorkerInfo) => boolean> = [
      (w) => q.length >= 4 && w.id.toLowerCase().startsWith(lower),
      (w) => (w.clientKind || "").toLowerCase() === lower,
      (w) => (w.userAgent || "").toLowerCase().includes(lower),
    ];
    for (const stage of stages) {
      const found = pool.filter(stage);
      if (!found.length) continue;
      const connected = found.filter((w) => w.connected);
      if (!connected.length) {
        throw new Error(`Worker '${ref}' is not connected`);
      }
      const offering = connected.filter((w) => offersTool(w, tool));
      if (!offering.length && tool) {
        // A worker whose tools/list failed (asleep phone, stale socket) may still answer: try it last.
        const unknown = connected.filter((w) => !w.tools);
        if (unknown.length) return unknown[0];
      }
      if (!offering.length) {
        throw new Error(
          `No connected worker matching '${ref}' offers tool '${tool}'. Candidates:\n${connected
            .map(describe)
            .join("\n")}\n(is the page loaded / app open? list tools: knowhow workers list --tools)`
        );
      }
      return offering[0];
    }
    throw new Error(
      `No client worker matches '${ref}'. Run: knowhow workers list --clients`
    );
  }

  const offering = pool.filter((w) => w.connected && offersTool(w, tool));
  if (!offering.length) {
    throw new Error(
      `No connected client worker offers tool '${tool}'. Run: knowhow workers list --clients --tools`
    );
  }
  const kinds = new Set(offering.map((w) => w.clientKind));
  if (kinds.size > 1) {
    throw new Error(
      `Tool '${tool}' is offered by several kinds of worker; pass --worker <id|kind>:\n${offering
        .map(describe)
        .join("\n")}`
    );
  }
  return offering[0];
}

export interface CallClientToolOptions {
  worker?: string;
  kind?: string;
  tool: string;
  args?: Record<string, unknown>;
  approvalId?: string;
  timeoutMs?: number;
  /** After `approval_pending`: keep retrying with the approvalId until the user approves (or the deadline). */
  waitApproval?: boolean;
  approvalTimeoutMs?: number;
  pollIntervalMs?: number;
  onApprovalPending?: (r: ClientWorkerToolResult) => void;
  /** Inject for tests */
  sleep?: (ms: number) => Promise<void>;
}

export interface CallClientToolOutcome {
  workerId: string;
  clientKind: string | null;
  result: ClientWorkerToolResult;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parse the tool arguments given on the command line (JSON object, `-` is handled by the caller). */
export function parseToolArgs(text: string | undefined): Record<string, unknown> {
  if (text === undefined || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`Tool arguments must be a JSON object: ${e.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export async function callClientTool(
  client: KnowhowSimpleClient,
  opts: CallClientToolOptions
): Promise<CallClientToolOutcome> {
  const workers = await listClientWorkers(client, {
    includeTools: true,
    all: true,
  });
  let target: ClientWorkerInfo;
  const isFullId = !!opts.worker && workers.some((w) => w.id === opts.worker);
  if (isFullId && !opts.tool) {
    target = workers.find((w) => w.id === opts.worker)!;
  } else {
    target = pickClientWorker(workers, {
      ref: opts.worker,
      kind: opts.kind,
      tool: isFullId ? undefined : opts.tool,
    });
  }

  const call = (approvalId?: string) =>
    client.callClientWorkerTool({
      workerId: target.id,
      tool: opts.tool,
      arguments: opts.args ?? {},
      ...(approvalId ? { approvalId } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });

  let res = (await call(opts.approvalId)).data;
  if (res.status === "approval_pending") {
    opts.onApprovalPending?.(res);
    if (opts.waitApproval && res.approval?.approvalId) {
      const sleep = opts.sleep ?? defaultSleep;
      const interval = Math.max(0, opts.pollIntervalMs ?? 3000);
      const deadline = Date.now() + (opts.approvalTimeoutMs ?? 120_000);
      const approvalId = res.approval.approvalId;
      while (res.status === "approval_pending" && Date.now() < deadline) {
        await sleep(interval);
        res = (await call(approvalId)).data;
      }
    }
  }
  return { workerId: target.id, clientKind: target.clientKind, result: res };
}

export function formatClientWorkerTable(
  workers: ClientWorkerInfo[],
  withTools = false
): string {
  const lines: string[] = [];
  for (const w of workers) {
    lines.push(
      `${w.id}  ${(w.clientKind ?? "?").padEnd(16)} ${
        w.connected ? "connected" : "offline  "
      }  ${w.tools ? `${w.tools.length} tools` : "-"}${
        w.toolsError ? `  (tools error: ${w.toolsError})` : ""
      }`
    );
    if (withTools) {
      for (const t of w.tools ?? []) {
        const raw = (t.description || "").split("\n")[0];
        const first = raw.length > 110 ? raw.slice(0, 109) + "…" : raw;
        lines.push(
          `    ${t.name}${t.tier ? ` [${t.tier}]` : ""}${first ? `  — ${first}` : ""}`
        );
      }
    }
  }
  return lines.join("\n");
}
