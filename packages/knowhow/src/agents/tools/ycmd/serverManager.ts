import { YcmdServer, YcmdServerInfo } from './server';

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
  public isRunning(): boolean {
    return this.server ? this.server.isRunning() : false;
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
  public async start(workspaceRoot?: string, port?: number): Promise<YcmdServerInfo> {
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
  public async restart(workspaceRoot?: string, port?: number): Promise<YcmdServerInfo> {
    const server = this.getServer();
    return server.restart(workspaceRoot, port);
  }
}

export const ycmdServerManager = YcmdServerManager.getInstance();