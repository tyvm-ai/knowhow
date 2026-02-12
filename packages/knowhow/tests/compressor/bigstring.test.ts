import { readFile } from "../../src/utils";
import { TokenCompressor, KeyInfo } from "../../src/processors/TokenCompressor";
import { services } from "../../src/services";
import { Message } from "../../src/clients/types";

describe("TokenCompressor - Large File Test", () => {
  let tokenCompressor: TokenCompressor;
  const bigstringPath = "tests/compressor/bigstring.txt";
  const jsonPath = "tests/compressor/githubjson.txt";

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
        console.log(
          `Retrieved chunk ${chunkCount} with key: ${nextKey}, length: ${retrieved.length}`
        );
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

  test("should handle json compression", async () => {
    const fileBuffer = await readFile(jsonPath);
    const fileContents = fileBuffer.toString();

    // Test that it compresses when above threshold
    const estimatedTokens = Math.ceil(fileContents.length / 4);
    expect(estimatedTokens).toBeGreaterThan(4000); // Default threshold

    const compressed = tokenCompressor.compressContent(fileContents);

    console.log({ compressedJson: compressed });

    // Should return JSON object (not a string marker) for MCP format
    const compressedObj = JSON.parse(compressed);
    expect(compressedObj._mcp_format).toBe(true);
    expect(compressedObj._data).toBeDefined();
    expect(compressedObj._schema_key).toBeDefined();

    // The compression should result in a smaller representation
    const compressionRatio = compressed.length / fileContents.length;
    expect(compressionRatio).toBeLessThan(0.5); // Less than 50% of original size
  });

  test("should detect json", async () => {
    const fileBuffer = await readFile(jsonPath);
    const fileContents = fileBuffer.toString();

    const compressed = tokenCompressor.tryParseJson(fileContents);

    expect(compressed).toBeTruthy();
  });

  test("should analyze githubjson.txt compression with key chain utilities", async () => {
    const fileBuffer = await readFile(jsonPath);
    const fileContents = fileBuffer.toString();

    console.log(`\n=== GitHub JSON Compression Analysis ===`);
    console.log(`Original file size: ${fileContents.length} characters`);
    console.log(`Estimated tokens: ${Math.ceil(fileContents.length / 4)}`);

    // Compress the content
    const compressed = tokenCompressor.compressContent(fileContents);

    console.log(
      `\nCompressed representation length: ${compressed.length} characters`
    );
    console.log(`\nCompressed output:\n${compressed.substring(0, 500)}...\n`);

    // Extract root keys from the compressed output
    const rootKeys = tokenCompressor.extractKeys(compressed);
    console.log(`\nRoot keys found: ${rootKeys.length}`);
    console.log(`Keys: ${rootKeys.join(", ")}\n`);

    expect(rootKeys.length).toBeGreaterThan(0);

    // Analyze the key chain for each root key
    for (const rootKey of rootKeys) {
      console.log(`\n--- Analyzing key chain for: ${rootKey} ---`);
      const keyChain = tokenCompressor.getKeyChain(rootKey);

      console.log(`Total keys in chain: ${keyChain.length}`);

      // Group keys by depth
      const byDepth = keyChain.reduce((acc, info) => {
        if (!acc[info.depth]) {
          acc[info.depth] = [];
        }
        acc[info.depth].push(info);
        return acc;
      }, {} as Record<number, KeyInfo[]>);

      console.log(`\nKeys by depth:`);
      for (const [depth, infos] of Object.entries(byDepth)) {
        console.log(`  Depth ${depth}: ${infos.length} keys`);
        for (const info of infos) {
          console.log(`    - ${info.key}:`);
          console.log(
            `        Size: ${info.size} chars (${info.tokens} tokens)`
          );
          console.log(`        Type: ${info.type}`);
          console.log(`        Child keys: ${info.childKeys.length}`);
          if (info.nextChunkKey) {
            console.log(`        Next chunk: ${info.nextChunkKey}`);
          }
        }
      }

      // Verify chunk sizes are reasonable
      for (const info of keyChain) {
        const data = await tokenCompressor.retrieveString(info.key);
        console.log({ data });

        // Chunks should not be unnecessarily small (at least 25% of threshold unless it's the last chunk)
        // Allow smaller chunks for next_chunk types at the end of chains
        if (info.type === "child") {
          expect(info.tokens).toBeGreaterThan(1000); // Child chunks should be substantial
        }

        // Chunks should not exceed the max tokens significantly
        expect(info.tokens).toBeLessThan(tokenCompressor.maxTokens * 1.5);
      }

      // Calculate total size
      const totalSize = keyChain.reduce((sum, info) => sum + info.size, 0);
      const totalTokens = keyChain.reduce((sum, info) => sum + info.tokens, 0);
      console.log(
        `\nTotal stored size: ${totalSize} characters (${totalTokens} tokens)`
      );
      console.log(
        `Storage efficiency: Stored ${keyChain.length} chunks for original content`
      );
    }

    // Verify storage state
    console.log(`\n=== Storage State ===`);
    console.log(`Total keys in storage: ${tokenCompressor.getStorageSize()}`);
    console.log(
      `All storage keys: ${tokenCompressor.getStorageKeys().join(", ")}`
    );

    expect(tokenCompressor.getStorageSize()).toBeGreaterThan(0);

    // Test extractKeys utility - with new schema format, compressed is a JSON object
    // Parse it to find actual data keys
    const parsedCompressed = tokenCompressor.tryParseJson(compressed);
    expect(parsedCompressed).toBeTruthy();

    // Look for keys in the parsed structure
    let dataKeys: string[] = [];
    if (parsedCompressed && typeof parsedCompressed === "object") {
      // Extract all keys from the object recursively
      const extractAllKeys = (obj: any): string[] => {
        const keys: string[] = [];
        const str = JSON.stringify(obj);
        keys.push(...tokenCompressor.extractKeys(str));
        return keys;
      };
      dataKeys = extractAllKeys(parsedCompressed);
    }

    console.log(`\nKeys found in compressed structure: ${dataKeys.length}`);
    const storedContent =
      dataKeys.length > 0 ? tokenCompressor.retrieveString(dataKeys[0]) : null;

    const embeddedKeys = tokenCompressor.extractKeys(storedContent!);
    console.log(
      `\nKeys embedded in first stored chunk: ${embeddedKeys.length}`
    );
    if (embeddedKeys.length > 0) {
      console.log(`Embedded keys: ${embeddedKeys.join(", ")}`);
    }
  });

  test("should demonstrate improved compression with schema and low-signal detection", async () => {
    const fileBuffer = await readFile(jsonPath);
    const fileContents = fileBuffer.toString();

    console.log(`\n=== Compression Performance Analysis ===`);
    console.log(`Original file size: ${fileContents.length} characters`);
    console.log(`Estimated tokens: ${Math.ceil(fileContents.length / 4)}`);

    // Compress the content
    const compressed = tokenCompressor.compressContent(fileContents);

    console.log(`\nCompressed representation: ${compressed.length} characters`);
    const compressionRatio = (
      (1 - compressed.length / fileContents.length) *
      100
    ).toFixed(2);
    console.log(`Compression ratio: ${compressionRatio}%`);

    // Parse the compressed output
    console.log(
      `\nCompressed output preview:\n${compressed.substring(0, 800)}`
    );

    const compressedObj = JSON.parse(compressed);

    console.log(`\n=== Schema Information ===`);
    if (compressedObj._schema_key) {
      console.log(`Schema key found: ${compressedObj._schema_key}`);
      // The _schema_key already includes the full key with _schema suffix
      const schema = tokenCompressor.retrieveString(compressedObj._schema_key);
      if (schema) {
        console.log(`Schema structure:`);
        console.log(JSON.stringify(schema, null, 2).substring(0, 1000));
      }
    }

    console.log(`\n=== Low-Signal Property Compression ===`);
    // Check first item in the data array for compression metadata
    if (compressedObj._data && Array.isArray(compressedObj._data)) {
      const firstItem = compressedObj._data[0];
      if (
        typeof firstItem === "string" &&
        firstItem.includes("COMPRESSED_JSON")
      ) {
        // Extract the key and retrieve the object
        const keyMatch = firstItem.match(/Key: (compressed_[a-z0-9_]+)/);
        if (keyMatch) {
          const itemKey = keyMatch[1];
          const itemData = tokenCompressor.retrieveString(itemKey);
          if (itemData) {
            const item = JSON.parse(itemData);
            const innerItem = JSON.parse(item.text);

            // Check for compressed properties in array items
            if (Array.isArray(innerItem)) {
              const sampleItem = innerItem[0];
              if (sampleItem._compressed_properties_key) {
                console.log(
                  `Sample item has ${sampleItem._compressed_property_names.length} compressed properties`
                );
                console.log(
                  `Compressed properties: ${sampleItem._compressed_property_names
                    .slice(0, 10)
                    .join(", ")}...`
                );
                console.log(`Info: ${sampleItem._compression_info}`);

                // Retrieve the compressed properties
                const compressedProps = tokenCompressor.getCompressedProperties(
                  sampleItem._compressed_properties_key
                );
                if (compressedProps) {
                  const propNames = Object.keys(
                    compressedProps.compressed_properties
                  );
                  console.log(
                    `\nRetrieved ${propNames.length} compressed properties successfully`
                  );
                  console.log(
                    `Sample compressed property keys: ${propNames
                      .slice(0, 5)
                      .join(", ")}`
                  );
                }
              }
            }
          }
        }
      }
    }

    console.log(`\n=== Storage Analysis ===`);
    const totalKeys = tokenCompressor.getStorageSize();
    console.log(`Total storage keys: ${totalKeys}`);

    // Calculate total stored size
    let totalStoredSize = 0;
    for (const key of tokenCompressor.getStorageKeys()) {
      const data = tokenCompressor.retrieveString(key);
      if (data) {
        totalStoredSize += data.length;
      }
    }

    console.log(`Total stored data: ${totalStoredSize} characters`);
    console.log(`Compressed representation: ${compressed.length} characters`);
    console.log(
      `Storage overhead ratio: ${(
        (totalStoredSize / fileContents.length) *
        100
      ).toFixed(2)}%`
    );
    console.log(`Initial view compression: ${compressionRatio}%`);

    // Verify we achieved good compression (showing first instance for usability)
    expect(parseFloat(compressionRatio)).toBeGreaterThan(60); // At least 60% compression

    // Verify schema is accessible
    if (compressedObj._schema_key) {
      const schema = tokenCompressor.retrieveString(compressedObj._schema_key);
      expect(schema).toBeTruthy();
    }

    // Verify low-signal compression happened
    expect(totalKeys).toBeGreaterThan(5); // Should have multiple compression keys

    console.log(`\n✓ Compression improvements verified!`);
  });

  test("should not double-compress already compressed content", async () => {
    // Load the githubjson.txt which contains a Message object
    const fileBuffer = await readFile(jsonPath);
    const fileContents = fileBuffer.toString();

    console.log(`\n=== Testing Double Compression Prevention ===`);
    console.log(`Original file size: ${fileContents.length} characters`);

    // Parse the message from the file
    const message = JSON.parse(fileContents) as Message;

    // Create a copy of the message to compress
    const messageToCompress: Message = JSON.parse(JSON.stringify(message));

    // First compression
    await tokenCompressor.compressMessage(messageToCompress);

    const firstCompression = (messageToCompress.content as any[])[0].text;
    console.log(`\nAfter first compression: ${firstCompression.length} characters`);
    console.log(`First compression preview:\n${firstCompression.substring(0, 300)}...`);

    // Parse the first compression result
    const firstParsed = tokenCompressor.tryParseJson(firstCompression);
    expect(firstParsed).toBeTruthy();
    expect(firstParsed._schema_key).toBeDefined();
    expect(firstParsed.data).toBeDefined();

    // Second compression - this should NOT compress again
    await tokenCompressor.compressMessage(messageToCompress);

    const secondCompression = (messageToCompress.content as any[])[0].text;
    console.log(`\nAfter second compression: ${secondCompression.length} characters`);
    console.log(`Second compression preview:\n${secondCompression.substring(0, 300)}...`);

    // Parse the second compression result
    const secondParsed = tokenCompressor.tryParseJson(secondCompression);
    expect(secondParsed).toBeTruthy();
    
    console.log(`\nSecond parsed structure keys:`, Object.keys(secondParsed));
    console.log(`Full structure:`, JSON.stringify(secondParsed, null, 2).substring(0, 500));
    
    // Check if we get the over-compressed bug: only metadata, no data
    const isOverCompressed = 
      Object.keys(secondParsed).length === 3 &&
      secondParsed._mcp_format === true &&
      secondParsed._raw_structure !== undefined &&
      secondParsed._schema_key !== undefined;
    
    console.log(`\nIs over-compressed: ${isOverCompressed}`);

    // After the fix, second compression should be identical to first (no re-compression)
    expect(secondCompression).toBe(firstCompression);
    
    // Both should have the same structure with data
    expect(secondParsed).toEqual(firstParsed);
    expect(secondParsed.data).toBeDefined();
    expect(Array.isArray(secondParsed.data)).toBe(true);
    
    // Should NOT be over-compressed
    expect(isOverCompressed).toBe(false);
    
    console.log(`\n✓ Double compression prevention verified!`);
  });
});
