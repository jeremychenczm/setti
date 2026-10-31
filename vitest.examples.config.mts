import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Prepared histories have no database or provider dependencies. */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["src/demo/studio-cases.test.ts"] },
});
