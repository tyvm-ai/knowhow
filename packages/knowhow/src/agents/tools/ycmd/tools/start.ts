import { ycmdServerManager } from '../serverManager';
import { YcmdClient } from '../client';
import { YcmdInstaller } from '../installer';
import { resolveWorkspaceRoot, findProjectRoot } from '../utils/pathUtils';

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
    if ((await ycmdServerManager.isRunning()) && !params.forceRestart) {
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
    if (params.forceRestart && (await ycmdServerManager.isRunning())) {
      await ycmdServerManager.stop();
    }

    // Resolve workspace root with CWD default and project root detection
    const resolvedWorkspaceRoot = resolveWorkspaceRoot();
    const projectRoot = findProjectRoot(resolvedWorkspaceRoot);

    // Start the server with resolved project root
    const serverInfo = await ycmdServerManager.start(projectRoot, params.port);

    // Verify server is responsive
    const client = new YcmdClient(serverInfo);
    const isReady = await client.isReady();

    if (!isReady) {
      throw new Error('Server started but is not ready');
    }

    // Load extra conf file if workspace is specified
    if (projectRoot) {
      try {
        await client.loadExtraConfFile(projectRoot);
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
