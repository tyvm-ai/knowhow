const mockClient: any = {
  listClientWorkersRaw: jest.fn(),
  callClientWorkerTool: jest.fn(),
};

jest.mock("../../src/services/KnowhowClient", () => ({
  KnowhowSimpleClient: class {
    constructor() {
      return mockClient;
    }
  },
}));

import {
  listClientWorkers,
  pickClientWorker,
  callClientTool,
  parseToolArgs,
  formatClientWorkerTable,
} from "../../src/services/ClientWorkerTools";

const tool = (name: string, tier = "read") => ({ name, description: `${name} d\nmore`, tier });

function w(over: any) {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000000",
    clientKind: "mobile",
    connected: true,
    lastConnected: "2026-01-01T00:00:00Z",
    userAgent: "knowhow-mobile",
    tools: [] as any[],
    ...over,
  };
}

const MOBILE_OLD = w({ id: "11111111-0000-0000-0000-000000000000", tools: [tool("browser_list_tabs")] });
const MOBILE_NEW = w({
  id: "22222222-0000-0000-0000-000000000000",
  lastConnected: "2026-01-02T00:00:00Z",
  tools: [tool("browser_list_tabs"), tool("script_tools_list")],
});
const MOBILE_GHOST = w({
  id: "33333333-0000-0000-0000-000000000000",
  connected: false,
  lastConnected: "2026-01-03T00:00:00Z",
  tools: [tool("script_tools_list")],
});
const COMPANION = w({
  id: "44444444-0000-0000-0000-000000000000",
  clientKind: "phone-companion",
  userAgent: "companion/1.0",
  tools: [tool("phone_get_status")],
});
const ALL = [MOBILE_OLD, MOBILE_NEW, MOBILE_GHOST, COMPANION];

beforeEach(() => jest.resetAllMocks());

describe("listClientWorkers", () => {
  it("hits listClientWorkersRaw, drops offline by default and filters by kind", async () => {
    mockClient.listClientWorkersRaw.mockResolvedValue({ data: ALL });
    const r = await listClientWorkers(mockClient, { kind: "Mobile" });
    expect(mockClient.listClientWorkersRaw).toHaveBeenCalledWith(true);
    expect(r.map((x) => x.id.slice(0, 2))).toEqual(["11", "22"]);
    const all = await listClientWorkers(mockClient, { all: true });
    expect(all).toHaveLength(4);
  });
});

describe("pickClientWorker", () => {
  it("picks the most recently connected worker of a kind that offers the tool", () => {
    expect(pickClientWorker(ALL, { ref: "mobile", tool: "script_tools_list" }).id).toBe(MOBILE_NEW.id);
    expect(pickClientWorker(ALL, { ref: "mobile", tool: "browser_list_tabs" }).id).toBe(MOBILE_NEW.id);
  });

  it("matches ids by full id and by prefix", () => {
    expect(pickClientWorker(ALL, { ref: MOBILE_OLD.id }).id).toBe(MOBILE_OLD.id);
    expect(pickClientWorker(ALL, { ref: "4444" }).id).toBe(COMPANION.id);
  });

  it("matches user-agent substrings", () => {
    expect(pickClientWorker(ALL, { ref: "companion/1" }).id).toBe(COMPANION.id);
  });

  it("refuses offline workers", () => {
    expect(() => pickClientWorker(ALL, { ref: MOBILE_GHOST.id })).toThrow(/not connected/);
  });

  it("explains when no matching worker offers the tool", () => {
    expect(() => pickClientWorker(ALL, { ref: "phone-companion", tool: "nope" })).toThrow(/offers tool 'nope'/);
  });

  it("falls back to a worker whose tools/list failed when none positively offers the tool", () => {
    const flaky = w({ id: "66666666-0000-0000-0000-000000000000", tools: undefined, toolsError: "timeout" });
    expect(pickClientWorker([flaky, MOBILE_OLD], { ref: "mobile", tool: "script_tools_list" }).id).toBe(flaky.id);
    expect(pickClientWorker([flaky, MOBILE_NEW], { ref: "mobile", tool: "script_tools_list" }).id).toBe(MOBILE_NEW.id);
  });

  it("errors for an unknown ref", () => {
    expect(() => pickClientWorker(ALL, { ref: "zzzz-none" })).toThrow(/No client worker matches/);
  });

  it("without a ref picks the unique worker kind offering the tool", () => {
    expect(pickClientWorker(ALL, { tool: "phone_get_status" }).id).toBe(COMPANION.id);
    expect(pickClientWorker(ALL, { tool: "script_tools_list" }).id).toBe(MOBILE_NEW.id);
  });

  it("without a ref is ambiguous across kinds", () => {
    const both = [MOBILE_NEW, w({ id: "55555555-0000-0000-0000-000000000000", clientKind: "browser", tools: [tool("browser_list_tabs")] })];
    expect(() => pickClientWorker(both, { tool: "browser_list_tabs" })).toThrow(/several kinds/);
    expect(pickClientWorker(both, { tool: "browser_list_tabs", kind: "browser" }).clientKind).toBe("browser");
  });
});

describe("parseToolArgs", () => {
  it("defaults to {} and parses objects", () => {
    expect(parseToolArgs(undefined)).toEqual({});
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 });
  });
  it("rejects non-objects and invalid JSON", () => {
    expect(() => parseToolArgs("[1]")).toThrow(/JSON object/);
    expect(() => parseToolArgs("{nope")).toThrow(/JSON object/);
  });
});

describe("callClientTool", () => {
  beforeEach(() => {
    mockClient.listClientWorkersRaw.mockResolvedValue({ data: ALL });
  });

  it("calls the chosen worker and returns the backend result", async () => {
    mockClient.callClientWorkerTool.mockResolvedValue({ data: { status: "ok", rawText: "hi" } });
    const out = await callClientTool(mockClient, {
      worker: "mobile",
      tool: "script_tools_list",
      args: { a: 1 },
      timeoutMs: 5000,
    });
    expect(mockClient.callClientWorkerTool).toHaveBeenCalledWith({
      workerId: MOBILE_NEW.id,
      tool: "script_tools_list",
      arguments: { a: 1 },
      timeoutMs: 5000,
    });
    expect(out).toMatchObject({ workerId: MOBILE_NEW.id, clientKind: "mobile", result: { status: "ok", rawText: "hi" } });
  });

  it("passes an explicit approvalId and a full worker id even if it does not list the tool", async () => {
    mockClient.callClientWorkerTool.mockResolvedValue({ data: { status: "ok" } });
    await callClientTool(mockClient, { worker: COMPANION.id, tool: "phone_tap", approvalId: "ap1" });
    expect(mockClient.callClientWorkerTool.mock.calls[0][0]).toMatchObject({
      workerId: COMPANION.id,
      approvalId: "ap1",
    });
  });

  it("returns approval_pending without polling by default", async () => {
    mockClient.callClientWorkerTool.mockResolvedValue({
      data: { status: "approval_pending", approval: { approvalId: "ap9" } },
    });
    const seen = jest.fn();
    const out = await callClientTool(mockClient, {
      worker: "mobile",
      tool: "browser_list_tabs",
      onApprovalPending: seen,
    });
    expect(out.result.status).toBe("approval_pending");
    expect(seen).toHaveBeenCalledTimes(1);
    expect(mockClient.callClientWorkerTool).toHaveBeenCalledTimes(1);
  });

  it("--wait-approval retries with the approvalId until approved", async () => {
    mockClient.callClientWorkerTool
      .mockResolvedValueOnce({ data: { status: "approval_pending", approval: { approvalId: "ap9" } } })
      .mockResolvedValueOnce({ data: { status: "approval_pending", approval: { approvalId: "ap9" } } })
      .mockResolvedValueOnce({ data: { status: "ok", rawText: "done" } });
    const sleep = jest.fn().mockResolvedValue(undefined);
    const out = await callClientTool(mockClient, {
      worker: "mobile",
      tool: "browser_list_tabs",
      waitApproval: true,
      pollIntervalMs: 10,
      sleep,
    });
    expect(out.result).toMatchObject({ status: "ok", rawText: "done" });
    expect(mockClient.callClientWorkerTool.mock.calls[0][0].approvalId).toBeUndefined();
    expect(mockClient.callClientWorkerTool.mock.calls[1][0].approvalId).toBe("ap9");
    expect(mockClient.callClientWorkerTool.mock.calls[2][0].approvalId).toBe("ap9");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("--wait-approval gives up after the deadline and reports approval_pending", async () => {
    mockClient.callClientWorkerTool.mockResolvedValue({
      data: { status: "approval_pending", approval: { approvalId: "ap9" } },
    });
    const out = await callClientTool(mockClient, {
      worker: "mobile",
      tool: "browser_list_tabs",
      waitApproval: true,
      approvalTimeoutMs: 0,
      sleep: jest.fn().mockResolvedValue(undefined),
    });
    expect(out.result.status).toBe("approval_pending");
    expect(mockClient.callClientWorkerTool).toHaveBeenCalledTimes(1);
  });
});

describe("formatClientWorkerTable", () => {
  it("lists workers and, with tools, each tool with its tier", () => {
    const text = formatClientWorkerTable([MOBILE_NEW], true);
    expect(text).toContain(MOBILE_NEW.id);
    expect(text).toContain("2 tools");
    expect(text).toContain("script_tools_list [read]  — script_tools_list d");
    expect(formatClientWorkerTable([MOBILE_NEW], false)).not.toContain("script_tools_list");
  });
});
