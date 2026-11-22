// The stable release version grammar and order, shared by the publisher and the installed updater.

/** Three nonnegative decimal components without leading zeroes: one spelling per version. */
export const RELEASE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** True only for a canonical stable version string. */
export function isReleaseVersion(value) {
	return typeof value === "string" && RELEASE_VERSION.test(value);
}

/**
 * Orders two canonical stable versions exactly: negative, zero or positive. Components are compared as digit strings,
 * never as numbers, so no component length loses precision; canonical spelling makes length-then-text order numeric.
 */
export function compareReleaseVersions(a, b) {
	const left = components(a);
	const right = components(b);
	for (let index = 0; index < 3; index++) {
		const [x, y] = [left[index], right[index]];
		if (x.length !== y.length) return x.length - y.length;
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}

function components(version) {
	const match = typeof version === "string" ? RELEASE_VERSION.exec(version) : null;
	if (match === null) throw new Error(`Not a canonical stable release version: ${String(version)}`);
	return match.slice(1);
}
