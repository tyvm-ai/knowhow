import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import resolverModule from "../ts_build/resolver.js";
import moduleEntry from "../ts_build/index.js";

const { VideoUrlResolver } = resolverModule;
const videoDownloaderModule = moduleEntry.default ?? moduleEntry;

test("VideoUrlResolver recognizes URLs and resolves downloads to a local path", async () => {
  const calls = [];
  const downloader = {
    async download(url, outputDir) {
      calls.push({ url, outputDir });
      return { id: "video-id", ext: "webm" };
    },
  };
  const outputDir = path.resolve(".tmp-video-resolver");
  const resolver = new VideoUrlResolver(downloader, outputDir);

  assert.equal(resolver.canHandle("https://www.youtube.com/watch?v=abc"), true);
  assert.equal(resolver.canHandle("./local-video.mp4"), false);
  assert.equal(
    await resolver.resolvePath("https://www.youtube.com/watch?v=abc"),
    path.join(outputDir, "video-id.webm")
  );
  assert.deepEqual(calls, [
    { url: "https://www.youtube.com/watch?v=abc", outputDir },
  ]);
});

test("the module registers its video URL resolver during init", async () => {
  let registered;
  await videoDownloaderModule.init({
    config: {},
    cwd: process.cwd(),
    context: {
      Conversion: {
        registerResolver(resolver) {
          registered = resolver;
        },
      },
    },
  });

  assert.equal(registered?.name, "video-url");
});
