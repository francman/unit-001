// Authorizes destructive acceptance only on a separately provisioned, explicitly marked Ubuntu host.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

/** Rejects a host that does not satisfy the standalone acceptance authorization boundary. */
export function validateDisposableHost(observation) {
	if (
		observation.actions === "true" ||
		observation.authorization !== "1" ||
		observation.platform !== "linux" ||
		observation.arch !== "x64" ||
		observation.uid !== 0 ||
		observation.init !== "systemd" ||
		!/^ID=ubuntu$/m.test(observation.os) ||
		!/^VERSION_ID="24\.04"$/m.test(observation.os) ||
		observation.markerUid !== 0 ||
		observation.markerMode !== 0o600 ||
		observation.marker !== `${observation.hostname}\n${observation.bootId}\n`
	)
		throw new Error(
			"Requires an explicitly authorized disposable Ubuntu24 x64/systemd root host; Actions is prohibited.",
		);
}

/** Checks the protected boot-bound marker before a fixture changes host accounts, services or data. */
export function requireDisposableHost() {
	const descriptor = openSync(
		"/run/unit-001-acceptance-authorized",
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const info = fstatSync(descriptor);
		if (!info.isFile() || info.size > 256)
			throw new Error("Expected a bounded regular acceptance authorization marker");
		validateDisposableHost({
			actions: process.env.GITHUB_ACTIONS,
			authorization: process.env.UNIT_001_STANDALONE_ACCEPTANCE,
			platform: process.platform,
			arch: process.arch,
			uid: process.getuid?.(),
			init: readFileSync("/proc/1/comm", "utf8").trim(),
			os: readFileSync("/etc/os-release", "utf8"),
			hostname: hostname(),
			bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
			markerUid: info.uid,
			markerMode: info.mode & 0o777,
			marker: readFileSync(descriptor, "utf8"),
		});
	} finally {
		closeSync(descriptor);
	}
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) requireDisposableHost();
