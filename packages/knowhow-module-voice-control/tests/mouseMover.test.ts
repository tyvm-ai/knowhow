import { mouseMoverFromComputerService } from "../src/commandMode";

describe("mouseMoverFromComputerService", () => {
  it("passes a Point to ComputerService.moveMouse and clicks via click()", async () => {
    const svc = { moveMouse: jest.fn(async () => undefined), click: jest.fn(async () => undefined) };
    const mover = mouseMoverFromComputerService(svc);
    await mover.moveMouse(5000, 800);
    expect(svc.moveMouse).toHaveBeenLastCalledWith({ x: 5000, y: 800 });
    await mover.clickAt(10, 20, "right");
    expect(svc.moveMouse).toHaveBeenLastCalledWith({ x: 10, y: 20 });
    expect(svc.click).toHaveBeenLastCalledWith("right");
    await mover.doubleClickAt(1, 2);
    expect(svc.click).toHaveBeenLastCalledWith("left", { double: true });
  });

  it("never moves to non-finite coordinates (which macOS resolves to the top-left corner)", async () => {
    const svc = { moveMouse: jest.fn(async () => undefined), click: jest.fn(async () => undefined) };
    const mover = mouseMoverFromComputerService(svc);
    await mover.moveMouse(NaN, 5);
    await mover.clickAt(undefined as unknown as number, 5);
    expect(svc.moveMouse).not.toHaveBeenCalled();
    expect(svc.click).not.toHaveBeenCalled();
  });
});
