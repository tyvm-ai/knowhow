/**
 * Simple LRU cache for operation indexes
 * Avoids re-parsing swagger specs on every request
 */

import { SwaggerSpec, Tool, OperationIndex } from './types';
import { generateToolsFromSwagger, buildOperationIndex } from './index';

interface CacheEntry {
  swaggerSpec: SwaggerSpec;
  tools: Tool[];
  operations: OperationIndex[];
  timestamp: number;
}

/**
 * Simple LRU cache for swagger operation indexes
 */
export class OperationIndexCache {
  private cache: Map<string, CacheEntry>;
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize: number = 100, ttlMs: number = 3600000) {
    // Default: 100 entries, 1 hour TTL
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /**
   * Get a cached entry by key (e.g., swagger hash)
   */
  get(key: string): CacheEntry | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if expired
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    // Move to end (LRU)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry;
  }

  /**
   * Set a cache entry
   */
  set(key: string, swaggerSpec: SwaggerSpec): CacheEntry {
    // Build tools and operations
    const tools = generateToolsFromSwagger(swaggerSpec);
    const operations = buildOperationIndex(swaggerSpec);

    const entry: CacheEntry = {
      swaggerSpec,
      tools,
      operations,
      timestamp: Date.now(),
    };

    // Evict oldest entry if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, entry);
    return entry;
  }

  /**
   * Clear the entire cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Remove expired entries
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }
}

/**
 * Global cache instance (singleton)
 */
let globalCache: OperationIndexCache | null = null;

/**
 * Get the global cache instance
 */
export function getGlobalCache(): OperationIndexCache {
  if (!globalCache) {
    globalCache = new OperationIndexCache();
  }
  return globalCache;
}

/**
 * Reset the global cache (useful for testing)
 */
export function resetGlobalCache(): void {
  globalCache = null;
}
