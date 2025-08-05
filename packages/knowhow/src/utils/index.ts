import gitignoreToGlob from "gitignore-to-glob";
import { promisify } from "util";
import * as util from "util";
import { exec } from "child_process";
import * as fs from "fs";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

marked.use(markedTerminal());

export const fileExists = promisify(fs.exists);
export const readFile = promisify(fs.readFile);
export const writeFile = promisify(fs.writeFile);
export const mkdir = promisify(fs.mkdir);
export const execAsync = util.promisify(exec);
export const fileStat = promisify(fs.stat);
export const wait = promisify(setTimeout);

export const askHistory = [];

export const ask = async (
  question: string,
  options: string[] = [],
  history = []
) => {
  const fullHistory = [...askHistory, ...history];
  const readline = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
    history: fullHistory,
    completer: (line) => {
      const hits = options.filter((c) => c?.startsWith(line));
      return [hits.length ? hits : options, line];
    },
    terminal: true,
  });

  const _ask = util.promisify(readline.question).bind(readline);
  const answer = await _ask(question);
  readline.close();

  return answer;
};

/**
 * Enhanced ask function that handles paste operations with newlines
 * and provides a better multi-line input experience
 */
export const askWithPaste = async (
  question: string,
  options: string[] = [],
  history: string[] = [],
  submitKeys: string[] = ["ctrl+d", "ctrl+enter"]
): Promise<string> => {
  const readline = require("readline");
  const fullHistory = [...askHistory, ...history];

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      history: fullHistory,
      completer: (line: string) => {
        const hits = options.filter((c) => c?.startsWith(line));
        return [hits.length ? hits : options, line];
      },
      terminal: true,
    });

    let buffer = "";
    let currentLine = "";
    let cursorPos = 0;
    const historyIndex = -1;

    // Display the question
    process.stdout.write(question);

    // Handle raw input to detect paste operations and special keys
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      rl.close();
    };

    process.stdin.on("data", (data) => {
      const input = data.toString();

      // Handle Ctrl+C
      if (input === "\u0003") {
        cleanup();
        process.exit(0);
        return;
      }

      // Handle Ctrl+D (submit)
      if (input === "\u0004") {
        process.stdout.write("\n");
        cleanup();
        resolve(buffer.trim());
        return;
      }

      // Handle Ctrl+Enter (submit)
      if (input === "\r\n" || input === "\n\r") {
        process.stdout.write("\n");
        cleanup();
        resolve(buffer.trim());
        return;
      }

      // Handle regular Enter (add newline to buffer)
      if (input === "\r" || input === "\n") {
        buffer += currentLine + "\n";
        currentLine = "";
        cursorPos = 0;
        process.stdout.write("\n");
        return;
      }

      // Handle Backspace
      if (input === "\u007f" || input === "\b") {
        if (cursorPos > 0) {
          currentLine =
            currentLine.slice(0, cursorPos - 1) + currentLine.slice(cursorPos);
          cursorPos--;
          // Redraw current line
          process.stdout.write(
            "\r" +
              " ".repeat(question.length + currentLine.length + 1) +
              "\r" +
              question +
              currentLine
          );
          process.stdout.write("\u001b[" + (question.length + cursorPos) + "G");
        }
        return;
      }

      // Handle Tab (autocomplete)
      if (input === "\t" && options.length > 0) {
        const hits = options.filter((c) => c?.startsWith(currentLine));
        if (hits.length === 1) {
          currentLine = hits[0];
          cursorPos = currentLine.length;
          process.stdout.write("\r" + question + currentLine);
        }
        return;
      }

      // Handle regular characters (including pasted content)
      if (input.length > 1) {
        // This is likely a paste operation
        currentLine =
          currentLine.slice(0, cursorPos) +
          input +
          currentLine.slice(cursorPos);
        cursorPos += input.length;
      } else if (input >= " ") {
        // Single printable character
        currentLine =
          currentLine.slice(0, cursorPos) +
          input +
          currentLine.slice(cursorPos);
        cursorPos++;
      }

      // Redraw current line
      process.stdout.write("\r" + question + currentLine);
      if (cursorPos < currentLine.length) {
        process.stdout.write("\u001b[" + (question.length + cursorPos) + "G");
      }
    });
  });
};

export const Marked = marked;

export function dotp(x, y) {
  function dotp_sum(a, b) {
    return a + b;
  }
  function dotp_times(a, i) {
    return x[i] * y[i];
  }
  return x.map(dotp_times).reduce(dotp_sum, 0);
}

export function cosineSimilarity(A, B) {
  const similarity =
    dotp(A, B) / (Math.sqrt(dotp(A, A)) * Math.sqrt(dotp(B, B)));
  return similarity;
}

const NEWLINE_REPLACE = "<ESC_NEWLINE>";
export function replaceEscapedNewLines(str: string): string {
  // const replacedStr = str.replace(/\\n/g, NEWLINE_REPLACE);
  return str;
}

export function escapeNewLines(str: string): string {
  return str.replace(/\\n/g, "\\n");
}

export function restoreEscapedNewLines(str: string): string {
  const escaped = [NEWLINE_REPLACE, "<ESCAPE_NEWLINE>"];
  let replacedStr = str;
  for (const esc of escaped) {
    replacedStr = replacedStr.replace(new RegExp(esc, "g"), "\\n");
  }
  return replacedStr;
}

export function splitByNewLines(str: string): string[] {
  const replacedStr = replaceEscapedNewLines(str);

  // Step 2: Split the string by actual new lines
  const parts = replacedStr.split("\n");

  // Step 3: Restore the escaped new lines in the split parts
  return parts.map((part) => restoreEscapedNewLines(part));
}

export function toUniqueArray<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function mcpToolName(toolName: string): string {
  const split = toolName.split("_");

  if (split.length < 2) {
    return null;
  }

  return split.slice(2).join("_");
}

export function takeFirstNWords(str: string, n: number): string {
  const words = str.split(" ");
  if (words.length <= n) {
    return str;
  }
  return words.slice(n).join(" ");
}
