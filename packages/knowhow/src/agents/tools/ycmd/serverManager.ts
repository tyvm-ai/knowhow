import { YcmdServer, YcmdServerInfo } from './server';
import { YcmdClient } from './client';
import * as net from 'net';

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
    const commonPorts = [8080, 8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089];
    
    for (const port of commonPorts) {
      try {
        // First check if port is open
        const isOpen = await this.checkPort('127.0.0.1', port);
        if (!isOpen) continue;
        
        // Try to connect as a ycmd server
        const serverInfo: YcmdServerInfo = {
          port,
          host: '127.0.0.1',
          hmacSecret: '', // We'll try without HMAC first
          status: 'running'
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
      
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      
      socket.on('error', () => {
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