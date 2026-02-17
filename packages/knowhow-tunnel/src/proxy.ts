import http from "http";
import https from "https";
import * as fs from "fs";
import WebSocket from "ws";
import {
  TunnelConfig,
  TunnelRequest,
  TunnelResponse,
  TunnelData,
  TunnelEnd,
  TunnelError,
  TunnelMessageType,
  StreamState,
  TunnelWsUpgrade,
  TunnelWsData,
  TunnelWsClose,
} from "./types";
import {
  normalizeHeadersForLocal,
  serializeTunnelMessage,
  isPortAllowed,
} from "./protocol";
import { Logger, clearTimeoutSafe, formatBytes, formatDuration } from "./utils";
import {
  createRewriterConfig,
  rewriteBuffer,
  isRewritableContentType,
  UrlRewriterConfig,
} from "./url-rewriter";

/**
 * HTTP Proxy Handler
 * Handles incoming tunnel requests and proxies them to local services
 */
export class TunnelProxy {
  private config: Required<Omit<TunnelConfig, 'workerId' | 'tunnelDomain'>> & { workerId?: string; tunnelDomain?: string };
  private logger: Logger;
  private activeStreams: Map<string, StreamState>;
  private sendMessage: (message: string) => void;

  constructor(
    config: TunnelConfig,
    sendMessage: (message: string) => void
  ) {
    this.config = {
      allowedPorts: config.allowedPorts || [],
      maxConcurrentStreams: config.maxConcurrentStreams || 50,
      maxResponseSize: config.maxResponseSize || 100 * 1024 * 1024, // 100MB
      connectTimeout: config.connectTimeout || 5000,
      idleTimeout: config.idleTimeout || 60000,
      forceIdentityEncoding: config.forceIdentityEncoding ?? true,
      localHost: config.localHost || "127.0.0.1",
      logLevel: config.logLevel || "info",
      portMapping: config.portMapping || {},
      workerId: config.workerId,
      enableUrlRewriting: config.enableUrlRewriting !== false,
      tunnelDomain: config.tunnelDomain,
    };

    this.logger = new Logger(this.config.logLevel);
    this.activeStreams = new Map();
    this.sendMessage = sendMessage;
  }

  /**
   * Get active stream count
   */
  getActiveStreamCount(): number {
    return this.activeStreams.size;
  }

  /**
   * Resolve the local port using port mapping if configured
   */
  private resolveLocalPort(remotePort: number): number {
    if (this.config.portMapping && this.config.portMapping[remotePort]) {
      const localPort = this.config.portMapping[remotePort];
      this.logger.debug(`Port mapping: ${remotePort} -> ${localPort}`);
      return localPort;
    }
    return remotePort;
  }

  /**
   * Handle incoming tunnel request
   */
  async handleRequest(request: TunnelRequest): Promise<void> {
    const { streamId, port, method, path, headers, scheme = "http", deadlineMs } = request;

    const logMsg = `[${new Date().toISOString()}] WORKER: handleRequest ${method} ${path} port=${port} streamId=${streamId}\n`;
    fs.appendFileSync('/tmp/tunnel-worker-debug.log', logMsg);

    this.logger.info(
      `New request: ${method} ${path} on port ${port} (stream: ${streamId})`
    );

    const logMsg2 = `[${new Date().toISOString()}] WORKER: After logger.info\n`;
    fs.appendFileSync('/tmp/tunnel-worker-debug.log', logMsg2);

    // Check if port is allowed
    if (!isPortAllowed(port, this.config.allowedPorts)) {
      this.logger.warn(`Port ${port} not allowed`);
      this.sendError(streamId, `Port ${port} is not allowed`, 403);
      return;
    }

    // Check concurrent stream limit
    // Resolve local port (may be different from requested port due to mapping)
    const localPort = this.resolveLocalPort(port);

    if (this.activeStreams.size >= this.config.maxConcurrentStreams) {
      this.logger.warn(`Max concurrent streams reached (${this.config.maxConcurrentStreams})`);
      this.sendError(streamId, "Too many concurrent streams", 503);
      return;
    }

    // Create stream state
    const streamState: StreamState = {
      streamId,
      workerId: request.workerId,
      port,
      method,
      path,
      startTime: Date.now(),
      bytesReceived: 0,
      bytesSent: 0,
      isPaused: false,
    };

    this.activeStreams.set(streamId, streamState);

    // Set deadline timer if provided
    if (deadlineMs) {
      streamState.deadlineTimer = setTimeout(() => {
        this.logger.warn(`Stream ${streamId} exceeded deadline`);
        this.cleanupStream(streamId, "Deadline exceeded");
      }, deadlineMs);
    }

    // Normalize headers
    const localHeaders = normalizeHeadersForLocal(headers, {
      forceIdentityEncoding: this.config.forceIdentityEncoding,
    });

    // Create HTTP client
    const client = scheme === "https" ? https : http;

    this.logger.info(
      `Attempting to connect to ${this.config.localHost}:${localPort} for stream ${streamId}`
    );

    try {
      const req = client.request(
        {
          host: this.config.localHost,
          port: localPort,
          method,
          path,
          headers: localHeaders,
          timeout: this.config.connectTimeout,
        },
        (res) => {
          this.handleResponse(streamId, res);
        }
      );

      streamState.request = req;

      // Handle request errors
      req.on("error", (err) => {
        this.logger.error(`Request error for stream ${streamId}:`, err.message);
        this.sendError(streamId, err.message, 502);
        this.cleanupStream(streamId);
      });

      req.on("timeout", () => {
        this.logger.error(`Request timeout for stream ${streamId}`);
        this.sendError(streamId, "Connection timeout", 504);
        this.cleanupStream(streamId);
      });

      // Don't end the request yet - we'll receive body data chunks
      this.logger.debug(`Request initiated for stream ${streamId}`);
    } catch (err: any) {
      this.logger.error(`Failed to create request for stream ${streamId}:`, err.message);
      this.sendError(streamId, err.message, 500);
      this.cleanupStream(streamId);
    }
  }

  /**
   * Handle request body data
   */
  handleData(streamId: string, data: Buffer): void {
    const streamState = this.activeStreams.get(streamId);

    if (!streamState || !streamState.request) {
      this.logger.warn(`Received data for unknown stream: ${streamId}`);
      return;
    }

    streamState.bytesReceived += data.length;

    // Write data to local request
    const canWrite = streamState.request.write(data);

    if (!canWrite) {
      // Backpressure: pause reading from tunnel
      streamState.isPaused = true;
      this.logger.debug(`Backpressure on stream ${streamId}, pausing`);

      // Resume when drained
      streamState.request.once("drain", () => {
        streamState.isPaused = false;
        this.logger.debug(`Stream ${streamId} drained, resuming`);
      });
    }

    // Reset idle timer
    this.resetIdleTimer(streamState);
  }

  /**
   * Handle request end
   */
  handleEnd(streamId: string): void {
    const streamState = this.activeStreams.get(streamId);

    if (!streamState || !streamState.request) {
      this.logger.warn(`Received end for unknown stream: ${streamId}`);
      return;
    }

    this.logger.debug(`Request body complete for stream ${streamId}`);
    streamState.request.end();
  }

  /**
   * Handle response from local service
   */
  private handleResponse(streamId: string, res: http.IncomingMessage): void {
    const streamState = this.activeStreams.get(streamId);

    if (!streamState) {
      this.logger.warn(`Received response for unknown stream: ${streamId}`);
      res.destroy();
      return;
    }

    streamState.response = res;

    const contentType = Array.isArray(res.headers['content-type']) ? res.headers['content-type'][0] : res.headers['content-type'];

    // If URL rewriting is enabled and content type is rewritable, remove content-length
    // header to allow dynamic content size changes
    const headers = { ...res.headers };
    if (streamState.workerId && this.config.enableUrlRewriting !== false) {
      if (isRewritableContentType(contentType)) {
        delete headers['content-length'];
        this.logger.debug(`Removed content-length header for stream ${streamId} (URL rewriting enabled)`);
      }
    }

    // Send response metadata
    const response: TunnelResponse = {
      type: TunnelMessageType.RESPONSE,
      streamId,
      statusCode: res.statusCode || 500,
      statusMessage: res.statusMessage,
      headers: headers,
    };

    this.sendMessage(serializeTunnelMessage(response));
    this.logger.info(
      `Response ${response.statusCode} for stream ${streamId}`
    );

    // Stream response body
    res.on("data", (chunk: Buffer) => {
      streamState.bytesSent += chunk.length;

      // Check max response size
      if (streamState.bytesSent > this.config.maxResponseSize) {
        this.logger.error(
          `Stream ${streamId} exceeded max response size (${formatBytes(this.config.maxResponseSize)})`
        );
        this.sendError(streamId, "Response too large", 413);
        this.cleanupStream(streamId);
        return;
      }

      // Apply URL rewriting if enabled
      let dataToSend = chunk;
      if (streamState.workerId && this.config.enableUrlRewriting !== false) {
        const urlRewriterConfig = createRewriterConfig(
          streamState.workerId,
          this.config.allowedPorts,
          { enabled: true, tunnelDomain: this.config.tunnelDomain }
        );

        const originalSize = chunk.length;
        dataToSend = rewriteBuffer(chunk, contentType, urlRewriterConfig);

        if (dataToSend.length !== originalSize) {
          this.logger.debug(`URL rewriting applied for stream ${streamId}: ${originalSize} -> ${dataToSend.length} bytes`);
        }
      }

      const dataMsg: TunnelData = {
        type: TunnelMessageType.DATA,
        streamId,
        data: dataToSend,
      };
      streamState.bytesSent += dataToSend.length - chunk.length; // Adjust for size difference

      this.sendMessage(serializeTunnelMessage(dataMsg));

      // Reset idle timer
      this.resetIdleTimer(streamState);
    });

    res.on("end", () => {
      const duration = Date.now() - streamState.startTime;
      this.logger.info(
        `Stream ${streamId} complete: ${formatBytes(streamState.bytesSent)} sent, ${formatDuration(duration)}`
      );

      const endMsg: TunnelEnd = {
        type: TunnelMessageType.END,
        streamId,
      };

      this.sendMessage(serializeTunnelMessage(endMsg));
      this.cleanupStream(streamId);
    });

    res.on("error", (err) => {
      this.logger.error(`Response error for stream ${streamId}:`, err.message);
      this.sendError(streamId, err.message);
      this.cleanupStream(streamId);
    });
  }

  /**
   * Handle WebSocket upgrade request
   */
  async handleWsUpgrade(upgrade: TunnelWsUpgrade): Promise<void> {
    const { streamId, port, path, headers } = upgrade;

    this.logger.info(`WebSocket upgrade request: ${path} on port ${port} (stream: ${streamId})`);

    // Check if port is allowed
    if (!isPortAllowed(port, this.config.allowedPorts)) {
      this.logger.warn(`Port ${port} not allowed for WebSocket`);
      this.sendError(streamId, `Port ${port} is not allowed`, 403);
      return;
    }

    // Resolve local port
    const localPort = this.resolveLocalPort(port);

    // Create stream state
    const streamState: StreamState = {
      streamId,
      port,
      method: "WS",
      path,
      startTime: Date.now(),
      bytesReceived: 0,
      bytesSent: 0,
      isPaused: false,
    };

    this.activeStreams.set(streamId, streamState);

    try {
      // Create WebSocket connection to local service
      const wsUrl = `ws://${this.config.localHost}:${localPort}${path}`;
      const ws = new WebSocket(wsUrl, {
        headers: headers as any,
      });

      streamState.wsClient = ws;

      ws.on("open", () => {
        this.logger.info(`WebSocket connected for stream ${streamId}`);
        // Send success response
        const response: TunnelResponse = {
          type: TunnelMessageType.RESPONSE,
          streamId,
          statusCode: 101,
          statusMessage: "Switching Protocols",
          headers: {},
        };
        this.sendMessage(serializeTunnelMessage(response));
      });

      ws.on("message", (data: Buffer, isBinary: boolean) => {
        streamState.bytesSent += data.length;

        const wsData: TunnelWsData = {
          type: TunnelMessageType.WS_DATA,
          streamId,
          data,
          isBinary,
        };

        this.sendMessage(serializeTunnelMessage(wsData));
        this.resetIdleTimer(streamState);
      });

      ws.on("close", (code, reason) => {
        this.logger.info(`WebSocket closed for stream ${streamId}: ${code} ${reason}`);

        const wsClose: TunnelWsClose = {
          type: TunnelMessageType.WS_CLOSE,
          streamId,
          code,
          reason: reason.toString(),
        };

        this.sendMessage(serializeTunnelMessage(wsClose));
        this.cleanupStream(streamId);
      });

      ws.on("error", (err) => {
        this.logger.error(`WebSocket error for stream ${streamId}:`, err.message);
        this.sendError(streamId, err.message, 502);
        this.cleanupStream(streamId);
      });
    } catch (err: any) {
      this.logger.error(`Failed to create WebSocket for stream ${streamId}:`, err.message);
      this.sendError(streamId, err.message, 500);
      this.cleanupStream(streamId);
    }
  }

  /**
   * Handle WebSocket data from tunnel
   */
  handleWsData(streamId: string, data: Buffer, isBinary: boolean): void {
    const streamState = this.activeStreams.get(streamId);

    if (!streamState || !streamState.wsClient) {
      this.logger.warn(`Received WS data for unknown stream: ${streamId}`);
      return;
    }

    streamState.bytesReceived += data.length;
    streamState.wsClient.send(data, { binary: isBinary });
    this.resetIdleTimer(streamState);
  }

  /**
   * Handle WebSocket close from tunnel
   */
  handleWsClose(streamId: string, code?: number, reason?: string): void {
    const streamState = this.activeStreams.get(streamId);

    if (!streamState || !streamState.wsClient) {
      this.logger.warn(`Received WS close for unknown stream: ${streamId}`);
      return;
    }

    this.logger.info(`Closing WebSocket for stream ${streamId}`);
    streamState.wsClient.close(code, reason);
    this.cleanupStream(streamId);
  }

  /**
   * Send error message
   */
  private sendError(streamId: string, error: string, statusCode: number = 500): void {
    const errorMsg: TunnelError = {
      type: TunnelMessageType.ERROR,
      streamId,
      error,
      statusCode,
    };

    this.sendMessage(serializeTunnelMessage(errorMsg));
  }

  /**
   * Reset idle timer for a stream
   */
  private resetIdleTimer(streamState: StreamState): void {
    clearTimeoutSafe(streamState.idleTimer);

    streamState.idleTimer = setTimeout(() => {
      this.logger.warn(`Stream ${streamState.streamId} idle timeout`);
      this.cleanupStream(streamState.streamId, "Idle timeout");
    }, this.config.idleTimeout);
  }

  /**
   * Cleanup a stream
   */
  private cleanupStream(streamId: string, reason?: string): void {
    const streamState = this.activeStreams.get(streamId);

    if (!streamState) {
      return;
    }

    if (reason) {
      this.logger.debug(`Cleaning up stream ${streamId}: ${reason}`);
    }

    // Clear timers
    clearTimeoutSafe(streamState.deadlineTimer);
    clearTimeoutSafe(streamState.idleTimer);

    // Destroy request/response
    if (streamState.request) {
      streamState.request.destroy();
    }
    if (streamState.response) {
      streamState.response.destroy();
    }

    // Close WebSocket
    if (streamState.wsClient) {
      streamState.wsClient.close();
    }

    this.activeStreams.delete(streamId);
  }

  /**
   * Cleanup all streams
   */
  cleanup(): void {
    this.logger.info(`Cleaning up ${this.activeStreams.size} active streams`);

    for (const streamId of this.activeStreams.keys()) {
      this.cleanupStream(streamId, "Proxy shutdown");
    }
  }
}
