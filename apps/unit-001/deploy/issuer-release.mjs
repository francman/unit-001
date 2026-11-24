// Binds a running administrative issuer to the installation's protected release selection.
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { assertSafePath, installationPaths, trustedFile, trustedParents } from "./installation.mjs";

/** Under the management lock, verifies that the running module is the selected installed issuer. */
export function assertSelectedIssuer(record, executingPath, root = "/") {
	const filesystem = resolve(root || "/");
	const { current } = installationPaths(record.id, filesystem);
	assertSafePath(dirname(current), filesystem);
	trustedParents(current, filesystem);
	const selector = lstatSync(current);
	const owner = filesystem === "/" ? 0 : process.getuid();
	const changed = "The selected release changed; retry the installation's current command.";
	if (
		!selector.isSymbolicLink() ||
		selector.uid !== owner ||
		readlinkSync(current) !== `../../releases/${record.releaseVersion}`
	)
		throw new Error(changed);
	const expected = join(filesystem, "opt/unit-001/releases", record.releaseVersion, "deploy", basename(executingPath));
	trustedFile(expected, filesystem);
	if (executingPath !== realpathSync(expected)) throw new Error(changed);
}
