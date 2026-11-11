import * as fs from "fs";
import * as path from "path";
import { services, ToolsService } from "../../services";

const RETRY_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_RETRIES = 50;

interface PendingWrite {
  filePath: string;
  content: string;
  isContinuing: boolean;
  isDone: boolean;
  createdAt: number;
}

// Content from writes that failed because the parent directory was missing.
// Lets the agent retry with createDirectories without resending the content.
const pendingWrites = new Map<string, PendingWrite>();

function newRetryKey(): string {
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function prunePendingWrites() {
  const now = Date.now();
  for (const [key, w] of pendingWrites) {
    if (now - w.createdAt > RETRY_TTL_MS) pendingWrites.delete(key);
  }
  while (pendingWrites.size > MAX_PENDING_RETRIES) {
    const oldest = pendingWrites.keys().next().value;
    if (oldest === undefined) break;
    pendingWrites.delete(oldest);
  }
}

/** Test hook. */
export function clearPendingWrites() {
  pendingWrites.clear();
}

/**
 * If the parent directory of `filePath` does not exist, describe which ancestor
 * is missing and the closest one that exists. Returns null when the parent exists.
 */
export function describeMissingParent(filePath: string): {
  missingAncestor: string;
  closestExisting: string;
  closestIsDirectory: boolean;
} | null {
  const abs = path.resolve(filePath);
  const parent = path.dirname(abs);
  if (fs.existsSync(parent)) return null;

  let missing = parent;
  let current = path.dirname(parent);
  while (!fs.existsSync(current) && path.dirname(current) !== current) {
    missing = current;
    current = path.dirname(current);
  }
  let closestIsDirectory = true;
  try {
    closestIsDirectory = fs.statSync(current).isDirectory();
  } catch {}
  return { missingAncestor: missing, closestExisting: current, closestIsDirectory };
}

function missingParentMessage(filePath: string, retryKey?: string): string | null {
  const info = describeMissingParent(filePath);
  if (!info) return null;
  const { missingAncestor, closestExisting, closestIsDirectory } = info;
  const lines = [
    `ENOENT: cannot write ${filePath}: parent directory does not exist (nothing was written).`,
    `Missing: ${missingAncestor}`,
    `Closest existing ancestor: ${closestExisting}${closestIsDirectory ? "" : " (this is a FILE, not a directory)"} (cwd: ${process.cwd()})`,
    `If the path is a typo or the wrong location, fix filePath. `,
  ];
  if (retryKey) {
    lines.push(
      `If this new location is intended, retry the same call with createDirectories: true and retryKey: "${retryKey}" (you can pass an empty content; your original content is held for 10 minutes so you do not need to resend it).`
    );
  } else {
    lines.push(`If this new location is intended, retry with createDirectories: true.`);
  }
  return lines.join("\n");
}

// Tool to write the full contents of a file
export function writeFile(
  filePath: string,
  content: string,
  createDirectories?: boolean
): string {
  try {
    if (createDirectories) {
      fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    }
    fs.writeFileSync(filePath, content);
    return `File ${filePath} written`;
  } catch (e) {
    if (e?.code === "ENOENT") {
      return missingParentMessage(filePath) || e.message;
    }
    return e.message;
  }
}

export async function writeFileChunk(
  filePath: string,
  content: string,
  isContinuing: boolean,
  isDone: boolean,
  createDirectories?: boolean | string,
  retryKey?: string,
  _ctx?: { taskId?: string }
) {
  // Get context from bound ToolsService
  const toolService = (
    this instanceof ToolsService ? this : services().Tools
  ) as ToolsService;
  const context = toolService.getContext();

  // Retry of a write that failed on a missing directory: reuse the held content.
  if (retryKey) {
    const pending = pendingWrites.get(retryKey);
    if (pending && pending.filePath === filePath) {
      if (content === undefined || content === "") {
        content = pending.content;
        isContinuing = pending.isContinuing;
        isDone = pending.isDone;
      }
    } else if (content === undefined || content === "") {
      throw new Error(
        `retryKey "${retryKey}" is unknown, expired, or belongs to a different filePath. Resend the full content.`
      );
    }
  }

  const wantsDirs =
    createDirectories === true ||
    (typeof createDirectories === "string" &&
      createDirectories.trim().toLowerCase() === "true");

  if (!filePath || content === undefined) {
    throw new Error(
      `File path and content are both required. We received: ${JSON.stringify({
        filePath,
        content,
      })}. Make sure you write small chunks of content (4k tokens), otherwise you will hit output limits, resulting in content being empty.`
    );
  }

  // Missing parent directory: error unless the agent opted in. ENOENT is a useful
  // signal that the path may be wrong, so we never create directories silently.
  if (describeMissingParent(filePath)) {
    if (!wantsDirs) {
      prunePendingWrites();
      const key = newRetryKey();
      pendingWrites.set(key, {
        filePath,
        content,
        isContinuing: !!isContinuing,
        isDone: !!isDone,
        createdAt: Date.now(),
      });
      throw new Error(missingParentMessage(filePath, key) as string);
    }
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  }
  if (retryKey) pendingWrites.delete(retryKey);

  // Read original content for event emission
  let originalContent = "";
  try {
    if (fs.existsSync(filePath)) {
      originalContent = fs.readFileSync(filePath, "utf8");
    }
  } catch (error) {
    // If we can't read the original file, continue with empty string
    originalContent = "";
  }

  // Emit pre-edit blocking event
  if (context.Events) {
    await context.Events.emitBlocking("file:pre-edit", {
      filePath,
      taskId: _ctx?.taskId,
      operation: isContinuing ? "append" : "write",
      content,
      originalContent,
    });
  }

  if (!isContinuing) {
    fs.writeFileSync(filePath, content);
  }

  if (isContinuing) {
    fs.appendFileSync(filePath, "\n" + content);
  }

  let message = "";

  if (isContinuing) {
    message = "Appended content to file.";
  }

  if (!isDone) {
    message += " Continue calling this tool until file is done.";
  }

  if (isDone) {
    message = " File write complete. Use readFile to verify";

    // Emit post-edit blocking event to get event results
    let eventResults: any[] = [];
    if (context.Events) {
      // Read updated content for event emission
      const updatedContent = fs.readFileSync(filePath, "utf8");

      eventResults = await context.Events.emitBlocking("file:post-edit", {
        filePath,
        taskId: _ctx?.taskId,
        operation: "write",
        content,
        originalContent,
        updatedContent,
      });
    }

    // Format event results
    let eventResultsText = "";
    if (eventResults && eventResults.length > 0) {
      if (eventResults.length > 0) {
        eventResultsText =
          "\n\nAdditional Information:\n" +
          JSON.stringify(eventResults, null, 2);
      }
    }

    message += eventResultsText;
  }

  return message;
}
