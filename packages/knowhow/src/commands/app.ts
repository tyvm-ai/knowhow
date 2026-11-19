import { Command } from "commander";

/** Exit codes: 0 ok, 1 error, 3 source push conflict (same as `knowhow repo`). */
export const EXIT_APP_PUSH_CONFLICT = 3;

async function makeClient() {
  const { KnowhowSimpleClient } = await import("../services/KnowhowClient");
  return new KnowhowSimpleClient();
}

function fail(error: any): never {
  // Backend errors are `{ error: { message, details } }` (HttpError.body); show that message, not the raw JSON.
  const e = error as { message?: string; status?: number; body?: any };
  const apiMessage = e?.body?.error?.message ?? e?.body?.message;
  console.error(
    "Error: " + (typeof apiMessage === "string" && e?.status ? `${apiMessage} (HTTP ${e.status})` : e?.message ?? String(error))
  );
  process.exit(error?.name === "AppPushError" && /conflict/i.test(error.message) ? EXIT_APP_PUSH_CONFLICT : 1);
}

function short(s?: string | null) {
  return s ? s.slice(0, 8) : "-";
}

function printPublish(p: { createdAt?: string; envName: string; kind: string; id: string; buildId?: string | null; sourceCommit?: string | null; note?: string | null }) {
  console.log(
    `${(p.createdAt ?? "").replace("T", " ").slice(0, 19).padEnd(19)}  ${p.envName.padEnd(10)} ${String(p.kind).padEnd(9)} ` +
      `build ${short(p.buildId)}  src ${short(p.sourceCommit)}  ${p.id}${p.note ? `  — ${p.note}` : ""}`
  );
}

export function addAppCommand(program: Command): void {
  const app = program
    .command("app")
    .description(
      "Knowhow apps: publish a build (knowhow.app.json) to an environment, manage environments, promote, rollback, history"
    );

  const appOpt = (c: Command) =>
    c
      .option("--app <id|slug>", "App id or slug (default: the slug in knowhow.app.json)")
      .option("--dir <dir>", "App directory containing knowhow.app.json", ".");

  appOpt(
    app
      .command("publish")
      .description("Build, upload changed files and publish to an environment (default prod)")
      .option("-e, --env <env>", "Environment to publish to", "prod")
      .option("-n, --note <note>", "Publish note")
      .option("--no-build", "Skip build.command")
      .option("--no-push", "Do not push the source to the Knowhow repository first")
  ).action(async (options) => {
    try {
      const { publishApp } = await import("../services/AppPublish");
      const r = await publishApp(await makeClient(), {
        dir: options.dir,
        app: options.app,
        env: options.env,
        note: options.note,
        build: options.build,
        push: options.push,
        log: console.log,
      });
      console.log(
        `✅ ${r.app.slug} → ${r.env} (build ${short(r.buildId)}, ${r.files} files: ${r.uploaded} uploaded, ${r.skipped} unchanged` +
          `${r.sourceCommit ? `, source ${short(r.sourceCommit)}` : ""})`
      );
      console.log(r.url ? `   ${r.url}` : "   (open it from Apps in Knowhow)");
    } catch (e) {
      fail(e);
    }
  });

  appOpt(
    app
      .command("source")
      .description(
        "Link the app to its Knowhow repository (needed for \"Develop this app\"). Default: this git repo's Knowhow repository, current branch, this directory's path inside the repo"
      )
      .option("--repo <id>", "Knowhow repository id (default: resolved from the current git repo)")
      .option("--branch <branch>", "Branch developed on (default: the current branch)")
      .option("--subdir <path>", "App directory inside the repository (default: --dir relative to the git root)")
      .option("--clear", "Detach the source repository")
  ).action(async (options) => {
    try {
      const { resolveAppId, setAppSource, describeSource } = await import("../services/AppPublish");
      const client = await makeClient();
      const appId = await resolveAppId(client, options);
      const link = await setAppSource(client, appId, options.dir, {
        repo: options.repo,
        branch: options.branch,
        subdir: options.subdir,
        clear: options.clear,
      });
      console.log(link.repositoryId ? `✅ source of the app: ${describeSource(link)}` : "✅ source repository detached");
    } catch (e) {
      fail(e);
    }
  });

  appOpt(
    app
      .command("develop")
      .description("Start your dev worker for the app (source branch checked out) and print where to chat with it")
      .option("-e, --env <env>", "Develop against this environment's tracked branch (default: the app's source branch)")
  ).action(async (options) => {
    try {
      const { resolveAppId, developApp } = await import("../services/AppPublish");
      const { KNOWHOW_API_URL } = await import("../services/KnowhowClient");
      const client = await makeClient();
      const appId = await resolveAppId(client, options);
      const r = await developApp(client, appId, { env: options.env, apiUrl: KNOWHOW_API_URL });
      const w = r.worker;
      console.log(
        `✅ dev worker ${w.cloudWorkerId}${w.status ? ` (${w.status})` : ""}${w.branch ? `, branch ${w.branch}` : ""}` +
          `${w.created ? ", created" : ""}${w.started ? ", started" : ""}`
      );
      console.log(r.url ? `   ${r.url}` : `   open ${r.path} in the Knowhow web app (set KNOWHOW_FRONTEND_URL to print the full URL)`);
    } catch (e) {
      fail(e);
    }
  });

  const env = app.command("env").description("Environment variables and data mode");

  appOpt(env.command("list").description("List environments with vars, data mode and current build").option("--json", "Output JSON")).action(
    async (options) => {
      try {
        const { resolveAppId } = await import("../services/AppPublish");
        const client = await makeClient();
        const appId = await resolveAppId(client, options);
        const envs = await client.listAppEnvironments(appId);
        if (options.json) return console.log(JSON.stringify(envs, null, 2));
        if (!envs.length) return console.log("No environments yet: run `knowhow app publish`.");
        for (const e of envs) {
          const data = e.dataMode === "shared" ? `shared (from ${e.dataEnv ?? e.dataSourceEnv ?? "prod"})` : e.dataMode ?? "separate";
          console.log(`${e.name}  build ${short(e.buildId)}${e.buildId ? "" : " (folder mode)"}  data: ${data}`);
          for (const [k, v] of Object.entries(e.vars ?? {})) console.log(`  ${k}=${v}`);
        }
      } catch (e) {
        fail(e);
      }
    }
  );

  appOpt(
    env
      .command("set <pairs...>")
      .description("Set variables: KEY=VALUE [KEY=VALUE...]")
      .option("-e, --env <env>", "Environment", "prod")
  ).action(async (pairs: string[], options) => {
    try {
      const { resolveAppId, parseEnvPairs, setEnvVars } = await import("../services/AppPublish");
      const set = parseEnvPairs(pairs);
      const client = await makeClient();
      await setEnvVars(client, await resolveAppId(client, options), options.env, set);
      console.log(`✅ ${options.env}: set ${Object.keys(set).join(", ")}`);
    } catch (e) {
      fail(e);
    }
  });

  appOpt(
    env
      .command("unset <keys...>")
      .description("Remove variables")
      .option("-e, --env <env>", "Environment", "prod")
  ).action(async (keys: string[], options) => {
    try {
      const { resolveAppId, unsetEnvVars } = await import("../services/AppPublish");
      const client = await makeClient();
      const r = await unsetEnvVars(client, await resolveAppId(client, options), options.env, keys);
      if (r.missing.length) console.log(`(not set in ${options.env}: ${r.missing.join(", ")})`);
      console.log(`✅ ${options.env}: unset ${keys.filter((k) => !r.missing.includes(k)).join(", ") || "nothing"}`);
    } catch (e) {
      fail(e);
    }
  });

  appOpt(
    env
      .command("data")
      .description("Choose whether an environment uses its own data or another environment's data")
      .requiredOption("-e, --env <env>", "Environment to configure")
      .requiredOption("--mode <mode>", "shared | separate")
      .option("--source <env>", "With --mode shared: the environment whose data is used (default: its current source, prod initially)")
  ).action(async (options) => {
    try {
      const { resolveAppId, setEnvDataMode } = await import("../services/AppPublish");
      const client = await makeClient();
      await setEnvDataMode(client, await resolveAppId(client, options), options.env, options.mode, options.source);
      console.log(
        `✅ ${options.env}: data ${options.mode}${options.mode === "shared" ? ` (source ${options.source ?? "unchanged, prod by default"})` : ""}`
      );
    } catch (e) {
      fail(e);
    }
  });

  appOpt(
    app
      .command("promote")
      .description("Point an environment at the build of another environment")
      .requiredOption("--from <env>", "Source environment")
      .requiredOption("--to <env>", "Target environment")
  ).action(async (options) => {
    try {
      const { resolveAppId, promoteApp } = await import("../services/AppPublish");
      const client = await makeClient();
      await promoteApp(client, await resolveAppId(client, options), options.from, options.to);
      console.log(`✅ promoted ${options.from} → ${options.to}`);
    } catch (e) {
      fail(e);
    }
  });

  appOpt(
    app
      .command("rollback")
      .description("Roll an environment back to its previous build (or to a specific publish)")
      .option("-e, --env <env>", "Environment", "prod")
      .option("--to <publishId>", "Publish id to roll back to (default: the previous one)")
  ).action(async (options) => {
    try {
      const { resolveAppId, rollbackApp } = await import("../services/AppPublish");
      const client = await makeClient();
      await rollbackApp(client, await resolveAppId(client, options), options.env, options.to);
      console.log(`✅ rolled back ${options.env}${options.to ? ` to publish ${options.to}` : ""}`);
    } catch (e) {
      fail(e);
    }
  });

  appOpt(app.command("status").description("Environments, current builds and last publishes").option("--json", "Output JSON")).action(
    async (options) => {
      try {
        const { resolveAppId, appStatus } = await import("../services/AppPublish");
        const client = await makeClient();
        const s = await appStatus(client, await resolveAppId(client, options));
        if (options.json) return console.log(JSON.stringify(s, null, 2));
        console.log(`${s.app.name ?? s.app.slug} (${s.app.slug}, ${s.app.id})`);
        if (!s.environments.length) console.log("No environments yet: run `knowhow app publish`.");
        for (const e of s.environments) {
          console.log(`\n${e.name}  build ${short(e.buildId)}${e.buildId ? "" : " (folder mode)"}`);
          if (e.url) console.log(`  url:  ${e.url}`);
          const data = e.dataMode === "shared" ? `shared (from ${e.dataSourceEnv ?? "prod"})` : e.dataMode ?? "separate";
          console.log(`  data: ${data}`);
          if (e.lastPublish) {
            process.stdout.write("  last: ");
            printPublish(e.lastPublish);
          }
        }
      } catch (e) {
        fail(e);
      }
    }
  );

  appOpt(
    app
      .command("history")
      .description("Publish history (publish, promote, rollback), newest first")
      .option("-e, --env <env>", "Only this environment")
      .option("--json", "Output JSON")
  ).action(async (options) => {
    try {
      const { resolveAppId, appHistory } = await import("../services/AppPublish");
      const client = await makeClient();
      const list = await appHistory(client, await resolveAppId(client, options), options.env);
      if (options.json) return console.log(JSON.stringify(list, null, 2));
      if (!list.length) return console.log("No publishes yet.");
      list.forEach(printPublish);
    } catch (e) {
      fail(e);
    }
  });
}
