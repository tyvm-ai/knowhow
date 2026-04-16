import fs from "fs";
import * as crypto from "crypto";
import { Hashes } from "./types";
import { readFile, writeFile } from "./utils";
import { convertToText } from "./conversion";

export async function getHashes() {
  const hashes = JSON.parse(await readFile(".knowhow/.hashes.json", "utf8"));
  return hashes as Hashes;
}

export async function saveHashes(hashes: any) {
  await writeFile(".knowhow/.hashes.json", JSON.stringify(hashes, null, 2));
}

export async function md5Hash(str: string) {
  return crypto.createHash("md5").update(str).digest("hex");
}

export async function checkNoFilesChanged(
  files: string[],
  promptHash: string,
  hashes: any
) {
  for (const file of files) {
    if (!fs.existsSync(file)) {
      return false;
    }

    // get the hash of the file
    const fileContent = await convertToText(file);
    const fileHash = crypto.createHash("md5").update(fileContent).digest("hex");

    if (!hashes[file]) {
      return false;
    }

    if (
      hashes[file].promptHash === promptHash &&
      hashes[file].fileHash === fileHash
    ) {
      return true;
    }

    if (hashes[file][promptHash] === fileHash) {
      return true;
    }

    return false;
  }

  return true;
}

export async function saveAllFileHashes(files: string[], promptHash: string) {
  const hashes = await getHashes();

  for (const file of files) {
    const fileContent = await convertToText(file);
    const fileHash = crypto.createHash("md5").update(fileContent).digest("hex");

    if (!hashes[file]) {
      hashes[file] = {
        fileHash,
        promptHash,
      };
    }
    hashes[file][promptHash] = fileHash;
  }

  await saveHashes(hashes);
}

const UPLOAD_KEY = "upload";

/**
 * Returns true if the file has changed since the last successful upload
 * (or if it has never been uploaded before)
 */
export async function hasFileChangedSinceUpload(
  localPath: string,
  hashes: any
): Promise<boolean> {
  if (!fs.existsSync(localPath)) return true;
  const content = fs.readFileSync(localPath);
  const currentHash = crypto.createHash("md5").update(content).digest("hex");
  return hashes[localPath]?.[UPLOAD_KEY] !== currentHash;
}

/**
 * Saves the hash of the file at the time of a successful upload
 */
export async function saveUploadHash(localPath: string) {
  const hashes = await getHashes();
  const content = fs.readFileSync(localPath);
  const currentHash = crypto.createHash("md5").update(content).digest("hex");
  if (!hashes[localPath]) {
    hashes[localPath] = { fileHash: currentHash, promptHash: "" };
  }
  hashes[localPath][UPLOAD_KEY] = currentHash;
  await saveHashes(hashes);
}

/**
 * Compute SHA-256 of a local file, returned as base64 (matches S3 encoding)
 */
export function computeSHA256Base64(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("base64");
}

/**
 * Returns true if the local file's SHA-256 matches the remote checksum,
 * meaning the file is up-to-date and download can be skipped.
 */
export function isLocalFileMatchingRemote(
  localPath: string,
  remoteChecksumSHA256: string | null
): boolean {
  if (!remoteChecksumSHA256) return false;
  if (!fs.existsSync(localPath)) return false;
  const localChecksum = computeSHA256Base64(localPath);
  return localChecksum === remoteChecksumSHA256;
}
