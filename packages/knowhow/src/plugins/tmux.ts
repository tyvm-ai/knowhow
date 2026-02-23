import { PluginBase, PluginMeta } from "./PluginBase";
import { PluginContext } from "./types";
import { execAsync } from "../utils";

export class TmuxPlugin extends PluginBase {
  static readonly meta: PluginMeta = {
    key: "tmux",
    name: "Tmux Plugin",
    requires: [],
  };

  meta = TmuxPlugin.meta;

  constructor(context: PluginContext) {
    super(context);
  }

  async embed(userPrompt: string) {
    return [];
  }

  /**
   * Check if we're currently in a tmux session
   */
  async isInTmux(): Promise<boolean> {
    try {
      const { stdout } = await execAsync("echo $TMUX");
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get current session information
   */
  async getCurrentSession(): Promise<string> {
    try {
      const { stdout } = await execAsync(
        "tmux display-message -p '#{session_name}:#{window_index}:#{window_name}'"
      );
      return stdout.trim();
    } catch (error) {
      return "";
    }
  }

  /**
   * Get all tmux sessions
   */
  async getSessions(): Promise<string[]> {
    try {
      const { stdout } = await execAsync("tmux list-sessions");
      return stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Get all windows in current session
   */
  async getWindows(): Promise<string[]> {
    try {
      const { stdout } = await execAsync("tmux list-windows");
      return stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Get all panes across all sessions
   */
  async getPanes(): Promise<string[]> {
    try {
      const { stdout } = await execAsync(
        "tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_title} #{pane_current_command} #{pane_current_path}'"
      );
      return stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  async call(): Promise<string> {
    const inTmux = await this.isInTmux();

    if (!inTmux) {
      return "TMUX PLUGIN: Not currently in a tmux session";
    }

    const currentSession = await this.getCurrentSession();
    const sessions = await this.getSessions();
    const windows = await this.getWindows();
    const panes = await this.getPanes();

    const output = `TMUX PLUGIN: You are currently in a tmux session. This means you can use tmux commands to help debug and navigate.

**Current Session/Window**: ${currentSession}

**Available Sessions**:
${sessions.map((s) => `  - ${s}`).join("\n")}

**Windows in Current Session**:
${windows.map((w) => `  - ${w}`).join("\n")}

**All Panes** (showing running commands and paths):
${panes.map((p) => `  - ${p}`).join("\n")}

**Useful tmux commands for debugging**:
- \`tmux send-keys -t <session>:<window>.<pane> "command" Enter\` - Send a command to a specific pane
- \`tmux capture-pane -t <session>:<window>.<pane> -p\` - Capture output from a pane
- \`tmux list-panes -a\` - List all panes
- \`tmux switch-client -t <session>\` - Switch to another session
- \`tmux select-window -t <window>\` - Switch to another window
- \`tmux select-pane -t <pane>\` - Switch to another pane

You can use execCommand to run these tmux commands to inspect running processes, send commands to other panes, or capture output for debugging.`;

    return output;
  }
}
