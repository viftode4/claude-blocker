import { injectViaTmux } from "./tmux.js";
import { injectViaPty, injectToPtySession, isPtyAvailable, hasSession } from "./pty.js";

export interface InjectionResult {
  success: boolean;
  error?: string;
}

// Inject to a specific session by ID
export async function injectToSession(
  response: string,
  sessionId: string,
  tmuxSession?: string
): Promise<InjectionResult> {
  const platform = process.platform;

  // Windows: Try to inject to specific PTY session
  if (platform === "win32") {
    if (hasSession(sessionId)) {
      return injectToPtySession(response, sessionId);
    }
    // Fallback to default PTY if session not found
    if (isPtyAvailable()) {
      return injectViaPty(response);
    }
  }

  // Unix/Mac: Use tmux (session routing not supported yet)
  if ((platform === "darwin" || platform === "linux") && tmuxSession) {
    return injectViaTmux(response, tmuxSession);
  }

  return {
    success: false,
    error: `No injection method available for session ${sessionId.substring(0, 8)}`,
  };
}

// Default injection (backwards compatible)
export async function injectResponse(
  response: string,
  tmuxSession?: string
): Promise<InjectionResult> {
  const platform = process.platform;

  // Unix/Mac: Use tmux if session is specified
  if ((platform === "darwin" || platform === "linux") && tmuxSession) {
    return injectViaTmux(response, tmuxSession);
  }

  // Windows: Use PTY if available
  if (platform === "win32" && isPtyAvailable()) {
    return injectViaPty(response);
  }

  // Fallback error messages
  if (platform === "win32") {
    return {
      success: false,
      error: "No PTY session available. Start Claude with 'npx claude-blocker' for response injection.",
    };
  }

  if (!tmuxSession) {
    return {
      success: false,
      error: "No tmux session specified. Run Claude in a named tmux session and set --tmux-session.",
    };
  }

  return {
    success: false,
    error: "Response injection not available on this platform.",
  };
}
