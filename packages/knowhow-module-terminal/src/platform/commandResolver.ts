import * as fs from "fs";
import * as path from "path";

/** Platform boundary for locating executable commands. */
export interface CommandResolver {
  resolve(command: string): string | null;
}

abstract class PathCommandResolver implements CommandResolver {
  constructor(protected readonly environment: NodeJS.ProcessEnv = process.env) {}

  protected abstract pathApi(): typeof path.posix;
  protected abstract commandExtensions(command: string): string[];
  protected abstract accessMode(): number;

  resolve(command: string): string | null {
    const pathApi = this.pathApi();
    const extensions = this.commandExtensions(command);

    // Explicit paths must never fall back to an unrelated command on PATH.
    if (pathApi.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
      return this.firstExecutable(pathApi.resolve(command), extensions);
    }

    for (const pathEntry of (this.environment.PATH || "").split(pathApi.delimiter)) {
      if (!pathEntry) continue;
      // Quoted entries are valid in a Windows PATH and harmless to support on POSIX.
      const directory = pathEntry.replace(/^"|"$/g, "");
      const match = this.firstExecutable(pathApi.join(directory, command), extensions);
      if (match) return match;
    }

    return null;
  }

  private firstExecutable(base: string, extensions: string[]): string | null {
    for (const extension of extensions) {
      const candidate = `${base}${extension}`;
      try {
        fs.accessSync(candidate, this.accessMode());
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Try the next platform-specific candidate.
      }
    }
    return null;
  }
}

/** Windows command lookup follows PATHEXT; executable permission bits do not apply. */
export class WindowsCommandResolver extends PathCommandResolver {
  protected pathApi(): typeof path.win32 {
    return path.win32;
  }

  protected commandExtensions(command: string): string[] {
    const extensions = (this.environment.PATHEXT || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean);
    const hasExecutableExtension = extensions.some((extension) =>
      command.toLowerCase().endsWith(extension.toLowerCase())
    );
    return hasExecutableExtension ? [""] : extensions;
  }

  protected accessMode(): number {
    return fs.constants.F_OK;
  }
}

/** POSIX command lookup requires the executable permission bit. */
export class PosixCommandResolver extends PathCommandResolver {
  protected pathApi(): typeof path.posix {
    return path.posix;
  }

  protected commandExtensions(): string[] {
    return [""];
  }

  protected accessMode(): number {
    return fs.constants.X_OK;
  }
}

export function createCommandResolver(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): CommandResolver {
  return platform === "win32"
    ? new WindowsCommandResolver(environment)
    : new PosixCommandResolver(environment);
}
