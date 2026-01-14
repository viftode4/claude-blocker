import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { DEFAULT_PORT } from "@claude-blocker/shared";

interface ClaudeSettings {
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
}

// Platform-specific hook commands
const UNIX_HOOK_COMMAND = `curl -s -X POST http://localhost:${DEFAULT_PORT}/hook -H 'Content-Type: application/json' -d "$(cat)" > /dev/null 2>&1 &`;

// Windows command using PowerShell to read stdin and POST to the server
const WINDOWS_HOOK_COMMAND = `powershell -NoProfile -Command "$body=[Console]::In.ReadToEnd();if($body){Invoke-RestMethod -Uri 'http://localhost:${DEFAULT_PORT}/hook' -Method Post -ContentType 'application/json' -Body $body 2>$null}"`;

const HOOK_COMMAND = platform() === "win32" ? WINDOWS_HOOK_COMMAND : UNIX_HOOK_COMMAND;

const HOOKS_CONFIG = {
  UserPromptSubmit: [
    {
      hooks: [
        {
          type: "command",
          command: HOOK_COMMAND,
        },
      ],
    },
  ],
  PreToolUse: [
    {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: HOOK_COMMAND,
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: "command",
          command: HOOK_COMMAND,
        },
      ],
    },
  ],
  SessionStart: [
    {
      hooks: [
        {
          type: "command",
          command: HOOK_COMMAND,
        },
      ],
    },
  ],
  SessionEnd: [
    {
      hooks: [
        {
          type: "command",
          command: HOOK_COMMAND,
        },
      ],
    },
  ],
};

export function setupHooks(): void {
  const claudeDir = join(homedir(), ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  // Ensure .claude directory exists
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
    console.log(`Created ${claudeDir}`);
  }

  // Load existing settings or create empty object
  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      const content = readFileSync(settingsPath, "utf-8");
      settings = JSON.parse(content);
      console.log("Loaded existing settings.json");
    } catch (error) {
      console.error("Error reading settings.json:", error);
      console.log("Creating new settings.json");
    }
  }

  // Merge hooks (don't overwrite existing hooks for other events)
  settings.hooks = {
    ...settings.hooks,
    ...HOOKS_CONFIG,
  };

  // Write settings
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  console.log(`
┌─────────────────────────────────────────────────┐
│                                                 │
│   Claude Blocker Setup Complete!                │
│                                                 │
│   Hooks configured in:                          │
│   ${settingsPath}
│                                                 │
│   Configured hooks:                             │
│   - UserPromptSubmit (work starting)            │
│   - PreToolUse (tool executing)                 │
│   - Stop (work finished)                        │
│   - SessionStart (session began)                │
│   - SessionEnd (session ended)                  │
│                                                 │
│   Next: Run 'npx claude-blocker' to start       │
│                                                 │
└─────────────────────────────────────────────────┘
`);
}

export function areHooksConfigured(): boolean {
  const settingsPath = join(homedir(), ".claude", "settings.json");

  if (!existsSync(settingsPath)) {
    return false;
  }

  try {
    const content = readFileSync(settingsPath, "utf-8");
    const settings: ClaudeSettings = JSON.parse(content);

    if (!settings.hooks) {
      return false;
    }

    // Check if at least one of our hooks is configured
    return Object.keys(HOOKS_CONFIG).some((hookName) => hookName in settings.hooks!);
  } catch {
    return false;
  }
}

export function removeHooks(): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");

  if (!existsSync(settingsPath)) {
    console.log("No settings.json found, nothing to remove.");
    return;
  }

  try {
    const content = readFileSync(settingsPath, "utf-8");
    const settings: ClaudeSettings = JSON.parse(content);

    if (settings.hooks) {
      // Remove our hooks
      for (const hookName of Object.keys(HOOKS_CONFIG)) {
        delete settings.hooks[hookName];
      }

      // If hooks object is empty, remove it entirely
      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log("Claude Blocker hooks removed from settings.json");
    } else {
      console.log("No hooks found in settings.json");
    }
  } catch (error) {
    console.error("Error removing hooks:", error);
  }
}
