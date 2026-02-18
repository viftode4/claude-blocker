/**
 * Transcript Watcher
 *
 * Watches Claude Code's transcript JSONL files for new messages
 * and forwards assistant responses to Telegram.
 *
 * The transcript file is written by Claude Code after each complete message,
 * so we get clean, structured data without TUI artifacts.
 */

import { watch, FSWatcher, existsSync, statSync } from "fs";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { forwardOutputToTelegram } from "./telegram.js";

// Transcript entry types (from Claude Code JSONL format)
interface TranscriptUserMessage {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
}

interface TranscriptAssistantMessage {
  type: "assistant";
  message: {
    role: "assistant";
    content: Array<{
      type: "text" | "tool_use" | "tool_result";
      text?: string;
      name?: string;
      input?: unknown;
    }>;
  };
}

interface TranscriptProgressEvent {
  type: "progress";
  content: {
    event: string;
  };
}

interface TranscriptSummary {
  type: "summary";
  summary: string;
}

type TranscriptEntry =
  | TranscriptUserMessage
  | TranscriptAssistantMessage
  | TranscriptProgressEvent
  | TranscriptSummary
  | { type: string }; // Catch-all for other types

interface WatcherState {
  sessionId: string;
  transcriptPath: string;
  watcher: FSWatcher | null;
  lastLineCount: number;
  lastFileSize: number;
  checkInterval: NodeJS.Timeout | null;
}

// Active watchers by session ID
const watchers = new Map<string, WatcherState>();

/**
 * Extract readable text from an assistant message.
 * Handles text blocks and optionally summarizes tool usage.
 */
function extractAssistantText(entry: TranscriptAssistantMessage): string {
  const parts: string[] = [];
  const toolsUsed: string[] = [];

  for (const block of entry.message.content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "tool_use" && block.name) {
      // Track tools used for summary
      toolsUsed.push(block.name);
    }
    // We skip tool_result blocks as they're usually verbose/technical
  }

  // Add tool usage summary if there were tools but no text
  // (helps understand what Claude is doing when it's just executing tools)
  if (parts.length === 0 && toolsUsed.length > 0) {
    const uniqueTools = [...new Set(toolsUsed)];
    if (uniqueTools.length <= 3) {
      parts.push(`🔧 Using: ${uniqueTools.join(", ")}`);
    } else {
      parts.push(`🔧 Using ${uniqueTools.length} tools...`);
    }
  }

  return parts.join("\n\n");
}

/**
 * Read and parse new lines from the transcript file.
 * Returns only new entries since last read.
 */
async function readNewEntries(state: WatcherState): Promise<TranscriptEntry[]> {
  if (!existsSync(state.transcriptPath)) {
    return [];
  }

  const entries: TranscriptEntry[] = [];
  let lineCount = 0;

  return new Promise((resolve) => {
    const stream = createReadStream(state.transcriptPath, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      lineCount++;
      // Only process lines we haven't seen before
      if (lineCount > state.lastLineCount) {
        try {
          const entry = JSON.parse(line) as TranscriptEntry;
          entries.push(entry);
        } catch {
          // Skip malformed lines
        }
      }
    });

    rl.on("close", () => {
      state.lastLineCount = lineCount;
      resolve(entries);
    });

    rl.on("error", () => {
      resolve(entries);
    });
  });
}

/**
 * Process new transcript entries and forward assistant messages to Telegram.
 */
async function processNewEntries(state: WatcherState): Promise<void> {
  const entries = await readNewEntries(state);

  for (const entry of entries) {
    // Only forward assistant messages
    if (entry.type === "assistant") {
      const text = extractAssistantText(entry as TranscriptAssistantMessage);
      if (text.trim()) {
        forwardOutputToTelegram(state.sessionId, text);
      }
    }
    // We could also forward summary entries if useful:
    // else if (entry.type === "summary") {
    //   forwardOutputToTelegram(state.sessionId, `Summary: ${(entry as TranscriptSummary).summary}`);
    // }
  }
}

/**
 * Check if file has been modified and process new content.
 * Uses file size comparison since mtime can be unreliable.
 */
async function checkForUpdates(state: WatcherState): Promise<void> {
  if (!existsSync(state.transcriptPath)) {
    return;
  }

  try {
    const stats = statSync(state.transcriptPath);
    const currentSize = stats.size;

    // File has grown - new content available
    if (currentSize > state.lastFileSize) {
      state.lastFileSize = currentSize;
      await processNewEntries(state);
    }
  } catch {
    // File might be temporarily unavailable during write
  }
}

/**
 * Start watching a transcript file for new messages.
 * Uses both fs.watch (for immediate notification) and polling (for reliability).
 */
export function startWatchingTranscript(sessionId: string, transcriptPath: string): void {
  // Don't create duplicate watchers
  if (watchers.has(sessionId)) {
    console.log(`Transcript watcher already exists for session ${sessionId.substring(0, 8)}`);
    return;
  }

  console.log(`Starting transcript watcher for session ${sessionId.substring(0, 8)}`);
  console.log(`  Path: ${transcriptPath}`);

  const state: WatcherState = {
    sessionId,
    transcriptPath,
    watcher: null,
    lastLineCount: 0,
    lastFileSize: 0,
    checkInterval: null,
  };

  // Initialize file size if file exists
  if (existsSync(transcriptPath)) {
    try {
      state.lastFileSize = statSync(transcriptPath).size;
      // Read existing entries to set lastLineCount (don't forward them)
      readNewEntries(state).then((entries) => {
        console.log(`  Existing entries: ${entries.length}`);
      });
    } catch {
      // File might not exist yet
    }
  }

  // Set up fs.watch for immediate notification
  try {
    state.watcher = watch(transcriptPath, { persistent: false }, async (eventType) => {
      if (eventType === "change") {
        await checkForUpdates(state);
      }
    });

    state.watcher.on("error", (error) => {
      console.error(`Transcript watcher error for ${sessionId.substring(0, 8)}:`, error.message);
    });
  } catch (error) {
    // File might not exist yet - that's OK, polling will catch it
    console.log(`  Note: fs.watch failed (file may not exist yet), using polling only`);
  }

  // Also use polling as backup (fs.watch can be unreliable)
  // Check every 2 seconds
  state.checkInterval = setInterval(async () => {
    await checkForUpdates(state);
  }, 2000);

  watchers.set(sessionId, state);
}

/**
 * Stop watching a transcript file.
 */
export function stopWatchingTranscript(sessionId: string): void {
  const state = watchers.get(sessionId);
  if (!state) {
    return;
  }

  console.log(`Stopping transcript watcher for session ${sessionId.substring(0, 8)}`);

  if (state.watcher) {
    state.watcher.close();
  }

  if (state.checkInterval) {
    clearInterval(state.checkInterval);
  }

  watchers.delete(sessionId);
}

/**
 * Stop all transcript watchers.
 */
export function stopAllTranscriptWatchers(): void {
  for (const [sessionId] of watchers) {
    stopWatchingTranscript(sessionId);
  }
}

/**
 * Check if a transcript watcher is active for a session.
 */
export function hasTranscriptWatcher(sessionId: string): boolean {
  return watchers.has(sessionId);
}
