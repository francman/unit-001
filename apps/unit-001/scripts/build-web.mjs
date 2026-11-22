// Bundles an explicit browser asset allowlist; developer fixtures never enter a release.
import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildTailwind } from "./build-tailwind.mjs";

const source = new URL("../web/", import.meta.url);
const destination = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL("../web-dist/", import.meta.url));
await mkdir(destination, { recursive: true });
// Tailwind also scans its working directory. Keep that scan inside the browser sources regardless of the caller.
process.chdir(fileURLToPath(source));
await build({
	entryPoints: [fileURLToPath(new URL("bootstrap.ts", source))],
	outfile: join(destination, "bootstrap.js"),
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "es2022",
	minify: true,
	metafile: false,
});
await copyFile(new URL("index.html", source), join(destination, "index.html"));
buildTailwind(join(destination, "style.css"), true);
