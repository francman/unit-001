// Builds the interface preview with sample data into a gitignored directory; never part of a release.
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildTailwind } from "./build-tailwind.mjs";

const source = new URL("../web/", import.meta.url);
const destination = new URL("../web-preview/", import.meta.url);
await mkdir(destination, { recursive: true });
await build({
	entryPoints: [fileURLToPath(new URL("preview.ts", source))],
	outfile: fileURLToPath(new URL("bootstrap.js", destination)),
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "es2022",
	sourcemap: true,
});
await copyFile(new URL("index.html", source), new URL("index.html", destination));
buildTailwind(fileURLToPath(new URL("style.css", destination)), false);
