import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ChatModule, ChatCommand, ChatMode, ChatContext } from "../types";
import { CliChatService } from "../CliChatService";

const execAsync = promisify(exec);

/**
 * Attempts to capture an image from the system clipboard and save it to a temp file.
 * Returns the filepath if successful, or null if the clipboard has no image.
 */
export async function captureClipboardImage(): Promise<string | null> {
  const tmpFile = path.join(os.tmpdir(), `knowhow-clipboard-${Date.now()}.png`);

  const platform = process.platform;

  try {
    if (platform === "darwin") {
      // macOS: use pngpaste if available, fall back to osascript
      try {
        await execAsync(`pngpaste "${tmpFile}"`);
        if (fs.existsSync(tmpFile)) return tmpFile;
      } catch {
        // pngpaste not available or no image in clipboard, try osascript
        const script = `
          tell application "System Events"
            set theImage to the clipboard as «class PNGf»
            set fileRef to open for access POSIX file "${tmpFile}" with write permission
            write theImage to fileRef
            close access fileRef
          end tell
        `;
        try {
          await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
          if (fs.existsSync(tmpFile)) return tmpFile;
        } catch {
          return null;
        }
      }
    } else if (platform === "linux") {
      // Linux: try xclip first, then xsel
      try {
        await execAsync(`xclip -selection clipboard -t image/png -o > "${tmpFile}"`);
        if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 0) return tmpFile;
      } catch {
        try {
          await execAsync(`xsel --clipboard --output > "${tmpFile}"`);
          if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 0) return tmpFile;
        } catch {
          return null;
        }
      }
    } else if (platform === "win32") {
      // Windows: use PowerShell
      const ps = `
        Add-Type -AssemblyName System.Windows.Forms
        $img = [System.Windows.Forms.Clipboard]::GetImage()
        if ($img -ne $null) {
          $img.Save('${tmpFile.replace(/\\/g, "\\\\")}')
          Write-Output 'saved'
        } else {
          Write-Output 'no image'
        }
      `;
      const { stdout } = await execAsync(`powershell -Command "${ps.replace(/"/g, '\\"')}"`);
      if (stdout.trim() === "saved" && fs.existsSync(tmpFile)) return tmpFile;
    }
  } catch {
    // Silently fail - clipboard doesn't contain an image
  }

  // Clean up empty file if created
  try {
    if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size === 0) {
      fs.unlinkSync(tmpFile);
    }
  } catch { /* ignore */ }

  return null;
}

export class ClipboardImageModule implements ChatModule {
  name = "clipboard-image";
  description = "Handles clipboard image paste detection and capture";
  commands: ChatCommand[] = [];
  modes: ChatMode[] = [];

  getCommands(): ChatCommand[] {
    return [
      {
        name: "paste",
        description: "Capture image from clipboard and send to agent",
        handler: this.handlePasteCommand.bind(this),
      },
    ];
  }

  getModes(): ChatMode[] {
    return [];
  }

  async initialize(chatService: CliChatService): Promise<void> {
    // Register /paste command
    chatService.registerCommand({
      name: "paste",
      description: "Capture image from clipboard and send to agent",
      handler: this.handlePasteCommand.bind(this),
    });

  }

  private async handlePasteCommand(args: string[]): Promise<{ handled: boolean; contents?: string }> {
    console.log("🔍 Checking clipboard for image...");
    const filepath = await captureClipboardImage();

    if (!filepath) {
      console.log("No image found in clipboard. Copy an image first, then use /paste.");
      return { handled: true };
    }

    console.log(`📋 Image captured: ${filepath}`);

    // Return as not-handled so the filepath flows through to modules (AgentModule)
    return { handled: false, contents: filepath };
  }

  async handleInput(input: string, context: ChatContext): Promise<boolean> {
    return false; // This module only handles commands
  }

  async cleanup(): Promise<void> {
  }
}
