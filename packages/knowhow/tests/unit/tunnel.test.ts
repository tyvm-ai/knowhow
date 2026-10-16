import { extractTunnelDomain } from "../../src/tunnel";

describe("extractTunnelDomain", () => {
  const originalTunnelWorkerDomain = process.env.TUNNEL_WORKER_DOMAIN;

  beforeEach(() => {
    delete process.env.TUNNEL_WORKER_DOMAIN;
  });

  afterAll(() => {
    if (originalTunnelWorkerDomain === undefined) {
      delete process.env.TUNNEL_WORKER_DOMAIN;
    } else {
      process.env.TUNNEL_WORKER_DOMAIN = originalTunnelWorkerDomain;
    }
  });

  it("uses the local tunnel proxy for a localhost API URL", () => {
    expect(extractTunnelDomain("http://localhost:4000")).toEqual({
      domain: "worker.localhost:4000",
      useHttps: false,
    });
  });

  it("uses the local tunnel proxy for loopback API URLs", () => {
    expect(extractTunnelDomain("http://127.0.0.1:4000")).toEqual({
      domain: "worker.localhost:4000",
      useHttps: false,
    });
  });

  it("continues to select dev and production tunnel domains", () => {
    expect(extractTunnelDomain("https://api.dev.knowhow.tyvm.ai")).toEqual({
      domain: "worker.dev.tyvm-apps.com",
      useHttps: true,
    });
    expect(extractTunnelDomain("https://api.knowhow.tyvm.ai")).toEqual({
      domain: "worker.tyvm-apps.com",
      useHttps: true,
    });
  });

  it("allows an explicit tunnel domain to override localhost detection", () => {
    process.env.TUNNEL_WORKER_DOMAIN = "worker.override.example";

    expect(extractTunnelDomain("http://localhost:4000")).toEqual({
      domain: "worker.override.example",
      useHttps: false,
    });
  });
});
