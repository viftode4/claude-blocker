import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin.ts", "src/server.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  // Bundle the shared package since it's TypeScript-only
  noExternal: ["@claude-blocker/shared"],
});
