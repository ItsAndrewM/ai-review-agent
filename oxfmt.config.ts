import { defineConfig } from "oxfmt"

export default defineConfig({
  printWidth: 120,
  semi: false,
  sortImports: { newlinesBetween: false },
  ignorePatterns: [
    "**/*.md",
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".superpowers/**",
    ".windsurf/**",
    "pnpm-lock.yaml",
    "tools/oxlint/anti-slop/**",
  ],
})
