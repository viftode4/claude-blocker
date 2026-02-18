import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type {
  HookPayload,
  ClientMessage,
  TelegramConfig,
  WrapperToServerMessage,
  WrapperSession,
  InjectMessage,
  SignalMessage,
} from "./types.js";
import { DEFAULT_PORT } from "./types.js";
import { state } from "./state.js";
import { initTelegram, stopTelegram, setWrapperSessions } from "./telegram.js";

// Store wrapper WebSocket connections by session ID
const wrapperSockets = new Map<string, WebSocket>();
const wrapperSessions = new Map<string, WrapperSession>();

// Export for telegram.ts to use
export function getWrapperSocket(sessionId: string): WebSocket | undefined {
  return wrapperSockets.get(sessionId);
}

export function getWrapperSessions(): Map<string, WrapperSession> {
  return wrapperSessions;
}

// Send inject message to a wrapper
export function sendInjectToWrapper(sessionId: string, text: string): boolean {
  const ws = wrapperSockets.get(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  const message: InjectMessage = {
    type: "inject",
    sessionId,
    text,
  };
  ws.send(JSON.stringify(message));
  return true;
}

// Send signal to a wrapper
export function sendSignalToWrapper(
  sessionId: string,
  signal: "SIGINT" | "SIGTERM" | "escape"
): boolean {
  const ws = wrapperSockets.get(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  const message: SignalMessage = {
    type: "signal",
    sessionId,
    signal,
  };
  ws.send(JSON.stringify(message));
  return true;
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export interface ServerOptions {
  port?: number;
  telegram?: TelegramConfig;
}

export function startServer(options: ServerOptions = {}): void {
  const { port = DEFAULT_PORT, telegram } = options;

  // Initialize Telegram bot if configured
  if (telegram) {
    initTelegram(telegram);
    // Share wrapper sessions with telegram module
    setWrapperSessions(wrapperSessions, wrapperSockets);
  }
  const server = createServer(async (req, res) => {
    // CORS headers for local development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${port}`);

    // Health check / status endpoint
    if (req.method === "GET" && url.pathname === "/status") {
      sendJson(res, state.getStatus());
      return;
    }

    // Hook endpoint - receives notifications from Claude Code
    if (req.method === "POST" && url.pathname === "/hook") {
      try {
        const body = await parseBody(req);
        const payload = JSON.parse(body) as HookPayload;

        if (!payload.session_id || !payload.hook_event_name) {
          sendJson(res, { error: "Invalid payload" }, 400);
          return;
        }

        state.handleHook(payload);
        sendJson(res, { ok: true });
      } catch {
        sendJson(res, { error: "Invalid JSON" }, 400);
      }
      return;
    }

    // 404 for unknown routes
    sendJson(res, { error: "Not found" }, 404);
  });

  // WebSocket server for Chrome extension and wrappers
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    let clientType: "extension" | "wrapper" | null = null;
    let wrapperSessionId: string | null = null;
    let unsubscribe: (() => void) | null = null;

    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Handle wrapper registration
        if (message.type === "wrapper_register") {
          clientType = "wrapper";
          wrapperSessionId = message.sessionId;

          // Store wrapper connection
          wrapperSockets.set(message.sessionId, ws);
          wrapperSessions.set(message.sessionId, {
            sessionId: message.sessionId,
            project: message.project,
            cwd: message.cwd,
            connectedAt: new Date(),
          });

          console.log(`Wrapper connected: ${message.project} (${message.sessionId.substring(0, 8)})`);
          return;
        }

        // Handle wrapper disconnect
        if (message.type === "wrapper_disconnect" && wrapperSessionId) {
          wrapperSockets.delete(wrapperSessionId);
          wrapperSessions.delete(wrapperSessionId);
          console.log(`Wrapper disconnected: ${wrapperSessionId.substring(0, 8)}`);
          return;
        }

        // Handle inject acknowledgment (for logging/debugging)
        if (message.type === "inject_ack") {
          if (!message.success) {
            console.log(`Inject failed for ${message.sessionId.substring(0, 8)}: ${message.error}`);
          }
          return;
        }

        // Note: Output forwarding to Telegram is now handled via transcript watcher,
        // not via wrapper output messages. The transcript provides cleaner, structured data.

        // First non-wrapper message means this is an extension client
        // Register BEFORE handling ping to ensure extension gets subscribed
        if (!clientType) {
          clientType = "extension";
          console.log("Extension connected");

          // Subscribe to state changes for extension clients
          unsubscribe = state.subscribe((stateMessage) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(stateMessage));
            }
          });
        }

        // Handle ping (from both extension and wrapper)
        if (message.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch {
        // Ignore invalid messages
      }
    });

    ws.on("close", () => {
      if (clientType === "wrapper" && wrapperSessionId) {
        wrapperSockets.delete(wrapperSessionId);
        wrapperSessions.delete(wrapperSessionId);
        console.log(`Wrapper disconnected: ${wrapperSessionId.substring(0, 8)}`);
      } else if (clientType === "extension") {
        console.log("Extension disconnected");
        unsubscribe?.();
      }
    });

    ws.on("error", () => {
      if (wrapperSessionId) {
        wrapperSockets.delete(wrapperSessionId);
        wrapperSessions.delete(wrapperSessionId);
      }
      unsubscribe?.();
    });
  });

  server.listen(port, () => {
    console.log(`
┌─────────────────────────────────────┐
│                                     │
│   Claude Blocker Server             │
│                                     │
│   HTTP:      http://localhost:${port}  │
│   WebSocket: ws://localhost:${port}/ws │
│                                     │
│   Waiting for Claude Code hooks...  │
│                                     │
└─────────────────────────────────────┘
`);
  });

  // Graceful shutdown - use once to prevent stacking handlers
  process.once("SIGINT", () => {
    console.log("\nShutting down...");
    stopTelegram();
    state.destroy();
    wss.close();
    server.close();
    process.exit(0);
  });
}
