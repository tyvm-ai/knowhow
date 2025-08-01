import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

/**
 * Utility class for detecting existing ycmd installations
 */
export class YcmdDetection {
  /**
   * Common paths where ycmd might be installed
   */
  private static readonly COMMON_PATHS = [
    // System-wide installations
    '/usr/local/bin/ycmd',
    '/usr/bin/ycmd',
    '/opt/ycmd',
    // User installations
    path.join(os.homedir(), '.local/bin/ycmd'),
    path.join(os.homedir(), '.vim/plugged/YouCompleteMe/third_party/ycmd'),
    path.join(os.homedir(), '.config/nvim/plugged/YouCompleteMe/third_party/ycmd'),
    // Knowhow installation path
    path.join(os.homedir(), '.knowhow/ycmd'),
  ];

  /**
   * Check if ycmd is available in the system PATH
   */
  static isInPath(): boolean {
    try {
      execSync('which ycmd', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find all available ycmd installations
   */
  static findInstallations(): string[] {
    const installations: string[] = [];

    // Check common paths
    for (const ycmdPath of this.COMMON_PATHS) {
      if (this.isValidYcmdInstallation(ycmdPath)) {
        installations.push(ycmdPath);
      }
    }

    // Check if ycmd is in PATH
    if (this.isInPath()) {
      try {
        const pathResult = execSync('which ycmd', { encoding: 'utf8' }).trim();
        if (pathResult && !installations.includes(pathResult)) {
          installations.push(pathResult);
        }
      } catch {
        // Ignore errors
      }
    }

    return installations;
  }

  /**
   * Get the preferred ycmd installation path
   */
  static getPreferredInstallation(): string | null {
    const installations = this.findInstallations();
    
    if (installations.length === 0) {
      return null;
    }

    // Prefer knowhow installation first
    const knowhowPath = path.join(os.homedir(), '.knowhow/ycmd');
    if (installations.includes(knowhowPath)) {
      return knowhowPath;
    }

    // Then prefer system PATH
    if (this.isInPath()) {
      try {
        return execSync('which ycmd', { encoding: 'utf8' }).trim();
      } catch {
        // Fall through to first installation
      }
    }

    // Return first available installation
    return installations[0];
  }

  /**
   * Check if a path contains a valid ycmd installation
   */
  static isValidYcmdInstallation(ycmdPath: string): boolean {
    try {
      // Check if directory exists
      if (!fs.existsSync(ycmdPath)) {
        return false;
      }

      const stat = fs.statSync(ycmdPath);
      
      // If it's an executable file (direct ycmd binary)
      if (stat.isFile()) {
        return this.isExecutable(ycmdPath);
      }

      // If it's a directory, look for ycmd executable or ycmd.py
      if (stat.isDirectory()) {
        const ycmdBinary = path.join(ycmdPath, 'ycmd');
        const ycmdScript = path.join(ycmdPath, 'ycmd.py');
        const ycmdMainScript = path.join(ycmdPath, 'ycmd', '__main__.py');

        return fs.existsSync(ycmdBinary) || 
               fs.existsSync(ycmdScript) || 
               fs.existsSync(ycmdMainScript);
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check if a file is executable
   */
  private static isExecutable(filePath: string): boolean {
    try {
      fs.accessSync(filePath, fs.constants.F_OK | fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the ycmd executable command for a given installation path
   */
  static getYcmdCommand(ycmdPath: string): string[] {
    if (!this.isValidYcmdInstallation(ycmdPath)) {
      throw new Error(`Invalid ycmd installation: ${ycmdPath}`);
    }

    const stat = fs.statSync(ycmdPath);

    // If it's an executable file
    if (stat.isFile() && this.isExecutable(ycmdPath)) {
      return [ycmdPath];
    }

    // If it's a directory, determine the appropriate command
    if (stat.isDirectory()) {
      const ycmdBinary = path.join(ycmdPath, 'ycmd');
      const ycmdScript = path.join(ycmdPath, 'ycmd.py');
      const ycmdMainScript = path.join(ycmdPath, 'ycmd', '__main__.py');

      if (fs.existsSync(ycmdBinary) && this.isExecutable(ycmdBinary)) {
        return [ycmdBinary];
      }

      if (fs.existsSync(ycmdScript)) {
        return ['python3', ycmdScript];
      }

      if (fs.existsSync(ycmdMainScript)) {
        return ['python3', '-m', 'ycmd'];
      }
    }

    throw new Error(`Could not determine ycmd command for: ${ycmdPath}`);
  }

  /**
   * Check if Python is available for running ycmd
   */
  static isPythonAvailable(): boolean {
    try {
      execSync('python3 --version', { stdio: 'pipe' });
      return true;
    } catch {
      try {
        execSync('python --version', { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Get Python command (python3 or python)
   */
  static getPythonCommand(): string {
    try {
      execSync('python3 --version', { stdio: 'pipe' });
      return 'python3';
    } catch {
      try {
        execSync('python --version', { stdio: 'pipe' });
        return 'python';
      } catch {
        throw new Error('Python is not available in PATH');
      }
    }
  }
}