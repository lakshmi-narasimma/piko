import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    // Resets and migrates the test database once per run (see test/global-setup.ts).
    globalSetup: ["./test/global-setup.ts"],
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
