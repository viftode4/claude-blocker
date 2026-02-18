import { Telegraf, Markup } from "telegraf";
import type {
  TelegramConfig,
  WaitingForInputEvent,
  SessionTopic,
  WrapperSession,
  InjectMessage,
  SignalMessage,
  StructuredQuestion,
  QuestionOption,
  FormState,
  MultiSelectState,
  NotificationRecord,
} from "./types.js";
import { state, type SessionStartEvent } from "./state.js";
import { injectResponse, injectToSession } from "./injector/index.js";
import { WebSocket } from "ws";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  startWatchingTranscript,
  stopWatchingTranscript,
  stopAllTranscriptWatchers,
} from "./transcript-watcher.js";
import { createHash } from "crypto";

// File to persist topic IDs for cleanup on restart
const __dirname = dirname(fileURLToPath(import.meta.url));
const TOPICS_FILE = join(__dirname, "..", "topics.json");

// Load persisted topic IDs
function loadPersistedTopics(): number[] {
  try {
    if (existsSync(TOPICS_FILE)) {
      const data = readFileSync(TOPICS_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch {
    // Ignore errors
  }
  return [];
}

// Save topic IDs to file
function savePersistedTopics(topicIds: number[]): void {
  try {
    writeFileSync(TOPICS_FILE, JSON.stringify(topicIds), "utf-8");
  } catch {
    // Ignore errors
  }
}

// Add a topic ID to persisted list
function persistTopicId(topicId: number): void {
  const topics = loadPersistedTopics();
  if (!topics.includes(topicId)) {
    topics.push(topicId);
    savePersistedTopics(topics);
  }
}

// Remove a topic ID from persisted list
function unpersistTopicId(topicId: number): void {
  const topics = loadPersistedTopics().filter(id => id !== topicId);
  savePersistedTopics(topics);
}

let bot: Telegraf | null = null;
let config: TelegramConfig | null = null;

// Map session IDs to their Telegram topics
const sessionTopics = new Map<string, SessionTopic>();
// Reverse map: topic ID to session ID for routing replies
const topicToSession = new Map<number, string>();

// Configurable delays via environment variables
const INPUT_DELAY_MS = parseInt(process.env.CLAUDE_INPUT_DELAY_MS || "150", 10);
const KEY_DELAY_MS = parseInt(process.env.CLAUDE_KEY_DELAY_MS || "100", 10);
const NOTIFICATION_DEBOUNCE_MS = 2000;

// Track sessions waiting for "Other..." custom input
// Key: sessionId, Value: { toolInput, questionIndex, freeTextOptionIndex }
interface PendingCustomInput {
  toolInput: Record<string, unknown>;
  questionIndex: number;
  freeTextOptionIndex: number; // The 1-based index of "Type something" option
}
const pendingCustomInput = new Map<string, PendingCustomInput>();

// Track form state for multi-step questions
// Key: sessionId
const formStates = new Map<string, FormState>();

// Track multi-select highlight position per session
// Key: sessionId
const multiSelectStates = new Map<string, MultiSelectState>();

// Track recent notifications for deduplication
// Key: sessionId
const recentNotifications = new Map<string, NotificationRecord>();

// Helper to create a hash for notification deduplication
function hashQuestion(question?: string, toolInput?: Record<string, unknown>): string {
  const data = JSON.stringify({ question, toolInput });
  return createHash("md5").update(data).digest("hex").substring(0, 8);
}

// Helper for async delay
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper to generate keyboard for a specific question
function generateQuestionKeyboard(
  sessionId: string,
  formState: FormState,
  questionIndex: number
): ReturnType<typeof Markup.inlineKeyboard> | null {
  if (questionIndex < 0 || questionIndex >= formState.questions.length) {
    return null;
  }

  const question = formState.questions[questionIndex];
  if (!question.options || question.options.length === 0) {
    return null;
  }

  const sessionPrefix = sessionId.substring(0, 8);
  const isMultiSelect = question.multiSelect === true;
  const multiFlag = isMultiSelect ? "1" : "0";

  // Get multi-select state for checkmarks
  const msState = multiSelectStates.get(sessionId);

  // Create option buttons
  const buttons = question.options.map((opt, index) => {
    const optIndex = index + 1; // 1-based for Claude TUI
    const callbackData = `opt:${sessionPrefix}:${optIndex}:${multiFlag}:${opt.label.substring(0, 20)}`;

    // Show checkmark for selected options in multi-select mode
    let label = `${optIndex}. ${opt.label}`;
    if (isMultiSelect && msState?.selectedOptions.has(index)) {
      label = `✓ ${label}`;
    }

    return Markup.button.callback(label, callbackData);
  });

  // Add "Other..." button for custom input
  buttons.push(Markup.button.callback("Other...", `other:${sessionPrefix}`));

  // Add navigation buttons based on position
  const totalQuestions = formState.questions.length;
  const isFirstQuestion = questionIndex === 0;
  const isLastQuestion = questionIndex === totalQuestions - 1;

  if (!isFirstQuestion) {
    buttons.push(Markup.button.callback("◀ Prev", `nav:${sessionPrefix}:left`));
  }
  if (!isLastQuestion) {
    buttons.push(Markup.button.callback("Next ▶", `nav:${sessionPrefix}:right`));
  }
  // Always show submit button for multi-select or multi-step
  if (isMultiSelect || totalQuestions > 1) {
    buttons.push(Markup.button.callback("✓ Submit", `nav:${sessionPrefix}:submit`));
  }

  return Markup.inlineKeyboard(buttons, { columns: 2 });
}

// Helper to update the message with current question's keyboard
async function updateQuestionKeyboard(
  ctx: { editMessageText: (text: string, options?: object) => Promise<unknown> },
  sessionId: string,
  formState: FormState
): Promise<void> {
  const questionIndex = formState.currentQuestionIndex;
  const question = formState.questions[questionIndex];
  if (!question) return;

  const keyboard = generateQuestionKeyboard(sessionId, formState, questionIndex);
  if (!keyboard) return;

  const totalQuestions = formState.questions.length;
  const header = question.header ? `[${question.header}] ` : "";
  const multiNote = question.multiSelect ? " (select multiple)" : "";

  let message = `❓ Question ${questionIndex + 1}/${totalQuestions} ${header}${multiNote}\n\n`;
  message += question.question;

  // Show previous answers summary
  if (formState.answers.size > 0) {
    message += "\n\n📝 Previous answers:";
    for (const [idx, answers] of formState.answers) {
      const q = formState.questions[idx];
      const qHeader = q?.header || `Q${idx + 1}`;
      message += `\n• ${qHeader}: ${answers.join(", ")}`;
    }
  }

  try {
    await ctx.editMessageText(message, keyboard);
  } catch {
    // Message might have been deleted or unchanged
  }
}

// References to wrapper sessions from server.ts
let wrapperSessionsRef: Map<string, WrapperSession> | null = null;
let wrapperSocketsRef: Map<string, WebSocket> | null = null;

// Called by server.ts to share wrapper session maps
export function setWrapperSessions(
  sessions: Map<string, WrapperSession>,
  sockets: Map<string, WebSocket>
): void {
  wrapperSessionsRef = sessions;
  wrapperSocketsRef = sockets;
}

// Send inject message to a wrapper
function sendInjectToWrapper(sessionId: string, text: string, raw?: boolean): boolean {
  if (!wrapperSocketsRef) return false;

  const ws = wrapperSocketsRef.get(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  const message: InjectMessage = {
    type: "inject",
    sessionId,
    text,
    raw,
  };
  ws.send(JSON.stringify(message));
  return true;
}

// Send signal to a wrapper
function sendSignalToWrapper(
  sessionId: string,
  signal: "SIGINT" | "SIGTERM" | "escape"
): boolean {
  if (!wrapperSocketsRef) return false;

  const ws = wrapperSocketsRef.get(sessionId);
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

// Check if session has a connected wrapper (by sessionId or by project match)
function hasWrapperSession(sessionId: string): boolean {
  if (!wrapperSocketsRef || !wrapperSessionsRef) return false;

  // Direct match by sessionId
  const ws = wrapperSocketsRef.get(sessionId);
  if (ws && ws.readyState === WebSocket.OPEN) return true;

  // Match by project name from topic
  const topic = sessionTopics.get(sessionId);
  if (topic?.project) {
    for (const [, session] of wrapperSessionsRef) {
      if (session.project === topic.project) {
        const wrapperWs = wrapperSocketsRef.get(session.sessionId);
        if (wrapperWs && wrapperWs.readyState === WebSocket.OPEN) return true;
      }
    }
  }

  return false;
}

// Find wrapper sessionId for a Claude session (by direct match or project match)
function findWrapperForSession(sessionId: string): string | null {
  if (!wrapperSocketsRef || !wrapperSessionsRef) return null;

  // Direct match
  const ws = wrapperSocketsRef.get(sessionId);
  if (ws && ws.readyState === WebSocket.OPEN) return sessionId;

  // Match by project name from topic
  const topic = sessionTopics.get(sessionId);
  if (topic?.project) {
    for (const [, session] of wrapperSessionsRef) {
      if (session.project === topic.project) {
        const wrapperWs = wrapperSocketsRef.get(session.sessionId);
        if (wrapperWs && wrapperWs.readyState === WebSocket.OPEN) {
          return session.sessionId;
        }
      }
    }
  }

  return null;
}

// Find full session ID from 8-char prefix (used in callback data)
// Improved matching: tries exact match, prefix match, then project+cwd match
function findSessionByPrefix(prefix: string): string | null {
  // 1. Exact sessionId match in session topics
  if (sessionTopics.has(prefix)) {
    return prefix;
  }

  // 2. Check session topics by prefix
  for (const [sessionId] of sessionTopics) {
    if (sessionId.startsWith(prefix)) {
      return sessionId;
    }
  }

  // 3. Check wrapper sessions by exact match
  if (wrapperSessionsRef?.has(prefix)) {
    return prefix;
  }

  // 4. Check wrapper sessions by prefix
  if (wrapperSessionsRef) {
    for (const [sessionId] of wrapperSessionsRef) {
      if (sessionId.startsWith(prefix)) {
        return sessionId;
      }
    }
  }

  // 5. Check form states (might have session ID stored there)
  for (const [sessionId] of formStates) {
    if (sessionId.startsWith(prefix)) {
      return sessionId;
    }
  }

  return null;
}

export function initTelegram(telegramConfig: TelegramConfig): void {
  config = telegramConfig;
  bot = new Telegraf(telegramConfig.botToken);

  // Security: Only accept messages from configured chat_id
  bot.use((ctx, next) => {
    const chatId = ctx.chat?.id?.toString();
    if (chatId !== config?.chatId) {
      console.log(`Telegram: Ignoring message from unauthorized chat: ${chatId}`);
      return;
    }
    return next();
  });

  // Handle /kill command - send Ctrl+C
  bot.command("kill", async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) {
      await ctx.reply("Use this command in a session topic.");
      return;
    }

    const sessionId = topicToSession.get(topicId);
    if (!sessionId) {
      await ctx.reply("No session associated with this topic.");
      return;
    }

    const wrapperSessionId = findWrapperForSession(sessionId);
    if (wrapperSessionId) {
      const sent = sendSignalToWrapper(wrapperSessionId, "SIGINT");
      if (sent) {
        await ctx.reply("⚡ Sent Ctrl+C (SIGINT)", { message_thread_id: topicId });
      } else {
        await ctx.reply("✗ Failed to send signal", { message_thread_id: topicId });
      }
    } else {
      await ctx.reply("✗ No wrapper connected for this session", { message_thread_id: topicId });
    }
  });

  // Handle /kill! command - force kill (SIGTERM)
  bot.command("killl", async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) {
      await ctx.reply("Use this command in a session topic.");
      return;
    }

    const sessionId = topicToSession.get(topicId);
    if (!sessionId) {
      await ctx.reply("No session associated with this topic.");
      return;
    }

    const wrapperSessionId = findWrapperForSession(sessionId);
    if (wrapperSessionId) {
      const sent = sendSignalToWrapper(wrapperSessionId, "SIGTERM");
      if (sent) {
        await ctx.reply("💀 Sent SIGTERM (force kill)", { message_thread_id: topicId });
      } else {
        await ctx.reply("✗ Failed to send signal", { message_thread_id: topicId });
      }
    } else {
      await ctx.reply("✗ No wrapper connected for this session", { message_thread_id: topicId });
    }
  });

  // Handle /escape command - send Escape key
  bot.command("escape", async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (!topicId) {
      await ctx.reply("Use this command in a session topic.");
      return;
    }

    const sessionId = topicToSession.get(topicId);
    if (!sessionId) {
      await ctx.reply("No session associated with this topic.");
      return;
    }

    const wrapperSessionId = findWrapperForSession(sessionId);
    if (wrapperSessionId) {
      const sent = sendSignalToWrapper(wrapperSessionId, "escape");
      if (sent) {
        await ctx.reply("⎋ Sent Escape key", { message_thread_id: topicId });
      } else {
        await ctx.reply("✗ Failed to send signal", { message_thread_id: topicId });
      }
    } else {
      await ctx.reply("✗ No wrapper connected for this session", { message_thread_id: topicId });
    }
  });

  // Handle inline keyboard button clicks
  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : null;
    if (!data) return;

    // Parse callback data formats:
    // "opt:sessionIdPrefix:optionIndex:isMulti:optionLabel" - select option by number
    // "other:sessionIdPrefix" - prompt user to type custom input
    // "nav:sessionIdPrefix:direction" - navigate tabs (left/right)
    const parts = data.split(":");
    const action = parts[0];
    const sessionIdPrefix = parts[1];

    // Find full session ID from prefix
    const fullSessionId = findSessionByPrefix(sessionIdPrefix);

    if (action === "opt" && fullSessionId) {
      const optionIndex = parseInt(parts[2], 10); // 1-based option number
      const isMultiSelect = parts[3] === "1"; // "1" = multi-select, "0" = single
      const optionLabel = parts.slice(4).join(":"); // Label might contain colons

      const wrapperSessionId = findWrapperForSession(fullSessionId);
      if (wrapperSessionId) {
        let sent = false;

        if (isMultiSelect) {
          // BUG FIX: Multi-select needs Space bar to toggle, not number keys
          // Claude Code has a bug where Enter acts like Tab in multi-select mode
          // Must navigate with arrows then press Space to toggle

          // Get or initialize multi-select state
          let msState = multiSelectStates.get(fullSessionId);
          if (!msState) {
            msState = { currentHighlight: 0, selectedOptions: new Set() };
            multiSelectStates.set(fullSessionId, msState);
          }

          const targetIndex = optionIndex - 1; // Convert to 0-based

          // Navigate to target option using arrow keys
          const currentPos = msState.currentHighlight;
          const stepsNeeded = targetIndex - currentPos;

          if (stepsNeeded > 0) {
            // Navigate down
            for (let i = 0; i < stepsNeeded; i++) {
              sendInjectToWrapper(wrapperSessionId, "\x1b[B", true); // Down arrow
              await delay(KEY_DELAY_MS);
            }
          } else if (stepsNeeded < 0) {
            // Navigate up
            for (let i = 0; i < Math.abs(stepsNeeded); i++) {
              sendInjectToWrapper(wrapperSessionId, "\x1b[A", true); // Up arrow
              await delay(KEY_DELAY_MS);
            }
          }

          // Now press Space to toggle the option
          await delay(KEY_DELAY_MS);
          sent = sendInjectToWrapper(wrapperSessionId, " ", true); // Space bar

          // Update state
          msState.currentHighlight = targetIndex;
          if (msState.selectedOptions.has(targetIndex)) {
            msState.selectedOptions.delete(targetIndex);
          } else {
            msState.selectedOptions.add(targetIndex);
          }

          if (sent) {
            const toggleState = msState.selectedOptions.has(targetIndex) ? "✓" : "○";
            await ctx.answerCbQuery(`${toggleState} ${optionLabel}`);

            // Update the keyboard to show selection state
            const formState = formStates.get(fullSessionId);
            if (formState) {
              await updateQuestionKeyboard(ctx, fullSessionId, formState);
            }
          } else {
            await ctx.answerCbQuery("✗ Failed to send");
          }
        } else {
          // Single-select: number keys work correctly
          sent = sendInjectToWrapper(wrapperSessionId, String(optionIndex), true);

          if (sent) {
            // Single-select: advance to next question after selection
            await delay(KEY_DELAY_MS);
            sendInjectToWrapper(wrapperSessionId, "\x1b[C", true); // Right arrow

            // Update form state
            const formState = formStates.get(fullSessionId);
            if (formState) {
              formState.currentQuestionIndex++;
              formState.answers.set(formState.currentQuestionIndex - 1, [optionLabel]);

              // If more questions, show next question's keyboard
              if (formState.currentQuestionIndex < formState.questions.length) {
                await delay(KEY_DELAY_MS * 2);
                await updateQuestionKeyboard(ctx, fullSessionId, formState);
              } else {
                // Last question answered, clear keyboard
                await ctx.editMessageText(
                  `✓ Selected: ${optionLabel}`,
                  { reply_markup: undefined }
                );
              }
            } else {
              await ctx.answerCbQuery("✓ Selected");
              await ctx.editMessageText(
                `✓ Selected: ${optionLabel}`,
                { reply_markup: undefined }
              );
            }
          } else {
            await ctx.answerCbQuery("✗ Failed to send");
          }
        }
      } else {
        // Fallback to PTY/tmux injection
        const result = await injectToSession(String(optionIndex), fullSessionId, config?.tmuxSession);
        if (result.success) {
          await ctx.answerCbQuery("✓ Sent");
          await ctx.editMessageText(
            `✓ Selected: ${optionLabel}`,
            { reply_markup: undefined }
          );
        } else {
          await ctx.answerCbQuery(`✗ ${result.error}`);
        }
      }
    } else if (action === "nav" && fullSessionId) {
      // Navigation buttons for multi-step forms
      const direction = parts[2]; // "left", "right", or "submit"

      const wrapperSessionId = findWrapperForSession(fullSessionId);
      if (!wrapperSessionId) {
        await ctx.answerCbQuery("✗ No wrapper connected");
        return;
      }

      const formState = formStates.get(fullSessionId);

      if (direction === "left") {
        // Left arrow to previous tab
        sendInjectToWrapper(wrapperSessionId, "\x1b[D", true);

        // Update form state and keyboard
        if (formState && formState.currentQuestionIndex > 0) {
          formState.currentQuestionIndex--;
          await delay(KEY_DELAY_MS * 2);
          await updateQuestionKeyboard(ctx, fullSessionId, formState);
        }
        await ctx.answerCbQuery("◀ Previous");
      } else if (direction === "right") {
        // Right arrow to next tab
        sendInjectToWrapper(wrapperSessionId, "\x1b[C", true);

        // Update form state and keyboard
        if (formState && formState.currentQuestionIndex < formState.questions.length - 1) {
          formState.currentQuestionIndex++;
          await delay(KEY_DELAY_MS * 2);
          await updateQuestionKeyboard(ctx, fullSessionId, formState);
        }
        await ctx.answerCbQuery("▶ Next");
      } else if (direction === "submit") {
        // BUG FIX: Calculate arrows needed based on current position, not hardcoded 5
        const currentIndex = formState?.currentQuestionIndex ?? 0;
        const totalQuestions = formState?.questions.length ?? 1;
        const stepsToSubmit = totalQuestions - currentIndex;

        // Navigate to Submit tab
        for (let i = 0; i < stepsToSubmit; i++) {
          sendInjectToWrapper(wrapperSessionId, "\x1b[C", true); // Right arrow
          await delay(KEY_DELAY_MS);
        }

        // Now press "1" to select "Submit answers"
        await delay(KEY_DELAY_MS);
        sendInjectToWrapper(wrapperSessionId, "1", true);

        // Clean up state
        formStates.delete(fullSessionId);
        multiSelectStates.delete(fullSessionId);

        await ctx.answerCbQuery("✓ Submitting...");
        await ctx.editMessageText("✓ Submitted", { reply_markup: undefined });
      } else {
        await ctx.answerCbQuery("Unknown direction");
      }
    } else if (action === "other" && fullSessionId) {
      // BUG FIX: "Other..." should NOT send Escape - it cancels the dialog
      // Instead, just prompt user to type and inject text directly
      const wrapperSessionId = findWrapperForSession(fullSessionId);
      if (wrapperSessionId) {
        // DON'T send Escape - it cancels the dialog!
        // Just mark as pending custom input and prompt user to type
        pendingCustomInput.set(fullSessionId, {
          toolInput: {},
          questionIndex: formStates.get(fullSessionId)?.currentQuestionIndex ?? 0,
          freeTextOptionIndex: 0,
        });

        await ctx.answerCbQuery("Ready for text input");
        await ctx.editMessageText(
          `📝 Type your custom response and send it.\n\nYour text will be entered directly into Claude.`,
          { reply_markup: undefined }
        );
      } else {
        await ctx.answerCbQuery("✗ No wrapper connected");
      }
    } else if (!fullSessionId) {
      await ctx.answerCbQuery("Session not found");
    }
  });

  // Handle incoming text messages as responses
  bot.on("text", async (ctx) => {
    const response = ctx.message.text;
    const topicId = ctx.message.message_thread_id;

    // Sanitize input - remove control characters except newlines
    const sanitized = response.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "");

    if (!sanitized.trim()) {
      await ctx.reply("Empty response ignored.");
      return;
    }

    // Skip bot commands
    if (sanitized.startsWith("/")) {
      return;
    }

    console.log(`Telegram: Received response in topic ${topicId}: "${sanitized.substring(0, 50)}${sanitized.length > 50 ? "..." : ""}"`);

    try {
      let result;

      // If message is in a topic, route to that specific session
      if (topicId && topicToSession.has(topicId)) {
        const sessionId = topicToSession.get(topicId)!;

        // Check if this is a pending custom input (user clicked "Other..." earlier)
        const isPendingCustom = pendingCustomInput.has(sessionId);
        if (isPendingCustom) {
          pendingCustomInput.delete(sessionId);
          console.log(`Telegram: Custom input for session ${sessionId.substring(0, 8)}`);
        }

        // Try wrapper first, then fallback to PTY/tmux
        const wrapperSessionId = findWrapperForSession(sessionId);
        if (wrapperSessionId) {
          const sent = sendInjectToWrapper(wrapperSessionId, sanitized);
          result = sent
            ? { success: true }
            : { success: false, error: "Failed to send to wrapper" };
        } else {
          result = await injectToSession(sanitized, sessionId, config?.tmuxSession);
        }
      } else {
        // Fallback to default injection (first available PTY or tmux)
        result = await injectResponse(sanitized, config?.tmuxSession);
      }

      if (result.success) {
        await ctx.reply("✓ Sent", { message_thread_id: topicId });
      } else {
        await ctx.reply(`✗ ${result.error}`, { message_thread_id: topicId });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      await ctx.reply(`Error: ${errorMessage}`, { message_thread_id: topicId });
    }
  });

  // Handle /status command
  bot.command("status", async (ctx) => {
    const status = state.getStatus();
    const sessionCount = status.sessions.length;
    const working = status.sessions.filter(s => s.status === "working").length;
    const waiting = status.sessions.filter(s => s.status === "waiting_for_input").length;
    const wrapperCount = wrapperSocketsRef?.size ?? 0;

    let message = `📊 Claude Blocker Status\n\n`;
    message += `Sessions: ${sessionCount}\n`;
    message += `Working: ${working}\n`;
    message += `Waiting: ${waiting}\n`;
    message += `Wrappers: ${wrapperCount}\n`;
    message += `Blocking: ${status.blocked ? "Yes" : "No"}\n\n`;
    message += `Active topics: ${sessionTopics.size}`;

    await ctx.reply(message, { message_thread_id: ctx.message.message_thread_id });
  });

  // Handle /help command
  bot.command("help", async (ctx) => {
    const helpText = `🤖 Claude Blocker Commands

/status - Show session status
/kill - Send Ctrl+C to session (interrupt)
/killl - Force kill session (SIGTERM)
/escape - Send Escape key

Reply to messages to send input to Claude.
Use inline buttons when available for quick responses.`;

    await ctx.reply(helpText, { message_thread_id: ctx.message.message_thread_id });
  });

  // Subscribe to session lifecycle events
  state.onSessionStart((event) => {
    createSessionTopic(event);
  });

  state.onSessionEnd((event) => {
    deleteSessionTopic(event.sessionId);
  });

  // Subscribe to waiting_for_input events
  state.onWaitingForInput((event) => {
    sendWaitingNotification(event);
  });

  // Start the bot with long polling
  bot.launch().then(async () => {
    console.log("Telegram bot started (forum topics mode)");
    // Clean up old topics from previous sessions
    await cleanupOldTopics();
  }).catch((error) => {
    console.error("Failed to start Telegram bot:", error.message);
  });

  // Graceful shutdown
  process.once("SIGINT", () => bot?.stop("SIGINT"));
  process.once("SIGTERM", () => bot?.stop("SIGTERM"));
}

// Clean up old topics from previous server runs
async function cleanupOldTopics(): Promise<void> {
  if (!bot || !config) return;

  const topicIds = loadPersistedTopics();
  if (topicIds.length === 0) {
    console.log("Telegram: No old topics to clean up");
    return;
  }

  console.log(`Telegram: Cleaning up ${topicIds.length} old topic(s)...`);

  for (const topicId of topicIds) {
    try {
      // Try to close the topic
      await bot.telegram.closeForumTopic(config.chatId, topicId);
      console.log(`Telegram: Closed old topic ${topicId}`);
    } catch (error) {
      // Topic might already be closed or deleted, ignore
      const msg = error instanceof Error ? error.message : "";
      if (!msg.includes("TOPIC_CLOSED") && !msg.includes("TOPIC_NOT_FOUND")) {
        console.log(`Telegram: Could not close topic ${topicId}: ${msg}`);
      }
    }
  }

  // Clear the persisted topics after cleanup
  savePersistedTopics([]);
  console.log("Telegram: Cleanup complete");
}

async function createSessionTopic(event: SessionStartEvent): Promise<void> {
  if (!bot || !config) return;

  // Skip if topic already exists for this session
  if (sessionTopics.has(event.sessionId)) {
    return;
  }

  const projectName = event.project || "Unknown Project";
  const shortId = event.sessionId.substring(0, 8);
  const topicName = `🤖 ${projectName} (${shortId})`;

  try {
    const result = await bot.telegram.createForumTopic(
      config.chatId,
      topicName,
      { icon_color: 0x6FB9F0 } // Blue color
    );

    const topic: SessionTopic = {
      topicId: result.message_thread_id,
      sessionId: event.sessionId,
      project: projectName,
      createdAt: new Date(),
    };

    sessionTopics.set(event.sessionId, topic);
    topicToSession.set(result.message_thread_id, event.sessionId);

    // Persist topic ID for cleanup on restart
    persistTopicId(result.message_thread_id);

    // Start transcript watcher if we have a transcript path
    if (event.transcriptPath) {
      startWatchingTranscript(event.sessionId, event.transcriptPath);
    }

    // Check if wrapper is connected for this session
    const hasWrapper = hasWrapperSession(event.sessionId);
    const welcomeMessage = hasWrapper
      ? `Claude session started (wrapper connected).\nReply here to send input to this session.\n\nCommands: /kill /killl /escape`
      : `Claude session started.\nReply here to send input to this session.`;

    // Send welcome message to the topic
    await bot.telegram.sendMessage(
      config.chatId,
      welcomeMessage,
      { message_thread_id: result.message_thread_id }
    );

    console.log(`Telegram: Created topic "${topicName}" for session ${shortId}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`Telegram: Failed to create topic: ${errorMessage}`);

    // If forum topics aren't enabled, fall back to regular messages
    if (errorMessage.includes("CHAT_NOT_MODIFIED") || errorMessage.includes("forum")) {
      console.log("Telegram: Forum topics not enabled, using regular messages");
    }
  }
}

async function deleteSessionTopic(sessionId: string): Promise<void> {
  if (!bot || !config) return;

  // Stop transcript watcher for this session
  stopWatchingTranscript(sessionId);

  const topic = sessionTopics.get(sessionId);
  if (!topic) return;

  try {
    // Send goodbye message before closing
    await bot.telegram.sendMessage(
      config.chatId,
      `Session ended.`,
      { message_thread_id: topic.topicId }
    );

    // Close the topic (can't fully delete, but can close it)
    await bot.telegram.closeForumTopic(config.chatId, topic.topicId);

    // Clean up maps and persistence
    sessionTopics.delete(sessionId);
    topicToSession.delete(topic.topicId);
    unpersistTopicId(topic.topicId);

    console.log(`Telegram: Closed topic for session ${sessionId.substring(0, 8)}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`Telegram: Failed to close topic: ${errorMessage}`);

    // Clean up maps and persistence even if API call fails
    sessionTopics.delete(sessionId);
    topicToSession.delete(topic.topicId);
    unpersistTopicId(topic.topicId);
  }
}

// Extract ALL structured questions from tool input
interface AllQuestionsResult {
  questions: StructuredQuestion[];
  totalQuestions: number;
}

function extractAllStructuredQuestions(toolInput?: Record<string, unknown>): AllQuestionsResult | null {
  if (!toolInput) return null;

  // AskUserQuestion format: { questions: [{ question: "...", options: [...], header: "...", multiSelect: bool }] }
  if (Array.isArray(toolInput.questions) && toolInput.questions.length > 0) {
    const questions: StructuredQuestion[] = [];

    for (const q of toolInput.questions) {
      const question = q as {
        question?: string;
        header?: string;
        options?: QuestionOption[];
        multiSelect?: boolean;
      };

      if (question?.question) {
        questions.push({
          question: question.question,
          header: question.header,
          options: question.options || [],
          multiSelect: question.multiSelect,
        });
      }
    }

    if (questions.length > 0) {
      return {
        questions,
        totalQuestions: questions.length,
      };
    }
  }

  return null;
}

// Find the index of the "Type something" / free text option (usually last)
function findFreeTextOptionIndex(options: QuestionOption[]): number {
  // Look for common free text option patterns
  const freeTextPatterns = [
    "type something",
    "type your",
    "other",
    "custom",
    "enter your",
    "write your",
  ];

  for (let i = 0; i < options.length; i++) {
    const label = options[i].label.toLowerCase();
    if (freeTextPatterns.some((p) => label.includes(p))) {
      return i + 1; // 1-based index for TUI
    }
  }

  // Default to last option + 1 (assumes "Type something" is always last)
  return options.length + 1;
}

export function sendWaitingNotification(event: WaitingForInputEvent): void {
  if (!bot || !config) return;

  const topic = sessionTopics.get(event.sessionId);
  const topicId = topic?.topicId;

  // Don't send to General channel - only send if we have a topic
  if (!topicId) {
    console.log(`Telegram: Skipping notification for session ${event.sessionId.substring(0, 8)} - no topic yet`);
    return;
  }

  // BUG FIX: Notification deduplication - skip if same question within debounce window
  const now = Date.now();
  const questionHash = hashQuestion(event.question, event.toolInput);
  const recent = recentNotifications.get(event.sessionId);

  if (recent && (now - recent.timestamp) < NOTIFICATION_DEBOUNCE_MS && recent.questionHash === questionHash) {
    console.log(`Telegram: Skipping duplicate notification for session ${event.sessionId.substring(0, 8)}`);
    return;
  }

  // Update recent notification record
  recentNotifications.set(event.sessionId, { questionHash, timestamp: now });

  // Try to extract ALL structured questions
  const allQuestions = extractAllStructuredQuestions(event.toolInput);

  // BUG FIX: Initialize form state for multi-step forms
  if (allQuestions && allQuestions.questions.length > 0) {
    // Clean up any previous state for this session
    multiSelectStates.delete(event.sessionId);

    // Initialize form state
    formStates.set(event.sessionId, {
      currentQuestionIndex: 0,
      questions: allQuestions.questions,
      answers: new Map(),
      toolInput: event.toolInput,
    });
  }

  // Build the message
  let message = `❓ Claude needs your input\n\n`;

  // Show question summary for multi-question forms
  if (allQuestions && allQuestions.questions.length > 1) {
    message += `📋 Multi-step form (${allQuestions.totalQuestions} questions):\n`;
    for (let i = 0; i < allQuestions.questions.length; i++) {
      const q = allQuestions.questions[i];
      const header = q.header ? `[${q.header}]` : `Q${i + 1}`;
      const multiNote = q.multiSelect ? " ✦" : "";
      message += `  ${i + 1}. ${header}${multiNote}\n`;
    }
    message += "\n";
  }

  // Show current question details
  const currentQuestion = allQuestions?.questions[0];
  if (currentQuestion) {
    const header = currentQuestion.header ? `[${currentQuestion.header}] ` : "";
    const multiNote = currentQuestion.multiSelect ? " (select multiple)" : "";
    const qNum = allQuestions && allQuestions.totalQuestions > 1 ? `Question 1/${allQuestions.totalQuestions} ` : "";

    message += `${qNum}${header}${multiNote}\n${currentQuestion.question}\n\n`;
  } else if (event.question) {
    // Single question with no options
    const maxLen = 500;
    const question = event.question.length > maxLen
      ? event.question.substring(0, maxLen) + "..."
      : event.question;
    message += `${question}\n\n`;
  }

  // Generate keyboard using form state
  const formState = formStates.get(event.sessionId);
  const keyboard = formState
    ? generateQuestionKeyboard(event.sessionId, formState, 0)
    : null;

  if (keyboard) {
    const isMultiSelect = currentQuestion?.multiSelect === true;
    const multiSelectNote = isMultiSelect
      ? " (Select multiple, then ✓ Submit)"
      : "";

    const isMultiStep = allQuestions && allQuestions.totalQuestions > 1;
    const suffix = isMultiStep
      ? "\n\nUse ◀ ▶ to navigate between questions."
      : "";

    bot.telegram.sendMessage(config.chatId, message + `Select an option or type your answer:${multiSelectNote}${suffix}`, {
      message_thread_id: topicId,
      ...keyboard,
    }).catch((error) => {
      console.error("Failed to send Telegram notification:", error.message);
    });
  } else {
    // No structured options, just send text message
    message += `Reply to respond.`;

    bot.telegram.sendMessage(config.chatId, message, {
      message_thread_id: topicId,
    }).catch((error) => {
      console.error("Failed to send Telegram notification:", error.message);
    });
  }
}

// Forward output from wrapper to Telegram topic
export function forwardOutputToTelegram(wrapperSessionId: string, text: string): void {
  if (!bot || !config) return;

  // Find the topic for this wrapper session
  // First check if there's a direct session topic match
  let topic = sessionTopics.get(wrapperSessionId);

  // If not, find by project name (wrapper might have different sessionId than Claude hooks)
  if (!topic && wrapperSessionsRef) {
    const wrapperSession = wrapperSessionsRef.get(wrapperSessionId);
    if (wrapperSession?.project) {
      // Find any session topic with matching project
      for (const [, sessionTopic] of sessionTopics) {
        if (sessionTopic.project === wrapperSession.project) {
          topic = sessionTopic;
          break;
        }
      }
    }
  }

  if (!topic) {
    // No topic yet - this can happen if output arrives before session_start hook
    return;
  }

  // Truncate long messages for Telegram (max 4096 chars)
  let message = text;
  if (message.length > 3800) {
    message = "..." + message.substring(message.length - 3800);
  }

  // Send as plain text - cleaner for mobile
  bot.telegram.sendMessage(config.chatId, message, {
    message_thread_id: topic.topicId,
  }).catch((error) => {
    console.error("Failed to forward output to Telegram:", error.message);
  });
}

export function stopTelegram(): void {
  // Stop all transcript watchers
  stopAllTranscriptWatchers();

  if (bot) {
    bot.stop();
    bot = null;
  }
  config = null;
  sessionTopics.clear();
  topicToSession.clear();
  pendingCustomInput.clear();
  formStates.clear();
  multiSelectStates.clear();
  recentNotifications.clear();
}
