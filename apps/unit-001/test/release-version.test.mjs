// Checks that the publisher and the installed updater accept and order exactly the same stable versions.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareReleaseVersions, isReleaseVersion } from "../deploy/release-version.mjs";
import { validateDescriptor } from "../deploy/update-trust.mjs";
import { generateRepositoryKeys, prepareRepository } from "../scripts/update-repository.mjs";

const compatibility = { stateVersion: 1, minReaderVersion: 1, maintenanceProtocol: 1 };
const CANONICAL = ["0.0.0", "0.0.1", "1.2.3", "10.0.0", "0.10.0", "9007199254740993.0.0"];
const REFUSED = [
	"0.0.01",
	"00.1.0",
	"01.0.0",
	"1.2",
	"1.2.3.4",
	"v1.2.3",
	"1.2.3-rc.1",
	"+1.0.0",
	"-1.0.0",
	" 1.2.3",
	"1.2.3 ",
	"1.2.3\n",
	"1e3.0.0",
	"0x1.0.0",
	"١.٢.٣",
	"",
];

test("the publisher signs exactly the versions the installed updater accepts", (t) => {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "unit-version-")));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const keys = join(directory, "keys");
	const rootBytes = generateRepositoryKeys(keys);
	const publisherAccepts = (version, index) => {
		try {
			prepareRepository({
				archive: join(directory, `unit-001-${version}-linux-x64.tar.gz`),
				archiveBytes: Buffer.from(`archive ${index}`),
				release: { version, platform: "linux-x64", source: { commit: "a".repeat(40), dirty: false }, compatibility },
				rootBytes,
				keys,
				out: join(directory, `out-${index}`),
			});
			return true;
		} catch (error) {
			assert.match(error.message, /exact stable version/);
			return false;
		}
	};
	const clientAccepts = (version) => {
		try {
			validateDescriptor({
				schemaVersion: 1,
				version,
				platform: "linux-x64",
				sourceCommit: "a".repeat(40),
				archiveTarget: `linux-x64/releases/${version}.tar.gz`,
				compatibility,
			});
			return true;
		} catch {
			return false;
		}
	};
	[...CANONICAL, ...REFUSED].forEach((version, index) => {
		const expected = CANONICAL.includes(version);
		assert.equal(isReleaseVersion(version), expected, JSON.stringify(version));
		assert.equal(clientAccepts(version), expected, `client ${JSON.stringify(version)}`);
		assert.equal(publisherAccepts(version, index), expected, `publisher ${JSON.stringify(version)}`);
	});
});

test("versions order by component value at any length, never through a lossy Number", () => {
	const ordered = ["0.0.0", "0.0.1", "0.0.9", "0.0.10", "0.1.0", "1.0.0", "9007199254740992.0.0", "9007199254740993.0.0"];
	for (const [i, a] of ordered.entries())
		for (const [j, b] of ordered.entries()) assert.equal(Math.sign(compareReleaseVersions(a, b)), Math.sign(i - j), `${a} ${b}`);
	assert.throws(() => compareReleaseVersions("0.0.01", "0.0.1"), /canonical/);
});
