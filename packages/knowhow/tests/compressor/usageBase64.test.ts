import { readFile } from "../../src/utils";
import { TokenCompressor } from "../../src/processors/TokenCompressor";
import { services } from "../../src/services";
import { Message } from "../../src/clients/types";

/**
 * Regression test reproducing the crash the user hit when an agent called
 * readFile on a large usage.json full of base64 image_url data URLs.
 *
 * The expectation from the user was:
 *   - JSON compression should ideally kick in, OR
 *   - at the very least string/chunk compression should occur,
 * so that the ~365k-token file does NOT reach the model uncompressed
 * (which blows the context window: "prompt is too long: 1318761 tokens").
 *
 * This test loads the actual captured usage.json fixture and asserts the
 * compressor materially shrinks it.
 */
describe("TokenCompressor - usage.json with base64 images", () => {
  let tokenCompressor: TokenCompressor;
  const usagePath = "tests/compressor/usageBase64.json";

  beforeAll(() => {
    const { Tools } = services();
    tokenCompressor = new TokenCompressor(Tools);
  });

  afterEach(() => {
    tokenCompressor.clearStorage();
  });

  test("fixture is large enough to require compression", async () => {
    const fileContents = (await readFile(usagePath)).toString();
    const estimatedTokens = Math.ceil(fileContents.length / 4);
    console.log(
      `usage.json size: ${fileContents.length} chars (~${estimatedTokens} tokens)`
    );
    expect(estimatedTokens).toBeGreaterThan(4000);
  });

  test("compressContent should materially shrink the file (not leave it raw)", async () => {
    const fileContents = (await readFile(usagePath)).toString();
    const originalLen = fileContents.length;

    const start = Date.now();
    const compressed = tokenCompressor.compressContent(fileContents, usagePath);
    const elapsed = Date.now() - start;

    console.log(`compressContent took ${elapsed}ms`);
    console.log(`original: ${originalLen} chars`);
    console.log(`compressed: ${compressed.length} chars`);
    console.log(
      `ratio: ${((compressed.length / originalLen) * 100).toFixed(2)}%`
    );
    console.log(`compressed preview:\n${compressed.substring(0, 400)}`);

    // The core assertion: SOME compression must occur. Whether it's JSON
    // compression or string chunking, the surfaced result must be a small
    // fraction of the original so it doesn't blow the context window.
    expect(compressed.length).toBeLessThan(originalLen * 0.5);

    // The estimated tokens of what actually reaches the model must be small.
    const surfacedTokens = Math.ceil(compressed.length / 4);
    console.log(`surfaced tokens: ${surfacedTokens}`);
    expect(surfacedTokens).toBeLessThan(50000);
  });

  test("compressMessage on a tool message shrinks the base64 payload", async () => {
    const fileContents = (await readFile(usagePath)).toString();

    // Simulate what actually happens: readFile's output becomes a tool message
    // content string, which the TokenCompressor processor compresses.
    const toolMessage: Message = {
      role: "tool",
      tool_call_id: "call_readfile_usage",
      name: "readFile",
      content: fileContents,
    };

    await tokenCompressor.compressMessage(toolMessage);

    const resultContent = toolMessage.content as string;
    console.log(`tool message content after compress: ${resultContent.length} chars`);
    console.log(`preview:\n${resultContent.substring(0, 300)}`);

    expect(typeof resultContent).toBe("string");
    expect(resultContent.length).toBeLessThan(fileContents.length * 0.5);
  });

  test("createProcessor compresses a fresh readFile tool response batch", async () => {
    const fileContents = (await readFile(usagePath)).toString();

    const messages: Message[] = [
      { role: "user", content: "read the usage file" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_readfile_usage",
            type: "function",
            function: { name: "readFile", arguments: "{}" },
          },
        ],
      } as Message,
      {
        role: "tool",
        tool_call_id: "call_readfile_usage",
        name: "readFile",
        content: fileContents,
      },
    ];

    const processor = tokenCompressor.createProcessor();
    // processor mutates the second array in place
    const modified = messages.map((m) => ({ ...m }));
    await processor(messages, modified);

    const toolMsg = modified[2];
    const toolContent = toolMsg.content as string;
    console.log(
      `processor result tool content: ${toolContent.length} chars (orig ${fileContents.length})`
    );
    console.log(`preview:\n${toolContent.substring(0, 300)}`);

    expect(toolContent.length).toBeLessThan(fileContents.length * 0.5);
  });

  /**
   * The readFile(usage.json) path compresses fine (proven above). The ACTUAL
   * mechanism that blows the context window ("prompt is too long: 1318761
   * tokens") is accumulated base64 SCREENSHOTS carried as multimodal
   * `image_url` content parts. `compressMessage` only compresses `text` parts
   * of array content and leaves `image_url` data URLs completely untouched, so
   * every screenshot the computer-use agent takes stays full-size in history.
   *
   * This test documents that gap. It is expected to FAIL until image_url
   * parts are handled (e.g. offloaded/compressed) by the message processor.
   */
  test("multimodal image_url base64 parts are NOT compressed (documents the context-blowup gap)", async () => {
    // Build a realistic base64 screenshot payload (~1.4MB like a real 4K jpeg).
    const bigBase64 = "/9j/2wBDAAYEBQYFBAYGBQYH" + "A".repeat(1_400_000);
    const dataUrl = `data:image/jpeg;base64,${bigBase64}`;

    const imageMessage: Message = {
      role: "tool",
      tool_call_id: "call_screenshot",
      name: "screenshot",
      content: [
        { type: "text", text: "screenshot captured" },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    } as unknown as Message;

    const beforeLen = JSON.stringify(imageMessage.content).length;
    await tokenCompressor.compressMessage(imageMessage);
    const afterLen = JSON.stringify(imageMessage.content).length;

    const parts = imageMessage.content as any[];
    const imagePart = parts.find((p) => p.type === "image_url");

    console.log(`multimodal content before: ${beforeLen} chars`);
    console.log(`multimodal content after:  ${afterLen} chars`);
    console.log(
      `image_url still base64? ${imagePart.image_url.url.startsWith("data:image")}`
    );
    console.log(`image_url length: ${imagePart.image_url.url.length}`);

    // CURRENT BEHAVIOR (the bug): the image_url payload passes through
    // untouched, so N accumulated screenshots => context-window overflow.
    // Flip these expectations once image handling is added to the processor.
    expect(imagePart.image_url.url.startsWith("data:image")).toBe(true);
    expect(afterLen).toBeGreaterThan(beforeLen * 0.9);
  });
});
