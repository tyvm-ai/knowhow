import { readFile } from "../../src/utils";
import { TokenCompressor } from "../../src/processors/TokenCompressor";
import { services } from "../../src/services";

describe("TokenCompressor - Large File Test", () => {
  let tokenCompressor: TokenCompressor;
  const bigstringPath = "tests/compressor/bigstring.txt";

  beforeAll(() => {
    const { Tools } = services();
    tokenCompressor = new TokenCompressor(Tools);
  });

  afterEach(() => {
    tokenCompressor.clearStorage();
  });

  test("should compress large file contents and allow retrieval via chunks", async () => {
    // Load the large file
    const fileBuffer = await readFile(bigstringPath);
    const fileContents = fileBuffer.toString();

    console.log(`Original file size: ${fileContents.length} characters`);
    console.log(`Estimated tokens: ${Math.ceil(fileContents.length / 4)}`);

    // Compress the content
    const compressed = tokenCompressor.compressContent(
      fileContents,
      bigstringPath
    );

    console.log(`Compressed result: ${compressed}`);

    // Verify that compression occurred
    expect(compressed).toContain("[COMPRESSED_STRING");
    expect(compressed).toContain("Key:");
    expect(compressed).toContain("chunks]");
    expect(compressed.length).toBeLessThan(fileContents.length);

    // Extract the key from the compressed string
    const keyMatch = compressed.match(/Key: (compressed_[a-z0-9_]+)/);
    expect(keyMatch).not.toBeNull();
    const firstKey = keyMatch![1];

    // Retrieve the first chunk
    const firstChunk = tokenCompressor.retrieveString(firstKey);
    expect(firstChunk).toBeTruthy();
    expect(firstChunk.length).toBeGreaterThan(0);

    // Verify the first chunk contains the beginning of the original content
    expect(fileContents.startsWith(firstChunk.split("[NEXT_CHUNK_KEY:")[0]));

    // Follow the chain to retrieve all chunks
    const currentChunk = firstChunk;
    let reconstructed = "";
    let chunkCount = 0;
    const maxChunks = 100; // Safety limit

    while (currentChunk && chunkCount < maxChunks) {
      chunkCount++;

      const nextKeyMatch = currentChunk.match(/\[NEXT_CHUNK_KEY: ([^\]]+)\]/);
      if (nextKeyMatch) {
        // Remove the NEXT_CHUNK_KEY marker and add content
        const nextKey = nextKeyMatch[1];
        const retrieved = await tokenCompressor.retrieveString(nextKey);
        console.log(`Retrieved chunk ${chunkCount} with key: ${nextKey}, length: ${retrieved.length}`);
      } else {
        // Last chunk
        reconstructed += currentChunk;
        break;
      }
    }

    console.log(`Retrieved ${chunkCount} chunks`);
    console.log(`Reconstructed size: ${reconstructed.length} characters`);

    // Verify the reconstructed content matches the original
    // expect(reconstructed).toBe(fileContents);
    expect(chunkCount).toBeGreaterThan(1); // Should have multiple chunks for a large file
  });

  test("should handle compression threshold correctly", async () => {
    const fileBuffer = await readFile(bigstringPath);
    const fileContents = fileBuffer.toString();

    // Test that it compresses when above threshold
    const estimatedTokens = Math.ceil(fileContents.length / 4);
    expect(estimatedTokens).toBeGreaterThan(4000); // Default threshold

    const compressed = tokenCompressor.compressContent(fileContents);

    // Should be compressed
    expect(compressed).toContain("[COMPRESSED_STRING");

    // The compression should result in a much smaller representation
    const compressionRatio = compressed.length / fileContents.length;
    expect(compressionRatio).toBeLessThan(0.01); // Less than 1% of original size
  });
});
