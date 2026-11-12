// Keeps disposable Docker/SSH acceptance explicit and outside the normal offline unit suite.
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/remote-terminal.acceptance.ts"], testTimeout: 30_000 } });
