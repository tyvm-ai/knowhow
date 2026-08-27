import crypto from "crypto";

export function randomId(bytes: number = 16): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function getBootId(): string {
  // single process bootId: stable for this module instance
  return randomId(16);
}
