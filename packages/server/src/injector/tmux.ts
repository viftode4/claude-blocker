import { exec } from "child_process";
import { promisify } from "util";
import type { InjectionResult } from "./index.js";

const execAsync = promisify(exec);

export async function injectViaTmux(
  response: string,
  sessionName: string
): Promise<InjectionResult> {
  try {
    // Check if tmux is available
    await execAsync("which tmux");
  } catch {
    return {
      success: false,
      error: "tmux is not installed or not in PATH.",
    };
  }

  try {
    // Check if the session exists
    const { stdout } = await execAsync("tmux list-sessions -F '#{session_name}'");
    const sessions = stdout.trim().split("\n");

    if (!sessions.includes(sessionName)) {
      return {
        success: false,
        error: `tmux session '${sessionName}' not found. Available sessions: ${sessions.join(", ") || "none"}`,
      };
    }
  } catch {
    return {
      success: false,
      error: "No tmux sessions are running.",
    };
  }

  try {
    // Escape special characters for tmux send-keys
    // tmux send-keys interprets some characters specially
    const escaped = escapeForTmux(response);

    // Send the response text
    await execAsync(`tmux send-keys -t ${shellEscape(sessionName)} ${escaped}`);

    // Send Enter key to submit
    await execAsync(`tmux send-keys -t ${shellEscape(sessionName)} Enter`);

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      error: `Failed to send keys to tmux session: ${errorMessage}`,
    };
  }
}

function escapeForTmux(text: string): string {
  // For tmux send-keys, we use literal mode with -- prefix for safety
  // and escape quotes for shell
  return `-- ${shellEscape(text)}`;
}

function shellEscape(str: string): string {
  // Escape for shell: wrap in single quotes and escape any single quotes within
  return `'${str.replace(/'/g, "'\\''")}'`;
}

export async function checkTmuxSession(sessionName: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("tmux list-sessions -F '#{session_name}'");
    const sessions = stdout.trim().split("\n");
    return sessions.includes(sessionName);
  } catch {
    return false;
  }
}
