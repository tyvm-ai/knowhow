/**
 * URL Rewriter for Tunnel Responses
 *
 * Rewrites localhost URLs in HTML/CSS/JS responses to use the tunnel proxy format.
 * This enables zero-config proxying where applications can make cross-port requests
 * through the tunnel system.
 *
 * Example transformations:
 *   http://localhost:3000/page  → http://WORKERID-p3000.worker.localhost:4000/page
 *   https://localhost:4000/api  → https://WORKERID-p4000.worker.localhost:4000/api
 *   //localhost:8080/ws         → //WORKERID-p8080.worker.localhost:4000/ws
 */

export interface UrlRewriterConfig {
  /** Worker ID for generating proxy URLs */
  workerId: string;

  /** Allowed ports that can be rewritten */
  allowedPorts: number[];

  /** Tunnel domain (default: worker.localhost:4000) */
  tunnelDomain?: string;

  /** Whether to use HTTPS for rewritten URLs */
  useHttps?: boolean;

  /** Whether to rewrite URLs (can be disabled for debugging) */
  enabled?: boolean;
}

/**
 * Check if content type is rewritable (text-based)
 */
export function isRewritableContentType(
  contentType: string | undefined
): boolean {
  if (!contentType) {
    return false;
  }

  const type = contentType.toLowerCase().split(";")[0].trim();

  const rewritableTypes = [
    "text/html",
    "text/css",
    "text/javascript",
    "application/javascript",
    "application/x-javascript",
    "text/xml",
    "application/xml",
    "application/json",
    "text/plain",
  ];

  return rewritableTypes.includes(type);
}

/**
 * Rewrite localhost URLs in text content
 */
export function rewriteUrls(
  content: string,
  config: UrlRewriterConfig
): string {
  if (!config.enabled) {
    return content;
  }

  const {
    workerId,
    allowedPorts,
    tunnelDomain = "worker.localhost:4000",
    useHttps = false,
  } = config;

  // Replace localhost URLs with tunnel proxy URLs
  // If useHttps is true, also upgrade http:// to https:// for security
  let result = content;
  let replacementCount = 0;

  for (const port of allowedPorts) {
    const replacement = `${workerId}\-p${port}\.${tunnelDomain}`;

    // Replace http://localhost:PORT with https://... if tunnel uses HTTPS
    if (useHttps) {
      const httpPattern = new RegExp(`http://localhost:${port}`, "g");
      const httpMatches = result.match(httpPattern);
      const httpCount = httpMatches ? httpMatches.length : 0;

      if (httpCount > 0) {
        result = result.replaceAll(`http://localhost:${port}`, `https://${replacement}`);
        replacementCount += httpCount;
        console.log(
          `[URL_REWRITE] Upgraded ${httpCount} occurrences of "http://localhost:${port}" to "https://${replacement}"`
        );
      }
    }

    // Replace remaining localhost:PORT patterns (for https://, //, or bare references)
    // Match "localhost:PORT" but NOT "worker.localhost:PORT" or other subdomains
    const pattern = new RegExp(`(?<!\\.)localhost:${port}`, "g");

    // Count and replace using the pattern
    const matches = result.match(pattern);
    const beforeCount = matches ? matches.length : 0;

    if (beforeCount > 0) {
      result = result.replaceAll(`localhost:${port}`, replacement);
      replacementCount += beforeCount;

      console.log(
        `[URL_REWRITE] Replaced ${beforeCount} occurrences of "localhost:${port}" with "${replacement}"`
      );
    }
  }

  if (replacementCount === 0) {
    console.log("[URL_REWRITE] No replacements made");
  }

  return result;
}

/**
 * Rewrite URLs in a Buffer, handling various encodings
 */
export function rewriteBuffer(
  buffer: Buffer,
  contentType: string | undefined,
  config: UrlRewriterConfig
): Buffer {
  if (!config.enabled) {
    return buffer;
  }

  if (!isRewritableContentType(contentType)) {
    return buffer;
  }

  // Determine encoding from content-type
  let encoding: BufferEncoding = "utf8";
  if (contentType) {
    const charsetMatch = /charset=([^;\s]+)/i.exec(contentType);
    if (charsetMatch) {
      const charset = charsetMatch[1].toLowerCase();
      // Map common charset names to Node.js encoding names
      if (charset === "utf-8" || charset === "utf8") {
        encoding = "utf8";
      } else if (charset === "iso-8859-1" || charset === "latin1") {
        encoding = "latin1";
      } else if (charset === "ascii") {
        encoding = "ascii";
      } else {
        console.warn(
          "[URL_REWRITE] Unsupported charset:",
          charset,
          "Defaulting to utf8"
        );
      }
      // For other encodings, default to utf8
    }
  }

  try {
    // Decode buffer to string
    const content = buffer.toString(encoding);

    const hasLocalhost = content.includes("localhost");

    if (!hasLocalhost) {
      return buffer;
    }

    if (hasLocalhost) {
      console.log("[URL_REWRITE] Before rewrite:", {
        hasLocalhost,
        contentLength: content.length,
        allowedPorts: config.allowedPorts,
        workerId: config.workerId,
        enabled: config.enabled,
      });
    }

    // Show a sample of localhost URLs found - use a broader pattern to see what's actually there
    if (hasLocalhost) {
      // Find all occurrences of "localhost" and show surrounding context (like grep -B5 -A5)
      const localhostIndices: number[] = [];
      let index = content.indexOf("localhost");
      while (index !== -1) {
        localhostIndices.push(index);
        index = content.indexOf("localhost", index + 1);
      }

      console.log(
        `[URL_REWRITE] Found ${localhostIndices.length} occurrences of "localhost"`
      );

      // Show first 5 occurrences with surrounding context
      const contextsToShow = Math.min(5, localhostIndices.length);
      for (let i = 0; i < contextsToShow; i++) {
        const pos = localhostIndices[i];
        const start = Math.max(0, pos - 50);
        const end = Math.min(content.length, pos + 50);
        const before = content.substring(start, pos);
        const after = content.substring(pos + 9, end); // 9 = length of "localhost"

        console.log(
          `[URL_REWRITE] Context ${i + 1} at position ${pos}:`,
          JSON.stringify(`${before}[LOCALHOST]${after}`)
        );
      }

      // Check specifically for our allowed ports
      const allowedPortMatches = content.match(
        new RegExp(`localhost:(${config.allowedPorts.join("|")})`, "g")
      );
      console.log(
        "[URL_REWRITE] Localhost with allowed ports:",
        allowedPortMatches?.slice(0, 5),
        `(Found ${allowedPortMatches?.length || 0} matches)`
      );
    }

    // Rewrite URLs
    const rewritten = rewriteUrls(content, config);

    if (hasLocalhost) {
      console.log("[URL_REWRITE] After rewrite:", {
        hasLocalhost: rewritten.includes("localhost"),
      });
    }

    // Encode back to buffer
    return Buffer.from(rewritten, encoding);
  } catch (err) {
    // If encoding/decoding fails, return original buffer
    console.error("URL rewriting failed:", err);
    return buffer;
  }
}

/**
 * Create a URL rewriter configuration from tunnel config
 */
export function createRewriterConfig(
  workerId: string,
  allowedPorts: number[],
  options: { enabled?: boolean; tunnelDomain?: string; useHttps?: boolean } = {}
): UrlRewriterConfig {
  return {
    workerId,
    allowedPorts,
    tunnelDomain: options.tunnelDomain || "worker.localhost:4000",
    useHttps: options.useHttps || false,
    enabled: options.enabled !== false, // Default to enabled
  };
}
