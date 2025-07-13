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
