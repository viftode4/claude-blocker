#!/usr/bin/env node

// ccwd - Claude Code Wrapped (Dangerous mode)
// This is a simple entry point that sets the mode and imports wrapper

process.env.CCWD_DANGEROUS_MODE = "1";

// Import and run wrapper
import("./wrapper.js").catch((err) => {
  console.error("Failed to load wrapper:", err);
  process.exit(1);
});
