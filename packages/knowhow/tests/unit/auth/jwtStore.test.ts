import fs from "fs";
import os from "os";
import path from "path";
import {
  getJwtFileName,
  loadJwtFromDisk,
  storeJwtForApi,
} from "../../../src/auth/jwtStore";

describe("environment-specific JWT storage", () => {
  const originalCwd = process.cwd();
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowhow-jwt-store-"));
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("uses readable names for production, development, and local APIs", () => {
    expect(getJwtFileName("https://api.knowhow.tyvm.ai")).toBe(".jwt");
    expect(getJwtFileName("https://api.dev.knowhow.tyvm.ai")).toBe(".jwt.dev");
    expect(getJwtFileName("http://localhost:4000")).toBe(".jwt.local");
  });

  it("keeps tokens for each API environment independent", () => {
    storeJwtForApi("prod-token", "https://api.knowhow.tyvm.ai");
    storeJwtForApi("dev-token", "https://api.dev.knowhow.tyvm.ai");
    storeJwtForApi("local-token", "http://localhost:4000");

    expect(loadJwtFromDisk("https://api.knowhow.tyvm.ai")).toBe("prod-token");
    expect(loadJwtFromDisk("https://api.dev.knowhow.tyvm.ai")).toBe("dev-token");
    expect(loadJwtFromDisk("http://localhost:4000")).toBe("local-token");
    expect(fs.statSync(path.join(workDir, ".knowhow", ".jwt.dev")).mode & 0o777).toBe(0o600);
  });

  it("does not send the legacy production token to another environment", () => {
    const configDir = path.join(workDir, ".knowhow");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, ".jwt"), "production-token");

    expect(loadJwtFromDisk("https://api.dev.knowhow.tyvm.ai")).toBe("");
    expect(loadJwtFromDisk("https://api.knowhow.tyvm.ai")).toBe("production-token");
  });

  it("uses a host-specific file for additional Knowhow instances", () => {
    expect(getJwtFileName("https://api.staging.example.com:8443")).toBe(
      ".jwt.api.staging.example.com-8443"
    );
  });
});
