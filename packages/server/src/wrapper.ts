#!/usr/bin/env node

/**
 * ccw / ccwd - Claude Code Wrapped
 *
 * A wrapper that spawns Claude in a PTY with:
 * - Full terminal support (colors, TUI, etc.)
 * - WebSocket connection to blocker server for remote input
 * - Session registration for multi-session topic routing
 */

import { config as loadEnv } from "dotenv";
import WebSocket from "ws";
import { DEFAULT_PORT } from "@claude-blocker/shared";
import { randomUUID } from "crypto";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";

// Load .env from package directory
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, "..", ".env") });

// Message types between wrapper and server
interface WrapperRegisterMessage {
  type: "wrapper_register";
  sessionId: string;
  project: string;
  cwd: string;
}

interface WrapperDisconnectMessage {
  type: "wrapper_disconnect";
  sessionId: string;
}

interface InjectMessage {
  type: "inject";
  sessionId: string;
  text: string;
  raw?: boolean; // If true, send text as-is without adding Enter
}

interface InjectAckMessage {
  type: "inject_ack";
  sessionId: string;
  success: boolean;
  error?: string;
}

interface SignalMessage {
  type: "signal";
  sessionId: string;
  signal: "SIGINT" | "SIGTERM" | "escape";
}

type ServerToWrapperMessage = InjectMessage | SignalMessage | { type: "pong" };
type WrapperToServerMessage = { type: "wrapper_register"; sessionId: string; project: string; cwd: string } | { type: "wrapper_disconnect"; sessionId: string } | { type: "inject_ack"; sessionId: string; success: boolean; error?: string };

// Configuration
const SERVER_PORT = parseInt(process.env.CLAUDE_BLOCKER_PORT || String(DEFAULT_PORT), 10);
const SERVER_URL = `ws://localhost:${SERVER_PORT}/ws`;
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;
const CLAUDE_COMMAND = process.env.CLAUDE_COMMAND || "claude";
// Delay before Enter key after typing text (Bug 7 fix: was 50ms, now 150ms default)
const INPUT_DELAY_MS = parseInt(process.env.CLAUDE_INPUT_DELAY_MS || "150", 10);


// State
let ws: WebSocket | null = null;
let pty: import("node-pty").IPty | null = null;
const sessionId = randomUUID();
let reconnectAttempts = 0;
let shouldReconnect = true;
let reconnectTimeout: NodeJS.Timeout | null = null;

// Check if invoked as ccwd (dangerous mode) - set by ccwd.ts entry point
const isDangerousMode = process.env.CCWD_DANGEROUS_MODE === "1";

// Parse CLI args - pass everything through to claude
let args = process.argv.slice(2);

// If invoked as ccwd, add --dangerously-skip-permissions
if (isDangerousMode && !args.includes("--dangerously-skip-permissions")) {
  args = ["--dangerously-skip-permissions", ...args];
}

const cwd = process.cwd();
const project = basename(cwd);

// Check for wrapper-specific flags
const showHelp = args.includes("--ccw-help");
if (showHelp) {
  console.log(`
${isDangerousMode ? "ccwd" : "ccw"} - Claude Code Wrapped${isDangerousMode ? " (Dangerous Mode)" : ""}

A wrapper for 'claude' that enables multi-session Telegram integration.
All arguments are passed through to claude.
${isDangerousMode ? "\nThis command automatically adds --dangerously-skip-permissions.\n" : ""}
Usage:
  ccw [claude-args...]      # Normal mode
  ccwd [claude-args...]     # With --dangerously-skip-permissions

Examples:
  ccw                       # Start Claude normally
  ccwd                      # Start with skip permissions
  ccw --resume              # Resume last conversation

Requirements:
  - claude-blocker server must be running (claude-blocker or claude-blocker --startup)

Environment:
  CLAUDE_BLOCKER_PORT    Server port (default: ${DEFAULT_PORT})
  CLAUDE_COMMAND         Claude command (default: claude)
`);
  process.exit(0);
}

function connectToServer(): void {
  if (!shouldReconnect) return;

  ws = new WebSocket(SERVER_URL);

  ws.on("open", () => {
    reconnectAttempts = 0;

    // Register this wrapper session
    const registerMsg: WrapperRegisterMessage = {
      type: "wrapper_register",
      sessionId,
      project,
      cwd,
    };
    ws!.send(JSON.stringify(registerMsg));
  });

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString()) as ServerToWrapperMessage;
      handleServerMessage(message);
    } catch {
      // Ignore parse errors
    }
  });

  ws.on("close", () => {
    ws = null;
    if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      reconnectTimeout = setTimeout(connectToServer, RECONNECT_DELAY_MS);
    }
  });

  ws.on("error", () => {
    // Server might not be running - that's OK for initial connection
    // Claude will still work, just no remote injection until server starts
  });
}

function handleServerMessage(message: ServerToWrapperMessage): void {
  switch (message.type) {
    case "inject":
      injectText(message.text, message.sessionId, message.raw);
      break;

    case "signal":
      handleSignal(message.signal);
      break;

    case "pong":
      // Heartbeat response, ignore
      break;
  }
}

function injectText(text: string, msgSessionId: string, raw?: boolean): void {
  // Verify session ID matches
  if (msgSessionId !== sessionId) {
    sendAck(false, "Session ID mismatch");
    return;
  }

  if (!pty) {
    sendAck(false, "PTY not available");
    return;
  }

  try {
    // Write text to PTY, optionally with Enter
    if (raw) {
      // Raw mode: send exactly what was requested (for arrow keys, escape sequences)
      pty.write(text);
    } else {
      // Normal mode: write text first, then Enter key after a delay
      // This mimics how a human types and helps with TUI input handling
      // Bug 7 fix: increased from 50ms to 150ms (configurable via CLAUDE_INPUT_DELAY_MS)
      pty.write(text);

      // Send Enter key after delay to let text register
      setTimeout(() => {
        if (pty) {
          pty.write("\r");
        }
      }, INPUT_DELAY_MS);
    }
    sendAck(true);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    sendAck(false, errorMessage);
  }
}

function handleSignal(signal: "SIGINT" | "SIGTERM" | "escape"): void {
  if (!pty) return;

  switch (signal) {
    case "SIGINT":
      // Send Ctrl+C
      pty.write("\x03");
      break;

    case "SIGTERM":
      pty.kill();
      break;

    case "escape":
      // Send Escape key
      pty.write("\x1b");
      break;
  }
}

function sendAck(success: boolean, error?: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const ack: InjectAckMessage = {
    type: "inject_ack",
    sessionId,
    success,
    error,
  };
  ws.send(JSON.stringify(ack));
}

function sendDisconnect(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const msg: WrapperDisconnectMessage = {
    type: "wrapper_disconnect",
    sessionId,
  };
  ws.send(JSON.stringify(msg));
}

function cleanup(): void {
  shouldReconnect = false;

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  sendDisconnect();

  if (ws) {
    ws.close();
    ws = null;
  }
}

async function startClaude(): Promise<boolean> {
  console.log(`Starting Claude${isDangerousMode ? " (dangerous mode)" : ""}...`);
  console.log(`Command: ${CLAUDE_COMMAND} ${args.join(" ")}`);

  // Dynamic import for node-pty - use createRequire to resolve from package dir
  let ptyModule: typeof import("node-pty");
  try {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    ptyModule = require("node-pty");
  } catch (err) {
    console.error("Error: node-pty is not installed.");
    console.error("\nInstall it with:");
    console.error("  cd packages/server && pnpm approve-builds && pnpm install");
    return false;
  }

  // Build command for PTY
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
  const shellArgs = process.platform === "win32"
    ? ["/c", CLAUDE_COMMAND, ...args]
    : ["-c", `${CLAUDE_COMMAND} ${args.join(" ")}`];

  try {
    // Get terminal size
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;

    pty = ptyModule.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: process.env as { [key: string]: string },
    });

    // Forward PTY output to stdout
    // (Telegram output is now handled via transcript watcher, not PTY output)
    pty.onData((data) => {
      process.stdout.write(data);
    });

    // Forward stdin to PTY
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", (data) => {
      pty?.write(data.toString());
    });

    // Handle terminal resize
    process.stdout.on("resize", () => {
      pty?.resize(process.stdout.columns || 120, process.stdout.rows || 40);
    });

    // Handle PTY exit
    pty.onExit(({ exitCode }) => {
      cleanup();
      process.stdin.setRawMode?.(false);
      process.exit(exitCode);
    });

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`Failed to start Claude: ${errorMessage}`);
    return false;
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  cleanup();
  pty?.write("\x03"); // Send Ctrl+C to PTY
});

process.on("SIGTERM", () => {
  cleanup();
  pty?.kill();
});

// Main
async function main(): Promise<void> {
  // Try to connect to server (with short timeout)
  let serverAvailable = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const testWs = new WebSocket(SERVER_URL);
      const timeout = setTimeout(() => {
        testWs.close();
        reject(new Error("Connection timeout"));
      }, 1000);

      testWs.on("open", () => {
        clearTimeout(timeout);
        testWs.close();
        serverAvailable = true;
        resolve();
      });

      testWs.on("error", () => {
        clearTimeout(timeout);
        reject(new Error("Connection failed"));
      });
    });
  } catch {
    // Server not available - warn but continue
    console.error("\x1b[33mWarning: claude-blocker server is not running.\x1b[0m");
    console.error("Telegram features will be unavailable until server starts.");
    console.error("Start server with: claude-blocker\n");
  }

  // Start Claude in PTY
  const started = await startClaude();
  if (!started) {
    process.exit(1);
  }

  // Connect to server (will reconnect in background if not available)
  if (serverAvailable) {
    connectToServer();
  } else {
    // Start background reconnection attempts
    shouldReconnect = true;
    reconnectTimeout = setTimeout(connectToServer, RECONNECT_DELAY_MS);
  }
}

main();
