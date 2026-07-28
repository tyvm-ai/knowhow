import { Command } from "commander";
import { KNOWHOW_API_URL, loadKnowhowJwt } from "../services/KnowhowClient";
import http from "../utils/http";

// ─── API client helper ────────────────────────────────────────────────────────

function getBaseUrl(): string {
  return `${process.env.KNOWHOW_API_URL || KNOWHOW_API_URL}/api`;
}

function getAuthHeaders(): Record<string, string> {
  const token =
    process.env.KNOWHOW_API_TOKEN ||
    (() => {
      try {
        return loadKnowhowJwt();
      } catch {
        throw new Error(
          "No API token found. Set KNOWHOW_API_TOKEN env var or run `knowhow login`."
        );
      }
    })();
  return { Authorization: `Bearer ${token}` };
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await http.get<T>(`${getBaseUrl()}${path}`, {
    headers: getAuthHeaders(),
  });
  return res.data;
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await http.post<T>(`${getBaseUrl()}${path}`, body, {
    headers: getAuthHeaders(),
  });
  return res.data;
}

async function apiDelete(path: string): Promise<void> {
  await http.delete(`${getBaseUrl()}${path}`, {
    headers: getAuthHeaders(),
  });
}

// ─── Domain types (minimal shapes we care about) ──────────────────────────────

interface Sandbox {
  id: string;
  name?: string | null;
  status: string;
  vmStatus?: string | null;
}

interface SandboxSnapshot {
  id: string;
  sandboxId: string;
  label?: string | null;
  description?: string | null;
  status: string;
  errorMsg?: string | null;
  statusMessage?: string | null;
  regenerationSandboxId?: string | null;
  snapshotContent?: string;
  setupScript?: string | null;
}

// ─── Resolve helpers ──────────────────────────────────────────────────────────

async function resolveSandboxId(nameOrId: string): Promise<string> {
  // Looks like a cuid/nanoid — use directly
  if (/^[a-z0-9]{15,}$/i.test(nameOrId)) {
    return nameOrId;
  }
  const sandboxes = await apiGet<Sandbox[]>("/sandboxes");
  const normalizedName = nameOrId.toLocaleLowerCase();
  const match = sandboxes.find(
    (s) => s.id === nameOrId || s.name?.toLocaleLowerCase() === normalizedName
  );
  if (!match) {
    const names = sandboxes.map((s) => s.name || s.id).join(", ");
    throw new Error(
      `Sandbox not found: "${nameOrId}". Available: ${names || "(none)"}`
    );
  }
  return match.id;
}

async function resolveSnapshot(
  sandboxId: string,
  nameOrId: string
): Promise<SandboxSnapshot> {
  // Try direct ID
  if (/^[a-z0-9]{15,}$/i.test(nameOrId)) {
    try {
      return await apiGet<SandboxSnapshot>(
        `/sandboxes/${sandboxId}/snapshots/${nameOrId}`
      );
    } catch {
      // fall through to name search
    }
  }
  // Search by label
  const snapshots = await apiGet<SandboxSnapshot[]>(
    `/sandboxes/${sandboxId}/snapshots`
  );
  let match = snapshots.find(
    (s) => s.label === nameOrId || s.id === nameOrId
  );
  if (!match) {
    // Org-wide search
    const orgSnaps = await apiGet<SandboxSnapshot[]>("/org-snapshots");
    match = orgSnaps.find((s) => s.label === nameOrId || s.id === nameOrId);
  }
  if (!match) {
    const labels = snapshots.map((s) => s.label || s.id).join(", ");
    throw new Error(
      `Snapshot not found: "${nameOrId}". Available for sandbox: ${labels || "(none)"}`
    );
  }
  return match;
}

// ─── Polling helpers ──────────────────────────────────────────────────────────

/**
 * Poll a snapshot's status until regeneration is complete.
 *
 * The backend's POST /regenerate endpoint is fire-and-forget — it returns
 * immediately with regenerationSandboxId set. We poll GET /snapshots/:id
 * until one of:
 *   - regenerationSandboxId is null AND status === "ready"  → success
 *   - status === "error"                                    → failure
 *   - deadline exceeded                                     → timeout
 *
 * statusMessage is printed whenever it changes so the user sees progress.
 */
async function pollRegeneration(
  sandboxId: string,
  snapshotId: string,
  timeoutMs: number
): Promise<SandboxSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  let lastMessage = "";
  while (Date.now() < deadline) {
    const snap = await apiGet<SandboxSnapshot>(
      `/sandboxes/${sandboxId}/snapshots/${snapshotId}`
    );
    if (snap.status !== lastStatus) {
      console.log(`  [snapshot] status: ${snap.status}`);
      lastStatus = snap.status;
    }
    if (snap.statusMessage && snap.statusMessage !== lastMessage) {
      console.log(`  [snapshot] ${snap.statusMessage}`);
      lastMessage = snap.statusMessage;
    }
    if (!snap.regenerationSandboxId && snap.status === "ready") return snap;
    if (snap.status === "error") {
      throw new Error(
        `Snapshot regeneration failed: ${snap.errorMsg || snap.statusMessage || "(no details)"}`
      );
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(
    `Timeout waiting for snapshot regeneration to complete (${timeoutMs}ms). Last status: ${lastStatus}`
  );
}

async function pollSandboxStatus(
  sandboxId: string,
  targetStatuses: string[],
  timeoutMs: number,
  label = sandboxId
): Promise<Sandbox> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const sandbox = await apiGet<Sandbox>(`/sandboxes/${sandboxId}`);
    if (sandbox.status !== lastStatus) {
      console.log(`  [${label}] status: ${sandbox.status}`);
      lastStatus = sandbox.status;
    }
    if (targetStatuses.includes(sandbox.status)) return sandbox;
    if (["error", "destroyed", "terminated"].includes(sandbox.status)) {
      throw new Error(
        `Sandbox ${label} entered terminal status: ${sandbox.status}`
      );
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(
    `Timeout waiting for sandbox ${label} to reach ${targetStatuses.join("/")} (${timeoutMs}ms). Last: ${lastStatus}`
  );
}

async function pollSnapshotStatus(
  sandboxId: string,
  snapshotId: string,
  targetStatuses: string[],
  timeoutMs: number
): Promise<SandboxSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const snap = await apiGet<SandboxSnapshot>(
      `/sandboxes/${sandboxId}/snapshots/${snapshotId}`
    );
    if (snap.status !== lastStatus) {
      console.log(`  [snapshot] status: ${snap.status}`);
      if (snap.statusMessage) console.log(`    message: ${snap.statusMessage}`);
      lastStatus = snap.status;
    }
    if (targetStatuses.includes(snap.status)) return snap;
    if (["error", "failed"].includes(snap.status)) {
      throw new Error(
        `Snapshot failed: ${snap.errorMsg || snap.statusMessage || "(no details)"}`
      );
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(
    `Timeout waiting for snapshot to reach ${targetStatuses.join("/")} (${timeoutMs}ms). Last: ${lastStatus}`
  );
}

// ─── Command registration ─────────────────────────────────────────────────────

export function addSandboxCommand(program: Command): void {
  const sandboxCmd = program
    .command("sandbox")
    .description("Manage Knowhow sandboxes and snapshots");

  // ── sandbox list ────────────────────────────────────────────────────────────
  sandboxCmd
    .command("list")
    .description("List all sandboxes in your org")
    .option("--status <status>", "Filter by status (running|stopped|all)", "all")
    .option("--json", "Output raw JSON")
    .action(async (opts: { status: string; json?: boolean }) => {
      const sandboxes = await apiGet<Sandbox[]>("/sandboxes");
      const filtered =
        opts.status === "all"
          ? sandboxes
          : sandboxes.filter((s) => s.status === opts.status);
      if (opts.json) {
        console.log(JSON.stringify(filtered, null, 2));
      } else {
        console.log(`Found ${filtered.length} sandbox(es):\n`);
        for (const s of filtered) {
          console.log(
            `  ${s.id}  name=${s.name || "(none)"}  status=${s.status}  vmStatus=${s.vmStatus || "?"}`
          );
        }
      }
    });

  // ── sandbox list-snapshots ──────────────────────────────────────────────────
  sandboxCmd
    .command("list-snapshots")
    .description("List snapshots (org-wide or for a specific sandbox)")
    .option("--sandbox-id <id>", "Filter by sandbox ID")
    .option("--sandbox-name <name>", "Filter by sandbox name")
    .option("--json", "Output raw JSON")
    .action(
      async (opts: {
        sandboxId?: string;
        sandboxName?: string;
        json?: boolean;
      }) => {
        let snapshots: SandboxSnapshot[];
        if (opts.sandboxId || opts.sandboxName) {
          const sbId = opts.sandboxId || (await resolveSandboxId(opts.sandboxName!));
          snapshots = await apiGet<SandboxSnapshot[]>(
            `/sandboxes/${sbId}/snapshots`
          );
        } else {
          snapshots = await apiGet<SandboxSnapshot[]>("/org-snapshots");
        }
        if (opts.json) {
          console.log(JSON.stringify(snapshots, null, 2));
        } else {
          console.log(`Found ${snapshots.length} snapshot(s):\n`);
          for (const s of snapshots) {
            console.log(
              `  ${s.id}  label=${s.label || "(none)"}  status=${s.status}  sandboxId=${s.sandboxId}`
            );
          }
        }
      }
    );

  // ── sandbox exec ────────────────────────────────────────────────────────────
  sandboxCmd
    .command("exec")
    .description("Execute a command in a running sandbox")
    .option("--sandbox-id <id>", "Sandbox ID")
    .option("--sandbox-name <name>", "Sandbox name")
    .requiredOption("--cmd <command>", "Shell command to run (passed to /bin/bash -c)")
    .option("--timeout-ms <ms>", "Timeout in ms (max 300000)", "60000")
    .action(
      async (opts: {
        sandboxId?: string;
        sandboxName?: string;
        cmd: string;
        timeoutMs: string;
      }) => {
        const sbId =
          opts.sandboxId || (opts.sandboxName ? await resolveSandboxId(opts.sandboxName) : null);
        if (!sbId) throw new Error("Provide --sandbox-id or --sandbox-name");

        console.log(`Executing in sandbox ${sbId}: ${opts.cmd}`);
        const result = await apiPost<{
          stdout?: string;
          stderr?: string;
          exitCode?: number;
        }>(`/sandboxes/${sbId}/exec`, {
          command: "/bin/bash",
          args: ["-c", opts.cmd],
          timeoutMs: Math.min(Number(opts.timeoutMs), 300000),
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.exitCode != null && result.exitCode !== 0) {
          process.exit(result.exitCode);
        }
      }
    );

  // ── sandbox start ───────────────────────────────────────────────────────────
  sandboxCmd
    .command("start")
    .description("Start a stopped sandbox")
    .option("--sandbox-id <id>", "Sandbox ID")
    .option("--sandbox-name <name>", "Sandbox name")
    .option("--wait", "Wait until sandbox is running")
    .option("--timeout-minutes <min>", "Max wait time in minutes", "10")
    .action(
      async (opts: {
        sandboxId?: string;
        sandboxName?: string;
        wait?: boolean;
        timeoutMinutes: string;
      }) => {
        const sbId =
          opts.sandboxId || (opts.sandboxName ? await resolveSandboxId(opts.sandboxName) : null);
        if (!sbId) throw new Error("Provide --sandbox-id or --sandbox-name");
        console.log(`Starting sandbox ${sbId}...`);
        await apiPost(`/sandboxes/${sbId}/start`);
        if (opts.wait) {
          await pollSandboxStatus(sbId, ["running"], Number(opts.timeoutMinutes) * 60000);
          console.log("✓ Sandbox is running");
        }
      }
    );

  // ── sandbox stop ────────────────────────────────────────────────────────────
  sandboxCmd
    .command("stop")
    .description("Stop a running sandbox")
    .option("--sandbox-id <id>", "Sandbox ID")
    .option("--sandbox-name <name>", "Sandbox name")
    .option("--wait", "Wait until sandbox is stopped")
    .option("--timeout-minutes <min>", "Max wait time in minutes", "10")
    .action(
      async (opts: {
        sandboxId?: string;
        sandboxName?: string;
        wait?: boolean;
        timeoutMinutes: string;
      }) => {
        const sbId =
          opts.sandboxId || (opts.sandboxName ? await resolveSandboxId(opts.sandboxName) : null);
        if (!sbId) throw new Error("Provide --sandbox-id or --sandbox-name");
        console.log(`Stopping sandbox ${sbId}...`);
        await apiPost(`/sandboxes/${sbId}/stop`);
        if (opts.wait) {
          await pollSandboxStatus(sbId, ["stopped"], Number(opts.timeoutMinutes) * 60000);
          console.log("✓ Sandbox is stopped");
        }
      }
    );

  // ── sandbox delete-snapshot ─────────────────────────────────────────────────
  sandboxCmd
    .command("delete-snapshot")
    .description("Delete a snapshot by ID")
    .option("--sandbox-id <id>", "Sandbox ID")
    .option("--sandbox-name <name>", "Sandbox name")
    .requiredOption("--snapshot-id <id>", "Snapshot ID to delete")
    .action(
      async (opts: {
        sandboxId?: string;
        sandboxName?: string;
        snapshotId: string;
      }) => {
        const sbId =
          opts.sandboxId || (opts.sandboxName ? await resolveSandboxId(opts.sandboxName) : null);
        if (!sbId) throw new Error("Provide --sandbox-id or --sandbox-name");
        await apiDelete(`/sandboxes/${sbId}/snapshots/${opts.snapshotId}`);
        console.log(`✓ Deleted snapshot ${opts.snapshotId}`);
      }
    );

  // ── sandbox regenerate-snapshot ─────────────────────────────────────────────
  sandboxCmd
    .command("regenerate-snapshot")
    .description(
      "Regenerate a snapshot: forks an ephemeral sandbox from it, runs the\n" +
        "snapshot's setupScript on a fresh base image, captures a new snapshot\n" +
        "with the same label, then destroys the ephemeral sandbox.\n\n" +
        "Typical CI usage (run before tests, only when inputs changed):\n" +
        "  knowhow hash --name prisma-gen --input 'prisma/schema/**,package-lock.json' \\\\\n" +
        "    || knowhow sandbox regenerate-snapshot \\\\\n" +
        "         --sandbox-name knowhow-web --snapshot-name tests-ready"
    )
    .option("--sandbox-id <id>", "Source sandbox ID")
    .option("--sandbox-name <name>", "Source sandbox name (alternative to --sandbox-id)")
    .option("--snapshot-id <id>", "Snapshot ID to regenerate")
    .option("--snapshot-name <name>", "Snapshot label to regenerate")
    .option("--no-wait", "Trigger regeneration and return immediately (do not poll for completion)")
    .option("--timeout-minutes <min>", "Max time for the full regen cycle", "60")
    .action(
      async (opts: {
        sandboxId?: string;
        sandboxName?: string;
        snapshotId?: string;
        snapshotName?: string;
        wait: boolean;
        timeoutMinutes: string;
      }) => {
        const timeoutMs = Number(opts.timeoutMinutes) * 60 * 1000;

        // ── 1. Resolve sandbox & snapshot ──────────────────────────────────
        if (!opts.sandboxId && !opts.sandboxName) {
          throw new Error("Provide --sandbox-id or --sandbox-name");
        }
        const sandboxId =
          opts.sandboxId || (await resolveSandboxId(opts.sandboxName!));

        if (!opts.snapshotId && !opts.snapshotName) {
          throw new Error("Provide --snapshot-id or --snapshot-name");
        }
        const snapshot = opts.snapshotId
          ? await apiGet<SandboxSnapshot>(
              `/sandboxes/${sandboxId}/snapshots/${opts.snapshotId}`
            )
          : await resolveSnapshot(sandboxId, opts.snapshotName!);
        const snapshotId = snapshot.id;

        console.log(
          `\n🔄 Regenerating snapshot "${snapshot.label || snapshotId}" (${snapshotId})`
        );
        console.log(`   Source sandbox: ${sandboxId}`);

        // ── 2. Validate preconditions ───────────────────────────────────────
        if (snapshot.status !== "ready" && !snapshot.regenerationSandboxId) {
          throw new Error(
            `Snapshot must be in 'ready' status to regenerate (current: ${snapshot.status})`
          );
        }

        // ── 3. Kick off background regeneration via backend API ─────────────
        // The backend POST /regenerate endpoint returns immediately with the
        // updated snapshot (regenerationSandboxId set). It runs the full
        // cycle (fork ephemeral → setupScript → snapshot) in the background.
        console.log("\n📡 Triggering backend regeneration...");
        const triggered = await apiPost<SandboxSnapshot>(
          `/sandboxes/${sandboxId}/snapshots/${snapshotId}/regenerate`
        );
        console.log(`   regenerationSandboxId: ${triggered.regenerationSandboxId || "(none)"}`);

        if (!opts.wait) {
          console.log(
            `\n✅ Regeneration triggered. Monitor with:\n` +
              `   knowhow sandbox snapshot-status --sandbox-id ${sandboxId} --snapshot-id ${snapshotId}`
          );
          return;
        }

        // ── 4. Poll until complete ──────────────────────────────────────────
        console.log("\n⏳ Waiting for regeneration to complete (Ctrl+C to stop polling)...");
        const done = await pollRegeneration(sandboxId, snapshotId, timeoutMs);

        console.log(
          `\n✅ Snapshot regeneration complete!\n` +
            `   Snapshot ID : ${done.id}\n` +
            `   Label       : ${done.label || "(none)"}\n` +
            `   Status      : ${done.status}`
        );
      }
    );

  // ── sandbox snapshot-status ──────────────────────────────────────────────────
  sandboxCmd
    .command("snapshot-status")
    .description(
      "Check and optionally wait for a snapshot's regeneration to complete.\n" +
        "Useful after triggering regeneration with --no-wait."
    )
    .option("--sandbox-id <id>", "Sandbox ID")
    .option("--sandbox-name <name>", "Sandbox name")
    .option("--snapshot-id <id>", "Snapshot ID")
    .option("--snapshot-name <name>", "Snapshot label")
    .option("--wait", "Poll until regeneration completes (or times out)")
    .option("--timeout-minutes <min>", "Max poll time in minutes", "60")
    .option("--json", "Output raw JSON")
    .action(
      async (opts: {
        sandboxId?: string;
        sandboxName?: string;
        snapshotId?: string;
        snapshotName?: string;
        wait?: boolean;
        timeoutMinutes: string;
        json?: boolean;
      }) => {
        if (!opts.sandboxId && !opts.sandboxName) {
          throw new Error("Provide --sandbox-id or --sandbox-name");
        }
        const sandboxId =
          opts.sandboxId || (await resolveSandboxId(opts.sandboxName!));

        if (!opts.snapshotId && !opts.snapshotName) {
          throw new Error("Provide --snapshot-id or --snapshot-name");
        }
        const snapshot = opts.snapshotId
          ? await apiGet<SandboxSnapshot>(
              `/sandboxes/${sandboxId}/snapshots/${opts.snapshotId}`
            )
          : await resolveSnapshot(sandboxId, opts.snapshotName!);

        if (opts.wait && snapshot.regenerationSandboxId) {
          console.log("⏳ Waiting for regeneration to complete...");
          const done = await pollRegeneration(
            sandboxId,
            snapshot.id,
            Number(opts.timeoutMinutes) * 60 * 1000
          );
          if (opts.json) {
            console.log(JSON.stringify(done, null, 2));
          } else {
            console.log(
              `✅ Done — status: ${done.status}  label: ${done.label || "(none)"}`
            );
          }
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(snapshot, null, 2));
        } else {
          const regenInfo = snapshot.regenerationSandboxId
            ? `🔄 regenerating (ephemeral: ${snapshot.regenerationSandboxId})`
            : `✅ ${snapshot.status}`;
          console.log(
            `Snapshot ${snapshot.id}  label=${snapshot.label || "(none)"}  ${regenInfo}`
          );
          if (snapshot.statusMessage) {
            console.log(`  message: ${snapshot.statusMessage}`);
          }
        }
      }
    );
}
