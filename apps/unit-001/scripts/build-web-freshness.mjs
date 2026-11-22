// Verifies the assets the browser fixture will serve without rebuilding them in place.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const builder = fileURLToPath(new URL("build-web.mjs", import.meta.url));
const webDist = fileURLToPath(new URL("../web-dist/", import.meta.url));
const rebuild = "From the repository root, run `node apps/unit-001/scripts/build-web.mjs`.";

/** Rejects missing assets or bytes that differ from the current production build. */
export async function assertFreshWebAssets(directory = webDist) {
	const assets = new Map();
	for (const filename of ["index.html", "bootstrap.js", "style.css"]) {
		try {
			assets.set(filename, await readFile(join(directory, filename)));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			throw new Error(`Missing web-dist/${filename}. ${rebuild}`);
		}
	}

	// Only the production build knows the full esbuild and Tailwind input graphs.
	const reference = await mkdtemp(join(tmpdir(), "unit-web-reference-"));
	try {
		await run(process.execPath, [builder, reference]);
		for (const [filename, actual] of assets) {
			const expected = await readFile(join(reference, filename));
			if (!actual.equals(expected)) throw new Error(`Stale web-dist/${filename}. ${rebuild}`);
		}
	} finally {
		await rm(reference, { recursive: true, force: true });
	}
}
