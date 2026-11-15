// Bundles an explicit browser asset allowlist; developer fixtures never enter a release.
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const source = new URL("../web/", import.meta.url);
const destination = new URL("../web-dist/", import.meta.url);
await mkdir(destination, { recursive: true });
await build({
	entryPoints: [fileURLToPath(new URL("bootstrap.ts", source))],
	outfile: fileURLToPath(new URL("bootstrap.js", destination)),
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "es2022",
	minify: true,
	metafile: false,
});
for (const file of ["index.html", "style.css"]) await copyFile(new URL(file, source), new URL(file, destination));
