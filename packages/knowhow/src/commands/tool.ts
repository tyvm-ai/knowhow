import { Command } from "commander";

/** Exit codes: 0 ok, 1 error/quarantined/failed, 2 approval still pending. */
export const EXIT_APPROVAL_PENDING = 2;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

export function addToolCommand(program: Command): void {
  const tool = program
    .command("tool")
    .description(
      "Call tools on your connected client workers (mobile app, phone companion, browser, extension) through the backend, without an agent run"
    );

  tool
    .command("call <tool> [args]")
    .description(
      "Call <tool> with JSON <args> (use - to read args from stdin) on a connected client worker. Mutating tools return approval_pending: approve on the device, then re-run with --approval-id, or use --wait-approval."
    )
    .option(
      "-w, --worker <id|kind|name>",
      "Worker id (or prefix), clientKind (e.g. mobile, phone-companion) or user-agent substring. Default: the connected worker that offers the tool"
    )
    .option("--kind <kind>", "Restrict to workers of this clientKind")
    .option("--approval-id <id>", "Retry a call that returned approval_pending, after approving on the device")
    .option(
      "--wait-approval",
      "On approval_pending, print the approval id and poll (retrying with it) until the user approves"
    )
    .option("--approval-timeout <ms>", "How long --wait-approval waits (default 120000)", "120000")
    .option("--poll-interval <ms>", "Poll interval for --wait-approval (default 3000)", "3000")
    .option("--timeout <ms>", "Worker-side call timeout (default 60000)")
    .option("--json", "Print the full backend result as JSON (status, approval, rawText, ...)")
    .action(async (toolName: string, argsText: string | undefined, options) => {
      let exitCode = 0;
      try {
        const { callClientTool, parseToolArgs } = await import(
          "../services/ClientWorkerTools"
        );
        const { KnowhowSimpleClient } = await import(
          "../services/KnowhowClient"
        );
        const args = parseToolArgs(
          argsText === "-" ? await readStdin() : argsText
        );
        const client = new KnowhowSimpleClient();
        const outcome = await callClientTool(client, {
          worker: options.worker,
          kind: options.kind,
          tool: toolName,
          args,
          approvalId: options.approvalId,
          timeoutMs: options.timeout ? parseInt(options.timeout, 10) : undefined,
          waitApproval: !!options.waitApproval,
          approvalTimeoutMs: parseInt(options.approvalTimeout, 10),
          pollIntervalMs: parseInt(options.pollInterval, 10),
          onApprovalPending: (r) => {
            console.error(
              `approval_pending: approve '${r.approval?.toolName ?? toolName}' on the device (approvalId=${r.approval?.approvalId})` +
                (options.waitApproval
                  ? " — waiting..."
                  : `; then re-run with --approval-id ${r.approval?.approvalId}`)
            );
          },
        });
        const r = outcome.result;
        console.error(
          `worker=${outcome.workerId} kind=${outcome.clientKind ?? "?"} status=${r.status}`
        );
        if (options.json) {
          console.log(JSON.stringify({ ...r, workerId: outcome.workerId }, null, 2));
        } else if (r.status === "approval_pending") {
          console.log(
            JSON.stringify({ status: r.status, approval: r.approval }, null, 2)
          );
        } else if (r.status === "quarantined") {
          console.log(
            typeof r.content === "string" ? r.content : JSON.stringify(r.content)
          );
        } else {
          const text =
            r.rawText ??
            (typeof r.content === "string" ? r.content : JSON.stringify(r.content));
          console.log(text ?? "");
        }
        exitCode =
          r.status === "approval_pending"
            ? EXIT_APPROVAL_PENDING
            : r.status === "ok"
            ? 0
            : 1;
      } catch (error: any) {
        console.error("Error: " + (error?.message ?? String(error)));
        exitCode = 1;
      }
      if (exitCode) process.exit(exitCode);
    });

  tool
    .command("list")
    .description("List connected client workers and their tools (same as `knowhow workers list --tools`)")
    .option("--kind <kind>", "Only workers of this clientKind")
    .option("--json", "Output JSON")
    .action(async (options) => {
      try {
        const { listClientWorkers, formatClientWorkerTable } = await import(
          "../services/ClientWorkerTools"
        );
        const { KnowhowSimpleClient } = await import(
          "../services/KnowhowClient"
        );
        const workers = await listClientWorkers(new KnowhowSimpleClient(), {
          includeTools: true,
          kind: options.kind,
        });
        if (options.json) console.log(JSON.stringify(workers, null, 2));
        else if (!workers.length) console.log("No connected client workers.");
        else console.log(formatClientWorkerTable(workers, true));
      } catch (error: any) {
        console.error("Error: " + (error?.message ?? String(error)));
        process.exit(1);
      }
    });
}
