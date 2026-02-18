/**
 * Claude Launcher - Wraps Claude with remote input capability
 *
 * This creates a named pipe that the blocker server can write to,
 * allowing response injection without PTY control.
 */

import { spawn } from "child_process";
import { createServer, type Socket } from "net";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const PIPE_PREFIX = process.platform === "win32"
  ? "\\\\.\\pipe\\claude-blocker-"
  : join(tmpdir(), "claude-blocker-");

// Active pipes for response injection
const activePipes = new Map<string, Socket>();

export function getPipePath(sessionId: string): string {
  return `${PIPE_PREFIX}${sessionId}`;
}

export function hasPipe(sessionId: string): boolean {
  return activePipes.has(sessionId);
}

export function writeToPipe(sessionId: string, data: string): boolean {
  const socket = activePipes.get(sessionId);
  if (!socket) return false;

  try {
    socket.write(data + "\n");
    return true;
  } catch {
    return false;
  }
}

interface LauncherOptions {
  sessionId: string;
  cwd?: string;
  onExit?: (code: number | null) => void;
}

export async function launchClaudeWithPipe(options: LauncherOptions): Promise<boolean> {
  const { sessionId, cwd = process.cwd(), onExit } = options;
  const pipePath = getPipePath(sessionId);

  // Clean up old pipe if exists (Unix only)
  if (process.platform !== "win32" && existsSync(pipePath)) {
    unlinkSync(pipePath);
  }

  return new Promise((resolve) => {
    // Create named pipe server
    const pipeServer = createServer((socket) => {
      console.log(`Pipe connected for session ${sessionId.substring(0, 8)}`);
      activePipes.set(sessionId, socket);

      socket.on("close", () => {
        activePipes.delete(sessionId);
      });

      socket.on("error", (err) => {
        console.error(`Pipe error: ${err.message}`);
        activePipes.delete(sessionId);
      });
    });

    pipeServer.listen(pipePath, () => {
      console.log(`Named pipe created: ${pipePath}`);

      // Now spawn Claude
      const claude = spawn("claude", [], {
        cwd,
        stdio: ["pipe", "inherit", "inherit"],
        shell: true,
      });

      // Forward stdin from pipe to Claude
      pipeServer.on("connection", (socket) => {
        socket.on("data", (data) => {
          if (claude.stdin && !claude.stdin.destroyed) {
            claude.stdin.write(data);
          }
        });
      });

      // Also forward terminal stdin to Claude
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.on("data", (data) => {
        if (claude.stdin && !claude.stdin.destroyed) {
          claude.stdin.write(data);
        }
      });

      claude.on("exit", (code) => {
        console.log(`Claude exited with code ${code}`);
        pipeServer.close();
        activePipes.delete(sessionId);

        // Clean up Unix pipe file
        if (process.platform !== "win32" && existsSync(pipePath)) {
          unlinkSync(pipePath);
        }

        onExit?.(code);
      });

      claude.on("error", (err) => {
        console.error(`Failed to start Claude: ${err.message}`);
        pipeServer.close();
        resolve(false);
      });

      resolve(true);
    });

    pipeServer.on("error", (err) => {
      console.error(`Failed to create pipe: ${err.message}`);
      resolve(false);
    });
  });
}
