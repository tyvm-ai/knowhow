import type { LogLevel } from "./services/EventService";

/**
 * App-wide logger utility.
 *
 * Features:
 * 1. `logger.info/warn/error(source, message)` — routes through EventService
 * 2. `Logger.of("ClassName")` — creates a bound logger so you don't repeat the source
 * 3. `logger.installConsoleOverload()` — replaces console.log/warn/error/info with
 *    our closure, so ALL output (including third-party modules) goes through us
 * 4. `logger.silence()` / `logger.unsilence()` — suppress all output, useful for
 *    commands that need clean stdout (e.g. github-credentials)
 *
 * Usage (module-level):
 *   import { logger } from "../logger";
 *   logger.info("MyService", "Something happened");
 *
 * Usage (class-level):
 *   import { Logger } from "../logger";
 *   class MyClass {
 *     private logger = Logger.of("MyClass");
 *     doThing() { this.logger.info("Something happened"); }
 *   }
 *
 * Silence mode (for clean-stdout commands):
 *   logger.silence();   // suppress everything
 *   // ... do work that must produce clean stdout ...
 *   logger.unsilence(); // restore
 */

// ---- Internal state ---------------------------------------------------------

let silenced = false;

// Original console methods — saved before any overload is installed
const _originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
};

let consoleOverloadInstalled = false;

// ---- EventService lazy accessor ---------------------------------------------

function getEvents() {
  try {
    const { services } = require("./services") as typeof import("./services");
    return services().Events;
  } catch {
    return null;
  }
}

// ---- Core emit logic --------------------------------------------------------

function emit(source: string, message: string, level: LogLevel): void {
  if (silenced) return;

  try {
    const events = getEvents();
    if (events) {
      events.log(source, message, level);
      return;
    }
  } catch {
    // fall through to direct console output
  }

  // Fallback: use original console methods (bypasses any overload we installed)
  const prefix = source ? `[${source}] ` : "";
  if (level === "warn") _originalConsole.warn(`${prefix}${message}`);
  else if (level === "error") _originalConsole.error(`${prefix}${message}`);
  else _originalConsole.log(`${prefix}${message}`);
}

// ---- Bound logger (returned by Logger.of) -----------------------------------

export interface BoundLogger {
  log(message: string, level?: LogLevel): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function makeBoundLogger(source: string): BoundLogger {
  return {
    log(message: string, level: LogLevel = "info"): void {
      emit(source, message, level);
    },
    info(message: string): void {
      emit(source, message, "info");
    },
    warn(message: string): void {
      emit(source, message, "warn");
    },
    error(message: string): void {
      emit(source, message, "error");
    },
  };
}

// ---- Public API -------------------------------------------------------------

export const logger = {
  log(source: string, message: string, level: LogLevel = "info"): void {
    emit(source, message, level);
  },

  info(source: string, message: string): void {
    emit(source, message, "info");
  },

  warn(source: string, message: string): void {
    emit(source, message, "warn");
  },

  error(source: string, message: string): void {
    emit(source, message, "error");
  },

  /**
   * Suppress all log output. Useful for commands that need clean stdout
   * (e.g. git credential helpers). All logger.* calls and overloaded
   * console.* calls become no-ops until unsilence() is called.
   */
  silence(): void {
    silenced = true;
  },

  /**
   * Restore log output after a silence() call.
   */
  unsilence(): void {
    silenced = false;
  },

  /**
   * Returns true if the logger is currently silenced.
   */
  isSilenced(): boolean {
    return silenced;
  },

  /**
   * Install console overload. After this call, console.log/warn/error/info
   * all route through our closure (respecting silence mode).
   * Safe to call multiple times — only installs once.
   *
   * Call this early in CLI startup (before any modules are loaded) to ensure
   * third-party module logs don't bypass the silence mechanism.
   */
  installConsoleOverload(): void {
    if (consoleOverloadInstalled) return;
    consoleOverloadInstalled = true;

    const route = (level: LogLevel, args: any[]) => {
      if (silenced) return;
      const message = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      emit("", message, level);
    };

    console.log = (...args: any[]) => route("info", args);
    console.info = (...args: any[]) => route("info", args);
    console.warn = (...args: any[]) => route("warn", args);
    // Note: console.error is intentionally NOT overloaded — real errors (stack
    // traces, crash reports) should always be visible. Only suppress via silence().
    // If you want to suppress errors too, call logger.silence() which checks the flag
    // before the overloaded console.warn/log routes reach here anyway.
  },

  /**
   * Remove the console overload and restore original console methods.
   */
  uninstallConsoleOverload(): void {
    if (!consoleOverloadInstalled) return;
    console.log = _originalConsole.log;
    console.info = _originalConsole.info;
    console.warn = _originalConsole.warn;
    consoleOverloadInstalled = false;
  },
};

/**
 * Factory for creating a bound logger with a fixed source name.
 * Ideal for class-level loggers:
 *
 *   class MyClass {
 *     private logger = Logger.of("MyClass");
 *     doThing() { this.logger.info("hello"); }
 *   }
 */
export const Logger = {
  of(source: string): BoundLogger {
    return makeBoundLogger(source);
  },
};
