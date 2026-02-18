#!/usr/bin/env node

import { config as loadEnv } from "dotenv";
import { createInterface } from "readline";
import { startServer } from "./server.js";
import { setupHooks, removeHooks, areHooksConfigured } from "./setup.js";
import { DEFAULT_PORT } from "@claude-blocker/shared";
import type { TelegramConfig } from "./types.js";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

// Load .env from package directory
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, "..", ".env") });

const args = process.argv.slice(2);

function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function getStartupPath(): string {
  if (process.platform === "win32") {
    return join(homedir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "claude-blocker.vbs");
  } else if (process.platform === "darwin") {
    return join(homedir(), "Library", "LaunchAgents", "com.claude-blocker.plist");
  } else {
    return join(homedir(), ".config", "autostart", "claude-blocker.desktop");
  }
}

function setupStartup(): void {
  const startupPath = getStartupPath();

  if (process.platform === "win32") {
    const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c npx claude-blocker", 0, False
`;
    writeFileSync(startupPath, vbsContent);
    console.log("✓ Added Claude Blocker to Windows startup");
    console.log(`  Location: ${startupPath}`);
    console.log("\nThe server will now start automatically when you log in.");
  } else if (process.platform === "darwin") {
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-blocker</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/npx</string>
        <string>claude-blocker</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
`;
    writeFileSync(startupPath, plistContent);
    console.log("✓ Added Claude Blocker to macOS startup");
    console.log(`  Location: ${startupPath}`);
    console.log("\nRun: launchctl load " + startupPath);
  } else {
    const desktopContent = `[Desktop Entry]
Type=Application
Name=Claude Blocker
Exec=npx claude-blocker
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;
    writeFileSync(startupPath, desktopContent);
    console.log("✓ Added Claude Blocker to Linux startup");
    console.log(`  Location: ${startupPath}`);
  }
}

function removeStartup(): void {
  const startupPath = getStartupPath();

  if (existsSync(startupPath)) {
    unlinkSync(startupPath);
    console.log("✓ Removed Claude Blocker from startup");
    console.log(`  Deleted: ${startupPath}`);
  } else {
    console.log("Claude Blocker is not configured to run at startup.");
  }
}

function printHelp(): void {
  console.log(`
Claude Blocker - Block distracting sites & Telegram notifications for Claude Code

Usage:
  claude-blocker [options]      Start the server
  ccw [claude-args...]          Run Claude with multi-session Telegram support
  ccwd [claude-args...]         Same as ccw with --dangerously-skip-permissions

Server Mode (default):
  claude-blocker                    Start server only - handles multiple Claude sessions
                                    Each session gets its own Telegram topic

Wrapper Mode (recommended for multiple sessions):
  ccw                               Run Claude with Telegram integration
  ccwd                              Run with --dangerously-skip-permissions

  Use 'ccw' or 'ccwd' instead of 'claude' for full bidirectional Telegram support.
  Each instance gets its own topic - run multiple in different terminals.

Launch Mode (single session, legacy):
  claude-blocker --launch           Start server AND launch Claude with PTY injection
                                    Only supports one session at a time

Options:
  --setup          Configure Claude Code hooks (required first time)
  --remove         Remove Claude Code hooks
  --startup        Add to system startup (run server in background on login)
  --remove-startup Remove from system startup
  --port <n>       Server port (default: ${DEFAULT_PORT})
  --launch         Launch Claude in PTY with response injection (legacy)
  --no-telegram    Disable Telegram integration
  --tmux-session   tmux session name for response injection (Unix/Mac)
  --help           Show this help

Environment Variables:
  CLAUDE_COMMAND        Claude command to use (default: "claude")
  TELEGRAM_BOT_TOKEN    Override default bot token
  TELEGRAM_CHAT_ID      Override default chat ID (use group ID for topics)
  CLAUDE_BLOCKER_PORT   Override server port (for ccw)

Recommended Setup:
  1. claude-blocker --setup          # Configure hooks (one-time)
  2. claude-blocker --startup        # Add to system startup
  3. Use 'ccwd' instead of 'claude'  # Multiple sessions with reply injection

Examples:
  claude-blocker                    # Start server
  ccw                               # Run Claude with Telegram support
  ccwd                              # Run Claude with skip permissions + Telegram
  ccwd --resume                     # Resume with skip permissions
  claude-blocker --startup          # Add to Windows/Mac/Linux startup
`);
}

async function main(): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--setup")) {
    setupHooks();
    process.exit(0);
  }

  if (args.includes("--remove")) {
    removeHooks();
    process.exit(0);
  }

  if (args.includes("--startup")) {
    setupStartup();
    process.exit(0);
  }

  if (args.includes("--remove-startup")) {
    removeStartup();
    process.exit(0);
  }

  // Parse port
  let port = DEFAULT_PORT;
  const portIndex = args.indexOf("--port");
  if (portIndex !== -1 && args[portIndex + 1]) {
    const parsed = parseInt(args[portIndex + 1], 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      port = parsed;
    } else {
      console.error("Invalid port number");
      process.exit(1);
    }
  }

  // Claude command configuration
  const CLAUDE_COMMAND = process.env.CLAUDE_COMMAND || "claude";

  // Telegram configuration - enabled by default
  const DEFAULT_BOT_TOKEN = "8330508727:AAH4Ddqc15qURr-Hln-pqjwOSyscuAefDFM";
  const DEFAULT_CHAT_ID = "6274965354";

  let telegram: TelegramConfig | undefined;
  if (!args.includes("--no-telegram")) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || DEFAULT_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID || DEFAULT_CHAT_ID;

    // Parse tmux session name
    let tmuxSession: string | undefined;
    const tmuxIndex = args.indexOf("--tmux-session");
    if (tmuxIndex !== -1 && args[tmuxIndex + 1]) {
      tmuxSession = args[tmuxIndex + 1];
    }

    telegram = { botToken, chatId, tmuxSession };
  }

  // Check if hooks are configured
  if (!areHooksConfigured()) {
    console.log("Claude Blocker hooks are not configured yet.\n");
    const answer = await prompt("Would you like to set them up now? (Y/n) ");
    const normalized = answer.trim().toLowerCase();

    if (normalized === "" || normalized === "y" || normalized === "yes") {
      setupHooks();
      console.log("");
    } else {
      console.log("\nSkipping setup. You can run 'claude-blocker --setup' later.\n");
    }
  }

  // Launch mode: start server + launch Claude with PTY
  const shouldLaunch = args.includes("--launch");

  if (shouldLaunch) {
    const { launchClaudeInPty } = await import("./injector/pty.js");

    console.log(`Launching "${CLAUDE_COMMAND}" with bidirectional messaging...`);
    const launched = await launchClaudeInPty({
      command: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
      args: process.platform === "win32" ? ["/c", CLAUDE_COMMAND] : ["-c", CLAUDE_COMMAND],
      onExit: () => {
        console.log("\nClaude session ended");
        process.exit(0);
      },
    });

    if (!launched) {
      console.error("Failed to launch Claude. Make sure node-pty is installed:");
      console.error("  pnpm approve-builds && pnpm install");
      process.exit(1);
    }
  }

  // Start the server
  startServer({ port, telegram });

  if (!shouldLaunch) {
    console.log("\nServer running. Open Claude sessions normally - each gets a Telegram topic.");
    console.log("Use --launch for a session with reply injection.\n");
  }
}

main();
