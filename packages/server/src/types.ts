// Hook event payload (from Claude Code)
export interface HookPayload {
  session_id: string;
  hook_event_name:
    | "UserPromptSubmit"
    | "PreToolUse"
    | "Stop"
    | "SessionStart"
    | "SessionEnd";
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  transcript_path?: string;
}

// Session state tracked by server
export interface Session {
  id: string;
  status: "idle" | "working" | "waiting_for_input";
  lastActivity: Date;
  waitingForInputSince?: Date;
  cwd?: string;
  transcriptPath?: string; // Path to JSONL transcript file (from SessionStart hook)
}

// Session info sent to extension (serializable)
export interface SessionInfo {
  id: string;
  status: "idle" | "working" | "waiting_for_input";
  project: string; // Extracted from cwd (just the folder name)
}

// WebSocket messages from server to extension
export type ServerMessage =
  | {
      type: "state";
      blocked: boolean;
      sessions: number;
      working: number;
      waitingForInput: number;
      sessionList: SessionInfo[];
    }
  | { type: "pong" };

// Tools that indicate Claude is waiting for user input
export const USER_INPUT_TOOLS = [
  "AskUserQuestion",
  "ask_user",
  "ask_human",
];

// WebSocket messages from extension to server
export type ClientMessage = { type: "ping" } | { type: "subscribe" };

// Server configuration
export const DEFAULT_PORT = 8765;
export const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Telegram configuration
export interface TelegramConfig {
  botToken: string;
  chatId: string; // Group ID for forum/topics mode
  tmuxSession?: string; // For Unix/Mac response injection
}

// Tracks a Claude session's Telegram topic
export interface SessionTopic {
  topicId: number;
  sessionId: string;
  project: string;
  createdAt: Date;
}

// Event emitted when Claude needs user input
export interface WaitingForInputEvent {
  sessionId: string;
  question?: string;
  project?: string;
  toolInput?: Record<string, unknown>; // Full tool input for structured questions
}

// Event emitted when a session ends
export interface SessionEndEvent {
  sessionId: string;
}

// Wrapper WebSocket message types
export interface WrapperRegisterMessage {
  type: "wrapper_register";
  sessionId: string;
  project: string;
  cwd: string;
}

export interface WrapperDisconnectMessage {
  type: "wrapper_disconnect";
  sessionId: string;
}

export interface InjectMessage {
  type: "inject";
  sessionId: string;
  text: string;
  raw?: boolean; // If true, send text as-is without adding Enter
}

export interface InjectAckMessage {
  type: "inject_ack";
  sessionId: string;
  success: boolean;
  error?: string;
}

export interface SignalMessage {
  type: "signal";
  sessionId: string;
  signal: "SIGINT" | "SIGTERM" | "escape";
}

// Note: OutputMessage was removed - output forwarding to Telegram is now
// handled via transcript watcher, not via wrapper output messages.

export type WrapperToServerMessage =
  | WrapperRegisterMessage
  | WrapperDisconnectMessage
  | InjectAckMessage
  | { type: "ping" };

export type ServerToWrapperMessage =
  | InjectMessage
  | SignalMessage
  | { type: "pong" };

// Wrapper session info
export interface WrapperSession {
  sessionId: string;
  project: string;
  cwd: string;
  connectedAt: Date;
}

// Question option from AskUserQuestion tool
export interface QuestionOption {
  label: string;
  description?: string;
}

// Structured question for inline keyboard
export interface StructuredQuestion {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

// Form state tracking for multi-step questions (used by Telegram)
export interface FormState {
  currentQuestionIndex: number;
  questions: StructuredQuestion[];
  answers: Map<number, string[]>; // questionIndex -> selected option labels
  messageId?: number; // Telegram message ID to edit
  toolInput?: Record<string, unknown>;
}

// Multi-select highlight tracking
export interface MultiSelectState {
  currentHighlight: number; // 0-based index of currently highlighted option
  selectedOptions: Set<number>; // Set of 0-based indices of selected options
}

// Notification deduplication tracking
export interface NotificationRecord {
  questionHash: string;
  timestamp: number;
}
