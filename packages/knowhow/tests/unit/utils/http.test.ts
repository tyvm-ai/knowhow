import http, { HTTP_UNAUTHORIZED_HANDLER, RefreshableHeaders } from "../../../src/utils/http";

describe("HTTP unauthorized renewal", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("renews and retries a 401 once with the updated headers", async () => {
    const headers: RefreshableHeaders = { Authorization: "Bearer old" };
    const renew = jest.fn(async () => {
      headers.Authorization = "Bearer new";
    });
    Object.defineProperty(headers, HTTP_UNAUTHORIZED_HANDLER, { value: renew });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(http.get("https://example.test", { headers })).resolves.toMatchObject({
      data: { ok: true },
    });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://example.test",
      expect.objectContaining({ headers: { Authorization: "Bearer new" } })
    );
  });

  it("does not renew or retry a second 401", async () => {
    const headers: RefreshableHeaders = { Authorization: "Bearer old" };
    const renew = jest.fn(async () => undefined);
    Object.defineProperty(headers, HTTP_UNAUTHORIZED_HANDLER, { value: renew });
    global.fetch = jest.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));

    await expect(http.get("https://example.test", { headers })).rejects.toMatchObject({ status: 401 });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
