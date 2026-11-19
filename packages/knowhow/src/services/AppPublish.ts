/**
 * AppPublish — logic behind `knowhow app publish | env | promote | rollback | status | history`.
 *
 * Spec: knowhow-web/.knowhow/tasks/min-app-updates/implementation.md ("API", "CLI").
 *
 * Publish flow: [repo push] -> build -> POST /apps/resolve -> hash files -> POST /apps/{id}/builds
 * -> PUT only the uploads the backend asks for (content-addressed reuse) -> complete -> publish to env.
 * The commands in `src/commands/app.ts` are thin wrappers around the functions in here; everything that
 * touches the network goes through the `AppClient` interface so tests can mock it.
 */
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type {
  AppBuildFileInfo,
  AppEnvironmentRecord,
  AppPublishRecord,
  AppRecord,
  CreateAppBuildRequest,
  CreateAppBuildResponse,
  ResolveAppRequest,
  SetAppSourceRequest,
  StartAppDevWorkerRequest,
  StartAppDevWorkerResponse,
  UpdateAppEnvironmentRequest,
} from "./KnowhowClient";
import type { PushResult } from "./RepoSync";

export const APP_MANIFEST_FILE = "knowhow.app.json";
export const DEFAULT_OUTPUT_DIR = "dist";
export const DEFAULT_ENV = "prod";

/** The slice of KnowhowSimpleClient the app commands use. */
export interface AppClient {
  resolveApp(req: ResolveAppRequest): Promise<AppRecord>;
  listApps(): Promise<AppRecord[]>;
  getApp?(appId: string, env?: string): Promise<AppRecord>;
  createAppBuild(appId: string, req: CreateAppBuildRequest): Promise<CreateAppBuildResponse>;
  completeAppBuild(appId: string, buildId: string): Promise<unknown>;
  publishAppEnvironment(
    appId: string,
    env: string,
    body: { buildId: string; note?: string; sourceCommit?: string }
  ): Promise<Record<string, any>>;
  promoteAppEnvironment(appId: string, env: string, body: { fromEnv: string }): Promise<Record<string, any>>;
  rollbackAppEnvironment(appId: string, env: string, body?: { publishId?: string }): Promise<Record<string, any>>;
  listAppEnvironments(appId: string): Promise<AppEnvironmentRecord[]>;
  updateAppEnvironment(
    appId: string,
    env: string,
    body: UpdateAppEnvironmentRequest
  ): Promise<AppEnvironmentRecord>;
  listAppPublishes(appId: string, env?: string): Promise<AppPublishRecord[]>;
  setAppSource(appId: string, body: SetAppSourceRequest): Promise<AppRecord>;
  startAppDevWorker(appId: string, body?: StartAppDevWorkerRequest): Promise<StartAppDevWorkerResponse>;
  resolveGitRepository(req: { originUrl: string; name?: string; defaultBranch?: string }): Promise<{ id: string }>;
}

export type Log = (message: string) => void;

// ---------------------------------------------------------------------------
// knowhow.app.json
// ---------------------------------------------------------------------------

export interface AppManifestFile {
  slug?: string;
  name?: string;
  build?: { command?: string; outputDir?: string; [k: string]: unknown };
  rootPath?: string;
  [k: string]: unknown;
}

export function readAppManifest(dir: string): AppManifestFile {
  const file = path.join(dir, APP_MANIFEST_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`${APP_MANIFEST_FILE} not found in ${path.resolve(dir)} (use --dir <app directory>).`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e: any) {
    throw new Error(`${APP_MANIFEST_FILE} is not valid JSON: ${e?.message ?? e}`);
  }
}

/** The manifest if there is one in `dir`, else undefined (non-publish commands can work with `--app`). */
export function tryReadAppManifest(dir: string): AppManifestFile | undefined {
  try {
    return readAppManifest(dir);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// File hashing
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".xml": "application/xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
};

export function contentTypeFor(fileName: string): string {
  return MIME[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

function sha256HexFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")));
  });
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() ? [full] : [];
  });
}

export interface HashedFile extends AppBuildFileInfo {
  /** absolute path on disk */
  abs: string;
}

/** Hash every file under `outDir` (sorted by path, POSIX relative paths, hex sha256). */
export async function hashBuildFiles(outDir: string): Promise<HashedFile[]> {
  if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) {
    throw new Error(`Build output directory not found: ${outDir} (check build.outputDir in ${APP_MANIFEST_FILE}).`);
  }
  const files = walk(outDir)
    .map((abs) => ({ abs, rel: path.relative(outDir, abs).split(path.sep).join("/") }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  if (!files.length) throw new Error(`Build output directory is empty: ${outDir}`);
  const out: HashedFile[] = [];
  for (const f of files) {
    out.push({
      path: f.rel,
      sha256: await sha256HexFile(f.abs),
      size: fs.statSync(f.abs).size,
      contentType: contentTypeFor(f.rel),
      abs: f.abs,
    });
  }
  return out;
}

export async function defaultUpload(url: string, file: string, contentType: string) {
  const size = fs.statSync(file).size;
  const res = await fetch(url, {
    method: "PUT",
    body: fs.readFileSync(file),
    headers: { "Content-Type": contentType, "Content-Length": String(size) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upload failed (HTTP ${res.status}) ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// App id resolution
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AppRef {
  /** `--app <id|slug>` */
  app?: string;
  /** directory containing knowhow.app.json (default: cwd) */
  dir?: string;
}

/**
 * Find an existing app id for commands that never create: `--app <uuid>` is used as-is, `--app <slug>` (or the
 * slug from knowhow.app.json) is looked up in the caller's apps.
 */
export async function resolveAppId(client: AppClient, ref: AppRef = {}): Promise<string> {
  if (ref.app && UUID_RE.test(ref.app)) return ref.app;
  const slug = ref.app ?? tryReadAppManifest(ref.dir ?? process.cwd())?.slug;
  if (!slug) {
    throw new Error(`No app specified: pass --app <id|slug> or run inside a directory with a ${APP_MANIFEST_FILE} (slug).`);
  }
  const apps = await client.listApps();
  const found =
    apps.find((a) => a.slug === slug) ??
    apps.find((a) => a.id === slug) ??
    apps.find((a) => (a.aliases ?? []).includes(slug));
  if (!found) throw new Error(`App '${slug}' not found. Create it with \`knowhow app publish\`.`);
  return found.id;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * Serving URL of an environment. The backend returns it: `origin` on every environment record
 * (list/update) and `env.origin` in the publish/promote/rollback response. Only when none of those is
 * available (older backend) it is derived from the app's prod `appOrigin`: prod `{slug}--{appIdHex}`,
 * other envs `{slug}--{env}--{appIdHex}`.
 */
export function envUrl(app: Pick<AppRecord, "appOrigin" | "slug" | "id" | "envName"> | undefined, env: string, hint?: Record<string, any>): string | undefined {
  const given = hint?.env?.origin ?? hint?.origin ?? hint?.url ?? hint?.environment?.origin ?? hint?.environment?.url;
  if (typeof given === "string" && given) return given;
  // `appOrigin` of GET /apps/{id}?env=<env> already describes that env
  if (app?.envName === env && app.appOrigin) return app.appOrigin;
  // an appOrigin that describes some other non-prod env cannot be used to derive this one
  if (app?.envName && app.envName !== DEFAULT_ENV) return undefined;
  const origin = app?.appOrigin;
  if (!origin) return undefined;
  if (env === DEFAULT_ENV) return origin;
  try {
    const u = new URL(origin);
    const [label, ...rest] = u.hostname.split(".");
    const i = label.lastIndexOf("--");
    if (i < 0) return undefined;
    u.hostname = [`${label.slice(0, i)}--${env}${label.slice(i)}`, ...rest].join(".");
    return u.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Source push (knowhow repository context)
// ---------------------------------------------------------------------------

export class AppPushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppPushError";
  }
}

/**
 * If `dir` is inside a git repo with a Knowhow repository (a `knowhow://` remote), push the current branch
 * (CAS bundle, see RepoSync.pushRepo) and return the pushed commit; return null when there is no Knowhow
 * repository context. A conflict or push failure throws AppPushError (publish must not go on with a source
 * commit that the repository does not have).
 */
export async function pushSourceIfKnowhowRepo(
  client: AppClient,
  dir: string,
  log: Log
): Promise<{ sha: string; branch: string; status: PushResult["status"] } | null> {
  const { getRealRepoInfo, isKnowhowUrl, KNOWHOW_REMOTE } = await import("./RealRepo");
  const info = getRealRepoInfo(dir, KNOWHOW_REMOTE);
  if (!info || !isKnowhowUrl(info.remoteUrl)) return null;
  const { pushRepo, RepoConflictError } = await import("./RepoSync");
  try {
    const r = await pushRepo(client as any, { cwd: dir, remote: info.remoteName, log });
    return { sha: r.sha, branch: r.branch, status: r.status };
  } catch (e: any) {
    if (e instanceof RepoConflictError || e?.name === "RepoConflictError") {
      throw new AppPushError(
        `Publish aborted: pushing the source conflicts with the Knowhow repository.\n${e.message}\n` +
          "Resolve it (`knowhow repo pull`, then retry) or publish without the source using --no-push."
      );
    }
    throw new AppPushError(`Publish aborted: pushing the source failed: ${e?.message ?? e}\n(use --no-push to skip it)`);
  }
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

export interface PublishOptions {
  /** app directory (contains knowhow.app.json), default cwd */
  dir?: string;
  env?: string;
  note?: string;
  /** false = skip the build command (`--no-build`) */
  build?: boolean;
  /** false = do not push the source first (`--no-push`) */
  push?: boolean;
  /** `--app <id|slug>` overrides the manifest slug for resolution */
  app?: string;
  log?: Log;
  /** test seams */
  runBuild?: (command: string, cwd: string) => void | Promise<void>;
  pushSource?: (client: AppClient, dir: string, log: Log) => Promise<{ sha: string } | null>;
  upload?: (url: string, file: string, contentType: string) => Promise<void>;
  /** links the app to the Knowhow repository of `dir` (default: {@link linkAppSource}) */
  linkSource?: (client: AppClient, appId: string, dir: string) => Promise<AppSourceLink>;
  concurrency?: number;
}

export interface PublishResult {
  app: AppRecord;
  env: string;
  buildId: string;
  files: number;
  uploaded: number;
  skipped: number;
  sourceCommit?: string;
  url?: string;
  publish: Record<string, any>;
  /** set when this publish linked the app to its Knowhow repository (first publish from a repo) */
  sourceLinked?: AppSourceLink;
}

export function defaultRunBuild(command: string, cwd: string) {
  const r = spawnSync(command, { cwd, shell: true, stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`Build command failed (exit ${r.status}): ${command}`);
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function publishApp(client: AppClient, opts: PublishOptions = {}): Promise<PublishResult> {
  const log = opts.log ?? (() => {});
  const dir = path.resolve(opts.dir ?? process.cwd());
  const env = opts.env || DEFAULT_ENV;
  const manifest = readAppManifest(dir);
  const slug = opts.app ?? manifest.slug;
  if (!slug) throw new Error(`${APP_MANIFEST_FILE} needs a "slug" (or pass --app <slug>).`);

  // 1. source first: the build records the commit it was built from
  let sourceCommit: string | undefined;
  if (opts.push !== false) {
    const pushed = await (opts.pushSource ?? pushSourceIfKnowhowRepo)(client, dir, log);
    if (pushed) {
      sourceCommit = pushed.sha;
      log(`📌 source ${pushed.sha.slice(0, 8)} is in the Knowhow repository`);
    } else {
      log("ℹ️  no Knowhow repository for this directory: publishing without a source commit (see `knowhow repo init --hosted`)");
    }
  }

  // 2. build
  const buildCommand = manifest.build?.command;
  if (opts.build !== false && buildCommand) {
    log(`🔨 ${buildCommand}`);
    await (opts.runBuild ?? defaultRunBuild)(buildCommand, dir);
  } else if (opts.build !== false) {
    log("ℹ️  no build.command in knowhow.app.json: publishing the output directory as is");
  }

  // 3. resolve the app (idempotent create-or-get)
  const app = await client.resolveApp({
    slug,
    ...(manifest.rootPath ? { rootPath: manifest.rootPath } : {}),
    ...(manifest.name ? { name: manifest.name } : {}),
  });

  // 4. hash files, create the build
  const outDir = path.resolve(dir, manifest.build?.outputDir || DEFAULT_OUTPUT_DIR);
  const hashed = await hashBuildFiles(outDir);
  const created = await client.createAppBuild(app.id, {
    files: hashed.map(({ path: p, sha256, size, contentType }) => ({ path: p, sha256, size, contentType })),
    manifest: manifest as Record<string, unknown>,
    ...(sourceCommit ? { sourceCommit } : {}),
  });

  // 5. upload only what the backend asked for
  const byPath = new Map(hashed.map((f) => [f.path, f]));
  const upload = opts.upload ?? defaultUpload;
  const uploads = created.uploads ?? [];
  for (const u of uploads) {
    if (!byPath.has(u.path)) throw new Error(`Backend asked for an unknown file: ${u.path}`);
  }
  let done = 0;
  await runPool(uploads, opts.concurrency ?? 4, async (u) => {
    const f = byPath.get(u.path)!;
    await upload(u.uploadUrl, f.abs, f.contentType);
    log(`⬆️  ${f.path} (${++done}/${uploads.length})`);
  });
  const skipped = hashed.length - uploads.length;
  log(`📦 ${hashed.length} files: ${uploads.length} uploaded, ${skipped} unchanged`);

  // 6. complete + publish (a build with nothing to upload is `ready` already)
  if (created.ready !== true) await client.completeAppBuild(app.id, created.buildId);
  const publish = await client.publishAppEnvironment(app.id, env, {
    buildId: created.buildId,
    ...(opts.note ? { note: opts.note } : {}),
    ...(sourceCommit ? { sourceCommit } : {}),
  });

  // 7. first publish from a Knowhow repository: link it as the app's source so "Develop this app" works.
  // Never overwrites an existing source, and a failure here does not fail the (already successful) publish.
  let sourceLinked: AppSourceLink | undefined;
  if (sourceCommit && !app.sourceRepositoryId) {
    try {
      sourceLinked = await (opts.linkSource ?? linkAppSource)(client, app.id, dir);
      log(`🔗 linked ${describeSource(sourceLinked)} as the source of ${app.slug} ("Develop this app" is ready)`);
    } catch (e: any) {
      log(`⚠️  could not link the source repository (run \`knowhow app source\`): ${e?.message ?? e}`);
    }
  }

  return {
    app,
    env,
    buildId: created.buildId,
    files: hashed.length,
    uploaded: uploads.length,
    skipped,
    sourceCommit,
    url: envUrl(app, env, publish),
    publish,
    ...(sourceLinked ? { sourceLinked } : {}),
  };
}

// ---------------------------------------------------------------------------
// source (link the app to its Knowhow repository) + develop
// ---------------------------------------------------------------------------

export interface AppSourceLink {
  repositoryId: string | null;
  branch?: string;
  /** app directory relative to the git root; undefined = repository root */
  subdir?: string;
}

export interface SourceOptions extends AppRef {
  /** `--repo <id>`: repository id instead of resolving the current git repo's */
  repo?: string;
  branch?: string;
  subdir?: string;
  /** `--clear`: detach the source */
  clear?: boolean;
}

export function describeSource(l: AppSourceLink): string {
  if (!l.repositoryId) return "no source repository";
  return `repository ${l.repositoryId.slice(0, 8)}${l.branch ? ` @ ${l.branch}` : ""}${l.subdir ? ` (${l.subdir}/)` : ""}`;
}

/**
 * What to PUT as the app's source. Default: the Knowhow repository of the git repo containing `dir`
 * (resolved like `knowhow repo`: prefers the `knowhow` remote), its current branch, and `dir` relative to the
 * git root (omitted at the root). `--repo/--branch/--subdir` override each part.
 */
export async function resolveSourceLink(
  client: AppClient,
  dir: string,
  opts: Pick<SourceOptions, "repo" | "branch" | "subdir"> = {}
): Promise<AppSourceLink> {
  const { getRealRepoInfo, KNOWHOW_REMOTE } = await import("./RealRepo");
  let repositoryId = opts.repo;
  let info = getRealRepoInfo(dir, KNOWHOW_REMOTE);
  if (!repositoryId) {
    const { resolveRepoContext } = await import("./TaskTransport");
    const ctx = await resolveRepoContext(client as any, dir, KNOWHOW_REMOTE);
    repositoryId = ctx.repo.id;
    info = ctx.info;
  }
  const branch = opts.branch ?? (info?.branch || undefined);
  const subdir = (opts.subdir ?? info?.projectSubdir ?? "").replace(/^\/+|\/+$/g, "") || undefined;
  return { repositoryId, ...(branch ? { branch } : {}), ...(subdir ? { subdir } : {}) };
}

/** Resolve the source of `dir` and PUT it on the app. */
export async function linkAppSource(client: AppClient, appId: string, dir: string, opts: Pick<SourceOptions, "repo" | "branch" | "subdir"> = {}) {
  const link = await resolveSourceLink(client, dir, opts);
  await client.setAppSource(appId, {
    repositoryId: link.repositoryId,
    ...(link.branch ? { branch: link.branch } : {}),
    ...(link.subdir ? { subdir: link.subdir } : {}),
  });
  return link;
}

/** `knowhow app source [--repo] [--branch] [--subdir] [--clear]` */
export async function setAppSource(client: AppClient, appId: string, dir: string, opts: SourceOptions = {}) {
  if (opts.clear) {
    if (opts.repo || opts.branch || opts.subdir) throw new Error("--clear cannot be combined with --repo/--branch/--subdir.");
    await client.setAppSource(appId, { repositoryId: null });
    return { repositoryId: null } as AppSourceLink;
  }
  return linkAppSource(client, appId, dir, opts);
}

/** Frontend URL: `KNOWHOW_FRONTEND_URL`, else derived from the API url (api.<host> -> <host>, localhost -> :3000). */
export function frontendBaseUrl(apiUrl?: string, envUrlValue: string | undefined = process.env.KNOWHOW_FRONTEND_URL): string | undefined {
  if (envUrlValue) return envUrlValue.replace(/\/+$/, "");
  if (!apiUrl) return undefined;
  try {
    const u = new URL(apiUrl);
    if (u.hostname === "localhost" || u.hostname === "::1" || u.hostname.startsWith("127.")) return `${u.protocol}//${u.hostname}:3000`;
    if (u.hostname.startsWith("api.")) return `${u.protocol}//${u.hostname.slice(4)}`;
  } catch {
    // fall through
  }
  return undefined;
}

export function devWorkerPath(cloudWorkerId: string) {
  return `/dashboard/workers/chat?workerId=${encodeURIComponent(cloudWorkerId)}`;
}

/** `knowhow app develop [--env]`: start the caller's dev worker; returns it plus the chat URL when the frontend is known. */
export async function developApp(client: AppClient, appId: string, opts: { env?: string; apiUrl?: string; frontendUrl?: string } = {}) {
  const worker = await client.startAppDevWorker(appId, opts.env ? { env: opts.env } : {});
  const p = devWorkerPath(worker.cloudWorkerId);
  const base = opts.frontendUrl?.replace(/\/+$/, "") ?? frontendBaseUrl(opts.apiUrl);
  return { worker, path: p, url: base ? `${base}${p}` : undefined };
}

// ---------------------------------------------------------------------------
// environments
// ---------------------------------------------------------------------------

/** KEY=VAL pairs (VAL may contain `=`). */
export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i <= 0) throw new Error(`Expected KEY=VALUE, got '${p}'.`);
    const key = p.slice(0, i);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
      throw new Error(`Invalid variable name '${key}' (letters, digits and _, not starting with a digit, max 64 chars).`);
    }
    out[key] = p.slice(i + 1);
  }
  return out;
}

function requireEnv(envs: AppEnvironmentRecord[], env: string) {
  const found = envs.find((e) => e.name === env);
  if (!found) {
    throw new Error(
      `Environment '${env}' does not exist (existing: ${envs.map((e) => e.name).join(", ") || "none"}). ` +
        `Create it by publishing: \`knowhow app publish --env ${env}\`.`
    );
  }
  return found;
}

async function currentVars(client: AppClient, appId: string, env: string) {
  const found = requireEnv(await client.listAppEnvironments(appId), env);
  return { ...((found.vars as Record<string, string> | undefined) ?? {}) };
}

/** Merge `set` into the environment's vars. The backend's PUT REPLACES `vars`, so the full merged map is sent. */
export async function setEnvVars(client: AppClient, appId: string, env: string, set: Record<string, string>) {
  const vars = { ...(await currentVars(client, appId, env)), ...set };
  await client.updateAppEnvironment(appId, env, { vars });
  return vars;
}

export async function unsetEnvVars(client: AppClient, appId: string, env: string, keys: string[]) {
  const vars = await currentVars(client, appId, env);
  const missing = keys.filter((k) => !(k in vars));
  for (const k of keys) delete vars[k];
  await client.updateAppEnvironment(appId, env, { vars });
  return { vars, missing };
}

/**
 * `knowhow app env data --env dev --mode shared|separate [--source prod]`. Mirrors the backend rules so the
 * error is clear before the request: prod always keeps its own data; a shared env needs ANOTHER existing
 * env as its source, and that source must itself keep its own data.
 */
export async function setEnvDataMode(
  client: AppClient,
  appId: string,
  env: string,
  mode: string,
  source?: string
) {
  if (mode !== "shared" && mode !== "separate") throw new Error(`--mode must be 'shared' or 'separate' (got '${mode}').`);
  if (source && source === env) throw new Error(`--source must be a different environment than --env (${env}).`);
  if (source && mode === "separate") throw new Error("--source only applies to --mode shared.");
  if (mode === "shared") {
    if (env === DEFAULT_ENV) throw new Error("prod always keeps its own data: it cannot be shared.");
    const envs = await client.listAppEnvironments(appId);
    const target = requireEnv(envs, env);
    const sourceName = source ?? target.dataSourceEnv ?? DEFAULT_ENV;
    if (sourceName === env) throw new Error(`An environment cannot share data with itself (${env}).`);
    const src = envs.find((e) => e.name === sourceName);
    if (!src) throw new Error(`Data source environment '${sourceName}' does not exist.`);
    if (src.dataMode === "shared") {
      throw new Error(`Data source environment '${sourceName}' itself shares data; point at an environment with its own data.`);
    }
    const dependents = envs.filter((e) => e.name !== env && e.dataMode === "shared" && e.dataSourceEnv === env);
    if (dependents.length) {
      throw new Error(
        `Other environments read '${env}' data (${dependents.map((e) => e.name).join(", ")}); make them separate first.`
      );
    }
  }
  return client.updateAppEnvironment(appId, env, {
    dataMode: mode,
    ...(source ? { dataSourceEnv: source } : {}),
  });
}

export async function promoteApp(client: AppClient, appId: string, from: string, to: string) {
  if (from === to) throw new Error("--from and --to must be different environments.");
  return client.promoteAppEnvironment(appId, to, { fromEnv: from });
}

export async function rollbackApp(client: AppClient, appId: string, env: string, publishId?: string) {
  return client.rollbackAppEnvironment(appId, env, publishId ? { publishId } : {});
}

// ---------------------------------------------------------------------------
// status / history
// ---------------------------------------------------------------------------

export function sortPublishes(publishes: AppPublishRecord[]): AppPublishRecord[] {
  return [...publishes].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

export interface AppStatus {
  app: AppRecord;
  environments: (AppEnvironmentRecord & { url?: string; lastPublish?: AppPublishRecord })[];
}

export async function appStatus(client: AppClient, appId: string): Promise<AppStatus> {
  const [app, envs, publishes] = await Promise.all([
    client.getApp ? client.getApp(appId) : client.listApps().then((a) => a.find((x) => x.id === appId)!),
    client.listAppEnvironments(appId),
    client.listAppPublishes(appId),
  ]);
  const sorted = sortPublishes(publishes);
  return {
    app,
    environments: envs.map((e) => ({
      ...e,
      url: envUrl(app, e.name, e),
      lastPublish: sorted.find((p) => p.envName === e.name),
    })),
  };
}

export async function appHistory(client: AppClient, appId: string, env?: string) {
  return sortPublishes(await client.listAppPublishes(appId, env));
}
