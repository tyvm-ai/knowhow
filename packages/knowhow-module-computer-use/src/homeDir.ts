import * as os from "os";

/**
 * The user's home directory. Prefers the HOME / USERPROFILE environment
 * variables (so tests and sandboxed hosts can redirect state) and falls back to
 * `os.homedir()`.
 */
export function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
