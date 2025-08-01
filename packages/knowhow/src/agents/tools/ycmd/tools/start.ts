import { ycmdServerManager } from '../serverManager';
import { YcmdClient } from '../client';
import { YcmdInstaller } from '../installer';

export interface YcmdStartParams {
  workspaceRoot?: string;
  port?: number;
  host?: string;
  logLevel?: 'debug' | 'info' | 'warning' | 'error';
  forceRestart?: boolean;
}

/**
 * Start ycmd server for code intelligence
 */
export async function ycmdStart(params: YcmdStartParams = {}): Promise<{
  success: boolean;
  serverInfo?: {
    host: string;
    port: number;
    status: string;
    pid?: number;
  };
  message: string;
}> {
  try {
    // Check if ycmd is installed
    const installInfo = YcmdInstaller.getInstallationInfo();
    if (!installInfo.isInstalled && installInfo.otherInstallations.length === 0) {
      await YcmdInstaller.install();
    }

    // Check if server is already running
    if (ycmdServerManager.isRunning() && !params.forceRestart) {
      const serverInfo = ycmdServerManager.getServerInfo();
      return {
        success: true,
        serverInfo: serverInfo ? {
          host: serverInfo.host,
          port: serverInfo.port,
          status: serverInfo.status,
          pid: serverInfo.pid
        } : undefined,
        message: 'ycmd server is already running'
      };
    }

    // Stop existing server if force restart
    if (params.forceRestart && ycmdServerManager.isRunning()) {
      await ycmdServerManager.stop();
    }

    // Start the server
    const serverInfo = await ycmdServerManager.start(params.workspaceRoot, params.port);

    // Verify server is responsive
    const client = new YcmdClient(serverInfo);
    const isReady = await client.isReady();

    if (!isReady) {
      throw new Error('Server started but is not ready');
    }

    // Load extra conf file if workspace is specified
    if (params.workspaceRoot) {
      try {
        await client.loadExtraConfFile(params.workspaceRoot);
      } catch (error) {
        console.warn('Failed to load extra conf file:', error);
      }
    }

    return {
      success: true,
      serverInfo: {
        host: serverInfo.host,
        port: serverInfo.port,
        status: serverInfo.status,
        pid: serverInfo.pid
      },
      message: `ycmd server started successfully on ${serverInfo.host}:${serverInfo.port}`
    };

  } catch (error) {
    return {
      success: false,
      message: `Failed to start ycmd server: ${(error as Error).message}`
    };
  }
}
