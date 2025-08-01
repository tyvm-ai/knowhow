import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getConfig } from "../../../config";
import { spawn, ChildProcess } from 'child_process';
import { YcmdDetection } from './detection';
import { YcmdInstaller } from './installer';

export interface YcmdServerInfo {
  port: number;
  host: string;
  hmacSecret: string;
  pid?: number;
  status: 'starting' | 'running' | 'stopped' | 'error';
}

/**
 * Manages ycmd server lifecycle
 */
export class YcmdServer {
  private process: ChildProcess | null = null;
  private serverInfo: YcmdServerInfo | null = null;
  private hmacSecret: string;
  private ycmdPath: string;

  constructor() {
    // Generate a unique HMAC secret for this server instance
    this.hmacSecret = crypto.randomBytes(32).toString('base64');

    // Find ycmd installation
    const installations = YcmdDetection.findInstallations();
    if (installations.length === 0) {
      throw new Error('No ycmd installation found. Please install ycmd first.');
    }

    // Use configured install path or prefer knowhow installation if available
    const knowhowConfig = require('../../../config').getConfigSync();
    const ycmdConfig = knowhowConfig.ycmd || {};
    const configuredPath = ycmdConfig.installPath;
    const knowhowPath = path.join(require('os').homedir(), '.knowhow/ycmd');
    this.ycmdPath = (configuredPath && installations.find(p => p === configuredPath)) ||
                   installations.find(p => p === knowhowPath) || installations[0];
  }

  /**
   * Start the ycmd server
   */
  async start(workspaceRoot?: string): Promise<YcmdServerInfo> {
    if (this.isRunning()) {
      throw new Error('ycmd server is already running');
    }

    console.log('Starting ycmd server...');

    try {
    // Get knowhow config for ycmd settings
    const knowhowConfig = await getConfig();
    const ycmdConfig = knowhowConfig.ycmd || {};
    
    // Check if ycmd is enabled in config
    if (ycmdConfig.enabled === false) {
      throw new Error("ycmd is disabled in configuration. Set ycmd.enabled to true in .knowhow/knowhow.json");
    }

      // Create server configuration
      const serverConfig = this.createServerConfig(workspaceRoot);
      const configPath = await this.writeServerConfig(serverConfig);

      // Start ycmd process
      const pythonCmd = YcmdDetection.getPythonCommand();
      const ycmdScript = path.join(this.ycmdPath, 'ycmd', '__main__.py');

      this.process = spawn(pythonCmd, [ycmdScript, '--options_file', configPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.ycmdPath
      });

      // Set up process event handlers
      this.setupProcessHandlers();

      // Wait for server to start and get port
      const serverInfo = await this.waitForServerStart();
      
      this.serverInfo = {
        ...serverInfo,
        pid: this.process.pid,
        status: 'running'
      };

      console.log(`ycmd server started on ${serverInfo.host}:${serverInfo.port}`);
      return this.serverInfo;

    } catch (error) {
      this.cleanup();
      throw new Error(`Failed to start ycmd server: ${(error as Error).message}`);
    }
  }

  /**
   * Stop the ycmd server
   */
  async stop(): Promise<void> {
    if (!this.isRunning()) {
      console.log('ycmd server is not running');
      return;
    }

    console.log('Stopping ycmd server...');

    return new Promise((resolve, reject) => {
      if (!this.process) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        // Force kill if graceful shutdown fails
        this.process?.kill('SIGKILL');
        reject(new Error('ycmd server failed to stop gracefully'));
      }, 5000);

      this.process.once('exit', () => {
        clearTimeout(timeout);
        this.cleanup();
        console.log('ycmd server stopped');
        resolve();
      });

      // Send shutdown signal
      this.process.kill('SIGTERM');
    });
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed && this.serverInfo?.status === 'running';
  }

  /**
   * Get server information
   */
  getServerInfo(): YcmdServerInfo | null {
    return this.serverInfo;
  }

  /**
   * Health check the server
   */
  async healthCheck(): Promise<boolean> {
    if (!this.isRunning() || !this.serverInfo) {
      return false;
    }

    try {
      // Try to make a simple request to the server
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(`http://${this.serverInfo.host}:${this.serverInfo.port}/healthy`, {
        method: 'GET',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Create server configuration object
   */
  private createServerConfig(workspaceRoot?: string): any {
    // Get knowhow config for ycmd settings
    const knowhowConfig = require('../../../config').getConfigSync();
    const ycmdConfig = knowhowConfig.ycmd || {};
    
    return {
      hmac_secret: this.hmacSecret,
      port: ycmdConfig.port || 0, // Let ycmd choose a free port
      host: '127.0.0.1',
      server_keep_logfiles: true,
      server_use_vim_stdout: false,
      log_level: ycmdConfig.logLevel || 'info',
      max_diagnostics_to_display: 30,
      auto_trigger_completion: true,
      completion_timeout: (ycmdConfig.completionTimeout || 5000) / 1000,
      // Language-specific settings
      global_ycm_extra_conf: workspaceRoot ? 
        path.join(workspaceRoot, '.ycm_extra_conf.py') : undefined,
      confirm_extra_conf: false,
      auto_start_csharp_server: true,
      auto_stop_csharp_server: true,
      use_clangd: true,
      clangd_binary_path: '',
      clangd_args: [],
      java_jdtls_workspace_root_path: workspaceRoot || '',
      python_binary_path: YcmdDetection.getPythonCommand()
    };
  }

  /**
   * Write server configuration to temporary file
   */
  private async writeServerConfig(config: any): Promise<string> {
    const configPath = path.join(require('os').tmpdir(), `ycmd_config_${Date.now()}.json`);
    await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
    return configPath;
  }

  /**
   * Set up process event handlers
   */
  private setupProcessHandlers(): void {
    if (!this.process) return;

    this.process.on('error', (error) => {
      console.error('ycmd server process error:', error);
      if (this.serverInfo) {
        this.serverInfo.status = 'error';
      }
    });

    this.process.on('exit', (code, signal) => {
      console.log(`ycmd server exited with code ${code}, signal ${signal}`);
      this.cleanup();
    });

    // Capture stdout for port detection
    this.process.stdout?.on('data', (data) => {
      const output = data.toString();
      console.log('ycmd stdout:', output);
    });

    this.process.stderr?.on('data', (data) => {
      const output = data.toString();
      console.error('ycmd stderr:', output);
    });
  }

  /**
   * Wait for server to start and return server info
   */
  private async waitForServerStart(): Promise<YcmdServerInfo> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('ycmd server failed to start within timeout'));
      }, 30000);

      const host = '127.0.0.1';

      // Try to detect when server is ready by checking multiple ports
      const checkReady = async () => {
        try {
          for (let port = 8080; port <= 8090; port++) {
            try {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 1000);
              
              const response = await fetch(`http://${host}:${port}/ready`, {
                signal: controller.signal
              });
              
              clearTimeout(timeoutId);

              if (response.ok) {
                clearTimeout(timeout);
                resolve({
                  host: host,
                  port: port,
                  hmacSecret: this.hmacSecret,
                  status: 'starting' as const
                });
                return;
              }
            } catch {
              // Continue trying other ports
            }
          }

          // If not ready yet, try again
          setTimeout(checkReady, 1000);
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
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
      this.serverInfo.status = 'stopped';
    }
  }

  /**
   * Restart the server
   */
  async restart(workspaceRoot?: string): Promise<YcmdServerInfo> {
    if (this.isRunning()) {
      await this.stop();
    }
    return this.start(workspaceRoot);
  }
}