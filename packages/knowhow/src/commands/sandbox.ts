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
  const match = sandboxes.find(
    (s) => s.name === nameOrId || s.id === nameOrId
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
    .option("--no-wait", "Return immediately without waiting for snapshot to be ready")
    .option("--timeout-minutes <min>", "Max time for the full regen cycle", "60")
    .action(
      async (opts: {
        sandboxId?: string;
        sandboxName?: string;
        snapshotId?: string;
        snapshotName?: string;
        wait: boolean; // commander flips --no-wait → wait=false
        timeoutMinutes: string;
      }) => {
        const timeoutMs = Number(opts.timeoutMinutes) * 60 * 1000;
        const deadline = Date.now() + timeoutMs;

        // ── 1. Resolve sandbox ──────────────────────────────────────────────
        if (!opts.sandboxId && !opts.sandboxName) {
          throw new Error("Provide --sandbox-id or --sandbox-name");
        }
        const sandboxId =
          opts.sandboxId || (await resolveSandboxId(opts.sandboxName!));

        // ── 2. Resolve snapshot ─────────────────────────────────────────────
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

        if (snapshot.status !== "ready") {
          throw new Error(
            `Snapshot must be in 'ready' status to regenerate (current: ${snapshot.status})`
          );
        }
        if (!snapshot.setupScript) {
          throw new Error(
            "Snapshot has no setupScript. Add one via the UI before regenerating."
          );
        }

        // ── 3. Fork ephemeral sandbox from the snapshot ─────────────────────
        console.log("\n📦 Step 1/4: Forking ephemeral sandbox from snapshot...");
        const ephemeralName = `regen-${snapshotId.slice(0, 8)}-${Date.now()}`;
        const forkResult = await apiPost<{ id?: string; sandboxId?: string }>(
          "/sandboxes/fork",
          { snapshotId, name: ephemeralName }
        );
        const ephemeralId = forkResult.id || forkResult.sandboxId;
        if (!ephemeralId) {
          throw new Error(
            `Fork did not return a sandbox ID: ${JSON.stringify(forkResult)}`
          );
        }
        console.log(`   Ephemeral sandbox: ${ephemeralId} (${ephemeralName})`);

        // ── 4. Wait for ephemeral sandbox to be running ─────────────────────
        console.log("\n⏳ Step 2/4: Waiting for sandbox to start...");
        await pollSandboxStatus(
          ephemeralId,
          ["running"],
          Math.min(deadline - Date.now(), 10 * 60 * 1000),
          ephemeralName
        );
        console.log("   ✓ Running");

        // ── 5. Execute the setupScript ──────────────────────────────────────
        console.log("\n🔧 Step 3/4: Executing setupScript...");
        console.log(`   Script length: ${snapshot.setupScript.length} chars`);
        let execResult: { stdout?: string; stderr?: string; exitCode?: number };
        try {
          execResult = await apiPost<{
            stdout?: string;
            stderr?: string;
            exitCode?: number;
          }>(`/sandboxes/${ephemeralId}/exec`, {
            command: "/bin/bash",
            args: ["-c", snapshot.setupScript],
            timeoutMs: Math.min(deadline - Date.now(), 25 * 60 * 1000),
          });
        } catch (err: any) {
          console.error(`\n❌ setupScript exec failed: ${err.message}`);
          await safeDestroy(ephemeralId);
          throw err;
        }

        if (execResult.stdout) {
          console.log("--- stdout ---");
          process.stdout.write(execResult.stdout);
        }
        if (execResult.stderr) {
          console.error("--- stderr ---");
          process.stderr.write(execResult.stderr);
        }
        if (execResult.exitCode != null && execResult.exitCode !== 0) {
          await safeDestroy(ephemeralId);
          throw new Error(`setupScript exited with code ${execResult.exitCode}`);
        }
        console.log("   ✓ setupScript completed");

        // ── 6. Capture new snapshot with the same label ─────────────────────
        console.log("\n📸 Step 4/4: Capturing new snapshot...");
        const newLabel = snapshot.label || `regen-${snapshotId.slice(0, 8)}`;
        let createResult: { snapshot?: SandboxSnapshot; id?: string };
        try {
          createResult = await apiPost<{ snapshot?: SandboxSnapshot; id?: string }>(
            `/sandboxes/${ephemeralId}/snapshots`,
            {
              label: newLabel,
              description: snapshot.description,
              snapshotContent: snapshot.snapshotContent || "full",
              snapshotType: "full",
            }
          );
        } catch (err: any) {
          console.error(`\n❌ Snapshot creation failed: ${err.message}`);
          await safeDestroy(ephemeralId);
          throw err;
        }

        const newSnapshot = createResult.snapshot || (createResult as SandboxSnapshot);
        const newSnapshotId = newSnapshot.id;
        console.log(`   New snapshot ID: ${newSnapshotId}`);

        if (opts.wait) {
          console.log("   Waiting for snapshot upload...");
          await pollSnapshotStatus(
            ephemeralId,
            newSnapshotId,
            ["ready"],
            Math.min(deadline - Date.now(), 20 * 60 * 1000)
          );
          console.log("   ✓ Snapshot ready");
        }

        // ── 7. Destroy ephemeral sandbox ────────────────────────────────────
        console.log("\n🗑  Destroying ephemeral sandbox...");
        await safeDestroy(ephemeralId);
        console.log("   ✓ Destroyed");

        console.log(
          `\n✅ Snapshot regeneration complete!\n` +
            `   Old snapshot ID : ${snapshotId}\n` +
            `   New snapshot ID : ${newSnapshotId}\n` +
            `   Label           : ${newLabel}\n\n` +
            `ℹ  The old snapshot still exists. Clean it up with:\n` +
            `   knowhow sandbox delete-snapshot --sandbox-id ${sandboxId} --snapshot-id ${snapshotId}`
        );
      }
    );
}

async function safeDestroy(sandboxId: string): Promise<void> {
  try {
    await apiDelete(`/sandboxes/${sandboxId}`);
  } catch (err: any) {
    console.warn(`⚠ Could not destroy sandbox ${sandboxId}: ${err.message}`);
  }
}
