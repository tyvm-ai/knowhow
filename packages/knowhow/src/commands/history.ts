import { Command } from "commander";
import { TimelineCore } from "../plugins/gitplugin/Core";
import { getConfigSync } from "../config";

function core(): TimelineCore {
  const c = new TimelineCore({
    root: process.cwd(),
    maxFileMb: () => getConfigSync()?.gitPlugin?.maxFileMb,
    include: () => getConfigSync()?.gitPlugin?.include,
    log: (m) => console.error(m),
  });
  if (!c.exists() || !c.recorder.tip()) {
    console.error("No timeline in .knowhow/.git yet (GitPlugin has not run in this project).");
    process.exit(1);
  }
  return c;
}

/** `knowhow history log|status|diff|doctor` (read-only; status runs a sweep, which only writes inside .knowhow/.git). */
export function addHistoryCommand(program: Command): void {
  const history = program
    .command("history")
    .description("view the agent edit timeline kept in .knowhow/.git");

  history
    .command("log")
    .option("--agent <taskId>", "only commits by this agent/task")
    .option("-n, --limit <n>", "max commits", "30")
    .option("--path <p>", "only commits touching this path")
    .option("--json", "JSON output")
    .action((o) => {
      const c = core();
      const commits = c.history.log({ agent: o.agent, limit: Number(o.limit) || 30, path: o.path });
      if (o.json) return console.log(JSON.stringify(commits, null, 2));
      for (const x of commits) console.log(c.history.formatLine(x));
    });

  history
    .command("status")
    .description("sweep, then list the last agent to touch recently changed files")
    .option("--json", "JSON output")
    .action((o) => {
      const c = core();
      const s = c.sweeper.sweep({ summary: "knowhow history status" });
      const recent = c.history.log({ limit: 20 });
      const out = {
        swept: s.swept.length,
        untracked: s.untracked.length,
        skippedOversize: s.skippedOversize,
        tip: c.recorder.tip(),
        recent: recent.map((x) => ({ sha: x.sha.slice(0, 8), agent: x.agent, kind: x.kind, subject: x.subject })),
      };
      if (o.json) return console.log(JSON.stringify(out, null, 2));
      console.log(`tip ${out.tip?.slice(0, 8)}; swept ${out.swept} file(s), untracked ${out.untracked}`);
      for (const x of recent) console.log(c.history.formatLine(x));
    });

  history
    .command("diff")
    .requiredOption("--agent <taskId>")
    .option("--path <p>")
    .action((o) => {
      const c = core();
      process.stdout.write(c.history.diffForAgent(o.agent, o.path));
    });

  history
    .command("show <sha>")
    .action((sha) => {
      process.stdout.write(core().history.show(sha));
    });

  history
    .command("restore <path>")
    .description("put one file back to an earlier timeline version (dry run unless --apply)")
    .option("--at <sha>", "restore the version at this timeline commit")
    .option("--before-agent <taskId>", "restore the version from before this agent first touched the file")
    .option("--apply", "write the file (default: dry run)")
    .option("--force", "also restore paths that are ignored or were untracked by policy")
    .option("--json", "JSON output")
    .action((p, o) => {
      const c = core();
      const r = c.restore(p, { at: o.at, beforeAgent: o.beforeAgent, apply: !!o.apply, force: !!o.force });
      if (o.json) console.log(JSON.stringify(r, null, 2));
      else console.log(`${r.status}: ${r.path}${r.source ? ` <- ${r.source}` : ""}${r.action ? ` (${r.action})` : ""}${r.reason ? ` - ${r.reason}` : ""}${r.status === "would-restore" ? "\n(dry run; add --apply to write)" : ""}`);
      if (r.status === "refused" || r.status === "error") process.exitCode = 1;
    });

  history
    .command("revert")
    .description("undo one agent's changes without touching other agents' later changes (dry run unless --apply)")
    .requiredOption("--agent <taskId>")
    .option("--path <glob>", "only paths matching this glob")
    .option("--exact-only", "ignore commits with ambiguous attribution")
    .option("--apply", "write the files (default: dry run)")
    .option("--json", "JSON output")
    .action((o) => {
      const c = core();
      const r = c.revert({ agent: o.agent, apply: !!o.apply, exactOnly: !!o.exactOnly, pathGlob: o.path });
      if (o.json) return console.log(JSON.stringify(r, null, 2));
      console.log(`Revert agent ${r.agent}: ${r.commitsConsidered} commit(s) considered, ${r.reverted.length} file(s) ${r.applied ? "reverted" : "revertable"}, ${new Set(r.conflicts.map((x) => x.path)).size} file(s) in conflict, ${r.skipped.length} skipped`);
      for (const x of r.reverted) console.log(`  ${r.applied ? "reverted" : "would revert"}: ${x.path} (${x.action}, ${x.commits.length} commit(s))`);
      for (const x of r.conflicts) console.log(`  conflict: ${x.path} @ ${x.commit}: ${x.reason} - left unchanged`);
      for (const x of r.skipped) console.log(`  skipped: ${x.path}: ${x.reason}`);
      for (const x of r.alsoEditedByOthers) console.log(`  also edited by others since: ${x.path} (${x.agents.join(", ")})`);
      for (const x of r.changedMeanwhile) console.log(`  changed meanwhile, not written: ${x}`);
      if (r.ambiguousIncluded.length) console.log(`  ambiguous exec commits included: ${r.ambiguousIncluded.join(", ")} (use --exact-only to drop them)`);
      if (r.ambiguousSkipped.length) console.log(`  ambiguous exec commits skipped: ${r.ambiguousSkipped.join(", ")}`);
      console.log(`  note: ${r.note}`);
      if (!r.applied) console.log("(dry run; add --apply to write)");
    });

  history
    .command("reset")
    .description("re-root the timeline to one commit of the current tree (dry run unless --apply)")
    .option("--drop-legacy", "also delete main and task/* (V1 branches) and run gc")
    .option("--force", "ignore the 'legacy ref updated recently' guard")
    .option("--minutes <n>", "guard window for --drop-legacy", "30")
    .option("--prune-now", "prune unreferenced objects of any age (default keeps the last 10 minutes; unsafe while agents record)")
    .option("--apply", "do it (default: dry run)")
    .option("--json", "JSON output")
    .action((o) => {
      const c = core();
      const r = c.reset({ dropLegacy: !!o.dropLegacy, apply: !!o.apply, force: !!o.force, minutes: Number(o.minutes) || 30, pruneNow: !!o.pruneNow });
      if (o.json) return console.log(JSON.stringify(r, null, 2));
      if (r.refused) {
        console.log(`refused: ${r.refused}`);
        process.exitCode = 1;
        return;
      }
      console.log(`${r.applied ? "reset" : "would reset"}: timeline ${r.commitsBefore} commit(s), ${r.files} file(s) -> 1 commit${o.dropLegacy ? `; ${r.applied ? "dropped" : "would drop"} ${r.applied ? r.droppedLegacy.length : r.legacyRefs.length} legacy ref(s)` : ""}`);
      console.log(`size ${(r.sizeBeforeKB / 1024).toFixed(1)} MB -> ${(r.sizeAfterKB / 1024).toFixed(1)} MB`);
      if (!r.applied) console.log("(dry run; add --apply)");
    });

  history
    .command("doctor")
    .option("--full", "run fsck --connectivity-only now")
    .action((o) => {
      const c = core();
      const r = c.doctor.check({ full: !!o.full });
      const fsck = o.full ? c.doctor.fsckAll() : undefined;
      console.log(JSON.stringify(fsck ? { ...r, fsckAll: fsck } : r, null, 2));
      if (!r.ok || (fsck && fsck.length)) process.exitCode = 1;
    });
}
