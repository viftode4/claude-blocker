import type { Session, HookPayload, ServerMessage, SessionInfo, WaitingForInputEvent, SessionEndEvent } from "./types.js";
import { SESSION_TIMEOUT_MS, USER_INPUT_TOOLS } from "./types.js";
import path from "path";
import { EventEmitter } from "events";

export interface SessionStartEvent {
  sessionId: string;
  project?: string;
  transcriptPath?: string;
}

export interface StateEvents {
  sessionStart: (event: SessionStartEvent) => void;
  sessionEnd: (event: SessionEndEvent) => void;
  waitingForInput: (event: WaitingForInputEvent) => void;
}

type StateChangeCallback = (message: ServerMessage) => void;

class SessionState extends EventEmitter {
  private sessions: Map<string, Session> = new Map();
  private stateListeners: Set<StateChangeCallback> = new Set();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    // Start cleanup interval for stale sessions
    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleSessions();
    }, 30_000); // Check every 30 seconds
  }

  onSessionStart(callback: (event: SessionStartEvent) => void): void {
    this.on("sessionStart", callback);
  }

  onSessionEnd(callback: (event: SessionEndEvent) => void): void {
    this.on("sessionEnd", callback);
  }

  onWaitingForInput(callback: (event: WaitingForInputEvent) => void): void {
    this.on("waitingForInput", callback);
  }

  subscribe(callback: StateChangeCallback): () => void {
    this.stateListeners.add(callback);
    // Immediately send current state to new subscriber
    callback(this.getStateMessage());
    return () => this.stateListeners.delete(callback);
  }

  private broadcast(): void {
    const message = this.getStateMessage();
    for (const listener of this.stateListeners) {
      listener(message);
    }
  }

  private getStateMessage(): ServerMessage {
    const sessions = Array.from(this.sessions.values());
    const working = sessions.filter((s) => s.status === "working").length;
    const waitingForInput = sessions.filter(
      (s) => s.status === "waiting_for_input"
    ).length;

    // Build session list with project names
    const sessionList: SessionInfo[] = sessions.map((s) => ({
      id: s.id,
      status: s.status,
      project: s.cwd ? path.basename(s.cwd) : "Unknown",
    }));

    return {
      type: "state",
      blocked: working === 0,
      sessions: sessions.length,
      working,
      waitingForInput,
      sessionList,
    };
  }

  handleHook(payload: HookPayload): void {
    const { session_id, hook_event_name } = payload;

    switch (hook_event_name) {
      case "SessionStart":
        this.sessions.set(session_id, {
          id: session_id,
          status: "idle",
          lastActivity: new Date(),
          cwd: payload.cwd,
          transcriptPath: payload.transcript_path,
        });
        console.log("Claude Code session connected");
        this.emit("sessionStart", {
          sessionId: session_id,
          project: payload.cwd ? path.basename(payload.cwd) : undefined,
          transcriptPath: payload.transcript_path,
        } as SessionStartEvent);
        break;

      case "SessionEnd":
        this.sessions.delete(session_id);
        console.log("Claude Code session disconnected");
        this.emit("sessionEnd", { sessionId: session_id } as SessionEndEvent);
        break;

      case "UserPromptSubmit":
        this.ensureSession(session_id, payload.cwd);
        const promptSession = this.sessions.get(session_id)!;
        promptSession.status = "working";
        promptSession.waitingForInputSince = undefined;
        promptSession.lastActivity = new Date();
        break;

      case "PreToolUse":
        this.ensureSession(session_id, payload.cwd);
        const toolSession = this.sessions.get(session_id)!;
        // Check if this is a user input tool
        if (payload.tool_name && USER_INPUT_TOOLS.includes(payload.tool_name)) {
          toolSession.status = "waiting_for_input";
          toolSession.waitingForInputSince = new Date();

          // Extract question from tool_input and emit event
          const question = this.extractQuestion(payload.tool_input);
          const project = payload.cwd ? path.basename(payload.cwd) : undefined;
          this.emit("waitingForInput", {
            sessionId: session_id,
            question,
            project,
            toolInput: payload.tool_input, // Pass full tool input for structured options
          } as WaitingForInputEvent);
        } else if (toolSession.status === "waiting_for_input") {
          // If waiting for input, only reset after 500ms (to ignore immediate tool calls like Edit)
          const elapsed = Date.now() - (toolSession.waitingForInputSince?.getTime() ?? 0);
          if (elapsed > 500) {
            toolSession.status = "working";
            toolSession.waitingForInputSince = undefined;
          }
        } else {
          toolSession.status = "working";
        }
        toolSession.lastActivity = new Date();
        break;

      case "Stop":
        this.ensureSession(session_id, payload.cwd);
        const idleSession = this.sessions.get(session_id)!;
        if (idleSession.status === "waiting_for_input") {
          // If waiting for input, only reset after 500ms (to ignore immediate Stop after AskUserQuestion)
          const elapsed = Date.now() - (idleSession.waitingForInputSince?.getTime() ?? 0);
          if (elapsed > 500) {
            idleSession.status = "idle";
            idleSession.waitingForInputSince = undefined;
          }
        } else {
          idleSession.status = "idle";
        }
        idleSession.lastActivity = new Date();
        break;
    }

    this.broadcast();
  }

  private ensureSession(sessionId: string, cwd?: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        id: sessionId,
        status: "idle",
        lastActivity: new Date(),
        cwd,
      });
      console.log("Claude Code session connected");
    }
  }

  private cleanupStaleSessions(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > SESSION_TIMEOUT_MS) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.sessions.delete(id);
      this.emit("sessionEnd", { sessionId: id } as SessionEndEvent);
    }

    if (toRemove.length > 0) {
      this.broadcast();
    }
  }

  getStatus(): { blocked: boolean; sessions: Session[] } {
    const sessions = Array.from(this.sessions.values());
    const working = sessions.filter((s) => s.status === "working").length;
    return {
      blocked: working === 0,
      sessions,
    };
  }

  private extractQuestion(toolInput?: Record<string, unknown>): string | undefined {
    if (!toolInput) return undefined;

    // AskUserQuestion format: { questions: [{ question: "..." }] }
    if (Array.isArray(toolInput.questions) && toolInput.questions.length > 0) {
      const firstQuestion = toolInput.questions[0] as { question?: string };
      if (firstQuestion?.question) {
        return firstQuestion.question;
      }
    }

    // Fallback: check for direct question field
    if (typeof toolInput.question === "string") {
      return toolInput.question;
    }

    return undefined;
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.sessions.clear();
    this.stateListeners.clear();
    this.removeAllListeners();
  }
}

export const state = new SessionState();
