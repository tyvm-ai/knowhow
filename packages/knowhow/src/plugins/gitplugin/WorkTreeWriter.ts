import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * The ONLY module of GitPlugin that writes into the user's work tree (design §12.3 A).
 * It is used by `history restore --apply` and `history revert --apply` only, never by
 * event handlers, and it never goes through git (the git wrapper has no work tree writers).
 */
export function sha1Buf(b: Buffer): string {
  return crypto.createHash("sha1").update(b).digest("hex");
}

/** git blob id of a buffer (what `git hash-object` prints), to compare disk bytes with tree blobs without spawning git. */
export function gitBlobId(b: Buffer): string {
  return crypto.createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
}

export function readDisk(root: string, rel: string): Buffer | null {
  try {
    const st = fs.lstatSync(path.join(root, rel));
    if (!st.isFile()) return null;
    return fs.readFileSync(path.join(root, rel));
  } catch {
    return null;
  }
}

/** Atomic replace: temp file in the same directory, then rename. Keeps the mode of an existing file. */
export function writeFileAtomic(root: string, rel: string, data: Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  let mode = 0o644;
  try {
    mode = fs.statSync(abs).mode & 0o777;
  } catch {
    /* new file */
  }
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.knowhow-tmp-${process.pid}`);
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, abs);
}

export function deleteFile(root: string, rel: string): void {
  fs.rmSync(path.join(root, rel), { force: true });
}
