#!/usr/bin/env node

import { createInterface } from "readline";
import { startServer } from "./server.js";
import { setupHooks, removeHooks, areHooksConfigured } from "./setup.js";
import { DEFAULT_PORT } from "@claude-blocker/shared";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

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
    // Create a VBS script that runs the server hidden
    const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c npx claude-blocker", 0, False
`;
    writeFileSync(startupPath, vbsContent);
    console.log("✓ Added Claude Blocker to Windows startup");
    console.log(`  Location: ${startupPath}`);
    console.log("\nThe server will now start automatically when you log in.");
  } else if (process.platform === "darwin") {
    // Create a launchd plist for macOS
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
    // Create a .desktop file for Linux
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
Claude Blocker - Block distracting sites when Claude Code isn't working

Usage:
  npx claude-blocker [options]

Options:
  --setup          Configure Claude Code hooks
  --remove         Remove Claude Code hooks
  --startup        Add to system startup (auto-start on login)
  --remove-startup Remove from system startup
  --port           Server port (default: ${DEFAULT_PORT})
  --help           Show this help message

Examples:
  npx claude-blocker               # Start the server (prompts for setup on first run)
  npx claude-blocker --startup     # Add to startup so it runs automatically
  npx claude-blocker --port 9000   # Start on custom port
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

  // Check if hooks are configured, prompt for setup if not
  if (!areHooksConfigured()) {
    console.log("Claude Blocker hooks are not configured yet.\n");
    const answer = await prompt("Would you like to set them up now? (Y/n) ");
    const normalized = answer.trim().toLowerCase();

    if (normalized === "" || normalized === "y" || normalized === "yes") {
      setupHooks();
      console.log(""); // Add spacing before server start
    } else {
      console.log("\nSkipping setup. You can run 'npx claude-blocker --setup' later.\n");
    }
  }

  startServer(port);
}

main();
