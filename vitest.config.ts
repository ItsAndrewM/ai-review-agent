import { readFileSync } from "node:fs"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    {
      name: "markdown-as-text",
      load: (id) => (id.endsWith(".md") ? `export default ${JSON.stringify(readFileSync(id, "utf8"))}` : null),
    },
  ],
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
})
