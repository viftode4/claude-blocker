# Claude Blocker

Block distracting websites unless [Claude Code](https://claude.ai/claude-code) is actively running inference.

**The premise is simple:** if Claude is working, you should be too. When Claude stops, your distractions come back.

> **Fork Note:** This is a fork of [t3-content/claude-blocker](https://github.com/t3-content/claude-blocker) by [Theo Browne](https://github.com/t3dotgg). See [What's New in This Fork](#whats-new-in-this-fork) for added features.

## How It Works

```
┌─────────────────┐     hooks      ┌─────────────────┐    websocket    ┌─────────────────┐
│   Claude Code   │ ─────────────► │  Blocker Server │ ◄─────────────► │ Chrome Extension│
│   (terminal)    │                │  (localhost)    │                 │   (browser)     │
└─────────────────┘                └─────────────────┘                 └─────────────────┘
       │                                   │                                   │
       │ UserPromptSubmit                  │ tracks sessions                   │ blocks sites
       │ PreToolUse                        │ broadcasts state                  │ shows modal
       │ Stop                              │                                   │ status overlay
       └───────────────────────────────────┴───────────────────────────────────┘
```

1. **Claude Code hooks** notify the server when you submit a prompt or when Claude finishes
2. **Blocker server** tracks all Claude Code sessions and their working/idle states
3. **Chrome extension** blocks configured sites when no session is actively working

## Installation

### Prerequisites

- **Node.js 18+** - [Download](https://nodejs.org/)
- **Chrome** (or Chromium-based browser like Edge, Brave, Arc)
- **Claude Code** - [Install](https://claude.ai/claude-code)

### Step 1: Install and Start the Server

```bash
npx claude-blocker --setup
```

This does three things:
1. Downloads and runs the blocker server
2. Automatically configures Claude Code hooks in `~/.claude/settings.json`
3. Starts listening for Claude Code sessions on port 9117

**Keep this terminal running** - the server needs to stay active.

> **Tip:** Add this to your shell startup file (`.bashrc`, `.zshrc`, etc.) to auto-start:
> ```bash
> npx claude-blocker &>/dev/null &
> ```

### Step 2: Install the Chrome Extension

#### Option A: Load Unpacked (Development)

1. Clone this repository:
   ```bash
   git clone https://github.com/viftode4/claude-blocker.git
   cd claude-blocker
   ```

2. Install dependencies and build:
   ```bash
   npm install -g pnpm   # if you don't have pnpm
   pnpm install
   pnpm build
   ```

3. Load in Chrome:
   - Navigate to `chrome://extensions`
   - Enable **Developer mode** (toggle in top-right)
   - Click **Load unpacked**
   - Select the `packages/extension/dist` folder

#### Option B: Chrome Web Store

*Coming soon*

### Step 3: Configure Blocked Sites

1. Click the Claude Blocker extension icon in Chrome
2. Click the **Settings** button (gear icon)
3. Add sites you want blocked when Claude is idle

**Default blocked sites:** `x.com`, `youtube.com`

### Verify It's Working

1. Make sure the server is running (`npx claude-blocker`)
2. Open Claude Code in a terminal and submit a prompt
3. The extension popup should show "Working" status
4. The status overlay should appear in your browser

## Features

### Core Features (Original)

- **Soft blocking** - Sites show a modal overlay, not a hard block
- **Real-time updates** - No page refresh needed when state changes
- **Multi-session support** - Tracks multiple Claude Code instances
- **Emergency bypass** - 5-minute bypass, once per day
- **Configurable sites** - Add/remove sites from extension settings
- **Works offline** - Blocks everything when server isn't running (safety default)

### What's New in This Fork

- **Status overlay widget** - Draggable widget on all pages showing live session status
- **Session details** - See each session's project name and current state (working, idle, waiting)
- **"Waiting for input" notifications** - Toast alert when Claude has a question for you
- **Block All Sites mode** - Nuclear option to block ALL sites, not just your configured list
- **Collapsible overlay** - Hide the overlay to a mini button, show it when you need it
- **Overlay toggle** - Quick show/hide from the extension popup

## Server CLI

```bash
# Start with auto-setup (recommended for first run)
npx claude-blocker --setup

# Start on custom port
npx claude-blocker --port 9000

# Just start the server (hooks already configured)
npx claude-blocker

# Remove hooks from Claude Code settings
npx claude-blocker --remove

# Show help
npx claude-blocker --help
```

## Development

```bash
# Clone and install
git clone https://github.com/viftode4/claude-blocker.git
cd claude-blocker
pnpm install

# Build everything
pnpm build

# Development mode (watches for changes)
pnpm dev
```

### Project Structure

```
packages/
├── server/      # Node.js server + CLI (published to npm)
├── extension/   # Chrome extension (Manifest V3)
└── shared/      # Shared TypeScript types
```

### Building the Extension

```bash
cd packages/extension
pnpm build
```

The built extension will be in `packages/extension/dist`.

## Troubleshooting

### Extension shows "Offline"
- Make sure the server is running: `npx claude-blocker`
- Check if port 9117 is available

### Sites not being blocked
- Verify the site is in your blocked list (Settings page)
- Check that Claude Code is idle (not actively working)
- Try refreshing the page

### Overlay not appearing
- Click the extension icon and check if "Show Overlay" is enabled
- Try clicking the mini button (📊) in the corner if overlay was hidden

### Hooks not working
- Run `npx claude-blocker --setup` to reconfigure hooks
- Restart Claude Code after hook configuration

## Privacy

- **No data collection** - All data stays on your machine
- **Local only** - Server runs on localhost, no external connections
- **Chrome sync** - Blocked sites list syncs via your Chrome account (if enabled)

See [PRIVACY.md](PRIVACY.md) for full privacy policy.

## Credits

- Original project by [Theo Browne](https://github.com/t3dotgg) at [t3-content/claude-blocker](https://github.com/t3-content/claude-blocker)
- Fork maintained by [viftode4](https://github.com/viftode4)

## License

MIT
