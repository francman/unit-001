// Runs the browser transport's deterministic boundary tests without a browser dependency.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", include: ["web/*.test.ts"] } });
