// ComputerService whose screen is a saved screenshot (for repeatable evals).
const cu = require("path").resolve(__dirname, "../../../../../knowhow-module-computer-use/ts_build");
const { ComputerService } = require(cu + "/ComputerService");
const { RustCoreDriver } = require(cu + "/drivers/RustCoreDriver");
const sharp = require("sharp");
module.exports = async (png, desk) => {
  const s = new ComputerService(); const r = RustCoreDriver.tryLoad(); if (r) s.registerDriver(r);
  const d = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const full = { __raw: true, width: d.info.width, height: d.info.height, data: d.data };
  const sx = full.width / desk.width, sy = full.height / desk.height;
  s.getDisplays = async () => [{ id: 1, bounds: desk, scaleFactor: sx, primary: true }];
  s.getActiveWindow = async () => ({ bounds: desk, title: "snapshot", app: "Google Chrome" });
  s.grabRawFrame = async (_id, region) => {
    if (!region) return { raw: full, desktop: desk, scaleX: sx, scaleY: sy };
    const c = s.cropFrame(full, region, desk, sx, sy);
    return { raw: { __raw: true, ...c.frame }, desktop: region, scaleX: c.frame.width / region.width, scaleY: c.frame.height / region.height };
  };
  return s;
};
