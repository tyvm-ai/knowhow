import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as net from "net";
import { getConfig } from "../../../config";
import { spawn, ChildProcess } from "child_process";
import { YcmdDetection } from "./detection";
import { YcmdInstaller } from "./installer";
import { YcmdClient } from "./client";

export interface YcmdServerInfo {
  port: number;
  host: string;
  hmacSecret: string;
  pid?: number;
  status: "starting" | "running" | "stopped" | "error";
}

/**
 * Manages ycmd server lifecycle
 */
export class YcmdServer {
  private process: ChildProcess | null = null;
  private serverInfo: YcmdServerInfo | null = null;
  private hmacSecret: string;
  private ycmdPath: string;
  private configuredPort: number = 0;
  private detectedPort: number | null = null;

  constructor() {
    this.setupExitHandler();
    // Generate a unique HMAC secret for this server instance
    this.hmacSecret = crypto.randomBytes(16).toString("base64");
    // Ensure cleanup when parent process exits
    process.on("exit", () => this.forceCleanup());

    // Find ycmd installation
    const installations = YcmdDetection.findInstallations();
    if (installations.length === 0) {
      throw new Error("No ycmd installation found. Please install ycmd first.");
    }

    // Use configured install path or prefer knowhow installation if available
    const knowhowConfig = require("../../../config").getConfigSync();
    const ycmdConfig = knowhowConfig.ycmd || {};
    const configuredPath = ycmdConfig.installPath;
    const knowhowPath = path.join(require("os").homedir(), ".knowhow/ycmd");
    this.ycmdPath =
      (configuredPath && installations.find((p) => p === configuredPath)) ||
      installations.find((p) => p === knowhowPath) ||
      installations[0];
  }

  /**
   * Start the ycmd server
   */
  async start(workspaceRoot?: string, port?: number): Promise<YcmdServerInfo> {
    return this.startWithRetry(0, workspaceRoot, port);
  }

  /**
   * Start the ycmd server with retry logic for port conflicts
   */
  private async startWithRetry(
    retryCount: number,
    workspaceRoot?: string,
    port?: number
  ): Promise<YcmdServerInfo> {
    const maxRetries = 5;

    if (retryCount >= maxRetries) {
      throw new Error(
        `Failed to start ycmd server after ${maxRetries} attempts`
      );
    }

    try {
      return await this.doStart(workspaceRoot, port);
    } catch (error: any) {
      if (
        error.message === "PORT_IN_USE" ||
        error.message.includes("PORT_IN_USE")
      ) {
        console.log(
          `Retrying with incremented port (attempt ${
            retryCount + 1
          }/${maxRetries})`
        );
        const nextPort = (port || 8080) + retryCount + 1;
        return this.startWithRetry(retryCount + 1, workspaceRoot, nextPort);
      }
      throw error;
    }
  }

  /**
   * Actually start the ycmd server (internal method)
   */
  private async doStart(
    workspaceRoot?: string,
    port?: number
  ): Promise<YcmdServerInfo> {
    if (this.isRunning()) {
      throw new Error("ycmd server is already running");
    }

    console.log("Starting ycmd server...");

    try {
      // Get knowhow config for ycmd settings
      const knowhowConfig = await getConfig();
      const ycmdConfig = knowhowConfig.ycmd || {};

      // Check if ycmd is enabled in config
      if (ycmdConfig.enabled === false) {
        throw new Error(
          "ycmd is disabled in configuration. Set ycmd.enabled to true in .knowhow/knowhow.json"
        );
      }

      // Create server configuration
      const serverConfig = this.createServerConfig(workspaceRoot, port);
      const availablePort = await this.findAvailablePort(serverConfig.port);
      this.configuredPort = availablePort;
      const configPath = await this.writeServerConfig(serverConfig);

      // Start ycmd process
      const pythonCmd = YcmdDetection.getPythonCommand();
      const ycmdScript = path.join(this.ycmdPath, "ycmd", "__main__.py");

      const args = ["--options_file", configPath];
      args.push("--port", availablePort.toString());

      this.process = spawn(pythonCmd, [ycmdScript, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: this.ycmdPath,
      });

      // Set up process event handlers
      try {
        await this.setupProcessHandlers();
      } catch (error: any) {
        if (error.message === "PORT_IN_USE") {
          throw error; // Re-throw to trigger retry logic
        }
      }

      // Wait for server to start and get port
      const serverInfo = await this.waitForServerStart();

      this.serverInfo = {
        ...serverInfo,
        pid: this.process.pid,
        status: "running",
      };

      console.log(
        `ycmd server started on ${serverInfo.host}:${serverInfo.port}`
      );
      return this.serverInfo;
    } catch (error) {
      this.cleanup();
      // Don't wrap PORT_IN_USE errors so retry logic works
      if ((error as Error).message === "PORT_IN_USE") {
        throw error;
      }
      throw new Error(
        `Failed to start ycmd server: ${(error as Error).message}`
      );
    }
  }

  /**
   * Stop the ycmd server
   */
  async stop(): Promise<void> {
    if (!this.isRunning()) {
      console.log("ycmd server is not running");
      return;
    }

    console.log("Stopping ycmd server...");

    return new Promise((resolve, reject) => {
      if (!this.process) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        // Force kill if graceful shutdown fails
        this.process?.kill("SIGKILL");
        reject(new Error("ycmd server failed to stop gracefully"));
      }, 5000);

      this.process.once("exit", () => {
        clearTimeout(timeout);
        this.cleanup();
        console.log("ycmd server stopped");
        resolve();
      });

      // Send shutdown signal
      this.process.kill("SIGTERM");
    });
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return (
      this.process !== null &&
      !this.process.killed &&
      this.serverInfo?.status === "running"
    );
  }

  /**
   * Get server information
   */
  getServerInfo(): YcmdServerInfo | null {
    return this.serverInfo;
  }

  /**
   * Set server info for external servers (not started by this instance)
   */
  setExternalServerInfo(serverInfo: YcmdServerInfo): void {
    this.serverInfo = serverInfo;
    // Don't set process since we didn't start it
    this.hmacSecret = serverInfo.hmacSecret || "";
  }

  /**
   * Health check the server
   */
  async healthCheck(): Promise<boolean> {
    if (!this.isRunning() || !this.serverInfo) {
      return false;
    }

    try {
      // Use YcmdClient for proper HMAC authentication
      const client = new YcmdClient(this.serverInfo);
      return await client.isReady();
    } catch {
      return false;
    }
  }

  /**
   * Create server configuration object
   */
  private createServerConfig(workspaceRoot?: string, port?: number): any {
    // Get knowhow config for ycmd settings
    const knowhowConfig = require("../../../config").getConfigSync();
    const ycmdConfig = knowhowConfig.ycmd || {};

    return {
      hmac_secret: this.hmacSecret,
      port: port || ycmdConfig.port || 0,
      host: "127.0.0.1",
      server_keep_logfiles: true,
      server_use_vim_stdout: false,
      log_level: ycmdConfig.logLevel || "info",
      max_diagnostics_to_display: 30,
      auto_trigger_completion: true,
      completion_timeout: (ycmdConfig.completionTimeout || 5000) / 1000,
      // Language-specific settings
      global_ycm_extra_conf: workspaceRoot
        ? path.join(workspaceRoot, ".ycm_extra_conf.py")
        : undefined,
      confirm_extra_conf: false,
      auto_start_csharp_server: true,
      auto_stop_csharp_server: true,
      use_clangd: true,
      clangd_binary_path: "",
      clangd_args: [],
      java_jdtls_workspace_root_path: workspaceRoot || "",
      python_binary_path: YcmdDetection.getPythonCommand(),
    };
  }

  /**
   * Write server configuration to temporary file
   */
  private async writeServerConfig(config: any): Promise<string> {
    const configPath = path.join(
      require("os").tmpdir(),
      `ycmd_config_${Date.now()}.json`
    );
    await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
    return configPath;
  }

  /**
   * Set up process event handlers
   */
  private setupProcessHandlers(): Promise<boolean> {
    if (!this.process) {
      return Promise.resolve(false);
    }

    return new Promise((resolve, reject) => {
      let stdoutBuffer = "";

      this.process.on("error", (error) => {
        console.error("ycmd server process error:", error);
        if (this.serverInfo) {
          this.serverInfo.status = "error";
        }
      });

      this.process.on("exit", (code, signal) => {
        console.log(`ycmd server exited with code ${code}, signal ${signal}`);
        this.cleanup();
      });

      // Capture stdout for port detection
      this.process.stdout?.on("data", (data) => {
        const output = data.toString();
        stdoutBuffer += output;

        // Look for server ready message with port info - try multiple patterns
        const serverReadyMatch =
          output.match(/serving on http:\/\/127\.0\.0\.1:(\d+)/i) ||
          output.match(/server running at .*:(\d+)/i) ||
          output.match(/listening on port (\d+)/i) ||
          output.match(/port:\s*(\d+)/i);

        if (serverReadyMatch) {
          const port = parseInt(serverReadyMatch[1], 10);
          console.log(`ycmd server detected on port ${port} from stdout`);
          this.detectedPort = port;
        }
        console.log("ycmd stdout:", output);
      });

      this.process.stderr?.on("data", (data) => {
        const output = data.toString();
        // console.error("ycmd stderr:", output);

        // Check for "Address already in use" error
        if (
          output.includes("Address already in use") ||
          output.includes("EADDRINUSE") ||
          output.includes("bind: Address already in use")
        ) {
          console.log(
            `Port ${this.configuredPort} is already in use, will retry with different port`
          );
          reject(new Error("PORT_IN_USE"));
          return;
        }
      });

      setTimeout(() => resolve(true), 1000); // Resolve after brief delay if no errors
    });
  }

  /**
   * Wait for server to start and return server info
   */
  private async waitForServerStart(): Promise<YcmdServerInfo> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log(
          "ycmd server startup timeout - server failed to start within 30 seconds"
        );
        reject(new Error("ycmd server failed to start within timeout"));
      }, 30000);

      const host = "127.0.0.1";
      // Use configured port since we pass it via --port argument
      const getPort = () => this.configuredPort;

      // Check for server readiness
      const checkReady = async () => {
        try {
          const port = getPort();
          console.log(`Checking ycmd server health on port ${port}`);

          // Create a temporary server info for health check
          const tempServerInfo: YcmdServerInfo = {
            host,
            port,
            hmacSecret: this.hmacSecret,
            status: "starting" as const,
          };

          const client = new YcmdClient(tempServerInfo);
          const isReady = await client.isReady();

          if (isReady) {
            const finalPort = getPort();
            console.log(`ycmd server is ready on port ${finalPort}`);
            clearTimeout(timeout);
            resolve({
              host,
              port: finalPort,
              hmacSecret: this.hmacSecret,
              status: "starting" as const,
            });
            return;
          }

          // If not ready yet, try again
          setTimeout(checkReady, 1000);
        } catch (error: any) {
          const currentPort = getPort();
          console.log(
            `Health check failed for port ${currentPort}: ${error.message}`
          );
          // Continue trying
          setTimeout(checkReady, 1000);
        }
      };

      // Start checking after a brief delay
      setTimeout(checkReady, 2000);
    });
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    this.process = null;
    if (this.serverInfo) {
      this.serverInfo.status = "stopped";
    }
  }

  /**
   * Force cleanup resources (for process exit handler)
   */
  private forceCleanup(): void {
    if (this.process && !this.process.killed) {
      console.log("Force killing ycmd server process on parent exit");
      this.process.kill("SIGKILL");
    }
    this.process = null;
    this.serverInfo = null;
  }

  /**
   * Setup exit handler (separate method for clarity)
   */
  private setupExitHandler(): void {
    // Handle normal process exit
    process.on("exit", () => this.forceCleanup());
    
    // Handle Ctrl+C (SIGINT)
    process.on("SIGINT", () => {
      console.log("\nReceived SIGINT (Ctrl+C), shutting down ycmd server gracefully...");
      this.gracefulShutdown().finally(() => {
        process.exit(0);
      });
    });
    
    // Handle SIGTERM (termination signal)
    process.on("SIGTERM", () => {
      console.log("\nReceived SIGTERM, shutting down ycmd server gracefully...");
      this.gracefulShutdown().finally(() => {
        process.exit(0);
      });
    });
  }

  /**
   * Graceful shutdown method
   */
  private async gracefulShutdown(): Promise<void> {
    try {
      await this.stop();
    } catch (error) {
      console.error("Error during graceful shutdown:", error);
    }
  }

  /**
   * Find an available port starting from the preferred port
   */
  private async findAvailablePort(preferredPort: number): Promise<number> {
    if (preferredPort === 0) {
      // Start scanning from default port range
      preferredPort = 8080;
    }

    // Check if preferred port is available
    if (await this.isPortAvailable(preferredPort)) {
      return preferredPort;
    }

    // Scan for available ports in range 8080-8090
    for (let port = 8080; port <= 8090; port++) {
      if (await this.isPortAvailable(port)) {
        console.log(
          `Port ${preferredPort} is busy, using port ${port} instead`
        );
        return port;
      }
    }

    throw new Error(`No available ports found in range 8080-8090`);
  }

  /**
   * Check if a port is available
   */
  private async isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(port, () => {
        server.once("close", () => resolve(true));
        server.close();
      });
      server.on("error", () => resolve(false));
    });
  }

  /**
   * Restart the server
   */
  async restart(
    workspaceRoot?: string,
    port?: number
  ): Promise<YcmdServerInfo> {
    if (this.isRunning()) {
      await this.stop();
    }
    return this.start(workspaceRoot, port);
  }
}
