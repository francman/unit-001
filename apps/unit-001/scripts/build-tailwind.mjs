// Compiles web/style.css with the pinned Tailwind CLI into a static, CSP-safe stylesheet.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Builds `outfile` from the web stylesheet; `minify` is on for production assets. */
export function buildTailwind(outfile, minify) {
	const require = createRequire(import.meta.url);
	const manifestPath = require.resolve("@tailwindcss/cli/package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const bin = join(dirname(manifestPath), typeof manifest.bin === "string" ? manifest.bin : manifest.bin.tailwindcss);
	const input = fileURLToPath(new URL("../web/style.css", import.meta.url));
	execFileSync(process.execPath, [bin, "-i", input, "-o", outfile, ...(minify ? ["--minify"] : [])], { stdio: "inherit" });
}
