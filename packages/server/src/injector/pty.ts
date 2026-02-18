import type { InjectionResult } from "./index.js";

// Dynamic import for node-pty since it's an optional dependency
let pty: typeof import("node-pty") | null = null;

// Support multiple PTY sessions
const ptySessions = new Map<string, import("node-pty").IPty>();
// Default PTY for backwards compatibility (when session ID unknown)
let defaultPty: import("node-pty").IPty | null = null;

async function loadPty(): Promise<typeof import("node-pty") | null> {
  if (pty) return pty;
  try {
    pty = await import("node-pty");
    return pty;
  } catch {
    return null;
  }
}

export function isPtyAvailable(): boolean {
  return defaultPty !== null || ptySessions.size > 0;
}

export function hasSession(sessionId: string): boolean {
  return ptySessions.has(sessionId);
}

// Inject to the default PTY (backwards compatible)
export async function injectViaPty(response: string): Promise<InjectionResult> {
  // Try default PTY first
  if (defaultPty) {
    return writeTopty(defaultPty, response);
  }

  // Fallback to first available session
  if (ptySessions.size > 0) {
    const firstPty = ptySessions.values().next().value as import("node-pty").IPty;
    return writeTopty(firstPty, response);
  }

  return {
    success: false,
    error: "No PTY session available.",
  };
}

// Inject to a specific session
export async function injectToPtySession(
  response: string,
  sessionId: string
): Promise<InjectionResult> {
  const ptySession = ptySessions.get(sessionId);
  if (!ptySession) {
    return {
      success: false,
      error: `No PTY for session ${sessionId.substring(0, 8)}`,
    };
  }
  return writeTopty(ptySession, response);
}

function writeTopty(ptyInstance: import("node-pty").IPty, response: string): InjectionResult {
  try {
    ptyInstance.write(response);
    ptyInstance.write("\r");
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      success: false,
      error: `Failed to write to PTY: ${errorMessage}`,
    };
  }
}

export interface LaunchOptions {
  sessionId?: string; // Optional session ID to track this PTY
  command?: string;
  args?: string[];
  cwd?: string;
  onData?: (data: string) => void;
  onExit?: (exitCode: number) => void;
}

export async function launchClaudeInPty(options: LaunchOptions = {}): Promise<boolean> {
  const ptyModule = await loadPty();
  if (!ptyModule) {
    console.error("node-pty is not installed. Run: pnpm approve-builds && pnpm install");
    return false;
  }

  const {
    sessionId,
    command = process.platform === "win32" ? "cmd.exe" : "/bin/bash",
    args = process.platform === "win32" ? ["/c", "claude"] : ["-c", "claude"],
    cwd = process.cwd(),
    onData,
    onExit,
  } = options;

  try {
    const newPty = ptyModule.spawn(command, args, {
      name: "xterm-color",
      cols: 120,
      rows: 40,
      cwd,
      env: process.env as { [key: string]: string },
    });

    // Forward output to stdout and optional callback
    newPty.onData((data) => {
      process.stdout.write(data);
      onData?.(data);
    });

    newPty.onExit(({ exitCode }) => {
      console.log(`Claude exited with code ${exitCode}`);

      // Clean up
      if (sessionId) {
        ptySessions.delete(sessionId);
      }
      if (newPty === defaultPty) {
        defaultPty = null;
      }

      onExit?.(exitCode);
    });

    // Store the PTY
    if (sessionId) {
      ptySessions.set(sessionId, newPty);
      console.log(`Claude launched in PTY for session ${sessionId.substring(0, 8)}`);
    } else {
      defaultPty = newPty;
      console.log("Claude launched in PTY - responses from Telegram will be injected here");
    }

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`Failed to launch Claude in PTY: ${errorMessage}`);
    return false;
  }
}

export function closePty(sessionId?: string): void {
  if (sessionId) {
    const ptySession = ptySessions.get(sessionId);
    if (ptySession) {
      ptySession.kill();
      ptySessions.delete(sessionId);
    }
  } else if (defaultPty) {
    defaultPty.kill();
    defaultPty = null;
  }
}

export function closeAllPtys(): void {
  for (const [id, ptySession] of ptySessions) {
    ptySession.kill();
    ptySessions.delete(id);
  }
  if (defaultPty) {
    defaultPty.kill();
    defaultPty = null;
  }
}

export function resizePty(cols: number, rows: number, sessionId?: string): void {
  if (sessionId) {
    const ptySession = ptySessions.get(sessionId);
    ptySession?.resize(cols, rows);
  } else {
    defaultPty?.resize(cols, rows);
  }
}
