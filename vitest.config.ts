import { defineConfig } from "vitest/config";

// Unit tests of the pure modules run in Node, which has the same WebCrypto
// the Worker uses. Tests against the Durable Object itself are phase 2.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node"
  }
});
