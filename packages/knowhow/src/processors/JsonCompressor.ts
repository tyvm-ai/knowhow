/**
 * Schema information for compressed JSON
 */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  compressed_properties?: string[];
}

/**
 * Metadata about compressed properties
 */
export interface CompressionMetadata {
  compressed_properties: Record<string, any>;
  compression_reason: string;
  similarity_score?: number;
}

/**
 * Interface for storage operations
 */
export interface JsonCompressorStorage {
  storeString(key: string, value: string): void;
  generateKey(): string;
  estimateTokens(text: string): number;
}

/**
 * Handles JSON-specific compression logic including schema generation,
 * low-signal property detection, and deduplication.
 */
export class JsonCompressor {
  // Deduplication tracking
  private deduplicationMap: Map<string, string> = new Map();
  private objectSeenCount: Map<string, number> = new Map();
  private propertyNamesMap: Map<string, string> = new Map();
  private propertyNamesSeenCount: Map<string, number> = new Map();

  private compressionThreshold: number;
  private maxTokens: number;
  private toolName: string;
  private storage: JsonCompressorStorage;

  constructor(
    storage: JsonCompressorStorage,
    compressionThreshold: number,
    maxTokens: number,
    toolName: string
  ) {
    this.storage = storage;
    this.compressionThreshold = compressionThreshold;
    this.maxTokens = maxTokens;
    this.toolName = toolName;
  }


  /**
   * Clear all deduplication tracking
   */
  clearDeduplication(): void {
    this.deduplicationMap.clear();
    this.objectSeenCount.clear();
    this.propertyNamesMap.clear();
    this.propertyNamesSeenCount.clear();
  }

  /**
   * Update compression settings
   */
  updateSettings(compressionThreshold: number, maxTokens: number): void {
    this.compressionThreshold = compressionThreshold;
    this.maxTokens = maxTokens;
  }

  /**
   * Attempts to parse content as JSON and returns parsed object if successful.
   * Also handles MCP tool response format where actual data is in content[0].text
   */
  tryParseJson(content: string): any | null {
    try {
      const parsed = JSON.parse(content);

      // If the parsed result is a string, try parsing it again (double-encoded JSON)
      if (typeof parsed === 'string') {
        try {
          return this.tryParseJson(parsed); // Recursive call to handle nested stringified JSON
        } catch (e) {
          return parsed; // If second parse fails, return the string
        }
      }

      // Check if this is an MCP tool response format
      if (parsed &&
          typeof parsed === 'object' &&
          Array.isArray(parsed.content) &&
          parsed.content.length > 0) {

        const firstContent = parsed.content[0];

        // Check if it has type: "text" and a text field
        if (firstContent.type === 'text' && typeof firstContent.text === 'string') {
          try {
            // Try to parse the nested text as JSON
            const nestedData = JSON.parse(firstContent.text);

            // Return a structured object that preserves the MCP format but exposes the data
            return {
              _mcp_format: true,
              _raw_structure: { content: [{ type: 'text' }] },
              data: nestedData
            };
          } catch (e) {
            // If nested text isn't JSON, return original parsed
            return parsed;
          }
        }
      }

      return parsed;
    } catch {
      return null;
    }
  }


  /**
   * Generate a JSON schema from an object
   */
  public generateSchema(obj: any, maxDepth: number = 3, currentDepth: number = 0): JsonSchema {
    if (currentDepth > maxDepth) {
      return { type: 'any' };
    }

    // Handle MCP format objects
    if (obj && typeof obj === 'object' && obj._mcp_format === true && obj.data) {
      // Generate schema for the actual data, not the wrapper
      const dataSchema = this.generateSchema(obj.data, maxDepth, currentDepth);
      return {
        type: 'mcp_response',
        properties: {
          data: dataSchema
        }
      };
    }

    if (obj === null) {
      return { type: 'null' };
    }

    if (Array.isArray(obj)) {
      if (obj.length === 0) {
        return { type: 'array', items: { type: 'unknown' } };
      }
      // Sample first few items to infer schema
      const sample = obj.slice(0, 3);
      const itemSchemas = sample.map(item => this.generateSchema(item, maxDepth, currentDepth + 1));
      // Use first item's schema as representative
      return { type: 'array', items: itemSchemas[0] };
    }

    if (typeof obj === 'object') {
      const properties: Record<string, JsonSchema> = {};
      for (const [key, value] of Object.entries(obj)) {
        properties[key] = this.generateSchema(value, maxDepth, currentDepth + 1);
      }
      return { type: 'object', properties };
    }

    return { type: typeof obj };
  }


  /**
   * Calculate similarity between two strings (simple prefix-based)
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const maxLen = Math.max(str1.length, str2.length);
    if (maxLen === 0) return 1.0;

    // Simple prefix similarity for URLs and similar strings
    let commonPrefixLen = 0;
    const minLen = Math.min(str1.length, str2.length);
    for (let i = 0; i < minLen; i++) {
      if (str1[i] === str2[i]) {
        commonPrefixLen++;
      } else {
        break;
      }
    }

    return commonPrefixLen / maxLen;
  }

  /**
   * Detect low-signal properties in an object (URLs, highly repetitive data)
   */
  private detectLowSignalProperties(obj: any): { lowSignal: string[], metadata: Record<string, any> } {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { lowSignal: [], metadata: {} };
    }

    const lowSignal: string[] = [];
    const metadata: Record<string, any> = {};
    const entries = Object.entries(obj);

    // Detect URL properties
    const urlPattern = /^https?:\/\//;
    const urlProps: string[] = [];

    for (const [key, value] of entries) {
      if (typeof value === 'string' && urlPattern.test(value)) {
        urlProps.push(key);
      }
    }

    // If multiple URL properties exist, check their similarity
    if (urlProps.length >= 3) {
      const urlValues = urlProps.map(key => obj[key] as string);
      let totalSimilarity = 0;
      let comparisons = 0;

      for (let i = 0; i < urlValues.length - 1; i++) {
        for (let j = i + 1; j < urlValues.length; j++) {
          totalSimilarity += this.calculateSimilarity(urlValues[i], urlValues[j]);
          comparisons++;
        }
      }

      const avgSimilarity = comparisons > 0 ? totalSimilarity / comparisons : 0;

      // If URLs are highly similar (>60% common prefix), consider them low signal
      if (avgSimilarity > 0.6) {
        lowSignal.push(...urlProps);
        metadata.url_similarity = avgSimilarity;
        metadata.url_count = urlProps.length;
      }
    }

    // Detect properties ending with _url, _id, node_id, etc.
    const lowSignalPatterns = [/_url$/, /_id$/, /^node_id$/, /^avatar_url$/, /^gravatar_id$/];
    for (const [key, value] of entries) {
      if (lowSignalPatterns.some(pattern => pattern.test(key)) && !lowSignal.includes(key)) {
        lowSignal.push(key);
      }
    }

    return { lowSignal, metadata };
  }


  /**
   * Compress an object by extracting low-signal properties
   */
  compressObjectWithLowSignalDetection(obj: any, path: string = ""): any {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return obj;
    }

    const { lowSignal, metadata } = this.detectLowSignalProperties(obj);

    // Only compress if we have significant low-signal properties (at least 5)
    if (lowSignal.length < 5) {
      return obj;
    }

    const highSignal: any = {};
    const compressed: any = {};

    for (const [key, value] of Object.entries(obj)) {
      if (lowSignal.includes(key)) {
        compressed[key] = value;
      } else {
        highSignal[key] = value;
      }
    }

    // Check if we've already compressed identical low-signal properties
    const compressedHash = this.hashObject(compressed);
    let compressedKey = this.deduplicationMap.get(compressedHash);
    
    if (!compressedKey) {
      // First time seeing these properties - store them
      compressedKey = this.storage.generateKey();
      this.deduplicationMap.set(compressedHash, compressedKey);
      
      const compressionMetadata: CompressionMetadata = {
        compressed_properties: compressed,
        compression_reason: 'low_signal_detection',
        similarity_score: metadata.url_similarity,
      };
      this.storage.storeString(compressedKey, JSON.stringify(compressionMetadata));
    }
    
    // If compressedKey already exists, we're reusing it from a duplicate object
    // This significantly reduces storage when objects like "owner" repeat

    // Deduplicate the property names array
    const propertyNamesHash = this.hashObject(lowSignal);
    const propertyNamesSeenCount = this.propertyNamesSeenCount.get(propertyNamesHash) || 0;
    this.propertyNamesSeenCount.set(propertyNamesHash, propertyNamesSeenCount + 1);
    
    let propertyNamesValue: string | any[] = lowSignal;
    
    if (propertyNamesSeenCount === 0) {
      // First occurrence - store it and return the full array
      const propertyNamesKey = this.storage.generateKey();
      this.propertyNamesMap.set(propertyNamesHash, propertyNamesKey);
      this.storage.storeString(propertyNamesKey, JSON.stringify(lowSignal));
      propertyNamesValue = lowSignal; // Return full array first time
    } else if (propertyNamesSeenCount >= 1) {
      // Subsequent occurrences - return a reference
      const existingPropertyNamesKey = this.propertyNamesMap.get(propertyNamesHash);
      propertyNamesValue = `[DEDUPLICATED_ARRAY]\nKey: ${existingPropertyNamesKey}`;
    }

    // Return high-signal properties with reference to compressed data
    return {
      ...highSignal,
      _compressed_properties_key: compressedKey,
      _compressed_property_names: propertyNamesValue,
      _compression_info: `${lowSignal.length} low-signal properties compressed (URLs, IDs). Use expandTokens with key "${compressedKey}" to retrieve.`
    };
  }


  /**
   * Creates a stable hash of an object for deduplication
   */
  private hashObject(obj: any): string {
    // Create a stable JSON representation for hashing
    const normalized = JSON.stringify(obj, Object.keys(obj).sort());
    // Simple hash function (for deduplication, not cryptographic security)
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(36);
  }

  /**
   * Compresses large properties within a JSON object using depth-first traversal.
   * Implements an efficient backward-iterating chunking strategy for large arrays.
   */
  compressJsonProperties(obj: any, path: string = ""): any {
    if (
      path === "" &&
      this.storage.estimateTokens(JSON.stringify(obj)) <= this.maxTokens
    ) {
      return obj;
    }

    if (Array.isArray(obj)) {
      // Step 1: Recursively compress all items first (depth-first).
      const processedItems = obj.map((item, index) =>
        this.compressJsonProperties(item, `${path}[${index}]`)
      );

      // Step 2: Early exit if the whole array is already small enough.
      // maxTokens allows us to fetch objects from the store without recompressing

      // Step 3: Iterate backwards, building chunks from the end.
      const finalArray: any[] = [];
      let currentChunk: any[] = [];

      for (let i = processedItems.length - 1; i >= 0; i--) {
        const item = processedItems[i];
        currentChunk.unshift(item); // Add item to the front of the current chunk

        const chunkString = JSON.stringify(currentChunk);
        const chunkTokens = this.storage.estimateTokens(chunkString);

        if (chunkTokens > this.compressionThreshold) {
          const key = this.storage.generateKey();
          this.storage.storeString(key, chunkString);

          const stub = `[COMPRESSED_JSON_ARRAY_CHUNK - ${chunkTokens} tokens, ${
            currentChunk.length
          } items]\nKey: ${key}\nPath: ${path}[${i}...${
            i + currentChunk.length - 1
          }]\nPreview: ${chunkString.substring(0, 100)}...\n[Use ${
            this.toolName
          } tool with key "${key}" to retrieve this chunk]`;
          finalArray.unshift(stub); // Add stub to the start of our final result.

          currentChunk = [];
        }
      }

      // Step 4: After the loop, add any remaining items from the start of the
      // array that did not form a full chunk.
      if (currentChunk.length > 0) {
        finalArray.unshift(...currentChunk);
      }
      return finalArray;
    }


    // Handle objects - try low-signal detection first, then process properties (depth-first)
    if (obj && typeof obj === "object") {
      // Check if this exact object (by original content) is a duplicate
      const objHash = this.hashObject(obj);
      const existingKey = this.deduplicationMap.get(objHash);
      
      if (existingKey) {
        // We've seen this exact object before and stored it
          return `[DEDUPLICATED_OBJECT]\nKey: ${existingKey}\nPath: ${path}\n[Use ${this.toolName} tool with key "${existingKey}" to retrieve content]`;
      }
      
      // Track that we've seen this object (increment count)
      const seenCount = this.objectSeenCount.get(objHash) || 0;
      this.objectSeenCount.set(objHash, seenCount + 1);
      
      // Store objects on FIRST occurrence so second occurrence can reference it
      // We increment seenCount above, so after increment:
      // seenCount=1: first occurrence (just incremented from 0 to 1), store it
      // seenCount>=2: we already stored it on first occurrence, should be in dedup map
      // Note: This means we store proactively - first occurrence gets stored AND returned in full
      // Second+ occurrences will find it in the dedup map and return a reference
      const isFirstOccurrence = seenCount === 1;

      // Process the object - apply low-signal detection
      const objWithLowSignalCompressed = this.compressObjectWithLowSignalDetection(obj, path);
      const objToProcess = objWithLowSignalCompressed !== obj ? objWithLowSignalCompressed : obj;

      const result: any = {};
      for (const [key, value] of Object.entries(objToProcess)) {
        const newPath = path ? `${path}.${key}` : key;
        result[key] = this.compressJsonProperties(value, newPath);
      }

      // After processing children, check if the entire object should be compressed
      const objectAsString = JSON.stringify(result);
      const tokens = this.storage.estimateTokens(objectAsString);
      
      // If this is the first occurrence of a potentially duplicated object, store it
      if (isFirstOccurrence && tokens > 100) {
          const key = this.storage.generateKey();
          this.deduplicationMap.set(objHash, key);
          this.storage.storeString(key, objectAsString);
          // Return the object data this time, next occurrences will get a reference
          return result;
      }
      
      // Check if object is large enough to compress as a whole
      if (tokens > this.compressionThreshold) {
        const key = this.storage.generateKey();
        this.storage.storeString(key, objectAsString);

        return `[COMPRESSED_JSON_OBJECT - ${tokens} tokens]\nKey: ${key}\nPath: ${path}\nKeys: ${Object.keys(
          result
        ).join(", ")}\nPreview: ${objectAsString.substring(0, 200)}...\n[Use ${
          this.toolName
        } tool with key "${key}" to retrieve full content]`;
      }
      return result;
    }


    // Handle primitive values (strings, numbers, booleans, null)
    if (typeof obj === "string") {
      // First, check if this string contains JSON that we can parse and compress more granularly
      const parsedJson = this.tryParseJson(obj);
      if (parsedJson) {
        const compressedJson = this.compressJsonProperties(parsedJson, path);
        const compressedJsonString = JSON.stringify(compressedJson, null, 2);

        const originalTokens = this.storage.estimateTokens(obj);
        const compressedTokens = this.storage.estimateTokens(compressedJsonString);

        if (compressedTokens < originalTokens * 0.8) {
          return compressedJsonString;
        }
      }

      // If not JSON or compression wasn't effective, handle as regular string
      const tokens = this.storage.estimateTokens(obj);
      if (tokens > this.compressionThreshold) {
        const key = this.storage.generateKey();
        this.storage.storeString(key, obj);

        return `[COMPRESSED_JSON_PROPERTY - ${tokens} tokens]\nKey: ${key}\nPath: ${path}\nPreview: ${obj.substring(
          0,
          200
        )}...\n[Use ${
          this.toolName
        } tool with key "${key}" to retrieve full content]`;
      }
      return obj;
    }

    return obj;
  }
}
