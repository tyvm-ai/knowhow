import * as path from 'path';
import * as fs from 'fs';

/**
 * Resolve a filepath to an absolute path, defaulting to CWD for relative paths
 */
export function resolveFilePath(filepath: string, workspaceRoot?: string): string {
  // If already absolute, return as-is
  if (path.isAbsolute(filepath)) {
    return filepath;
  }

  // For relative paths, resolve against workspace root or CWD
  const basePath = workspaceRoot || process.cwd();
  return path.resolve(basePath, filepath);
}

/**
 * Get the workspace root, defaulting to CWD if not provided
 */
export function resolveWorkspaceRoot(): string {
  return  process.cwd();
}

/**
 * Check if a file exists
 */
export async function fileExists(filepath: string): Promise<boolean> {
  try {
    await fs.promises.access(filepath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the nearest tsconfig.json or package.json to determine project root
 */
export function findProjectRoot(startPath: string): string {
  let currentPath = path.resolve(startPath);
  const rootPath = path.parse(currentPath).root;

  while (currentPath !== rootPath) {
    const tsconfigPath = path.join(currentPath, 'tsconfig.json');
    const packageJsonPath = path.join(currentPath, 'package.json');

    if (fs.existsSync(tsconfigPath) || fs.existsSync(packageJsonPath)) {
      console.log(`Found project root at: ${currentPath}`);
      return currentPath;
    }

    currentPath = path.dirname(currentPath);
  }

  // Fall back to original path if no project markers found
  console.warn(`No project root found, returning start path: ${startPath}`);
  return startPath;
}
