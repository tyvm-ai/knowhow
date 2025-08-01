import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { YcmdDetection } from './detection';

/**
 * Installation manager for ycmd
 */
export class YcmdInstaller {
  private static readonly YCMD_REPO_URL = 'https://github.com/ycm-core/ycmd.git';

  /**
   * Get the default ycmd installation path
   */
  static getDefaultInstallPath(): string {
    return path.join(os.homedir(), '.knowhow/ycmd');
  }

  /**
   * Check if ycmd is installed in the specified directory
   */
  static isInstalledInKnowhow(installPath?: string): boolean {
    const ycmdPath = installPath || this.getDefaultInstallPath();
    return YcmdDetection.isValidYcmdInstallation(ycmdPath);
  }

  /**
   * Install ycmd in the specified directory (defaults to knowhow directory)
   */
  static async install(installPath?: string): Promise<void> {
    const ycmdPath = installPath || this.getDefaultInstallPath();
    console.log(`Installing ycmd to ${ycmdPath}...`);

    // Ensure parent directory exists
    const parentDir = path.dirname(ycmdPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Check prerequisites
    this.checkPrerequisites();

    try {
      // Clone ycmd repository
      console.log('Cloning ycmd repository...');
      execSync(`git clone --recursive ${this.YCMD_REPO_URL} "${ycmdPath}"`, {
        stdio: 'inherit',
        cwd: parentDir
      });

      // Build ycmd
      console.log('Building ycmd...');
      await this.buildYcmd(ycmdPath);

      console.log('ycmd installation completed successfully');
    } catch (error) {
      // Clean up on failure
      if (fs.existsSync(ycmdPath)) {
        fs.rmSync(ycmdPath, { recursive: true, force: true });
      }
      throw new Error(`Failed to install ycmd: ${(error as Error).message}`);
    }
  }

  /**
   * Build ycmd after cloning
   */
  private static async buildYcmd(ycmdPath: string): Promise<void> {
    const buildScript = path.join(ycmdPath, 'build.py');

    if (!fs.existsSync(buildScript)) {
      throw new Error('build.py not found in ycmd directory');
    }

    const pythonCmd = YcmdDetection.getPythonCommand();

    // Run the build script
    execSync(`${pythonCmd} build.py --all`, {
      stdio: 'inherit',
      cwd: ycmdPath
    });
  }

  /**
   * Check if all prerequisites are available
   */
  private static checkPrerequisites(): void {
    // Check git
    try {
      execSync('git --version', { stdio: 'pipe' });
    } catch {
      throw new Error('Git is required but not found in PATH');
    }

    // Check Python
    if (!YcmdDetection.isPythonAvailable()) {
      throw new Error('Python 3 is required but not found in PATH');
    }

    // Check cmake (required for building)
    try {
      execSync('cmake --version', { stdio: 'pipe' });
    } catch {
      throw new Error('CMake is required but not found in PATH. Please install cmake.');
    }

    // Check build tools based on platform
    this.checkPlatformPrerequisites();
  }

  /**
   * Check platform-specific prerequisites
   */
  private static checkPlatformPrerequisites(): void {
    const platform = os.platform();

    switch (platform) {
      case 'linux':
        // Check for build-essential or equivalent
        try {
          execSync('gcc --version', { stdio: 'pipe' });
        } catch {
          throw new Error('GCC compiler is required but not found. Please install build-essential or equivalent.');
        }
        break;

      case 'darwin':
        // Check for Xcode command line tools
        try {
          execSync('xcode-select --print-path', { stdio: 'pipe' });
        } catch {
          throw new Error('Xcode command line tools are required. Please run: xcode-select --install');
        }
        break;

      case 'win32':
        // Check for Visual Studio Build Tools
        try {
          execSync('cl', { stdio: 'pipe' });
        } catch {
          console.warn('Visual Studio Build Tools not detected. ycmd build may fail.');
        }
        break;

      default:
        console.warn(`Platform ${platform} may not be fully supported`);
    }
  }

  /**
   * Uninstall ycmd from specified directory
   */
  static uninstall(installPath?: string): void {
    const ycmdPath = installPath || this.getDefaultInstallPath();
    if (fs.existsSync(ycmdPath)) {
      console.log('Uninstalling ycmd...');
      fs.rmSync(ycmdPath, { recursive: true, force: true });
      console.log('ycmd uninstalled successfully');
    } else {
      console.log('ycmd is not installed in specified directory');
    }
  }

  /**
   * Update ycmd installation
   */
  static async update(installPath?: string): Promise<void> {
    const ycmdPath = installPath || this.getDefaultInstallPath();
    if (!this.isInstalledInKnowhow(ycmdPath)) {
      throw new Error('ycmd is not installed in specified directory');
    }

    console.log('Updating ycmd...');

    try {
      // Pull latest changes
      execSync('git pull origin master', {
        stdio: 'inherit',
        cwd: ycmdPath
      });

      // Update submodules
      execSync('git submodule update --recursive', {
        stdio: 'inherit',
        cwd: ycmdPath
      });

      // Rebuild
      await this.buildYcmd(ycmdPath);

      console.log('ycmd updated successfully');
    } catch (error) {
      throw new Error(`Failed to update ycmd: ${(error as Error).message}`);
    }
  }

  /**
   * Get installation status and information
   */
  static getInstallationInfo(installPath?: string): {
    isInstalled: boolean;
    path?: string;
    version?: string;
    hasOtherInstallations: boolean;
    otherInstallations: string[];
  } {
    const ycmdPath = installPath || this.getDefaultInstallPath();
    const isInstalled = this.isInstalledInKnowhow(ycmdPath);
    const otherInstallations = YcmdDetection.findInstallations()
      .filter(p => p !== ycmdPath);

    const info = {
      isInstalled,
      hasOtherInstallations: otherInstallations.length > 0,
      otherInstallations
    };

    if (isInstalled) {
      return {
        ...info,
        path: ycmdPath,
        version: this.getVersion(ycmdPath)
      };
    }

    return info;
  }

  /**
   * Get ycmd version from installation
   */
  private static getVersion(ycmdPath: string): string | undefined {
    try {
      const versionFile = path.join(ycmdPath, 'ycmd', 'VERSION');
      if (fs.existsSync(versionFile)) {
        return fs.readFileSync(versionFile, 'utf8').trim();
      }

      // Try to get version from git
      const gitVersion = execSync('git describe --tags --abbrev=0', {
        cwd: ycmdPath,
        encoding: 'utf8'
      }).trim();

      return gitVersion;
    } catch {
      return undefined;
    }
  }
}
