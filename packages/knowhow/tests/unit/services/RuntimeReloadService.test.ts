import { RuntimeReloadService } from "../../../src/services/RuntimeReloadService";

describe("RuntimeReloadService", () => {
  it("reports when reload has not been configured", async () => {
    await expect(new RuntimeReloadService().reload()).rejects.toThrow(
      "Runtime reload is unavailable"
    );
  });

  it("coalesces concurrent reload requests", async () => {
    const service = new RuntimeReloadService();
    let resolve!: (value: { tools: number; mcps: number; modules: number }) => void;
    const result = { tools: 2, mcps: 1, modules: 3 };
    const handler = jest.fn()
      .mockImplementationOnce(() => new Promise<typeof result>((done) => (resolve = done)))
      .mockResolvedValue(result);
    service.configure(handler);

    const first = service.reload();
    const second = service.reload();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    resolve(result);
    await expect(first).resolves.toEqual(result);
    await service.reload();
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
