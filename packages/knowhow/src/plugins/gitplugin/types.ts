export const TIMELINE_REF = "refs/heads/timeline";
export const TASK_REF_PREFIX = "refs/knowhow/tasks/";
export const PROTOCOL_VERSION = 2;

/** Never tracked: secrets, deps, our own state. Same list as V1. */
export const INTERNAL_EXCLUDES = [
  ".knowhow/",
  "node_modules/",
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
];
export const DEFAULT_MAX_FILE_MB = 25;
export const BULK_PATH_CAP = 500;

export type CommitKind =
  | "edit"
  | "exec"
  | "sweep"
  | "untrack"
  | "revert"
  | "import"
  | "marker";

export interface RecordRequest {
  /** taskId of the agent, "user" for unowned sweeps, "system" for untrack */
  agent: string;
  /** repo-relative, forward-slash paths. Missing on disk = removal. */
  paths: string[];
  kind: CommitKind;
  summary: string;
  tool?: string;
  cmd?: string;
  attribution?: "exact" | "ambiguous";
  alsoPossible?: string[];
  realHead?: string;
  bulk?: boolean;
  /** extra trailers, e.g. Reverts-Agent */
  trailers?: Record<string, string>;
  /** paths to force-remove from the index regardless of disk state (untrack) */
  forceRemove?: boolean;
}

export interface RecordResult {
  sha: string | null;
  /** number of CAS retries used */
  retries: number;
  files: string[];
}

export interface TimelineCommit {
  sha: string;
  subject: string;
  agent: string;
  kind: string;
  date: string;
  trailers: Record<string, string>;
}

export function agentLabel(agent: string): string {
  return agent.length > 24 ? agent.slice(0, 24) : agent;
}

export function toPosix(p: string): string {
  return p.split("\\").join("/");
}
export const DEFAULT_KEEP_TASKS = 50;
