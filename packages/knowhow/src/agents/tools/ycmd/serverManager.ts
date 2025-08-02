import { YcmdServer, YcmdServerInfo } from "./server";
import { YcmdClient, getFileTypes } from "./client";
import {
  resolveFilePath,
  findProjectRoot,
  fileExists,
} from "./utils/pathUtils";
import { ycmdStart } from "./tools/start";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { wait } from "../../../utils";

/**
 * Interface for setupClientAndNotifyFile parameters
 */
export interface SetupClientParams {
  filepath: string;
  fileContents?: string;
}

export type SetupClientResult =
  | {
      success: true;
      client: YcmdClient;
      resolvedFilePath: string;
      contents: string;
      filetypes: string[];
      message: string;
    }
  | {
      success: false;
      client?: undefined;
      resolvedFilePath?: undefined;
      contents?: undefined;
      filetypes?: undefined;
      message: string;
    };

/**
 * Global singleton manager for ycmd server instances
 * Ensures all tools use the same server instance
 */
class YcmdServerManager {
  private static instance: YcmdServerManager;
  private server: YcmdServer | null = null;

  private constructor() {}

  public static getInstance(): YcmdServerManager {
    if (!YcmdServerManager.instance) {
      YcmdServerManager.instance = new YcmdServerManager();
    }
    return YcmdServerManager.instance;
  }

  /**
   * Get or create the server instance
   */
  public getServer(): YcmdServer {
    if (!this.server) {
      this.server = new YcmdServer();
    }
    return this.server;
  }

  /**
   * Check if server is running
   */
  public async isRunning(): Promise<boolean> {
    // First check if our managed server is running
    if (this.server && this.server.isRunning()) {
      return true;
    }

    // If not, try to detect any running ycmd servers
    const detectedServer = await this.detectRunningServer();
    if (detectedServer) {
      // Update our server info to point to the detected server
      if (!this.server) {
        this.server = new YcmdServer();
      }
      // Set the detected server info (we'll need to expose this method)
      this.server.setExternalServerInfo(detectedServer);
      return true;
    }

    return false;
  }

  /**
   * Try to detect any running ycmd servers on common ports
   */
  private async detectRunningServer(): Promise<YcmdServerInfo | null> {
    const commonPorts = [
      8080, 8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089,
    ];

    for (const port of commonPorts) {
      try {
        // First check if port is open
        const isOpen = await this.checkPort("127.0.0.1", port);
        if (!isOpen) continue;
        // Try to connect as a ycmd server
        const serverInfo: YcmdServerInfo = {
          port,
          host: "127.0.0.1",
          hmacSecret: "", // We'll try without HMAC first
          status: "running",
        };

        const client = new YcmdClient(serverInfo);
        const isReady = await client.isReady();
        if (isReady) {
          console.log(`Detected running ycmd server on port ${port}`);
          return serverInfo;
        }
      } catch (error) {
        // Continue trying other ports
        continue;
      }
    }

    return null;
  }

  /**
   * Check if a port is open
   */
  private checkPort(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(1000);

      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });

      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });

      socket.on("error", () => {
        resolve(false);
      });

      socket.connect(port, host);
    });
  }

  /**
   * Get server info
   */
  public getServerInfo(): YcmdServerInfo | null {
    return this.server ? this.server.getServerInfo() : null;
  }

  /**
   * Start server
   */
  public async start(
    workspaceRoot?: string,
    port?: number
  ): Promise<YcmdServerInfo> {
    const server = this.getServer();
    return server.start(workspaceRoot, port);
  }

  /**
   * Stop server
   */
  public async stop(): Promise<void> {
    if (this.server) {
      await this.server.stop();
    }
  }

  /**
   * Health check
   */
  public async healthCheck(): Promise<boolean> {
    return this.server ? this.server.healthCheck() : false;
  }

  /**
   * Restart server
   */
  public async restart(
    workspaceRoot?: string,
    port?: number
  ): Promise<YcmdServerInfo> {
    const server = this.getServer();
    return server.restart(workspaceRoot, port);
  }

  /**
   * Enhanced setup method for all ycmd tools with proper TSServer project recognition
   * Handles file path resolution, content reading, server startup, client creation, and file notification
   */
  public async setupClientAndNotifyFile(
    params: SetupClientParams
  ): Promise<SetupClientResult> {
    try {
      // 1. Resolve file path
      const resolvedFilePath = resolveFilePath(params.filepath);

      // 1.5. Find project root
      const projectRoot = findProjectRoot(path.dirname(resolvedFilePath));
      const tsconfigPath = path.join(projectRoot, "tsconfig.json");

      // 2. Read file contents if not provided
      let contents = params.fileContents;
      if (!contents) {
        try {
          contents = await fs.promises.readFile(resolvedFilePath, "utf8");
        } catch (error) {
          return {
            success: false,
            message: `Failed to read file: ${(error as Error).message}`,
          };
        }
      }

      // 3. Get file types
      const filetypes = getFileTypes(resolvedFilePath);

      // 4. Check/start server
      if (!(await this.isRunning())) {
        console.log("ycmd server not running, attempting to start...");
        try {
          const startResult = await ycmdStart({});
          if (!startResult.success) {
            return {
              success: false,
              message: `Failed to start ycmd server: ${startResult.message}`,
            };
          }
          console.log("ycmd server started successfully");
        } catch (error) {
          return {
            success: false,
            message: `Failed to start ycmd server: ${(error as Error).message}`,
          };
        }
      }

      const serverInfo = this.getServerInfo();
      if (!serverInfo) {
        return {
          success: false,
          message: "Failed to get server information",
        };
      }

      // 5. Create client
      const client = new YcmdClient(serverInfo);

      // 6. Enhanced file notification sequence for TypeScript project recognition
      try {
        console.log("Starting enhanced TSServer setup sequence...");
        console.log(`Project root: ${projectRoot}`);
        console.log(`TSConfig path: ${tsconfigPath}`);
        console.log(`File types: ${filetypes.join(", ")}`);
        console.log(`Target file: ${resolvedFilePath}`);

        // Then load the target file
        console.log(`Notifying target file: ${resolvedFilePath}`);
        await client.notifyFileEvent(
          "BufferVisit",
          resolvedFilePath,
          contents,
          filetypes
        );

        // Additional delay after BufferVisit
        await wait(100);

        await client.notifyFileEvent(
          "FileReadyToParse",
          resolvedFilePath,
          contents,
          filetypes
        );

        // Additional delay after FileReadyToParse
        await wait(100);

        // Final delay to let TSServer process everything
        await wait(500);

        console.log("Successfully completed enhanced TSServer setup sequence");
      } catch (error) {
        console.warn("Failed to notify file event:", error);
        // We continue even if notification fails as it's not always critical
      }

      return {
        success: true,
        client,
        resolvedFilePath,
        contents,
        filetypes,
        message: "Successfully set up ycmd client and notified file",
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to set up ycmd client: ${(error as Error).message}`,
      };
    }
  }
}

export const ycmdServerManager = YcmdServerManager.getInstance();
