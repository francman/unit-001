// Prints the unit-001 workspaces (apps/unit-*, packages/unit-*) that define an npm script, one path per line.
// Workflows run the script in each, so a new unit package is picked up without editing a workflow.
// Usage: node .github/scripts/unit-workspaces.mjs <script-name>
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const WORKSPACE_ROOTS = ["apps", "packages"];
export const WORKSPACE_PREFIX = "unit-";

/** @returns {string[]} workspace paths relative to `root`, sorted, that define `script`. */
export function listWorkspaces({ root = process.cwd(), script }) {
	const found = [];
	for (const parent of WORKSPACE_ROOTS) {
		const parentPath = join(root, parent);
		if (!existsSync(parentPath)) continue;
		for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
			if (!entry.isDirectory() || !entry.name.startsWith(WORKSPACE_PREFIX)) continue;
			const manifestPath = join(parentPath, entry.name, "package.json");
			if (!existsSync(manifestPath)) continue;
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			if (typeof manifest.scripts?.[script] === "string") found.push(`${parent}/${entry.name}`);
		}
	}
	return found.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const script = process.argv[2];
	if (!script || process.argv.length > 3) {
		console.error("Usage: node .github/scripts/unit-workspaces.mjs <script-name>");
		process.exit(2);
	}
	for (const workspace of listWorkspaces({ script })) console.log(workspace);
}
